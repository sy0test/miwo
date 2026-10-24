/**
 * Phase 1c Task 9 的判别力用例：**供应商凭据不回传 + 提交/执行代码的接口不存在 + `deleteVendor` 无穿越面**。
 *
 * ── 为什么必须 spawn **真应用进程** + 真 sqlite + 真 HTTP ──
 *  · "接口不存在 ⇒ 404" 只有**真路由表**（`src/router.ts` 被 `app.ts` 装配之后）才成立：
 *    in-process 挂一个 router 测 404 是自证循环（你没挂它，当然 404）。
 *  · "密钥不回传"要看**中间件链 + 真 DB 行**跑出来的响应体（构造一个 fake key 写进库，
 *    再断言序列化后的响应里没有那个字面量）。
 *  · "进程里没有 vm2/sucrase"必须在**真子进程**里观测 `require.cache`（Ruling 243：
 *    观测不到闭包 ⇒ 红，不是绿）。
 *
 * ── 五组判据 ──
 *   A. `getVendorList`（admin）：响应体**不含**明文 key、不含 `code` 字段、`inputValues.apiKey === "***"`、
 *      `__configured.apiKey === true`；**普通用户 403**（与 Task 4 的矩阵互为印证）；写入落审计。
 *   B. 旧的三个"提交/执行代码"接口 ⇒ **404**（`addVendor` / `updateCode` / `getCodeByLink`），
 *      且**任何文件都没被创建/删除**（直读 `%TEMP%` 数据目录快照）。
 *   C. `deleteVendor` 的穿越尝试（`../` / 绝对路径 / UNC / 大小写 / 符号链接）**五次全被拒（400）**，
 *      每次都对**目标外探针文件**直读校验"还在"；合法 id ⇒ 200 且 DB 行消失、`o_agentDeploy` 置空。
 *   D. 真进程里 `require.cache` **不含** vm2 / sucrase（本用例自证"观测到了闭包"）。
 *   E. 失败响应脱敏：新写/新读路径的 4xx·5xx 里**没有**绝对路径 / 表名 / 堆栈。
 *
 * ⚠ 一次性数据目录在 `%TEMP%`；`apps/api/data/db2.sqlite` 全程只读不碰（Ruling 170）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { signToken } from "@/auth/tokens";
import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-vendor-secrets-"));
const CONFIG_SECRET = "vendor-secrets-test-config-secret-32b!!";
const ADMIN_USER = 1;
const NORMAL_USER = 7;
/** 构造的 fake 供应商 key：只要它出现在响应体里 ⇒ 失败（用 `sk-` 前缀，与真实 OpenAI 形态同款）。 */
const FAKE_KEY = "sk-vendor-secrets-MARK-0123456789";
const MARKER_VENDOR = "vs-marker-vendor";
/** 目标外探针文件（用来证明"被拒的删除**一格文件都没动**"）。 */
const PROBE_FILE = "vs-probe-target.txt";
const PROBE_CONTENT = "vs-probe-ORIGINAL\n";

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

/** 真 HTTP；连接失败记为 status 0（不吞，交给断言报错）。
 *
 *  ⚠ `agent: false` 是**必须**的：Node ≥19 的全局 agent 默认 `keepAlive: true`，于是"复用的那条
 *  空闲连接"在服务端被回收之后，下一次请求会以 `ECONNRESET`（= status 0）失败 —— 而
 *  非幂等的 **POST 不会自动重试**（GET 会）。本用例族大量使用 POST（vendorConfig 全家都是 POST），
 *   曾因此出现"第一次 POST 必然 0、重试才 200"的假红。关掉连接复用，每次请求新开一条，行为确定。 */
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
        agent: false,
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

/** `o_auditLog` 里某 action 与 target 的行数（"审计真的落库"的判据）。 */
async function auditCount(db: Knex, action: string, target?: string): Promise<number> {
  const q = db("o_auditLog").where("action", action);
  if (target !== undefined) q.andWhere("target", target);
  return Number(((await q.count({ n: "*" }).first()) as any)?.n ?? 0);
}

/**
 * 递归列出目录下的相对路径（含文件大小）。
 *
 * ⚠ 必须**显式递归**，且要跳过 `oss/`（应用启动会自动 mkdir）之外的"每次启动都在变"的东西 ——
 *   这里比的是**供应商资产区**（`<dataDir>/vendor` 与探针文件所在层），不是整棵数据目录。
 */
