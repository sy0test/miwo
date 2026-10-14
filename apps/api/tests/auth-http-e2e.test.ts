/**
 * 登录链路的**真应用端到端**证据（Phase 1c Task 3 的生死判据 / 任务书 §5 判别力 1）。
 *
 * 为什么必须 spawn **真进程**（`tsx src/app.ts`）+ 真 sqlite 文件 + 真 HTTP：
 *   Task 1 把 `o_user` 重建为 §7.1 的十列、并把 `tokenKey` 移出 `o_setting` 之后，
 *   **旧登录路由读的是已经不存在的列**（`o_user.name` / `o_user.password`）⇒ 登录必坏。
 *   而当时三条验收脚本都**不经过登录接口**，所以全绿掩盖了它（账本 1c-16）。
 *   这一条要证明的正是"经由 `src/app.ts` 的真实中间件链 + 真实路由表"能登录：
 *   在内存里挂几个 router 是测不到"app.ts 的挂载顺序 / 白名单 / 中间件接线"的。
 *
 * 用例顺序（后面的用例依赖前面种下的账号）：
 *   ① 邀请码注册（错码必须 403）→ ② 注册第二个账号 → ③ `/api/auth/login` 拿令牌 → ④ 令牌访问**真受保护路由**
 *   → ⑤ 错口令 401 → ⑥ 连错 5 次锁定（正确口令也拒）→ ⑦ refresh Cookie 续期
 *
 * ⚠【Phase 1c Task 11】本文件原来用**旧登录路径** `/api/login/login` 拿令牌（那时它是"过渡薄壳"）。
 *   该路径已整体退役（路由文件删除 + 白名单条目删除）⇒ 现在全程走 `/api/auth/login`。
 *
 * ⚠ 数据目录是 `%TEMP%` 下的一次性目录（`MIWO_DATA_DIR`），**不碰** `apps/api/data/db2.sqlite`
 *   （Ruling 170：dev 库永远只读；`db-target-guard` 也会在启动期拦住指向它的进程）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-auth-e2e-"));
const CONFIG_SECRET = "auth-e2e-test-config-secret-32-bytes!";
const USER = "e2e-user-1";
const LOCK_USER = "e2e-user-lock";
const PW = "pw-e2e-123456";
const INVITE = "e2e-invite-code-1";
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
  body: any;
  raw: string;
  setCookie: string[];
}

/** 真 HTTP；连接失败记为 status 0（不吞掉，交给断言报错）。 */
function request(method: string, pathname: string, opts: { token?: string; body?: unknown; cookie?: string } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        timeout: 15000,
        headers: {
          ...(opts.token ? { Authorization: opts.token } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* 保留原文 */
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw, setCookie: res.headers["set-cookie"] ?? [] });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, body: "", raw: "", setCookie: [] }));
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
      MIWO_DB_DRIVER: "sqlite", // 钉死 sqlite：即使外层设了 MIWO_TEST_MYSQL=1，本用例也只在一次性 sqlite 上跑
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
    throw new Error(`应用没起来（port ${port}，dataDir ${dataDir}）。输出尾部：\n${output.slice(-1500)}`);
  }

  // 夹具：种一个邀请码（`registrationMode` 由 005_accounts 默认成 "invite"）
  const db: Knex = createKnex(dbConfigOf(dataDir));
  try {
    const mode: any = await db("o_setting").where("key", "registrationMode").first();
    expect(mode?.value, `新库的 registrationMode 必须是 005 种下的 invite，实际 ${JSON.stringify(mode)}`).toBe("invite");
    await db("o_invite").insert({ code: INVITE, createdBy: 1, maxUses: 5, usedCount: 0, expiresAt: null, disabled: 0, createdAt: Date.now() });
    expect(await db("o_invite").where("code", INVITE).first()).toBeTruthy();
  } finally {
    await db.destroy();
  }
}, 180000);

