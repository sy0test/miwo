/**
 * Phase 1c Task 11 的判别力用例：**旧形状令牌（`{id,name}`）与旧登录路径的退役**。
 *
 * ── 为什么必须 spawn 真应用（`tsx src/app.ts`）+ 真 sqlite + 真 HTTP ──
 * 本文件的被测对象是"**整条链的装配顺序**"：
 *   · 退役掉的旧登录路径在真应用里是 **401（匿名）/ 404（带令牌）** —— 为什么匿名不是 404？
 *     因为 `app.use("/api", …)` 的 `authenticate` 跑在**路由之前**，这是 `src/app.ts` 的挂载顺序决定的，
 *     in-process 挂几个 router **测不到**；
 *   · "旧令牌必须 401"成立的前提是"验签 → 读 DB 复核 → 建 ctx"这条链**没有**回退分支，
 *     而那条分支原来正好住在 `middleware/auth.ts` 里。
 *
 * ── 红端（改动前）原文（同一份请求，Task 11 动手前实测，见 task-11-report.md）──
 *   ① 旧形状 `{id:7}` → `POST /api/project/getProject`  ⇒ **200**
 *   ② 旧形状 `{id:1}` → `GET /api/setting/dbConfig/dbInfo`（admin-only）⇒ **200**（= 管理员越权）
 *   ③ `POST /api/login/login` ⇒ **200**
 * 绿端就是本文件的断言（401 / 401 / 401+404）。
 *
 * ⚠ 数据目录是 `%TEMP%` 下的一次性目录（`MIWO_DATA_DIR`），**不碰** `apps/api/data/db2.sqlite`。
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
import { signToken } from "@/auth/tokens";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-t11-legacy-retired-"));
const CONFIG_SECRET = "task11-legacy-retired-secret-32-bytes!";
/** 夹具 id 刻意用 1 与 7：`roleOfUserId(1) === "admin"` 正是旧桥接的漏洞面。 */
const ADMIN_USER = 1;
const NORMAL_USER = 7;
const READY_TIMEOUT_MS = 90000;

let child: ChildProcess | null = null;
let port = 0;
let dataDir = "";
let output = "";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

interface Reply {
  status: number;
  body: string;
}

