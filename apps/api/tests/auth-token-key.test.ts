/**
 * JWT key priority: DB row `o_setting.tokenKey` first, config `MIWO_JWT_SECRET` as fallback.
 * (Phase 1a / Task 5, regression net added by the Task 5 review fix round.)
 *
 * Why this file spawns the REAL server (tsx src/app.ts) instead of importing app.ts:
 *   - importing app.ts in-process would start addon side effects (it calls startServe() at module
 *     load) and banish a failed db boot to `process.exit(1)`, killing the whole vitest worker;
 *   - the thing under test is the middleware TEXT in src/app.ts plus the real `o_setting` read,
 *     so the highest-fidelity evidence is: real process, real sqlite file, real HTTP.
 * Evidence shape per case:
 *   1. boot with MIWO_DATA_DIR = fresh temp dir (migrations 001 + 002 run on boot),
 *   2. insert the DB tokenKey row through a SEPARATE knex connection (writes a real row),
 *   3. ask the SAME live server to verify a token - jwt.verify is stateless and tokenKey is read
 *      per request, so no restart is needed for the assertion to be meaningful,
 *   4. a WRONG key must be rejected before a right key is accepted: otherwise a 200 could come
 *      from some whitelist/bypass and the case would pass vacuously.
 *
 * Cases:
 *   (R1) DB has no tokenKey -> a token signed with MIWO_JWT_SECRET is accepted (the fallback side
 *        that verify-phase0 only proves indirectly, through "the app boots and answers 200").
 *   (R2) DB has a tokenKey -> it wins: a token signed with THAT value is accepted, and a token
 *        signed with MIWO_JWT_SECRET is rejected. This is the side NOT covered before this file.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import jwt from "jsonwebtoken";
import type { Knex } from "knex";
import { afterAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-auth-token-key-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Arbitrary but >= 32 bytes: config.ts fail-fast rejects anything shorter. */
const CONFIG_SECRET = "auth-priority-test-config-secret-32b!!";
const DB_SECRET = "auth-priority-test-db-token-key-32bytes";

const READY_TIMEOUT_MS = 90000;
const CAPTURE_TAIL = 1200;

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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTTP GET returning status + body; a connection error is reported as status 0. */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
}

/**
 * Kill the spawned server and its process tree. On Windows `child.kill()` only signals the one
 * process, and the tsx loader runs the app in that same process, but a tree kill is the safe
 * habit (and matches scripts/verify-phase0.cjs).
 */
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

interface Server {
  child: ChildProcess;
  port: number;
  dataDir: string;
  output(): string;
}

/**
 * Boot the real app on a fresh, empty data dir (the app runs migrations itself) and wait until
 * `configHealth?summary=1` answers 200. Throws with the captured output when it never gets there.
 */
async function startServer(): Promise<Server> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(TMP, "boot-"));
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      MIWO_ENV: "dev",
      MIWO_PORT: String(port),
      MIWO_HOST: "127.0.0.1",
      MIWO_DATA_DIR: dataDir,
      MIWO_JWT_SECRET: CONFIG_SECRET,
      NODE_OPTIONS: "--import=tsx",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (out += d.toString()));

  const healthUrl = `http://127.0.0.1:${port}/api/other/configHealth?summary=1`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(500);
    if (child.exitCode !== null || child.signalCode !== null) break;
    const res = await get(healthUrl);
    if (res.status === 200) return { child, port, dataDir, output: () => out };
  }
  await stopChild(child);
  throw new Error(`app never became ready on port ${port}. Output tail:\n${out.slice(-CAPTURE_TAIL)}`);
}

/** A knex handle on the temp data dir (same file the live server reads per request). */
function openDb(dataDir: string, tag: string): Knex {
  return createKnex({
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir,
    mediaDir: path.join(dataDir, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: CONFIG_SECRET,
    // ⚠ 必须是 config.ts 的默认库名 db2.sqlite：应用子进程用的就是 MIWO_DATA_DIR/db2.sqlite，
    //    换成别的名字会连到一个**刚被 better-sqlite3 创建出来的空库**，"no such table: o_setting"
    //    （第一版就踩了这个，用例红得毫无信息量）。
    db: { driver: "sqlite", file: path.join(dataDir, "db2.sqlite") },
  } as MiwoConfig);
}

/** Sign a token the way routes/login/login.ts does (HS256, 180 days). */
function sign(secret: string): string {
  return (jwt.sign as any)({ id: 1, name: "auth-priority-test" }, secret, { expiresIn: "180Days" });
}

/** A protected, non-whitelisted route: no token -> 401, valid token -> reaches the handler. */
const GUARDED = "/api/project/getProject";

describe("JWT 密钥优先级（库里 tokenKey 优先，配置兜底）", () => {
  it("R1：库里没有 tokenKey 时，用 MIWO_JWT_SECRET 签的 token 能过校验", async () => {
    const srv = await startServer();
    try {
      const db = openDb(srv.dataDir, "r1");
      try {
        // 前置：确认库里确实没有 tokenKey（这正是 002_platform_seed 之后新库的预期状态）
        expect(await db("o_setting").where("key", "tokenKey").first()).toBeUndefined();
      } finally {
        await db.destroy();
      }

      const base = `http://127.0.0.1:${srv.port}`;
      // 判别力前置：错密钥必须被拒（否则下面的 200 可能是"白名单放行"造成的恒真）
      const wrong = await get(`${base}${GUARDED}?token=${sign("definitely-not-the-key-".repeat(2))}`);
      expect(wrong.status, `错密钥不应通过：${wrong.body.slice(0, 120)}`).toBe(401);

      const ok = await get(`${base}${GUARDED}?token=${sign(CONFIG_SECRET)}`);
      expect(ok.status, `配置兜底的密钥应通过：${ok.body.slice(0, 200)}`).not.toBe(401);
      expect(ok.status).not.toBe(444);
    } finally {
      await stopChild(srv.child);
    }
  }, 180000);

  it("R2：库里有 tokenKey 时用库值签发/校验，配置密钥签的 token 被拒", async () => {
    const srv = await startServer();
    try {
      const db = openDb(srv.dataDir, "r2");
      try {
        // 写入"库里的密钥"行（这就是老库的形态）—— 无需重启：中间件每个请求都现读这一行。
        await db("o_setting").insert({ key: "tokenKey", value: DB_SECRET });
        expect((await db("o_setting").where("key", "tokenKey").first()).value).toBe(DB_SECRET);
      } finally {
        await db.destroy();
      }

      const base = `http://127.0.0.1:${srv.port}`;
      // 判别力前置：配置密钥现在必须**不**再被接受（证明库里那行真的接管了密钥）
      const configSigned = await get(`${base}${GUARDED}?token=${sign(CONFIG_SECRET)}`);
      expect(configSigned.status, `库里 tokenKey 存在时不应再用配置密钥：${configSigned.body.slice(0, 120)}`).toBe(401);

      const dbSigned = await get(`${base}${GUARDED}?token=${sign(DB_SECRET)}`);
      expect(dbSigned.status, `库里的 tokenKey 应通过：${dbSigned.body.slice(0, 200)}`).not.toBe(401);
      expect(dbSigned.status).not.toBe(444);
    } finally {
      await stopChild(srv.child);
    }
  }, 180000);
});