afterAll(async () => {
  await stopChild();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("登录链路端到端（真进程 + 真库 + 真 HTTP）", () => {
  it("① 无令牌访问受保护接口 ⇒ 401（判别力前置：证明后面那个 200 不是匿名放行）", async () => {
    const res = await request("POST", "/api/project/getProject", { body: {} });
    expect(res.status, `无 token 必须 401：${res.raw.slice(0, 200)}`).toBe(401);
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  }, 60000);

  it("② 邀请码注册：错码 403、对码 200（真应用里也强制邀请制）", async () => {
    const bad = await request("POST", "/api/auth/register", { body: { username: USER, password: PW, inviteCode: "wrong-code" } });
    expect(bad.status, `错邀请码必须 403：${bad.raw.slice(0, 200)}`).toBe(403);

    const ok = await request("POST", "/api/auth/register", { body: { username: USER, password: PW, inviteCode: INVITE } });
    expect(ok.status, `邀请码注册必须 200：${ok.raw.slice(0, 300)}`).toBe(200);
    expect(ok.body?.data?.username).toBe(USER);

    // 第二个账号（锁定用例用）：同一个邀请码 maxUses=5，可以再用
    const second = await request("POST", "/api/auth/register", { body: { username: LOCK_USER, password: PW, inviteCode: INVITE } });
    expect(second.status, `第二个账号注册必须 200：${second.raw.slice(0, 300)}`).toBe(200);
  }, 60000);

  it("③ ★ `/api/auth/login` 拿到令牌，且该令牌能访问**真受保护路由** `/api/project/getProject`", async () => {
    const res = await request("POST", "/api/auth/login", { body: { username: USER, password: PW } });
    expect(res.status, `登录路径必须 200：${res.raw.slice(0, 300)}`).toBe(200);
    const token = String(res.body?.data?.token ?? "");
    expect(token.startsWith("Bearer "), `响应里的 token 必须带 Bearer 前缀：${token.slice(0, 40)}`).toBe(true);
    expect(res.body?.data?.name).toBe(USER);
    expect(res.body?.data?.id).toBeGreaterThan(0);

    // 本路径**下发** refresh Cookie（续期那半条链就是它；Cookie 是 HttpOnly，不进响应体）。
    // ⚠ Phase 1c Task 11 前这条断言是反的（当时打的是**旧**路径 `/api/login/login`，它有意不发 Cookie）。
    expect(res.setCookie.join(";"), "登录必须下发 refresh Cookie").toContain("miwo_rt=");
    expect(res.setCookie.join(";")).toContain("HttpOnly");

    // 真受保护路由（Phase 1b 的租户隔离入口）：令牌有效才可能 200
    const projects = await request("POST", "/api/project/getProject", { token, body: {} });
    expect(projects.status, `带令牌访问 /api/project/getProject 必须 200：${projects.raw.slice(0, 300)}`).toBe(200);
    expect(projects.body?.code).toBe(200);

    // 新路由 `/api/auth/me` 同源复核（username 必须是注册的那个）
    const me = await request("GET", "/api/auth/me", { token });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body?.data?.name).toBe(USER);
    expect(JSON.stringify(me.body)).not.toContain("passwordHash");
  }, 60000);

  /**
   * Phase 1c Task 11：**旧登录路径整体退役**的**真应用**证据。
   *
   * ⚠ 两个状态码是**刻意分开**的（任务书 §5 只写了"404"）：
   *   · 匿名 ⇒ **401**：`/api/*` 的 `authenticate` 在路由**之前**跑 ⇒ 未认证时"路径不存在"看不见；
   *   · 带有效令牌 ⇒ **404**：这才证明**路由真的没了**（不是"只是加了鉴权"）。
   */
  it("③b ★ 旧登录路径 `/api/login/login` 已退役（真应用）：匿名 ⇒ 401，带有效令牌 ⇒ 404", async () => {
    const login = await request("POST", "/api/auth/login", { body: { username: USER, password: PW } });
    const token = String(login.body?.data?.token ?? "");
    expect(token.startsWith("Bearer ")).toBe(true);

    const anon = await request("POST", "/api/login/login", { body: { username: USER, password: PW } });
    expect(anon.status, `匿名打已退役路径 ⇒ 401（鉴权先于路由），实际 ${anon.status}：${anon.raw.slice(0, 200)}`).toBe(401);

    const authed = await request("POST", "/api/login/login", { token, body: { username: USER, password: PW } });
    expect(authed.status, `带令牌打已退役路径 ⇒ 404（路由不存在），实际 ${authed.status}：${authed.raw.slice(0, 200)}`).toBe(404);
  }, 60000);

  it("④ 错口令 ⇒ 401（不泄露账号是否存在），响应体不带 token", async () => {    const res = await request("POST", "/api/auth/login", { body: { username: USER, password: "definitely-wrong" } });
    expect(res.status, `错口令必须 401：${res.raw.slice(0, 300)}`).toBe(401);
    expect(res.raw).not.toContain(USER);
    expect(res.body?.data ?? null).toBeNull();
  }, 60000);

  it("⑤ ★ 连错 5 次 ⇒ 第 6 次**即使口令正确**也被锁定（lockedUntil 在未来）", async () => {
    for (let i = 1; i <= 5; i += 1) {
      const r = await request("POST", "/api/auth/login", { body: { username: LOCK_USER, password: `wrong-${i}` } });
      expect(r.status, `第 ${i} 次错口令必须 401：${r.raw.slice(0, 200)}`).toBe(401);
    }
    const before = Date.now();
    const locked = await request("POST", "/api/auth/login", { body: { username: LOCK_USER, password: PW } });
    expect(locked.status, `锁定期内正确口令也必须 401：${locked.raw.slice(0, 300)}`).toBe(401);
    expect(String(locked.body?.message)).toContain("锁定");

    // 直读库（不是只看 API 返回）：failedCount 到阈值 + lockedUntil 在未来
    const db: Knex = createKnex(dbConfigOf(dataDir));
    try {
      const rec: any = await db("o_loginAttempt").whereLike("username", LOCK_USER).first();
      expect(Number(rec?.failedCount)).toBeGreaterThanOrEqual(5);
      expect(Number(rec?.lockedUntil)).toBeGreaterThan(before);
    } finally {
      await db.destroy();
    }
  }, 60000);

  it("⑥ refresh Cookie 续期：拿新 access 访问受保护路由（Cookie 是 HttpOnly，响应体里没有它）", async () => {
    const login = await request("POST", "/api/auth/login", { body: { username: USER, password: PW } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.setCookie.join(";")).toContain("HttpOnly");
    expect(login.setCookie.join(";")).toContain("Path=/api/auth");
    expect(login.setCookie.join(";")).toContain("SameSite=Lax");
    const cookie = String(login.setCookie.find((c) => c.startsWith("miwo_rt="))).split(";")[0];
    expect(login.raw).not.toContain(cookie.split("=")[1]);

    const refreshed = await request("POST", "/api/auth/refresh", { cookie });
    expect(refreshed.status, `refresh 必须 200：${refreshed.raw.slice(0, 300)}`).toBe(200);
    const token2 = String(refreshed.body?.data?.token ?? "");
    expect(token2.startsWith("Bearer ")).toBe(true);
    expect(token2).not.toBe(String(login.body?.data?.token));

    const res = await request("POST", "/api/project/getProject", { token: token2, body: {} });
    expect(res.status, `续期后的 access 必须可用：${res.raw.slice(0, 300)}`).toBe(200);
  }, 60000);

  it("⑦ 全程结束服务仍活着（没有因为认证链路的异常把进程带崩）", () => {
    expect(child?.exitCode, `子进程提前退出，输出尾部：\n${output.slice(-1200)}`).toBeNull();
    expect(output).not.toContain("TENANT_NO_CONTEXT");
  });
});