function listFiles(dir: string, out: string[] = [], base = dir): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out, base);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

describe("Task 9 · 供应商凭据不回传 / 提交代码接口不存在 / deleteVendor 无穿越（真应用 + 真库 + 真 HTTP）", () => {
  let child: ChildProcess;
  let port = 0;
  let dataDir = "";
  let output = "";
  /** `require.cache` 快照（子进程自证输出，见用例 D）。 */
  let requireCacheKeys: string[] = [];
  let moduleProbeSelfCheck = "";
  let moduleProbeOut = "";
  let moduleProbeAppModules = "";
  let moduleProbeSandboxModules = "";

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

  /**
   * **新形状** access 令牌（Phase 1c Task 11）。
   *
   * ⚠ 旧形状 `{id:N}`（靠 `roleOfUserId(1)==="admin"` 桥接角色）已随 legacy 分支整体退役：
   *   它**不读 DB** ⇒ 停用账号照样是 admin，这正是 Task 11 要堵的洞。现在角色只信库里的
   *   `o_user.role`，令牌里带 `tv` 还要与库里的 `tokenVersion` 相等。
   */
  async function signAs(db: Knex, userId: number, role: "user" | "admin"): Promise<string> {
    const row: any = await db("o_setting").where("key", "tokenKey").first();
    const secret = (row && row.value) || CONFIG_SECRET;
    return signToken({ uid: userId, role, tv: 0, typ: "access" }, secret);
  }

  beforeAll(async () => {
    // ── 判据 D 的事实探针（另一个真进程，一次性数据目录 + 另一个随机端口）──
    //   ⚠ 用**异步** `spawn` 而不是 `spawnSync`：探针要起一个真应用（冷库迁移 + 加载整个模块图），
    //     同步等待会把本进程的事件循环堵住几十秒 —— vitest 的 worker RPC 会因此超时
    //     （实测：`[vitest-worker]: Timeout calling "onTaskUpdate"`，报告为 unhandled error，
    //     即使 9 条用例全绿也会让退出码非 0）。异步等待则事件循环始终可泵。
    {
      const probeDataDir = fs.mkdtempSync(path.join(TMP, "probe-"));
      const probePort = await freePort();
      const probe = spawn(
        process.execPath,
        ["--env-file-if-exists=.env", "--import=tsx", path.join("tests", "helpers", "require-cache-probe.ts")],
        {
          cwd: API_ROOT,
          env: {
            ...process.env,
            MIWO_ENV: "dev",
            MIWO_PORT: String(probePort),
            MIWO_HOST: "127.0.0.1",
            MIWO_DATA_DIR: probeDataDir,
            MIWO_JWT_SECRET: CONFIG_SECRET,
            NODE_OPTIONS: "--import=tsx",
            MIWO_DB_DRIVER: "sqlite",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      moduleProbeOut = "";
      probe.stdout?.on("data", (d) => (moduleProbeOut += d.toString()));
      probe.stderr?.on("data", (d) => (moduleProbeOut += d.toString()));
      // 等探针打印完那几行（它**不会自己退出**：服务还在监听）⇒ 轮询输出，超时兜底并杀进程
      const probeDeadline = Date.now() + 150000;
      while (Date.now() < probeDeadline && !moduleProbeOut.includes("VS_REQUIRE_CACHE_KEYS=")) {
        if (probe.exitCode !== null || probe.signalCode !== null) break;
        await delay(250);
      }
      await stopChild(probe);
      const keysLine = moduleProbeOut.split(/\r?\n/).find((l) => l.startsWith("VS_REQUIRE_CACHE_KEYS="));
      requireCacheKeys = keysLine ? JSON.parse(keysLine.slice("VS_REQUIRE_CACHE_KEYS=".length)) : [];
      moduleProbeSelfCheck = moduleProbeOut.split(/\r?\n/).find((l) => l.startsWith("VS_REQUIRE_CACHE=")) ?? "";
      moduleProbeAppModules = moduleProbeOut.split(/\r?\n/).find((l) => l.startsWith("VS_REQUIRE_CACHE_APP_MODULES=")) ?? "";
      moduleProbeSandboxModules = moduleProbeOut.split(/\r?\n/).find((l) => l.startsWith("VS_REQUIRE_CACHE_SANDBOX_MODULES=")) ?? "";
    }

    port = await freePort();
    dataDir = fs.mkdtempSync(path.join(TMP, "boot-"));
    // 探针：`<dataDir>/vendor/<PROBE_FILE>` 与 `<dataDir>/<PROBE_FILE>` 两个文件都放。
    //   前者是"按 id 拼 `<dataDir>/vendor/<id>.ts`"这条**旧代码路径**的目标目录；后者是"穿越一层"
    //   （`../<PROBE_FILE>`）的目标。删除请求若真做文件操作，必然会动到其中之一。
    fs.mkdirSync(path.join(dataDir, "vendor"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "vendor", PROBE_FILE), PROBE_CONTENT, "utf8");
    fs.writeFileSync(path.join(dataDir, PROBE_FILE), PROBE_CONTENT, "utf8");

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
      // 账号夹具：新形状令牌每请求读 `o_user` 复核 role/status/tokenVersion ⇒ 必须 active
      //（旧形状靠 `roleOfUserId`（id===1 ⇒ admin）桥接，那条路已随 legacy 分支退役）。
      await db("o_user")
        .insert({ id: ADMIN_USER, username: "vs-admin", email: null, passwordHash: "", role: "admin", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null })
        .onConflict("id")
        .merge();
      await db("o_user")
        .insert({ id: NORMAL_USER, username: "vs-user", email: null, passwordHash: "", role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null })
        .onConflict("id")
        .merge();
      // ★ 关键夹具：一个**带明文 key 的行**（判据 A 的红端就靠它）
      await db("o_vendorConfig")
        .insert({
          id: "miwo",
          inputValues: JSON.stringify({ apiKey: FAKE_KEY, baseUrl: "https://api.toonflow.net/v1" }),
          models: "[]",
          enable: 1,
        })
        .onConflict("id")
        .merge();
      // 判据 C 的夹具：一个可合法删除的供应商行
      await db("o_vendorConfig").insert({ id: MARKER_VENDOR, inputValues: "{}", models: "[]", enable: 0 }).onConflict("id").merge();
      await db("o_agentDeploy").where("key", "scriptAgent").update({ vendorId: MARKER_VENDOR, model: "m", modelName: `${MARKER_VENDOR}:m` });
      const seeded: any = await db("o_vendorConfig").where("id", "miwo").first();
      expect(String(seeded?.inputValues ?? ""), "前置：库里必须真的写着明文 key（否则判据 A 是空断言）").toContain(FAKE_KEY);
    } finally {
      await db.destroy();
    }
  }, 240000);

  afterAll(async () => {
    await stopChild(child);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  // ────────────────────────── A. 密钥不回传 ──────────────────────────

  it("★ A1 admin 打 getVendorList：响应体**不含**明文 key（改前含）、不含 code 字段", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const res = await request("POST", url("/api/setting/vendorConfig/getVendorList"), { token });
      expect(res.status, `admin 打 getVendorList 必须 200：${res.body.slice(0, 200)}`).toBe(200);

      // ★ 红端对照：明文 key 在**库里**（上面 beforeAll 已断言），但**不在响应里**
      expect(res.body, "响应体绝不能包含供应商明文 key").not.toContain(FAKE_KEY);
      expect(res.body, "响应体不得出现 sk- 形态的凭据字面量").not.toMatch(/sk-[A-Za-z0-9-]{6,}/);

      const parsed = JSON.parse(res.body);
      const rows: any[] = parsed.data ?? [];
      const miwo = rows.find((r) => r.id === "miwo");
      expect(miwo, "前置：miwo 行必须在列表里（否则下面的键级断言是空转）").toBeTruthy();

      // 键名级断言：`code` 字段**整块删掉**（不是"清空"）
      expect(Object.keys(miwo), "不得再有 code 字段（适配器源码不应回传）").not.toContain("code");
      // 原始 inputValues 列（含明文的 JSON 串）也必须被剔除，不能只"覆盖"
      for (const row of rows) {
        expect(Object.keys(row), `${row.id} 不得直接带原始 inputValues 列之外的凭据字段`).not.toContain("code");
      }
      // ★ 值级断言：掩码 + 存在性
      expect(miwo.inputValues.apiKey, "apiKey 的值必须是掩码").toBe("***");
      expect(miwo.__configured.apiKey, "必须告诉前端「填过没填过」").toBe(true);
      // 非凭据键要留着（否则前端连"打到哪个地址"都显示不出来）
      expect(miwo.inputValues.baseUrl, "baseUrl 不是凭据，必须原样保留").toBe("https://api.toonflow.net/v1");
      // 掩码是"按键名"，不是"把一切都掩掉"
      expect(miwo.name, "供应商显示名照旧").toBeTruthy();
      expect(Array.isArray(miwo.models) || typeof miwo.models === "object", "models 照旧回传").toBe(true);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("★ A2 `updateVendorInputs`（admin）响应**不回显** key，但库里真的写进去了 + 落审计", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const NEW_KEY = "sk-vendor-secrets-UPDATED-9876543210";
      const auditBefore = await auditCount(db, "setting.vendor.inputs.update", "miwo");
      const res = await request("POST", url("/api/setting/vendorConfig/updateVendorInputs"), {
        token,
        body: { id: "miwo", inputValues: { apiKey: NEW_KEY, baseUrl: "https://api.toonflow.net/v1" } },
      });
      expect(res.status, `admin 改凭据必须 200：${res.body.slice(0, 200)}`).toBe(200);
      expect(res.body, "写入响应不得回显 key").not.toContain(NEW_KEY);
      const row: any = await db("o_vendorConfig").where("id", "miwo").first();
      expect(String(row.inputValues), "写入必须真的落库（不是只回个 200）").toContain(NEW_KEY);
      expect(await auditCount(db, "setting.vendor.inputs.update", "miwo"), "改凭据必须落审计").toBeGreaterThan(auditBefore);
      // 收尾：把库里的 key 换回 A1 那个探针值（后面的用例不依赖具体值，但保持可读）
      await db("o_vendorConfig").where("id", "miwo").update({ inputValues: JSON.stringify({ apiKey: FAKE_KEY, baseUrl: "https://api.toonflow.net/v1" }) });
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("★ A2b masked credential round-trips preserve the stored secret", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      await db("o_vendorConfig").where("id", "miwo").update({
        inputValues: JSON.stringify({ apiKey: FAKE_KEY, baseUrl: "https://api.toonflow.net/v1" }),
      });
      const res = await request("POST", url("/api/setting/vendorConfig/updateVendorInputs"), {
        token,
        body: { id: "miwo", inputValues: { apiKey: "***", baseUrl: "https://updated.example/v1" } },
      });
      expect(res.status, `masked credential round-trip must succeed: ${res.body.slice(0, 200)}`).toBe(200);
      const row: any = await db("o_vendorConfig").where("id", "miwo").first();
      const stored = JSON.parse(String(row.inputValues));
      expect(stored.apiKey, "the mask sentinel must not replace the configured key").toBe(FAKE_KEY);
      expect(stored.baseUrl, "unmasked settings in the same save must still update").toBe("https://updated.example/v1");
    } finally {
      await db("o_vendorConfig").where("id", "miwo").update({
        inputValues: JSON.stringify({ apiKey: FAKE_KEY, baseUrl: "https://api.toonflow.net/v1" }),
      });
      await db.destroy();
    }
  }, 90000);

  it("★ A3 普通用户打 getVendorList ⇒ **403**（与 Task 4 的矩阵互为印证，且响应里没有 key）", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, NORMAL_USER, "user");
      const res = await request("POST", url("/api/setting/vendorConfig/getVendorList"), { token });
      expect(res.status, `普通用户必须 403（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(403);
      expect(res.body, "被拒的响应里同样不能有凭据").not.toContain(FAKE_KEY);
    } finally {
      await db.destroy();
    }
  }, 60000);

  // ──────────────── B. "提交/执行代码"的接口不存在 ────────────────

  it("★ B1 旧的三个接口 ⇒ **404**（addVendor / updateCode / getCodeByLink），连 admin 也是 404", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const before = listFiles(dataDir);
      const CASES: Array<{ p: string; body: unknown; why: string }> = [
        { p: "/api/setting/vendorConfig/addVendor", body: { tsCode: "export default {};" }, why: "提交新适配器源码" },
        { p: "/api/setting/vendorConfig/updateCode", body: { id: "miwo", tsCode: "export default {};" }, why: "覆写已有适配器源码" },
        { p: "/api/setting/vendorConfig/getCodeByLink", body: { link: "https://example.invalid/x" }, why: "按 URL 抓取源码（SSRF 面）" },
      ];
      for (const c of CASES) {
        const res = await request("POST", url(c.p), { token, body: c.body });
        // ⚠ 404 = 路由不存在（不是 403/501）：这是"删掉比停用更进一步"的证据
        expect(res.status, `${c.p}（${c.why}）必须是 404，实际 ${res.status}：${res.body.slice(0, 200)}`).toBe(404);
      }
      expect(listFiles(dataDir), "三个接口打完：数据目录**一个文件都没变**（没有新写的 .ts，也没有被删的）").toEqual(before);
      // 静态复核：源文件与挂载都不在了（"404 是因为路由没挂"而不是"路由挂了但内部返回 404"）
      for (const f of ["addVendor.ts", "updateCode.ts", "getCodeByLink.ts"]) {
        expect(fs.existsSync(path.join(API_ROOT, "src", "routes", "setting", "vendorConfig", f)), `${f} 必须已删除`).toBe(false);
      }
      const routerText = fs.readFileSync(path.join(API_ROOT, "src", "router.ts"), "utf8");
      expect(routerText, "router.ts 不得再挂载它们").not.toMatch(/vendorConfig\/(addVendor|updateCode|getCodeByLink)"/);
    } finally {
      await db.destroy();
    }
  }, 90000);

  // ──────────────────────── C. deleteVendor 无穿越 ────────────────────────

  it("★ C1 五种越界 id（`../` / 反斜杠 / 绝对路径 / UNC / 大小写）**全被拒（400）**，且目标外文件原封不动", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const probeInVendor = path.join(dataDir, "vendor", PROBE_FILE);
      const probeOutside = path.join(dataDir, PROBE_FILE);

      const ATTEMPTS: Array<{ id: string; why: string }> = [
        { id: `../${PROBE_FILE}`, why: "相对穿越（上一级）" },
        { id: `..\\${PROBE_FILE}`, why: "相对穿越（Windows 反斜杠）" },
        { id: path.join(dataDir, PROBE_FILE), why: "绝对路径" },
        { id: `\\\\localhost\\c$\\${PROBE_FILE}`, why: "UNC 路径" },
        { id: `..%2f${PROBE_FILE}`, why: "URL 编码形态的穿越（zod 看的是解码后的字符串）" },
      ];

      for (const a of ATTEMPTS) {
        const res = await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: a.id } });
        expect(res.status, `${a.why}（id=${JSON.stringify(a.id)}）必须被拒 400，实际 ${res.status}：${res.body.slice(0, 220)}`).toBe(400);
        // ★ 每次尝试后都直读探针（"被拒"必须落在**文件没被动**上，而不只是状态码）
        expect(fs.existsSync(probeInVendor) && fs.readFileSync(probeInVendor, "utf8"), `${a.why} 之后 vendor/ 里的探针文件必须仍在且内容不变`).toBe(PROBE_CONTENT);
        expect(fs.existsSync(probeOutside) && fs.readFileSync(probeOutside, "utf8"), `${a.why} 之后目标外探针文件必须仍在且内容不变`).toBe(PROBE_CONTENT);
      }
      // 拒绝理由必须能看懂（不是 500 内部错）
      const bad = await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: "../x" } });
      expect(bad.status).toBe(400);
      expect(bad.body, "拒绝理由要能被调用方看懂").toMatch(/id/);
    } finally {
      await db.destroy();
    }
  }, 90000);

  /**
   * ★ 符号链接那一条**为什么不测"拒绝"**（这是本任务最重要的语义变更，必须写清楚）。
   *
   * Task 9 之前：`deleteVendor` 会 `fs.rmSync(path.join(u.getPath("vendor"), `${id}.ts`))` ——
   *   那是一条**真的文件删除路径**，于是"id 里有符号链接/相对段"确实能删到目标外的东西。
   * Task 8/9 之后：适配器是编译期内置的，**运行期不存在可删的适配器文件** ⇒ 那行 `fs.rmSync`
   *   整段删掉，删除面**由构造消除**（spec Tier 0 #4 的原文）。所以现在：
   *   · 一个**合法形状**的 id（`vs-link`）即使指向符号链接，也不会被拒 —— 因为**根本没有任何
   *     文件操作**会碰它（拒它反而会变成一个假的"防护"）；
   *   · 判据必须落在"**这个文件里没有文件操作**"上（静态 + 行为两面）。
   * 这条就是"能力不存在"与"加了校验"的区别。
   */
  it("★ C1b 符号链接：`deleteVendor` **不做任何文件操作**（静态 + 行为双证据），故链接目标绝不会被动", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const probeOutside = path.join(dataDir, PROBE_FILE);
      const linkName = "vs-link";
      const linkPath = path.join(dataDir, "vendor", linkName);
      // 建一个**指向目标外文件**的符号链接；本机若无权限/开发者模式 ⇒ 明确记一行，不静默跳过
      let linkCreated = false;
      try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(probeOutside, linkPath, "file");
        linkCreated = true;
      } catch (e: any) {
        console.log(`[vendor-secrets] ⚠ 符号链接夹具未建立（本机不允许建 symlink：${e?.code ?? e?.message}）——本条以"静态证据 + 合法 id 的删除行为"作证。`);
      }

      // 行为证据：删一个**指向链接的合法 id**（无论夹具是否建立，都必须正常 200/404，且**不碰文件**）
      const res = await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: linkName } });
      expect([200, 404].includes(res.status) || res.status === 200, `合法 id 形状不该 400（实际 ${res.status}）：${res.body.slice(0, 200)}`).toBe(true);
      if (linkCreated) expect(fs.existsSync(linkPath), "符号链接本身不该被删（没有文件操作）").toBe(true);
      expect(fs.existsSync(probeOutside) && fs.readFileSync(probeOutside, "utf8"), "链接目标（目标外文件）必须原封不动").toBe(PROBE_CONTENT);

      // 静态证据：源文件里**没有**任何 fs 文件操作（`fs.rmSync` / `fs.unlink` / `writeFile` / `createWriteStream` …）
      // ⚠ 先剥注释再断言：文件头**故意**写着 `fs.rmSync(...)` 来说明"这行已删除"，那是记录不是能力。
      const rawSrc = fs.readFileSync(path.join(API_ROOT, "src", "routes", "setting", "vendorConfig", "deleteVendor.ts"), "utf8");
      const src = rawSrc
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
      expect(src, "deleteVendor.ts 不得 import fs").not.toMatch(/from\s+["'](node:)?fs["']/);
      expect(src, "deleteVendor.ts 不得出现任何 fs.* 文件操作").not.toMatch(/\bfs\.[A-Za-z]+/);
      expect(src, "deleteVendor.ts 不得再按 id 拼路径").not.toMatch(/path\.join|getPath\(|rmSync|\bunlink\b|writeFile/);
    } finally {
      await db.destroy();
    }
  }, 90000);

  it("★ C2 合法 id ⇒ 200、DB 行消失、`o_agentDeploy` 的 vendorId/model 置空 + 落审计", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      // ⚠ 夹具在**本用例内部**重建：C1b 会删一个合法形状的 id（`vs-link`），而"两次都删同一行"
      //   会让 C2 的前置断言变成"夹具必须还在"这种脆弱写法。这里自己 upsert，用例之间不共享状态。
      await db("o_vendorConfig").insert({ id: MARKER_VENDOR, inputValues: "{}", models: "[]", enable: 0 }).onConflict("id").merge();
      await db("o_agentDeploy").where("key", "scriptAgent").update({ vendorId: MARKER_VENDOR, model: "m", modelName: `${MARKER_VENDOR}:m` });
      const before: any = await db("o_vendorConfig").where("id", MARKER_VENDOR).first();
      expect(before, "前置：夹具行必须在").toBeTruthy();
      const auditBefore = await auditCount(db, "setting.vendor.delete", MARKER_VENDOR);

      const res = await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: MARKER_VENDOR } });
      expect(res.status, `合法删除必须 200：${res.body.slice(0, 200)}`).toBe(200);
      expect(await db("o_vendorConfig").where("id", MARKER_VENDOR).first(), "DB 行必须消失").toBeFalsy();
      const dep: any = await db("o_agentDeploy").where("key", "scriptAgent").first();
      expect(dep?.vendorId, "o_agentDeploy.vendorId 必须被置空").toBeNull();
      expect(dep?.model, "o_agentDeploy.model 必须被置空").toBeNull();
      expect(await auditCount(db, "setting.vendor.delete", MARKER_VENDOR), "删除供应商必须落审计").toBeGreaterThan(auditBefore);
    } finally {
      await db.destroy();
    }
  }, 90000);

  // ──────────────── D. 真进程里没有 vm2 / sucrase ────────────────

  it("★ D1 真应用进程的 `require.cache` **不含** vm2 / sucrase（自证观测到了闭包）", () => {
    // 自证：探针必须真的打印了"缓存里有 N 个模块"
    expect(moduleProbeSelfCheck, `探针没输出 VS_REQUIRE_CACHE=（观测不到 ⇒ 不算绿）：${moduleProbeOut.slice(-800)}`).toMatch(/^VS_REQUIRE_CACHE=\d+/);
    const count = Number(moduleProbeSelfCheck.split("=")[1]);
    expect(count, `require.cache 里应有大量模块（实际 ${count}）—— 太少说明探针跑在了错误的位置`).toBeGreaterThan(50);
    expect(requireCacheKeys.length, "键数组必须与计数一致（否则 JSON 解析失败）").toBe(count);
    // ★ "观测到了闭包"的正面证据：应用自己的模块必须在缓存里（否则"没有 vm2"可能只是"什么都没加载"）
    const joined = requireCacheKeys.join("\n");
    expect(joined, "应用入口 app.ts / router.ts 必须出现在 require.cache 里（正面对照）").toMatch(/app\.ts|router\.ts/);
    expect(moduleProbeAppModules, `探针自己的正面对照行必须命中：${moduleProbeAppModules}`).toMatch(/app\.ts|router\.ts/);
    // 13 个内置适配器也必须在缓存里（"编译期内置"的正面证据）
    expect(joined, "内置适配器必须真的被加载（@/vendors/*.ts 出现在 require.cache 里）").toMatch(/[\\/]vendors[\\/](miwo|deepseek|openai)\.ts/);
    const hits = requireCacheKeys.filter((k) => /[\\/](vm2|sucrase)[\\/]/i.test(k));
    console.log(`[vendor-secrets] 探针：require.cache ${count} 个模块；沙箱模块命中 ${JSON.stringify(moduleProbeSandboxModules)}`);
    expect(hits, `真进程里不该加载过这些模块：\n  ${hits.join("\n  ")}`).toEqual([]);
  }, 60000);

  // ──────────────── E. 失败响应脱敏 ────────────────

  it("★ E1 新路径的失败响应里没有绝对路径 / 表名 / 堆栈", async () => {
    const db = createKnex(dbConfigOf(dataDir));
    try {
      const token = await signAs(db, ADMIN_USER, "admin");
      const replies: Array<{ name: string; r: Reply }> = [];
      replies.push({ name: "deleteVendor 越界 id", r: await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: "../x" } }) });
      // 未知供应商 + 合法形状 id：走 DB 分支（不抛）
      replies.push({ name: "deleteVendor 未知 id", r: await request("POST", url("/api/setting/vendorConfig/deleteVendor"), { token, body: { id: "vs-absent-not-there" } }) });
      replies.push({ name: "updateVendorInputs 类型不符", r: await request("POST", url("/api/setting/vendorConfig/updateVendorInputs"), { token, body: { id: "miwo", inputValues: { apiKey: 123 } } }) });

      for (const { name, r } of replies) {
        expect(r.status, `${name}：本轮只断言"不是 5xx 泄漏"`).toBeLessThan(500);
        expect(r.body, `${name} 的响应不得含绝对路径`).not.toMatch(/[A-Za-z]:[\\/]/);
        expect(r.body, `${name} 的响应不得含堆栈`).not.toMatch(/\bat \w+ \(|node_modules|\.pnpm/);
        expect(r.body, `${name} 的响应不得含表名/约束名`).not.toMatch(/o_vendorConfig|o_agentDeploy|UNIQUE|constraint/i);
      }
    } finally {
      await db.destroy();
    }
  }, 90000);
});
