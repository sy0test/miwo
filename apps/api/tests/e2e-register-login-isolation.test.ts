/**
 * Phase 1c / Task 12 —— "**新用户注册 → 登录 → 只用自己数据**" 的 **CI 口径**（不依赖本机脚本）。
 *
 * ── 为什么要有这个文件（而不是只靠 `verify-phase1c.cjs`）──
 *   brief 的 Step 3 原话：`verify-phase1c.cjs` 里"起进程 + 真 HTTP"的部分在 CI 里更贵，
 *   所以把**不依赖本机东西**的那几条做成 vitest，CI 每轮都跑到。本文件只补
 *   `tests/auth-http-e2e.test.ts`（注册/登录/me/refresh Cookie）与 `tests/authorization.test.ts`
 *   （收权矩阵）**没覆盖**的这三条：
 *     ① **跨租户的写路径**：B 按 id 改/删 A 的项目 —— 判据落在**库里那一行有没有变**上；
 *     ② **登出即吊销**：`tokenVersion++` 之后**旧 access 立即 401**；
 *     ③ **邀请码不可超发**（`maxUses=1` 用第二次必须失败）。
 *
 * ── 两条判据纪律（本文件存在的理由，都是被实测逼出来的）──
 *   · **不能用 HTTP 状态码判跨租户写**：`editProject` / `delProject` 两个 handler **无条件**
 *     `res.status(200).send(success(...))`（不看受影响行数）⇒ 守卫完全生效时它们**也是 200**。
 *     第一版把判据写成"不是 200"就红了，那是**假红**。所以这里**直读那个一次性库**判"行未变 / 行仍在"，
 *     并把 HTTP 状态一起打印出来当**已知行为**记录。
 *   · **空转护栏**：本文件所有"看不到 / 改不动"的断言，在"夹具没落库"时也会通过。
 *     所以 beforeAll 结尾**直读库**断言夹具与归属真的在（A 的项目 `userId === A.id`）。
 *
 * ⚠ 与 `auth-http-e2e.test.ts` 同一套装配：**真进程** `src/app.ts` + 一次性 `MIWO_DATA_DIR`
 *   + 空闲端口 + `MIWO_DB_DRIVER=sqlite` 钉死（**不碰** `apps/api/data/db2.sqlite`）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-isolation-write-"));
const CONFIG_SECRET = "isolation-write-config-secret-32-bytes!";
const USER_A = "iso-write-a";
const USER_B = "iso-write-b";
const PW = "pw-iso-write-123456";
const INVITE_A = "iso-write-invite-a";
const INVITE_B = "iso-write-invite-b";
const PROJ_NAME = "iso-write-project-A";
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

/** 直读那一次性的库（只读用途；写它的只有被测进程）。 */
async function withDb<T>(fn: (db: ReturnType<typeof createKnex>) => Promise<T>): Promise<T> {
  const db = createKnex(dbConfigOf(dataDir));
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** 登录拿 access（响应体里的形态带 `Bearer ` 前缀，与前端契约一致）。 */
async function login(username: string): Promise<string> {
  const res = await request("POST", "/api/auth/login", { body: { username, password: PW } });
  expect(res.status, `${username} 登录必须 200：${res.raw.slice(0, 200)}`).toBe(200);
  const token = String(res.body?.data?.token ?? "");
  expect(token.startsWith("Bearer "), `登录响应里的 token 必须带 Bearer 前缀：${token.slice(0, 40)}`).toBe(true);
  return token;
}

const PROJECT_BODY = {
  projectType: "iso-write",
  name: PROJ_NAME,
  intro: "跨租户写路径的夹具",
  type: "iso-write",
  artStyle: "",
  videoRatio: "16:9",
  imageModel: "",
  videoModel: "",
  imageQuality: "",
  mode: "",
};

let tokenA = "";
let tokenB = "";
let projectIdA = 0;
let userIdA = 0;

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

  // 夹具：两张邀请码（`INVITE_A` 的 maxUses=1 ⇒ "不可超发"那条有真实判别力）
  await withDb(async (db) => {
    const mode: any = await db("o_setting").where("key", "registrationMode").first();
    expect(mode?.value, `registrationMode 必须是 005 种下的 invite，实际 ${JSON.stringify(mode)}`).toBe("invite");
    await db("o_invite").insert([
      { code: INVITE_A, createdBy: 1, maxUses: 1, usedCount: 0, expiresAt: null, disabled: 0, createdAt: Date.now() },
      { code: INVITE_B, createdBy: 1, maxUses: 5, usedCount: 0, expiresAt: null, disabled: 0, createdAt: Date.now() },
    ]);
  });

  const regA = await request("POST", "/api/auth/register", { body: { username: USER_A, password: PW, inviteCode: INVITE_A } });
  expect(regA.status, `A 注册必须 200：${regA.raw.slice(0, 300)}`).toBe(200);
  const regB = await request("POST", "/api/auth/register", { body: { username: USER_B, password: PW, inviteCode: INVITE_B } });
  expect(regB.status, `B 注册必须 200：${regB.raw.slice(0, 300)}`).toBe(200);

  tokenA = await login(USER_A);
  tokenB = await login(USER_B);

  const meA = await request("GET", "/api/auth/me", { token: tokenA });
  expect(meA.status, `A 的 /api/auth/me 必须 200：${meA.raw.slice(0, 200)}`).toBe(200);
  userIdA = Number(meA.body?.data?.id);
  expect(userIdA, "前置：A 必须是一个真实的普通用户 id").toBeGreaterThan(0);

  const addA = await request("POST", "/api/project/addProject", { token: tokenA, body: PROJECT_BODY });
  expect(addA.status, `A 建项目必须 200：${addA.raw.slice(0, 300)}`).toBe(200);

  // ★ 空转护栏（直读库）：项目真的落库、且**守卫注入了归属**；A/B 真的是两个不同的 user id
  await withDb(async (db) => {
    const row: any = await db("o_project").where("name", PROJ_NAME).first();
    expect(row, "前置：A 的项目必须真的落库（否则后面『改不动』会假绿）").toBeTruthy();
    projectIdA = Number(row.id);
    expect(Number(row.userId), `前置：项目的 userId 必须是守卫注入的 A 的 id（实际 ${row.userId}）`).toBe(userIdA);

    const meB = await request("GET", "/api/auth/me", { token: tokenB });
    expect(meB.status).toBe(200);
    expect(Number(meB.body?.data?.id), "前置：A/B 必须是两个不同的用户").not.toBe(userIdA);
  });
}, 240000);

