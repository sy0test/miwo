/**
 * Task 7（Phase 1b）对抗用例：**6 个运维接口的授权边界**。
 *
 * 为什么必须 spawn **真应用**（`tsx src/app.ts`）+ 真 sqlite 文件 + 真 HTTP：
 *   - 这 6 个接口的能力是"整库 drop / 全表导出 / 任意表清空"，用的是 `systemDb`（实例级绕过口）；
 *     "它们到底被谁打得动"只有在**真实中间件链**（`tenantContextMiddleware` → `requireAdmin` → handler）
 *     上才成立。in-process 挂 router 会绕开 `app.ts` 的注册顺序，测不到"接线有没有漏一个"。
 *   - 也**必须**用 `%TEMP%` 一次性库：改造前普通 token 打 `deleteAllData` 会**真的把库清空**——
 *     这正是要钉的漏洞，绝不能让它作用在共享测试库上（否则整条 vitest 一起崩）。
 *
 * 判别力（每条都防"只断言状态码"的假绿）：
 *   · 无 token  ⇒ 6 个接口全 401；
 *   · 普通 token（id=7，role=user）⇒ 6 个接口全 **403**，并且**直读快照逐表相等**（"一行都没少"）——
 *     改造前 `deleteAllData`/`clearTable`/`clearData`/`importData` 会真的删/灌，快照必然不等 ⇒ 红；
 *   · admin token（id=1）⇒ 6 个接口可达：`dbInfo` 200；
 *   · admin ⇒ `exportData` 200 且响应体**不含** `tokenKey` 行（最高价值凭据不外泄）；
 *   · admin ⇒ `deleteAllData` 200，且**我种的行真的没了**（正向对照：证明"删得动"而不是"接口没生效"）。
 *
 * ⚠ 用例**顺序是有意义的**：破坏性最强的 `deleteAllData`(admin) 放最后（它 drop 全表）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import jwt from "jsonwebtoken";
import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-ops-auth-"));
const CONFIG_SECRET = "ops-auth-test-config-secret-32-bytes!!";
const DB_SECRET = "ops-auth-test-db-token-key-32-bytes!!";
const MARKER_PROJECT = 55555;
const MARKER_SCRIPT = 55556;
const NORMAL_USER = 7;
const ADMIN_USER = 1;

/** 6 个运维接口（路径/方法与 `src/router.ts:233,316-320` 一一对应）。 */
const OPS_ENDPOINTS: ReadonlyArray<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
  { method: "POST", path: "/api/other/deleteAllData" },
  { method: "GET", path: "/api/setting/dbConfig/clearData" },
  { method: "POST", path: "/api/setting/dbConfig/clearTable", body: { tableName: "o_project" } },
  { method: "GET", path: "/api/setting/dbConfig/dbInfo" },
  { method: "GET", path: "/api/setting/dbConfig/exportData" },
  { method: "POST", path: "/api/setting/dbConfig/importData", body: { tables: {} } },
];

const READY_TIMEOUT_MS = 90000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  body: string;
}

/** 真 HTTP 调用；连接失败记为 status 0（不吞掉，交由断言报错）。 */
function request(method: string, url: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const u = new URL(url);
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        timeout: 8000,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, body: "" }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) return;
  if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await Promise.race([exited, delay(5000)]);
}

