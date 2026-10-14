/**
 * Task 7（Phase 1b）+ Task 4（Phase 1c）对抗用例：**运维接口的授权边界与处置分级**。
 *
 * 为什么必须 spawn **真应用**（`tsx src/app.ts`）+ 真 sqlite 文件 + 真 HTTP：
 *   - 这些接口的能力是"整库 drop / 全表导出 / 任意表清空"，用的是 `systemDb`（实例级绕过口）；
 *     "它们到底被谁打得动"只有在**真实中间件链**（`authenticate` → `requireAdmin` → handler）
 *     上才成立。in-process 挂 router 会绕开 `app.ts` 的注册顺序，测不到"接线有没有漏一个"。
 *   - 也**必须**用 `%TEMP%` 一次性库：改造前普通 token 打这些接口会**真的把库清空**——
 *     这正是要钉的漏洞，绝不能让它作用在共享测试库上（否则整条 vitest 一起崩）。
 *
 * ── Phase 1b Task 7 钉住的（本轮保留）──
 *   · 无 token ⇒ 全 401；普通 token ⇒ 全 **403** 且**直读快照逐表相等**（"一行都没少"）；
 *   · admin ⇒ `dbInfo`/`exportData`/`clearTable` 可达（`clearTable` 直读确认**真的删了**）。
 *
 * ── Phase 1c Task 4 新增/改写的（本文件的核心判别力）──
 *   · `deleteAllData` 的路由**整体删除** ⇒ `POST /api/other/deleteAllData` 现在是 **404**
 *     （连 admin 也打不到）：这就是"删掉比停用更进一步"的证据；
 *   · `clearData` / `importData` / `clearTable` **默认关闭**（`allowDbAdminOps=0`）：
 *     admin 也拿 **403** 且**零副作用**（直读快照不变）；
 *   · 把开关打开（`o_setting.allowDbAdminOps='1'`）⇒ admin 打 `clearTable` **200 且真的删了**
 *     （正向对照：证明"默认关闭"是开关生效，不是接口坏了）；
 *   · `exportData` **默认完整备份**（含 `passwordHash` / `inputValues` ⇒ 恢复后还能登录）
 *     与 **`?redact=1` 脱敏导出**（不含上述值、但**保留键名**）两端都断言。
 *   · 每一次成功/被拒的运维调用都落 `o_auditLog`（直读断言）。
 *
 * ⚠ 用例**顺序是有意义的**：只读/拒绝断言在前，改状态的用例（开开关、清表）在后。
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
/** 种在 `%TEMP%` 数据目录里的技能夹具（用来断言"普通 token 的写尝试真的零副作用"）。 */
const SKILL_FIXTURE_FILE = "ops-auth-skill-fixture.md";
const SKILL_FIXTURE = "skills-fixture-ORIGINAL-CONTENT\n";

/**
 * 5 个仍在挂载的运维接口（`deleteAllData` 已整体删除，不在列）。
 *
 * ⚠ 它们**全部**是"默认关闭"或"只读"的：前三个破坏性接口在 `allowDbAdminOps=0` 时
 *   连 admin 都拿 403 —— 所以"普通 token 403"这条断言在任何开关状态下都成立
 *   （鉴权在功能开关**之前**，见 Task 4 的处理器顺序）。
 */
const OPS_ENDPOINTS: ReadonlyArray<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/setting/dbConfig/clearData" },
  { method: "POST", path: "/api/setting/dbConfig/clearTable", body: { tableName: "o_project" } },
  { method: "GET", path: "/api/setting/dbConfig/dbInfo" },
  { method: "GET", path: "/api/setting/dbConfig/exportData" },
  { method: "POST", path: "/api/setting/dbConfig/importData", body: { tables: {} } },
];

/** 破坏性三件套（"默认关闭"要在这三个上验证）。 */
const DESTRUCTIVE_ENDPOINTS = OPS_ENDPOINTS.filter((e) => e.path !== "/api/setting/dbConfig/dbInfo" && e.path !== "/api/setting/dbConfig/exportData");

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

/** `o_auditLog` 里某 action 的行数（审计"真的落库了"的判据，不是只看 API 返回）。 */
async function auditCount(db: Knex, action: string): Promise<number> {
  return Number(((await db("o_auditLog").where("action", action).count({ n: "*" }).first()) as any)?.n ?? 0);
}