afterAll(async () => {
  await stopChild();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Phase 1c 端到端（CI 口径）：注册 / 只用自己数据 / 登出即吊销", () => {
  it("① ★ 邀请码不可超发：maxUses=1 的码用第二次必须失败（不是 200）", async () => {
    const again = await request("POST", "/api/auth/register", {
      body: { username: `${USER_A}-again`, password: PW, inviteCode: INVITE_A },
    });
    expect(again.status, `已用尽的邀请码必须失败：${again.raw.slice(0, 200)}`).not.toBe(200);
    expect([403, 409]).toContain(again.status);
  }, 60000);

  it("② ★ 跨租户**读**：B 的列表里没有 A 的项目，A 的列表里有（正向对照）", async () => {
    const listA = await request("POST", "/api/project/getProject", { token: tokenA, body: {} });
    const listB = await request("POST", "/api/project/getProject", { token: tokenB, body: {} });
    expect(listA.status, listA.raw.slice(0, 200)).toBe(200);
    expect(listB.status, listB.raw.slice(0, 200)).toBe(200);
    const idsA = (listA.body?.data ?? []).map((p: any) => Number(p.id));
    const idsB = (listB.body?.data ?? []).map((p: any) => Number(p.id));
    expect(idsA, "正向对照：A 必须看得见自己的项目").toContain(projectIdA);
    expect(idsB, "★ B 的列表里**不得**出现 A 的项目").not.toContain(projectIdA);
  }, 60000);

  it("③ ★ 跨租户**写**（按 id 直取，不走列表）：B 改不动 A 的项目 —— 判据是库里那一行逐字未变", async () => {
    const res = await request("POST", "/api/project/editProject", {
      token: tokenB,
      body: { ...PROJECT_BODY, id: projectIdA, name: "HACKED-BY-B" },
    });
    // ⚠ 状态码**不是**判据（handler 无条件 200）；这里只是把"已知行为"记下来，方便下一个人别再用它判隔离。
    const row: any = await withDb((db) => db("o_project").where("id", projectIdA).first());
    expect(row, "那一行必须还在").toBeTruthy();
    expect(String(row.name), `★ 守卫必须挡住跨租户写：name 实际 ${JSON.stringify(row.name)}（HTTP ${res.status}）`).toBe(PROJ_NAME);
    expect(Number(row.userId), "归属也不得被改").toBe(userIdA);
  }, 60000);

  it("④ ★ 跨租户**删**（按 id 直取）：B 删不掉 A 的项目 —— 那一行仍在", async () => {
    const res = await request("POST", "/api/project/delProject", { token: tokenB, body: { id: projectIdA } });
    const row: any = await withDb((db) => db("o_project").where("id", projectIdA).first());
    expect(row, `★ 守卫必须挡住跨租户删（HTTP ${res.status}）—— 那一行仍在`).toBeTruthy();
    expect(Number(row.id)).toBe(projectIdA);
  }, 60000);

  it("⑤ ★ 登出即吊销：`tokenVersion++` 之后**旧 access 立即 401**，且该账号所有设备一起失效", async () => {
    // 同一账号开两个"设备"（两次登录 = 两把独立 access，`tokenVersion` 相同）
    const dev1 = await login(USER_B);
    const dev2 = await login(USER_B);
    expect((await request("GET", "/api/auth/me", { token: dev2 })).status, "前置：第二把 access 必须可用").toBe(200);

    // 直读库拿"登出前的 tokenVersion"——这是"401 是因为 tv 被 ++ 了"的**机械证据**，
    // 而不是"反正它 401 了"（后者在"令牌本来就坏"时也会通过）。
    const before: any = await withDb((db) => db("o_user").where("username", USER_B).first());
    const tvBefore = Number(before?.tokenVersion);

    const out = await request("POST", "/api/auth/logout", { token: dev1 });
    expect(out.status, `登出必须 200：${out.raw.slice(0, 200)}`).toBe(200);

    const afterRow: any = await withDb((db) => db("o_user").where("username", USER_B).first());
    expect(
      Number(afterRow?.tokenVersion),
      `★ 登出必须把 tokenVersion ++ （登出前 ${tvBefore}，登出后 ${afterRow?.tokenVersion}）`,
    ).toBe(tvBefore + 1);

    const after1 = await request("GET", "/api/auth/me", { token: dev1 });
    const after2 = await request("GET", "/api/auth/me", { token: dev2 });
    expect(after1.status, "★ 登出设备自己的旧 access 必须立即 401").toBe(401);
    expect(after2.status, "★ **另一台设备**的 access 也必须立即 401（tokenVersion 是账号级的）").toBe(401);

    // 重新登录还能进（吊销不是"把账号锁死"）
    const fresh = await login(USER_B);
    expect((await request("GET", "/api/auth/me", { token: fresh })).status, "重新登录必须恢复正常").toBe(200);
    tokenB = fresh;
  }, 120000);

  it("⑥ 收尾：服务仍活着（认证链路没把进程带崩）", () => {
    expect(child?.exitCode, `应用不该退出；输出尾部：\n${output.slice(-800)}`).toBeNull();
  });
});