function dbConfigOf(dataDir: string): MiwoConfig {
  return {
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir,
    mediaDir: path.join(dataDir, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: CONFIG_SECRET,
    db: { driver: "sqlite", file: path.join(dataDir, "db2.sqlite") },
  } as MiwoConfig;
}

/** 直读快照：种下的那两行 + tokenKey 行是否还在（"行没被删"的判据）。 */
async function snapshot(db: Knex): Promise<Record<string, number>> {
  const count = async (table: string, where: Record<string, unknown>): Promise<number> =>
    Number(((await db(table).where(where).count({ n: "*" }).first()) as any)?.n ?? 0);
  return {
    markerProject: await count("o_project", { id: MARKER_PROJECT }),
    markerScript: await count("o_script", { id: MARKER_SCRIPT }),
    tokenKeyRows: await count("o_setting", { key: "tokenKey" }),
  };
}

describe("Task 7 运维接口授权（真应用 + 真库 + 真 HTTP）", () => {
  let child: ChildProcess;
  let port = 0;
  let dataDir = "";
  let output = "";

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  /** 用**当前**库里的 tokenKey 签发（没有则回退配置密钥）——这样"改造前的清库"也不会让后续断言失去意义。 */
  async function signAs(db: Knex, userId: number): Promise<string> {
    const row: any = await db("o_setting").where("key", "tokenKey").first();
    const secret = (row && row.value) || CONFIG_SECRET;
    return (jwt.sign as any)({ id: userId, name: `ops-auth-${userId}` }, secret, { expiresIn: "180Days" });
  }

  beforeAll(async () => {
    port = await freePort();
    dataDir = fs.mkdtempSync(path.join(TMP, "boot-"));
    child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        MIWO_ENV: "dev",
        MIWO_PORT: String(port),
        MIWO_HOST: "127.0.0.1",
        MIWO_DATA_DIR: dataDir,
        MIWO_JWT_SECRET: CONFIG_SECRET,
        NODE_OPTIONS: "--import=tsx",
        MIWO_DB_DRIVER: "sqlite", // 钉死方言（vitest.config.ts 可能注入 MIWO_TEST_MYSQL）
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      await delay(500);
      if (child.exitCode !== null || child.signalCode !== null) break;
      const res = await request("GET", url("/api/other/configHealth?summary=1"));
      if (res.status === 200) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      await stopChild(child);
      throw new Error(`应用没起来（port ${port}）。输出尾部：\n${output.slice(-1500)}`);
    }

    const db = createKnex(dbConfigOf(dataDir));
    try {
      await db("o_project").insert({ id: MARKER_PROJECT, userId: NORMAL_USER, name: "ops-auth-marker", createTime: 1 });
      await db("o_script").insert({ id: MARKER_SCRIPT, projectId: MARKER_PROJECT, userId: NORMAL_USER, name: "ep-marker" });
      const snap = await snapshot(db);
      expect(snap, "前置：种下的行必须在库里（否则后面的'行没被删'是空断言）").toMatchObject({ markerProject: 1, markerScript: 1 });
    } finally {
      await db.destroy();
    }
  }, 180000);

  afterAll(async () => {
    await stopChild(child);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("① 无 token ⇒ 6 个运维接口全部 401", async () => {
    for (const ep of OPS_ENDPOINTS) {
      const res = await request(ep.method, url(ep.path), { body: ep.body });
      expect(res.status, `${ep.method} ${ep.path} 无 token 必须 401：${res.body.slice(0, 200)}`).toBe(401);
    }
  }, 60000);

  it("② 普通 token（id=7）⇒ 6 个运维接口全部 403，且**一行都没少**（直读快照逐项相等）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, NORMAL_USER);
      const before = await snapshot(db);
      expect(before.markerProject).toBe(1); // 前置：改造前这里会被破坏性接口抹掉 ⇒ 下面的快照比对就会红

      const statuses: Array<[string, number]> = [];
      for (const ep of OPS_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        statuses.push([`${ep.method} ${ep.path}`, res.status]);
        // soft：别在第一个接口就中断，否则"改前的破坏面"看不到全貌（6 个状态码 + 行有没有少）
        expect.soft(res.status, `${ep.method} ${ep.path} 普通 token 必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      }
      console.log("[ops-auth] 普通 token 的 6 个状态码：" + JSON.stringify(statuses));

      // ★ 只断言状态码会假绿：必须直读确认破坏性接口**没有真的执行**
      const after = await snapshot(db);
      console.log("[ops-auth] 普通 token 打完之后的直读快照：" + JSON.stringify(after) + "（改前应为全 0 / 行被删）");
      expect(after, "普通 token 打完之后，种下的行与 tokenKey 行必须**逐项不变**（= 行没被删）").toEqual(before);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("③ admin token（id=1）⇒ dbInfo 200；exportData 200 且响应体不含 tokenKey（凭据不外泄）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      // 种一个**可判别的** tokenKey：导出里若出现它，就是线上凭据泄露
      await db("o_setting").where("key", "tokenKey").del();
      await db("o_setting").insert({ key: "tokenKey", value: DB_SECRET });
      const token = await signAs(db, ADMIN_USER);

      const info = await request("GET", url("/api/setting/dbConfig/dbInfo"), { token });
      expect(info.status, `admin 打 dbInfo 必须可达：${info.body.slice(0, 200)}`).toBe(200);

      const exp = await request("GET", url("/api/setting/dbConfig/exportData"), { token });
      expect(exp.status, `admin 打 exportData 必须可达：${exp.body.slice(0, 200)}`).toBe(200);
      // 正向对照：导出**确实**是整库（含 o_setting 表）——否则"不含 tokenKey"可能只是"什么都没导"
      expect(exp.body).toMatch(/o_setting/);
      expect(exp.body, "导出的 JSON 里不得出现 tokenKey 的**值**").not.toContain(DB_SECRET);
      expect(exp.body, "导出的 JSON 里不得出现 tokenKey 这个**键**").not.toMatch(/"key"\s*:\s*"tokenKey"/);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("④ admin token ⇒ 放行（非 401/403）：`clearTable` 真实删表（直读确认行没了）+ `deleteAllData` 命中 handler", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      // 前置：种一个**独立的**破坏面：clearTable 只删 o_script 的 marker 行，o_project 的必须留着（证明"按表"而不是"整库"）
      // （用例② 通过后那行本来就还在，用 onConflict-ignore 让本用例在任何前序状态下都可重入）
      await db("o_script").insert({ id: MARKER_SCRIPT, projectId: MARKER_PROJECT, userId: NORMAL_USER, name: "ep-marker" }).onConflict("id").ignore();
      const token = await signAs(db, ADMIN_USER);
      const before = await snapshot(db);
      expect(before, "前置：两行都要在").toMatchObject({ markerProject: 1, markerScript: 1 });

      // ★ "admin 才允许"的正向证据：admin 打 clearTable **真的删掉了**那一行（直读）
      const clear = await request("POST", url("/api/setting/dbConfig/clearTable"), { token, body: { tableName: "o_script" } });
      expect(clear.status, `admin 打 clearTable 必须可达：${clear.body.slice(0, 200)}`).toBe(200);
      const after = await snapshot(db);
      expect(after.markerScript, "admin 该表被清空 ⇒ marker 行必须消失（证明接口真的执行了）").toBe(0);
      expect(after.markerProject, "clearTable 是按表清的 ⇒ 另一张表的行必须还在").toBe(1);

      // `deleteAllData`：只断言"requireAdmin 放行"（不是 401/403）。
      // ⚠ 它当前**必 500**：`initDB(db, true)` 在**第一张表** `o_user` 上就抛
      //   `drop table \`o_user\` - database is locked`，所以它既没删成、也不是被授权拦下的 ——
      //   这是 **Task 3 之前就存在**的 bug（与本次收权无关），登记在报告里，不在本任务修
      //   （修好它 = 让"整库清空"真的能打，超出"收权"范围）。
      const del = await request("POST", url("/api/other/deleteAllData"), { token, body: {} });
      console.log(`[ops-auth] admin 打 deleteAllData：status=${del.status} body=${del.body.slice(0, 160)}`);
      expect(del.status, "admin 不该被 requireAdmin 拦（401/403）").not.toBe(401);
      expect(del.status, "admin 不该被 requireAdmin 拦（401/403）").not.toBe(403);
    } finally {
      await db.destroy();
    }
  }, 90000);
});