function request(method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        timeout: 15000,
        headers: {
          ...(opts.token ? { Authorization: opts.token } : {}),
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

async function stopChild(): Promise<void> {
  const c = child;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => c.once("exit", () => resolve()));
  try {
    c.kill();
  } catch {
    /* already gone */
  }
  if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) return;
  if (c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await Promise.race([exited, delay(5000)]);
}

function dbConfigOf(dir: string): MiwoConfig {
  return {
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir: dir,
    mediaDir: path.join(dir, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: CONFIG_SECRET,
    db: { driver: "sqlite", file: path.join(dir, "db2.sqlite") },
  } as MiwoConfig;
}

/** 旧形状（`{id,name}`，无 `typ`/`tv`）—— 用**当前**密钥签，这正是"退役前的可用令牌"。 */
function legacyToken(userId: number, secret = CONFIG_SECRET): string {
  return (jwt.sign as any)({ id: userId, name: `legacy-${userId}` }, secret, { expiresIn: "180Days" });
}

beforeAll(async () => {
  port = await freePort();
  dataDir = fs.mkdtempSync(path.join(TMP, "boot-"));
  // SPA 壳必须存在：本文件要证明"退役不会把登录页一起锁掉"（`GET /` 匿名 200）
  fs.mkdirSync(path.join(dataDir, "web"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "web", "index.html"), "<html>miwo login shell</html>", "utf8");

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
      MIWO_DB_DRIVER: "sqlite",
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
    if ((await request("GET", "/api/other/configHealth?summary=1")).status === 200) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    await stopChild();
    throw new Error(`应用没起来（port ${port}）。输出尾部：\n${output.slice(-1500)}`);
  }

  // 账号夹具：一行 active 普通用户 + 一行 active 管理员（角色只信 DB）
  const db = createKnex(dbConfigOf(dataDir));
  try {
    await db("o_user")
      .insert([
        { id: ADMIN_USER, username: "legacy-admin", email: null, passwordHash: "", role: "admin", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: 1, lastLoginAt: null },
        { id: NORMAL_USER, username: "legacy-user", email: null, passwordHash: "", role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: 1, lastLoginAt: null },
      ])
      .onConflict("id")
      .merge();
    const seeded = await db("o_user").whereIn("id", [ADMIN_USER, NORMAL_USER]).select("id", "status");
    expect(seeded.length, "前置：两行账号夹具必须真的落库（否则后面的 401 是空断言）").toBe(2);
  } finally {
    await db.destroy();
  }
}, 180000);

afterAll(async () => {
  await stopChild();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Phase 1c Task 11：旧形状令牌 / 旧登录路径的退役（真应用 + 真 HTTP）", () => {
  it("① ★ 旧形状 `{id:7}` 令牌打受保护接口 ⇒ **401**（退役前是 **200**）", async () => {
    const res = await request("POST", "/api/project/getProject", { token: legacyToken(NORMAL_USER), body: {} });
    expect(res.status, `旧形状令牌必须被拒（退役前这一条是 200）：${res.body.slice(0, 200)}`).toBe(401);
    expect(res.body, "失败体是统一形状（不泄露内部原因）").toMatch(/"code"\s*:\s*401/);
  }, 60000);

  it("② ★★ 旧形状 `{id:1}` 令牌打 **admin-only** 接口 ⇒ **401**（退役前是 **200** = 管理员越权）", async () => {
    const res = await request("GET", "/api/setting/dbConfig/dbInfo", { token: legacyToken(ADMIN_USER) });
    expect(
      res.status,
      `旧令牌不许再靠 roleOfUserId(1)==="admin" 装管理员（退役前这一条是 200）：${res.body.slice(0, 200)}`,
    ).toBe(401);
  }, 60000);

  it("③ 判别力对照：新形状令牌照常可用（普通 200 / 管理员 200）—— 否则上面两条只是「整条链都拒」", async () => {
    const user = await request("POST", "/api/project/getProject", {
      token: signToken({ uid: NORMAL_USER, role: "user", tv: 0, typ: "access" }, CONFIG_SECRET),
      body: {},
    });
    expect(user.status, `新形状普通用户令牌必须 200：${user.body.slice(0, 200)}`).toBe(200);

    const admin = await request("GET", "/api/setting/dbConfig/dbInfo", {
      token: signToken({ uid: ADMIN_USER, role: "admin", tv: 0, typ: "access" }, CONFIG_SECRET),
    });
    expect(admin.status, `新形状管理员令牌必须 200：${admin.body.slice(0, 200)}`).toBe(200);
  }, 60000);

  it("④ ★ 被停用账号的**新形状**令牌 ⇒ 401（旧形状做不到这条：它不读 DB）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      await db("o_user").where("id", NORMAL_USER).update({ status: "disabled" });
      const res = await request("POST", "/api/project/getProject", {
        token: signToken({ uid: NORMAL_USER, role: "user", tv: 0, typ: "access" }, CONFIG_SECRET),
        body: {},
      });
      expect(res.status, `disabled 账号的令牌必须 401（这就是"封禁真的生效"）：${res.body.slice(0, 200)}`).toBe(401);
      // 反向对照：恢复 active ⇒ 同一个令牌立刻又能用（证明 401 来自 status，而不是令牌本身坏了）
      await db("o_user").where("id", NORMAL_USER).update({ status: "active" });
      const back = await request("POST", "/api/project/getProject", {
        token: signToken({ uid: NORMAL_USER, role: "user", tv: 0, typ: "access" }, CONFIG_SECRET),
        body: {},
      });
      expect(back.status, "恢复 active 后同一个 id 的令牌必须又能用").toBe(200);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("⑤ ★ 旧登录路径 `/api/login/login` 已退役：匿名 ⇒ 401（鉴权先于路由），带有效令牌 ⇒ 404（路由真的没了）", async () => {
    const anon = await request("POST", "/api/login/login", { body: { username: "x", password: "y" } });
    expect(anon.status, `匿名打已退役路径 ⇒ 401，实际 ${anon.status}：${anon.body.slice(0, 200)}`).toBe(401);

    const token = signToken({ uid: NORMAL_USER, role: "user", tv: 0, typ: "access" }, CONFIG_SECRET);
    const authed = await request("POST", "/api/login/login", { token, body: { username: "x", password: "y" } });
    expect(authed.status, `带令牌打已退役路径 ⇒ 404，实际 ${authed.status}：${authed.body.slice(0, 200)}`).toBe(404);
  }, 60000);

  it("⑥ ★ 退役不牵连登录页：匿名 `GET /`（SPA 壳）仍然 **200**", async () => {
    const res = await request("GET", "/");
    expect(res.status, `匿名 GET / 必须 200（否则用户连登录页都打不开）：${res.body.slice(0, 200)}`).toBe(200);
    expect(res.body).toContain("miwo login shell");
  }, 60000);

  it("⑦ 旧形状令牌**换个密钥**签也照样 401（证明不是「只拒我们自己签的那一个」）", async () => {
    const res = await request("POST", "/api/project/getProject", {
      token: legacyToken(NORMAL_USER, "some-other-secret-at-least-32-bytes!!"),
      body: {},
    });
    expect(res.status).toBe(401);
  }, 60000);
});