async function setOpsSwitch(db: Knex, value: "0" | "1"): Promise<void> {
  await db("o_setting").insert({ key: "allowDbAdminOps", value }).onConflict("key").merge();
}

describe("Task 7/4 运维接口授权与处置（真应用 + 真库 + 真 HTTP）", () => {
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
      // 前置：破坏性三件套必须**默认关闭**（005_accounts 种的 allowDbAdminOps=0）
      const flag: any = await db("o_setting").where("key", "allowDbAdminOps").first();
      expect(String(flag?.value ?? "<缺行>"), "005_accounts 必须种下 allowDbAdminOps=0（默认关闭）").toBe("0");
      // 前置：技能目录在 `%TEMP%` 一次性数据目录里是**空的**（app.ts 只 mkdir）⇒ 自己种一个夹具文件，
      // 这样"普通 token 的写尝试零副作用"才有可直读的判据（否则只能是空断言）。
      const skillsDir = path.join(dataDir, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, "ops-auth-skill-fixture.md"), SKILL_FIXTURE, "utf8");
      // 前置：种一个**账号夹具**（本用例族用旧形状 token `{id:…}` 鉴权，而 `roleOfUserId(1)="admin"`）。
      // 005_accounts 之后迁移不再种 o_user 行（旧系统的单账号是迁成 disabled 的），
      // 但 `o_user` 表存在且有 `id` 列 ⇒ 这里显式种两行，好让"导出里含/不含 passwordHash"
      // 有**可判别的真实数据**（不是空表断言）。
      await db("o_user").insert({ id: ADMIN_USER, username: "ops-auth-admin", email: null, passwordHash: "", role: "admin", status: "disabled", tokenVersion: 0, mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null }).onConflict("id").ignore();
      await db("o_user").insert({ id: NORMAL_USER, username: "ops-auth-user", email: null, passwordHash: "", role: "user", status: "disabled", tokenVersion: 0, mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null }).onConflict("id").ignore();
    } finally {
      await db.destroy();
    }
  }, 180000);

  afterAll(async () => {
    await stopChild(child);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("① 无 token ⇒ 5 个仍挂载的运维接口全部 401", async () => {
    for (const ep of OPS_ENDPOINTS) {
      const res = await request(ep.method, url(ep.path), { body: ep.body });
      expect(res.status, `${ep.method} ${ep.path} 无 token 必须 401：${res.body.slice(0, 200)}`).toBe(401);
    }
  }, 60000);

  it("② 普通 token（id=7）⇒ 5 个运维接口全部 403，且**一行都没少**（直读快照逐项相等）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, NORMAL_USER);
      const before = await snapshot(db);
      expect(before.markerProject).toBe(1); // 前置：改造前这里会被破坏性接口抹掉 ⇒ 下面的快照比对就会红

      const statuses: Array<[string, number]> = [];
      for (const ep of OPS_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        statuses.push([`${ep.method} ${ep.path}`, res.status]);
        // soft：别在第一个接口就中断，否则"改前的破坏面"看不到全貌（5 个状态码 + 行有没有少）
        expect.soft(res.status, `${ep.method} ${ep.path} 普通 token 必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      }
      console.log("[ops-auth] 普通 token 的 5 个状态码：" + JSON.stringify(statuses));

      // ★ 只断言状态码会假绿：必须直读确认破坏性接口**没有真的执行**
      const after = await snapshot(db);
      console.log("[ops-auth] 普通 token 打完之后的直读快照：" + JSON.stringify(after) + "（改前应为全 0 / 行被删）");
      expect(after, "普通 token 打完之后，种下的行与 tokenKey 行必须**逐项不变**（= 行没被删）").toEqual(before);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("③ ★ `deleteAllData` 接口已**整体删除**：admin 打它也是 404（路由不存在，而不是 501/403）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      // 前置：库里确实有可删的行（否则"行还在"是空断言）
      await db("o_project").insert({ id: MARKER_PROJECT, userId: NORMAL_USER, name: "ops-auth-marker", createTime: 3 }).onConflict("id").ignore();
      const before = await snapshot(db);
      expect(before.markerProject, "前置：marker 行必须在").toBe(1);
      const token = await signAs(db, ADMIN_USER);

      const del = await request("POST", url("/api/other/deleteAllData"), { token, body: {} });
      console.log(`[ops-auth] admin 打 deleteAllData（已删除的接口）：status=${del.status} body=${del.body.slice(0, 160)}`);
      expect(del.status, `路由已删除 ⇒ 必须是 404，实际 ${del.status}：${del.body.slice(0, 200)}`).toBe(404);
      // 直读：行**还在**（接口不存在 = 零副作用）
      expect(await snapshot(db), "不存在的接口一行都不该删").toEqual(before);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("④ ★ 破坏性三件套**默认关闭**：admin 打它们也 403（`allowDbAdminOps=0`），且零副作用 + 落审计", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      await setOpsSwitch(db, "0");
      await db("o_script").insert({ id: MARKER_SCRIPT, projectId: MARKER_PROJECT, userId: NORMAL_USER, name: "ep-marker" }).onConflict("id").ignore();
      await db("o_project").insert({ id: MARKER_PROJECT, userId: NORMAL_USER, name: "ops-auth-marker", createTime: 4 }).onConflict("id").ignore();
      const before = await snapshot(db);
      expect(before, "前置：两行都要在").toMatchObject({ markerProject: 1, markerScript: 1 });
      const token = await signAs(db, ADMIN_USER);
      const auditBefore = await auditCount(db, "db.clearTable");

      for (const ep of DESTRUCTIVE_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        expect(res.status, `${ep.method} ${ep.path} 默认关闭时必须 403（admin 也一样），实际 ${res.status}：${res.body.slice(0, 220)}`).toBe(403);
        expect(res.body, "文案要写明这是'默认关闭'，不是权限不足").toMatch(/默认关闭/);
        expect(res.body, "不该是权限不足的口径").not.toMatch(/需要管理员权限/);
      }
      expect(await snapshot(db), "默认关闭 ⇒ 一行都不该动").toEqual(before);
      // 审计：被拒绝的尝试也要有痕迹
      expect(await auditCount(db, "db.clearTable"), "被拒绝的 clearTable 必须落一条审计").toBeGreaterThan(auditBefore);
      const last: any = await db("o_auditLog").where("action", "db.clearTable").orderBy("id", "desc").first();
      expect(String(last?.target)).toContain("rejected:ops-disabled");
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("⑤ admin token（id=1）⇒ dbInfo 200（只回表名与行数）；exportData **默认模式 = 完整备份**（含可恢复所需列）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      // exportData 也在 `allowDbAdminOps` 闸下（控制器裁定 §2.2：导出/清库/导入同属"破坏性 + 凭据面"）
      await setOpsSwitch(db, "1");
      // 种一个**可判别的** tokenKey：导出里若出现它，就是线上凭据泄露
      await db("o_setting").where("key", "tokenKey").del();
      await db("o_setting").insert({ key: "tokenKey", value: DB_SECRET });
      const token = await signAs(db, ADMIN_USER);

      const info = await request("GET", url("/api/setting/dbConfig/dbInfo"), { token });
      expect(info.status, `admin 打 dbInfo 必须可达：${info.body.slice(0, 200)}`).toBe(200);
      expect(info.body, "dbInfo 必须只回表名与行数（不回列内容）").toMatch(/rowCount/);

      const exp = await request("GET", url("/api/setting/dbConfig/exportData"), { token });
      expect(exp.status, `admin 打 exportData 必须可达（完整备份模式）：${exp.body.slice(0, 200)}`).toBe(200);
      // 正向对照：导出**确实**是整库（含 o_setting 表）——否则"不含 tokenKey"可能只是"什么都没导"
      expect(exp.body).toMatch(/o_setting/);
      expect(exp.body, "导出的 JSON 里不得出现 tokenKey 的**值**").not.toContain(DB_SECRET);
      expect(exp.body, "导出的 JSON 里不得出现 tokenKey 这个**键**").not.toMatch(/"key"\s*:\s*"tokenKey"/);
      // ★ 默认模式仍是**完整备份**（掩掉它会"恢复备份后登录不上" —— 那是功能回归）
      expect(exp.body, "默认导出必须带 o_user.passwordHash（否则备份不可恢复）").toMatch(/"passwordHash"/);
      expect(exp.body, "默认导出必须带 o_vendorConfig.inputValues（否则供应商配置丢失）").toMatch(/"inputValues"/);
      expect(exp.body, "默认导出不该出现脱敏占位符").not.toContain("***REDACTED***");
      expect(JSON.parse(exp.body).redacted, "响应体要自证这份文件是完整备份").toBe(false);
      // 收尾：关掉闸（后续用例自己控制开关状态）
      await setOpsSwitch(db, "0");
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("⑥ ★ `exportData?redact=1` 脱敏模式：不含 passwordHash/inputValues 的**值**（保留键名），且明确不可恢复", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      await setOpsSwitch(db, "1");
      // 种一个可判别的哈希与供应商 key：脱敏模式下这两个**字面量**都不该出现
      const HASH_MARK = "$argon2id$v=19$m=19456,t=2,p=1$opsAuthRedactMark$abcdefghijklmnop";
      const VENDOR_SECRET = "ops-auth-vendor-secret-MARK";
      const user: any = await db("o_user").orderBy("id", "desc").first();
      expect(user, "前置：库里要有 o_user 行").toBeTruthy();
      await db("o_user").where("id", user.id).update({ passwordHash: HASH_MARK });
      await db("o_vendorConfig").insert({ id: "ops-auth-vendor", inputValues: JSON.stringify({ apiKey: VENDOR_SECRET }), models: "[]", enable: 0 }).onConflict("id").merge();
      const token = await signAs(db, ADMIN_USER);

      const full = await request("GET", url("/api/setting/dbConfig/exportData"), { token });
      expect(full.status).toBe(200);
      expect(full.body, "前置（红端对照）：**完整**导出里这两个凭据必须真的出现").toContain(VENDOR_SECRET);

      const red = await request("GET", url("/api/setting/dbConfig/exportData?redact=1"), { token });
      expect(red.status, `admin 打脱敏导出必须 200：${red.body.slice(0, 200)}`).toBe(200);
      const parsed = JSON.parse(red.body);
      expect(parsed.redacted, "响应体要自证这是脱敏导出").toBe(true);
      // ★ 两个凭据的**值**都不在
      expect(red.body, "脱敏导出不得含 passwordHash 的值").not.toContain(HASH_MARK);
      expect(red.body, "脱敏导出不得含供应商 key 的值").not.toContain(VENDOR_SECRET);
      // ★ 但**键名**要留着（让运维知道"这里有一列被剔除了"）
      expect(red.body, "脱敏导出必须保留 passwordHash 键名").toMatch(/"passwordHash"/);
      expect(red.body, "脱敏导出必须保留 inputValues 键名").toMatch(/"inputValues"/);
      expect(red.body, "占位符必须出现（值被替换过）").toContain("***REDACTED***");
      // 正向对照：脱敏导出**仍然是整库导出**（不是"什么都没导"）
      expect(red.body).toMatch(/o_setting/);
      expect(parsed.redactedColumns?.o_user, "响应体要列出被脱敏的表+列").toContain("passwordHash");
      // 审计：两次导出各一条（含 redacted 标记）
      expect(await auditCount(db, "db.export"), "导出必须落审计").toBeGreaterThanOrEqual(2);
      await setOpsSwitch(db, "0");
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("⑦ ★ 开关打开（allowDbAdminOps=1）⇒ admin 打 clearTable 200 且**真的删了**（正向对照，证明开关生效而不是接口坏了）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      await db("o_script").insert({ id: MARKER_SCRIPT, projectId: MARKER_PROJECT, userId: NORMAL_USER, name: "ep-marker" }).onConflict("id").ignore();
      await db("o_project").insert({ id: MARKER_PROJECT, userId: NORMAL_USER, name: "ops-auth-marker", createTime: 5 }).onConflict("id").ignore();
      const token = await signAs(db, ADMIN_USER);
      const before = await snapshot(db);
      expect(before, "前置：两行都要在").toMatchObject({ markerProject: 1, markerScript: 1 });

      // 先确认关闭态（红端）：admin 403
      await setOpsSwitch(db, "0");
      const closed = await request("POST", url("/api/setting/dbConfig/clearTable"), { token, body: { tableName: "o_script" } });
      expect(closed.status, "关闭态必须 403").toBe(403);
      expect(await snapshot(db), "关闭态零副作用").toEqual(before);

      // 再开：admin 200 且真的删掉那一行（直读）
      await setOpsSwitch(db, "1");
      const clear = await request("POST", url("/api/setting/dbConfig/clearTable"), { token, body: { tableName: "o_script" } });
      expect(clear.status, `开关打开后 admin 打 clearTable 必须可达：${clear.body.slice(0, 200)}`).toBe(200);
      const after = await snapshot(db);
      expect(after.markerScript, "admin 该表被清空 ⇒ marker 行必须消失（证明接口真的执行了）").toBe(0);
      expect(after.markerProject, "clearTable 是按表清的 ⇒ 另一张表的行必须还在").toBe(1);
      expect(await auditCount(db, "db.clearTable"), "成功的 clearTable 也要落审计").toBeGreaterThan(0);

      // 非白名单表（knex 基础设施表）必须被拒（表名白名单的判别力）
      const infra = await request("POST", url("/api/setting/dbConfig/clearTable"), { token, body: { tableName: "knex_migrations" } });
      expect(infra.status, `knex_migrations 不在允许清空的名单里 ⇒ 400，实际 ${infra.status}：${infra.body.slice(0, 200)}`).toBe(400);
      expect(infra.body).toMatch(/不在允许清空的名单里/);

      // 收尾：把开关关回去，别影响后续用例/其它测试文件
      await setOpsSwitch(db, "0");
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("⑧ importData：非白名单表名 ⇒ 400（且**库没被动过**）；开关关闭 ⇒ 403", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      await setOpsSwitch(db, "1");
      await db("o_project").insert({ id: MARKER_PROJECT, userId: NORMAL_USER, name: "ops-auth-marker", createTime: 6 }).onConflict("id").ignore();
      const before = await snapshot(db);
      expect(before.markerProject).toBe(1);
      const token = await signAs(db, ADMIN_USER);

      // 白名单外的表名：必须在"drop 全库"**之前**就被拒（否则库已经没了）
      const bad = await request("POST", url("/api/setting/dbConfig/importData"), { token, body: { tables: { knex_migrations: [{ a: 1 }] } } });
      expect(bad.status, `白名单外的表名必须 400，实际 ${bad.status}：${bad.body.slice(0, 220)}`).toBe(400);
      expect(bad.body).toMatch(/不在白名单里/);
      expect(await snapshot(db), "被拒的导入必须零副作用（库还在）").toEqual(before);

      // 白名单内但列不存在：也要在动手前拒绝
      const badCols = await request("POST", url("/api/setting/dbConfig/importData"), { token, body: { tables: { o_project: [{ id: 1, definitelyNotAColumn: 1 }] } } });
      expect(badCols.status, `不存在的列必须 400，实际 ${badCols.status}：${badCols.body.slice(0, 220)}`).toBe(400);
      expect(await snapshot(db), "被拒的导入必须零副作用（库还在）").toEqual(before);

      // 关闭态：连"能不能导入"都不给（403）
      await setOpsSwitch(db, "0");
      const closed = await request("POST", url("/api/setting/dbConfig/importData"), { token, body: { tables: {} } });
      expect(closed.status, "关闭态必须 403").toBe(403);
      expect(await snapshot(db), "关闭态零副作用").toEqual(before);
    } finally {
      await db.destroy();
    }
  }, 90000);

  /**
   * Phase 1b 收尾轮 / 终审 ③-B：`/api/setting/agentDeploy/*` 家族 6 个端点**全部未收权**，
   * 其中 `agentSetKey` 是**写供应商 key** 的接口 ⇒ 任意登录用户都能改供应商凭据。
   * 判据照 Task 7：无 token 401 / 普通 token 403 / **admin 正向对照 200** / 普通 token 打完**直读数据一行未变**。
   */
  const AGENT_DEPLOY_ENDPOINTS: ReadonlyArray<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
    { method: "POST", path: "/api/setting/agentDeploy/agentSetKey", body: { key: "HACKED-KEY" } },
    { method: "POST", path: "/api/setting/agentDeploy/deployAgentModel", body: { items: [] } },
    { method: "POST", path: "/api/setting/agentDeploy/getAgentDeploy" },
    { method: "GET", path: "/api/setting/agentDeploy/getAgentUseMode" },
    { method: "POST", path: "/api/setting/agentDeploy/updateAgentModel", body: { id: 1, name: "x", model: "y" } },
    { method: "POST", path: "/api/setting/agentDeploy/updateUseMode", body: { agentUseMode: "999" } },
  ];

  it("★ agentDeploy 家族 6 个端点：无 token 401 / 普通 token 403 / admin 200，且普通 token 试写后**数据未被改**", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      // 前置：种一个会被 updateUseMode 改掉的行（否则"没被改"是空断言）
      await db("o_setting").insert({ key: "agentUseMode", value: "1" }).onConflict("key").merge();
      const before = {
        useMode: String(((await db("o_setting").where("key", "agentUseMode").first()) as any)?.value),
        agentDeployRows: Number(((await db("o_agentDeploy").count({ n: "*" }).first()) as any)?.n ?? 0),
        hackedRows: Number(((await db("o_setting").where("value", "HACKED-KEY").count({ n: "*" }).first()) as any)?.n ?? 0),
      };
      expect(before.useMode, "前置：agentUseMode 行必须在库里").toBe("1");
      expect(before.hackedRows, "前置：库里不该已有 HACKED-KEY").toBe(0);

      // ① 无 token ⇒ 全 401
      for (const ep of AGENT_DEPLOY_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { body: ep.body });
        expect(res.status, `${ep.method} ${ep.path} 无 token 必须 401（实际 ${res.status}）`).toBe(401);
      }
      // ② 普通 token ⇒ 全 403
      const token = await signAs(db, NORMAL_USER);
      for (const ep of AGENT_DEPLOY_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        expect(res.status, `${ep.method} ${ep.path} 普通 token 必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      }
      // ③ 直读：**一行都没被改**（agentSetKey 的假 key 没落库、useMode 没变成 999、agentDeploy 行数没动）
      const after = {
        useMode: String(((await db("o_setting").where("key", "agentUseMode").first()) as any)?.value),
        agentDeployRows: Number(((await db("o_agentDeploy").count({ n: "*" }).first()) as any)?.n ?? 0),
        hackedRows: Number(((await db("o_setting").where("value", "HACKED-KEY").count({ n: "*" }).first()) as any)?.n ?? 0),
      };
      expect(after, "普通 token 的 6 次尝试必须零写入").toEqual(before);
      // ④ admin 正向对照：读接口仍可用 ⇒ 403 是"收权"，不是"接口坏了"
      const admin = await signAs(db, ADMIN_USER);
      const read1 = await request("POST", url("/api/setting/agentDeploy/getAgentDeploy"), { token: admin });
      expect(read1.status, `admin 打 getAgentDeploy 应 200：${read1.body.slice(0, 200)}`).toBe(200);
      const read2 = await request("GET", url("/api/setting/agentDeploy/getAgentUseMode"), { token: admin });
      expect(read2.status, `admin 打 getAgentUseMode 应 200：${read2.body.slice(0, 200)}`).toBe(200);
      expect(read2.body, "admin 读到的是真数据（useMode=1）").toContain("1");
    } finally {
      await db("o_setting").where("key", "agentUseMode").del().catch(() => {});
      await db.destroy();
    }
  }, 90000);

  /**
   * Phase 1c Task 4 的新增族：`vendorConfig` 整族 13 个端点全部收权（spec §7.3）。
   *
   * 判据：无 token 401 / 普通 token 403 / admin 正向对照非 403 / 普通 token 打完**直读零写入**。
   * ⚠ `getVendorList` 是其中最敏感的一个（它把 `inputValues` 原样回传 ⇒ 供应商 key 明文）。
   * ⚠ 请求体必须**通过 zod**（中间件顺序是 `validateFields` → `requireAdmin`，见 brief Step 2 的
   *   "每个文件在 validateFields 之后插 requireAdmin"）—— 否则看到的是 400 而不是 403。
   *   这些 body 全部对真实数据无害（假 id / 不存在的 modelName / 校验必败的类型）。
   */
  const MODEL_TEXT = { name: "n", modelName: "m", type: "text", think: false };
  const VENDOR_CONFIG_ENDPOINTS: ReadonlyArray<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
    { method: "POST", path: "/api/setting/vendorConfig/getVendorList" },
    { method: "POST", path: "/api/setting/vendorConfig/addVendor", body: { tsCode: "export default {}" } },
    { method: "POST", path: "/api/setting/vendorConfig/addVendorModel", body: { id: "ops-auth-absent-vendor", model: MODEL_TEXT } },
    { method: "POST", path: "/api/setting/vendorConfig/deleteVendor", body: { id: "ops-auth-absent-vendor" } },
    { method: "POST", path: "/api/setting/vendorConfig/delVendorModel", body: { id: "ops-auth-absent-vendor", modelName: "m" } },
    { method: "POST", path: "/api/setting/vendorConfig/enableVendor", body: { id: "ops-auth-absent-vendor", enable: 0 } },
    { method: "POST", path: "/api/setting/vendorConfig/getCodeByLink", body: { link: "https://example.invalid/x" } },
    { method: "POST", path: "/api/setting/vendorConfig/modelTest", body: { modelName: "m", type: "text", id: "ops-auth-absent-vendor" } },
    { method: "POST", path: "/api/setting/vendorConfig/updateCode", body: { id: "ops-auth-absent-vendor", tsCode: "export default {}" } },
    { method: "POST", path: "/api/setting/vendorConfig/updateVendorInputs", body: { id: "ops-auth-absent-vendor", inputValues: { apiKey: "HACKED-VENDOR-KEY" } } },
    { method: "POST", path: "/api/setting/vendorConfig/upVendorModel", body: { id: "ops-auth-absent-vendor", modelName: "m", model: MODEL_TEXT } },
    { method: "POST", path: "/api/setting/vendorConfig/modelTest/imageTest", body: { modelName: "m", id: "ops-auth-absent-vendor", prompt: "p", imageBase64: "" } },
    { method: "POST", path: "/api/setting/vendorConfig/modelTest/textTest", body: { modelName: "m", id: "ops-auth-absent-vendor", messages: [] } },
    { method: "POST", path: "/api/setting/vendorConfig/modelTest/videoTest", body: { modelName: "m", id: "ops-auth-absent-vendor", mode: "singleImage", prompt: "p", videos: [], audios: [], images: [] } },
  ];

  it("★ vendorConfig 整族：无 token 401 / 普通 token 403 / admin 非 403，且普通 token 试写后**数据未被改**", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const before = {
        hacked: Number(((await db("o_vendorConfig").where("inputValues", "like", "%HACKED-VENDOR-KEY%").count({ n: "*" }).first()) as any)?.n ?? 0),
        vendorRows: Number(((await db("o_vendorConfig").count({ n: "*" }).first()) as any)?.n ?? 0),
      };
      expect(before.hacked, "前置：库里不该已有 HACKED-VENDOR-KEY").toBe(0);

      for (const ep of VENDOR_CONFIG_ENDPOINTS) {
        const noToken = await request(ep.method, url(ep.path), { body: ep.body });
        expect(noToken.status, `${ep.method} ${ep.path} 无 token 必须 401（实际 ${noToken.status}）`).toBe(401);
      }
      const token = await signAs(db, NORMAL_USER);
      for (const ep of VENDOR_CONFIG_ENDPOINTS) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        expect(res.status, `${ep.method} ${ep.path} 普通 token 必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      }
      const after = {
        hacked: Number(((await db("o_vendorConfig").where("inputValues", "like", "%HACKED-VENDOR-KEY%").count({ n: "*" }).first()) as any)?.n ?? 0),
        vendorRows: Number(((await db("o_vendorConfig").count({ n: "*" }).first()) as any)?.n ?? 0),
      };
      expect(after, "普通 token 的 14 次尝试必须零写入（尤其 HACKED-VENDOR-KEY 不许落库）").toEqual(before);

      // admin 正向对照：读端点必须**非 403**（证明 403 是收权，不是接口坏了）
      const admin = await signAs(db, ADMIN_USER);
      const list = await request("POST", url("/api/setting/vendorConfig/getVendorList"), { token: admin });
      expect(list.status, `admin 打 getVendorList 必须非 403：${list.body.slice(0, 200)}`).not.toBe(403);
      expect(list.status, `admin 打 getVendorList 必须 200：${list.body.slice(0, 200)}`).toBe(200);
    } finally {
      await db.destroy();
    }
  }, 120000);

  /** 其余被收权的写端点（提示词 / 模型绑定 / 技能文本）。body 必须过 zod，见上一条注释。 */
  const OTHER_ADMIN_ONLY: ReadonlyArray<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
    { method: "POST", path: "/api/setting/promptManage/updatePrompt", body: { id: 999999, data: "HACKED-PROMPT" } },
    { method: "POST", path: "/api/setting/modelMap/savePrompt", body: { name: "ops-auth-fixture", data: "HACKED-PROMPT", type: "image" } },
    { method: "POST", path: "/api/setting/modelMap/updatePrompt", body: { name: "ops-auth-fixture", data: "HACKED-PROMPT", type: "image" } },
    { method: "POST", path: "/api/setting/modelMap/deletePrompt", body: { path: "ops-auth-fixture.md" } },
    { method: "POST", path: "/api/setting/modelMap/bindingPrompt", body: { vendorId: "ops-auth-absent-vendor", model: "m", path: "p", fileName: "f" } },
    { method: "POST", path: "/api/setting/skillManagement/saveSkillContent", body: { path: SKILL_FIXTURE_FILE, content: "HACKED-SKILL" } },
  ];

  it("★ 提示词/模型绑定/技能文本写端点：无 token 401 / 普通 token 403（且技能文件没被改）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    const skillFile = path.join(dataDir, "skills", SKILL_FIXTURE_FILE);
    try {
      expect(fs.existsSync(skillFile), "前置：技能夹具文件必须存在（否则'没被改'是空断言）").toBe(true);

      for (const ep of OTHER_ADMIN_ONLY) {
        const noToken = await request(ep.method, url(ep.path), { body: ep.body });
        expect(noToken.status, `${ep.method} ${ep.path} 无 token 必须 401（实际 ${noToken.status}）`).toBe(401);
      }
      const token = await signAs(db, NORMAL_USER);
      for (const ep of OTHER_ADMIN_ONLY) {
        const res = await request(ep.method, url(ep.path), { token, body: ep.body });
        expect(res.status, `${ep.method} ${ep.path} 普通 token 必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      }
      // 直读：技能文件**逐字节未变**（这是"只断言状态码会假绿"的那一条）
      expect(fs.readFileSync(skillFile, "utf8"), "普通 token 的写尝试必须零副作用").toBe(SKILL_FIXTURE);

      // L3 / 路径白名单的反向证据：admin 传非 .md 也要 400（不是 403）
      const admin = await signAs(db, ADMIN_USER);
      const notMd = await request("POST", url("/api/setting/skillManagement/saveSkillContent"), { token: admin, body: { path: "ops-auth-skill-fixture.txt", content: "x" } });
      expect(notMd.status, `非 .md 必须 400（白名单口径），实际 ${notMd.status}：${notMd.body.slice(0, 200)}`).toBe(400);
      const escape = await request("POST", url("/api/setting/skillManagement/saveSkillContent"), { token: admin, body: { path: "../db2.sqlite", content: "x" } });
      expect(escape.status, `越出 skills 的路径必须 400，实际 ${escape.status}：${escape.body.slice(0, 200)}`).toBe(400);
      // 正向对照：admin 写**合法**的 .md 夹具必须成功（证明 400 是白名单口径，不是"整个接口坏了"）
      const ok = await request("POST", url("/api/setting/skillManagement/saveSkillContent"), { token: admin, body: { path: SKILL_FIXTURE_FILE, content: "skills-fixture-ADMIN-REWRITE\n" } });
      expect(ok.status, `admin 写合法的 .md 必须 200：${ok.body.slice(0, 200)}`).toBe(200);
      expect(fs.readFileSync(skillFile, "utf8"), "admin 的写必须真的落盘").toBe("skills-fixture-ADMIN-REWRITE\n");
      expect(await auditCount(db, "setting.skill.write"), "技能写必须落审计").toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  }, 90000);
});
