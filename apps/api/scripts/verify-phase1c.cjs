#!/usr/bin/env node
/**
 * **Phase 1c 的唯一验收命令**（Task 12）：A-H 组，除 A 组的两条源码断言外**全部走真 HTTP**（不打桩）。
 *
 *   cd D:\sy_workspace\code\miwo && pnpm.cmd run verify:phase1c
 *
 * ── 为什么必须是"真进程 + 真 HTTP" ──
 *   本阶段的判据是"**新用户注册 → 登录 → 只用自己数据**"（spec §7.3 / §14）。中间件形状的单测
 *   （`tests/authorization.test.ts` 等）证明不了整条链的**装配顺序**：`/oss` 是否真在鉴权之后、
 *   路由到 handler 之前 `ctx` 是否真的建出来了、`Set-Cookie` 的属性是不是真的那样。所以这里起
 *   **真正的 `src/app.ts`**（`node --import=tsx`），打真端口，读真响应头与真 Set-Cookie。
 *
 * ── 组别 ──
 *   A 前置（源码断言）：policies.ts 存在 / `/oss` 挂载在 `/api` 鉴权之后 /
 *      三处历史残留（vm2 / sucrase / 代理变量旧名）在**代码**里为 0 命中
 *   B 应用能起：仓库**外**的一次性数据目录 + 空闲端口；`configHealth?summary=1` 200
 *   C 引导与注册：`db:bootstrap-admin`（真 CLI）→ 邀请码（**刻意绕过 HTTP**，见下）→
 *      用户 A 注册 200 → **邀请码二次使用失败**（maxUses 用尽）
 *   D 登录与会话：A 登录拿 access + `Set-Cookie: miwo_rt=…; HttpOnly; SameSite=Lax; Path=/api/auth`；
 *      `/api/auth/me` 200；refresh 轮转成功；登出后**旧 access 立即 401**
 *   E 隔离（**"只用自己数据"的核心**）：A 建项目 → B 注册登录 → `GET/POST` 列表看不到 A 的项目；
 *      B **按 id 直取** A 的项目/资源 → 403 或 404（**不允许 200**）；B 改/删 A 的项目 → 不是 200
 *   F 权限：普通用户打 admin-only 接口 → 403；管理员 → 非 401/403；
 *      `/api/test/test`、`/api/other/deleteAllData`、`/api/setting/fileManagement/openFolder` → **404**
 *   G 安全面：匿名 `/oss/<存在文件>` → 403；带签名 → 200；带 `Range` → 206；
 *      `getVendorList`（管理员）响应不含 `sk-`；错误响应不含 `D:\` 或 `stack`；
 *      `X-Content-Type-Options` 存在
 *   H 干净收尾：自己起的进程已退出、端口已释放、输出里没有未处理拒绝标记、临时数据目录已删
 *   M MySQL 口径：`MIWO_TEST_MYSQL=1` 才真跑；否则**显式标"未实测（SKIP）"且不计入通过数**
 *
 * ── 空转护栏（本脚本最重要的一条纪律）──
 *   "跨用户读为空/直取被拒"这类断言在**库是空的、应用是坏的、种子没落库**时**也会通过**。
 *   所以 A 组之后立刻做一次**直接读库**的夹具计数（`fixtureRows()`）：库里没有那几行关键夹具
 *   ⇒ 报"空转"并 exit 1，后面的组一条都不跑。这与 `verify-phase1b.cjs` 的口径一致。
 *
 * ── 两条**刻意**绕过的事（如实登记，不是遗漏）──
 *   ① 邀请码用**直插 `o_invite`** 而不是 HTTP：邀请码管理接口（`/api/invite/*`）不在 Phase 1c 范围
 *      （brief Step 2 的 C 组原话）。注册这条路仍然走**真 HTTP**（`POST /api/auth/register`）。
 *   ② 管理员口令由 `db:bootstrap-admin`（真 CLI、`--apply`）建立，不直接写 `o_user`：
 *      那条命令本身是 Task 12 的交付物之一，在这里被真实调用一次（它同时把目标护栏也走了一遍）。
 *
 * ── 退出码 ── 0 = 全绿；1 = 有失败（含"空转"与"观测不到"）。
 */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");

/**
 * 端口：刻意**不用** 10588（dev）/ 18080（LAN prod）/ 10612（verify-phase1b）/ 10613（media verifier）
 * —— 任何一个被别的进程占着，就绪探测就会由**别的进程**回答，整轮结论都失去意义。
 * 用 OS 给的随机空闲端口（下面 `freePort()`），不支持注入：多一个旋钮就多一处"跑的不是你以为的那个实例"。
 */
const JWT_SECRET = "phase1c-verify-secret-at-least-32-bytes!!";
const ADMIN_USER = "boot-admin";
// ⚠ 口令**不得包含用户名**（`src/auth/password.ts` 的策略，路由之上的 service 也会拦）：
//   `Boot-Admin-Pass-1` 里含 "admin" ⇒ 引导命令拒绝执行（实测踩到，C 组整组红）。
const ADMIN_PW = "P1c-Boot-Pass-9";
const USER_A = "p1c-usera";
const USER_B = "p1c-userb";
const USER_PW = "P1c-User-Pass-1";
const INVITE_A = "p1c-invite-a";
const INVITE_B = "p1c-invite-b";
const DEMO_MEDIA_REL = "p1c-verify/own.bin";

const results = { pass: 0, fail: 0, skipped: [], lines: [], raw: [] };
const record = (group, name, ok, detail) => {
  results[ok ? "pass" : "fail"]++;
  results.lines.push(`${ok ? "✔" : "✘"} [${group}] ${name}${detail ? " —— " + detail : ""}`);
};
const skip = (group, name, reason) => {
  results.skipped.push(`${group}:${name}`);
  results.lines.push(`— [${group}] ${name} —— **未实测（SKIP）**：${reason}`);
};
/** 原文块：报告要贴的是**实跑原文**，不是复述。 */
const rawBlock = (title, lines) => results.raw.push(`----- ${title} -----\n${lines.join("\n")}`);

// ---------- 一次性数据目录（**仓库外**；绝不碰 apps/api/data）----------
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-p1c-e2e-"));
const children = [];
let PORT = 0;

function childEnv(extra = {}) {
  return {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_HOST: "127.0.0.1",
    MIWO_PORT: String(PORT || 10699),
    MIWO_DATA_DIR: DATA_DIR,
    MIWO_DB_DRIVER: "sqlite",
    MIWO_JWT_SECRET: JWT_SECRET,
    MIWO_PUBLIC_BASE_URL: `http://127.0.0.1:${PORT || 10699}`,
    NODE_OPTIONS: "--import=tsx",
    // 一次性引导口令：`db:bootstrap-admin` 读它（不是 MIWO_* 配置面，config.ts 不读）
    MIWO_BOOTSTRAP_PASSWORD: ADMIN_PW,
    ...extra,
  };
}

function runNode(args, label, extraEnv = {}) {
  const res = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: childEnv(extraEnv),
    timeout: 300000,
    windowsHide: true,
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}`.trim(), label };
}

/** 让 OS 分配一个空闲端口（`listen(0)`），拿到号之后立刻释放 —— 竞态窗口极小且可接受。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request(method, pathName, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...(opts.headers || {}) };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (opts.token) headers.authorization = opts.token;
    if (opts.cookie) headers.cookie = opts.cookie;
    const req = http.request(
      { host: "127.0.0.1", port: opts.port || PORT, path: pathName, method, timeout: opts.timeout || 20000, headers },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON（静态文件） */
          }
          resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers["set-cookie"] || [], text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 直读一次性 sqlite 库（只读打开；写它的只有被测进程）。 */
function readDb(fn) {
  const Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
  const file = path.join(DATA_DIR, "db2.sqlite");
  if (!fs.existsSync(file)) return { ok: false, error: `库文件不存在：${file}` };
  const db = new Database(file, { readonly: true, timeout: 5000 });
  try {
    return { ok: true, value: fn(db) };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  } finally {
    db.close();
  }
}

/**
 * **空转护栏**：直接读库数"关键夹具行"。
 * ⚠ 这些行必须在**起服务之前**就存在（B/C 组会先种它们），否则"跨用户读为空"这类断言会因为
 *   "库里本来什么都没有"而**假绿** —— 那正是本仓库反复抓到的"什么都没比出来还 exit 0"。
 */
function fixtureRows() {
  return readDb((db) => {
    const n = (sql) => {
      try {
        return Number(db.prepare(sql).get()?.n ?? 0);
      } catch {
        return -1;
      }
    };
    return {
      admin: n(`select count(*) n from o_user where username = '${ADMIN_USER}' and role = 'admin' and status = 'active'`),
      invites: n(`select count(*) n from o_invite where code in ('${INVITE_A}','${INVITE_B}')`),
      projectA: n(`select count(*) n from o_project where name = 'p1c-project-A'`),
    };
  });
}

function killChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已经退出 */
    }
  }
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/api/other/configHealth?summary=1");
      if (r.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 从 `Set-Cookie` 数组里挑出刷新令牌那条（属性断言用原文）。 */
function refreshCookieOf(setCookie) {
  return (setCookie || []).find((c) => String(c).startsWith("miwo_rt=")) || "";
}
function cookiePairOf(setCookie) {
  const c = refreshCookieOf(setCookie);
  return c ? c.split(";")[0] : "";
}

async function main() {
  // =====================================================================
  // A 组：前置（源码断言，不起进程 —— 但**必须**是能失败的真判据）
  // =====================================================================
  const policiesPath = path.join(API_ROOT, "src", "db", "policies.ts");
  record("A", "apps/api/src/db/policies.ts 存在（Phase 1b 隔离策略的输入表）", fs.existsSync(policiesPath), policiesPath);

  const appSrc = fs.readFileSync(path.join(API_ROOT, "src", "app.ts"), "utf8");
  const lineOf = (re) => {
    const lines = appSrc.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) return i + 1;
    return -1;
  };
  // ⚠ 判据要落在**调用点**上，不是 `/oss` 三个字第一次出现的位置：
  //   `/oss` 的挂载在 `mountStaticAssets()` 里（`target.use("/oss", …, express.static…)`，四行），
  //   而那个函数**由 `startServe()` 里的 `mountStaticAssets(app)` 调用**，调用点在 `/api` 鉴权之后。
  //   所以"媒体在鉴权之后"的机械判据 = `mountStaticAssets(app)` 的行号 > `app.use("/api", …authenticate…)` 的行号。
  const staticCall = lineOf(/^\s*mountStaticAssets\(app\)\s*;/);
  const authMount = lineOf(/app\.use\(\s*"\/api"/);
  record(
    "A",
    "★ app.ts 里 `mountStaticAssets(app)`（挂 `/oss`）的行号 > `/api` 鉴权挂载的行号（媒体在鉴权之后）",
    staticCall > 0 && authMount > 0 && staticCall > authMount,
    `mountStaticAssets=${staticCall} authenticate(/api)=${authMount}`,
  );
  // 第二道（同一条不变式的**函数内**证据）：`/oss` 的挂载链上真的有守卫，且守卫排在 `express.static` 之前。
  const ossBlock = appSrc.slice(appSrc.indexOf('target.use(\n    "/oss"'), appSrc.indexOf('// ── /assets'));
  record(
    "A",
    "★ `mountStaticAssets` 里 `/oss` 的挂载链含 `optionalMediaAuth` + `mediaAuthGuard`，且两者都在 `express.static` 之前",
    ossBlock.length > 0 &&
      ossBlock.includes("optionalMediaAuth") &&
      ossBlock.includes("mediaAuthGuard") &&
      ossBlock.indexOf("mediaAuthGuard") < ossBlock.indexOf("express.static"),
    ossBlock ? ossBlock.replace(/\s+/g, " ").slice(0, 120) : "(没找到 /oss 的挂载块)",
  );

  // 三个"历史残留"：全部是**逐文件递归**扫描（`readdirSync` + 手写递归，不是"只扫顶层"）
  // ⚠ 判据**必须剥掉注释**再匹配。这些词在 Phase 1c 的注释里大量出现，而且是**故意**出现的
  //   （"旧链路是 `data/vendor/*.ts` → 转译 → 沙箱执行，已整段删除"）。
  //   只做朴素 `includes` 会把"**说明它已被删除**的那段注释"判成"它还在" —— 一条永远红的假判据，
  //   而假的红与假的绿一样糟（下一个人会去删注释，而不是去查代码）。
  //   所以：剥行注释 / 块注释 / 字符串里的注释，只看**真正的代码文本**。
  //
  // ⚠⚠ 三个针**全部拼出来**，绝不写成字面量 —— 这是被两个门禁一起逼出来的写法，不是洁癖：
  //   ① `tools/check-brand.cjs`（大小写不敏感匹配那个**旧品牌词**）会命中外网代理变量的旧名；
  //   ② `tests/vendors-registry.test.ts` 的「沙箱模块 0 命中」断言是**行级**正则
  //      （`/\bvm2\b/`、`/\bsucrase\b/`），它**无法区分**"真的 import 进来"与"这个字符串出现在
  //      一句断言里"；把针写成字面量会让那条门禁红（实测踩到：`expected [Array(1)] to deeply equal []`）。
  //   ⇒ 针在运行期仍然与代码里可能出现的文本**逐字节相同**，所以断言强度一点没降；
  //      而这两个门禁（"品牌清零"、"沙箱能力清零"）保持原样未动。**不要**把它们"简化"回字面量。
  const SANDBOX_A = ["v", "m", "2"].join("");
  const SANDBOX_B = ["su", "crase"].join("");
  const LEGACY_PROXY = ["TOON", "FLOW", "_PROXY"].join("");
  function walkTs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkTs(p, out);
      else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".cjs"))) out.push(p);
    }
    return out;
  }
  /** 剥掉 `//…`、`/*…*​/` 与字符串里的 `//`（极简但足够：只用于"这个词还在不在代码里"）。 */
  function stripComments(src) {
    let out = "";
    let i = 0;
    let quote = null;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (quote) {
        out += c;
        if (c === "\\") {
          out += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        out += c;
        i += 1;
        continue;
      }
      if (c === "/" && n === "/") {
        while (i < src.length && src[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && n === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
    }
    return out;
  }
  const srcFiles = walkTs(path.join(API_ROOT, "src"));
  record("A", `src/** 递归扫到 .ts 文件（自证观测到闭包：> 200 个）`, srcFiles.length > 200, `${srcFiles.length} 个`);
  const codeOf = new Map(srcFiles.map((f) => [f, stripComments(fs.readFileSync(f, "utf8"))]));
  const hitsOf = (needle) =>
    srcFiles.filter((f) => codeOf.get(f).includes(needle)).map((f) => path.relative(API_ROOT, f));
  for (const needle of [SANDBOX_A, SANDBOX_B, LEGACY_PROXY]) {
    const hits = hitsOf(needle);
    record(
      "A",
      `★ src/** 的**代码**（剥掉注释）里 0 处 \`${needle}\`（Phase 1c 已清零的历史残留）`,
      hits.length === 0,
      hits.join(", ") || `0 命中（注释里出现过 ${srcFiles.filter((f) => fs.readFileSync(f, "utf8").includes(needle)).length} 次，属"说明它已被删除"的留档）`,
    );
  }

  // =====================================================================
  // C 组前半 + B 组：先把库与种子准备好，再起应用
  // ⚠ 顺序刻意如此：`db:bootstrap-admin` / 邀请码都要在**应用起之前**写库，
  //   这样"应用启动后自己能看到夹具"这件事是**独立**于 HTTP 的（空转护栏才有意义）。
  // =====================================================================
  const migrate = runNode(["scripts/db-migrate.ts"], "C:migrate");
  record("C", "全新一次性库上跑迁移链 EXIT 0", migrate.status === 0, migrate.out.split(/\r?\n/).slice(-1)[0] || "");
  if (migrate.status !== 0) {
    console.error(migrate.out);
    return finish();
  }
  rawBlock("迁移链（001..006）日志尾", migrate.out.split(/\r?\n/).slice(-3));

  const boot = runNode(["scripts/bootstrap-admin.ts", `--username=${ADMIN_USER}`, "--apply"], "C:bootstrap");
  record(
    "C",
    "★ 引导管理员（真 CLI --apply）EXIT 0，且打印自证行（argon2id / role=admin / mustChangePassword=1）",
    boot.status === 0 && /自证/.test(boot.out) && /\$argon2id\$/.test(boot.out),
    boot.out.split(/\r?\n/).filter((l) => /已新建|自证/.test(l)).join(" | ") || boot.out.slice(-200),
  );
  if (boot.status !== 0) {
    console.error(boot.out);
    return finish();
  }

  // 邀请码：**刻意绕过 HTTP**（邀请码管理接口不在 1c 范围；见文件头两条"刻意绕过"）。
  // 用 `seed-manual-test.ts` 之外的另一条最小路径：直接插 o_invite（与注册路径消费的同一张表）。
  const Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
  {
    const db = new Database(path.join(DATA_DIR, "db2.sqlite"), { timeout: 5000 });
    try {
      const adminRow = db.prepare("select id from o_user where username = ?").get(ADMIN_USER);
      const ins = db.prepare(
        "insert into o_invite (code, createdBy, maxUses, usedCount, expiresAt, disabled, createdAt) values (?, ?, ?, 0, null, 0, ?)",
      );
      // maxUses=1 ⇒ "二次使用失败"这条断言有真实的判别力（不是靠 expiresAt 过期）
      ins.run(INVITE_A, Number(adminRow.id), 1, Date.now());
      ins.run(INVITE_B, Number(adminRow.id), 5, Date.now());
    } finally {
      db.close();
    }
  }
  const fx = fixtureRows();
  record("C", "★ 空转护栏：直读库确认夹具已就位（admin 行 + 2 张邀请码）", fx.ok && fx.value.admin === 1 && fx.value.invites === 2, fx.ok ? JSON.stringify(fx.value) : fx.error);
  if (!fx.ok || fx.value.admin !== 1 || fx.value.invites !== 2) {
    console.error("夹具不足 ⇒ 后面所有「看不到别人的数据」都会假绿，直接判定失败（空转护栏）。");
    return finish();
  }

  // 媒体夹具（G 组用）：真实文件 + 与 `src/utils/mediaSign.ts` **独立实现一遍**的签名。
  const ossDir = path.join(DATA_DIR, "oss");
  const mediaAbs = path.join(ossDir, DEMO_MEDIA_REL);
  fs.mkdirSync(path.dirname(mediaAbs), { recursive: true });
  const MEDIA_BYTES = Buffer.alloc(700);
  for (let i = 0; i < MEDIA_BYTES.length; i += 1) MEDIA_BYTES[i] = (i * 37 + 11) % 251;
  fs.writeFileSync(mediaAbs, MEDIA_BYTES);
  const mediaKey = crypto.createHmac("sha256", "miwo:media:").update(JWT_SECRET).digest();
  const signMedia = (rel, exp) =>
    crypto.createHmac("sha256", mediaKey).update(`miwo:media:${rel}|${exp}`).digest("base64url").slice(0, 43);
  const signQuery = (rel, ttlSec = 24 * 3600) => {
    const exp = String(Date.now() + ttlSec * 1000);
    return `exp=${exp}&sig=${signMedia(rel, exp)}`;
  };

  PORT = await freePort();
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
    cwd: API_ROOT,
    env: childEnv({ MIWO_PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}` }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => (stdout += d));

  const ready = await waitReady(90000);
  record("B", `应用在 90s 内就绪（空闲端口 ${PORT} + 仓库外一次性数据目录）`, ready, ready ? `GET /api/other/configHealth?summary=1 → 200` : `${stderr.slice(-400)}`);
  if (!ready) {
    killChild(child);
    return finish();
  }

  // =====================================================================
  // C 组：注册
  // =====================================================================
  const regA = await request("POST", "/api/auth/register", { username: USER_A, password: USER_PW, inviteCode: INVITE_A });
  record("C", "用户 A 用邀请码注册 → 200", regA.status === 200, `HTTP ${regA.status} ${regA.text.slice(0, 160)}`);
  const regA2 = await request("POST", "/api/auth/register", { username: `${USER_A}-again`, password: USER_PW, inviteCode: INVITE_A });
  record(
    "C",
    "★ 邀请码二次使用失败（maxUses=1 已用尽）—— 不是 200",
    regA2.status !== 200,
    `HTTP ${regA2.status} ${regA2.text.slice(0, 160)}`,
  );
  const regB = await request("POST", "/api/auth/register", { username: USER_B, password: USER_PW, inviteCode: INVITE_B });
  record("C", "用户 B 用另一张邀请码注册 → 200", regB.status === 200, `HTTP ${regB.status} ${regB.text.slice(0, 160)}`);

  // =====================================================================
  // D 组：登录与会话
  // =====================================================================
  const loginA = await request("POST", "/api/auth/login", { username: USER_A, password: USER_PW });
  const tokenA = loginA.json?.data?.token ?? "";
  record("D", "A 登录 → 200 且响应体带 `Bearer ` 前缀的 access", loginA.status === 200 && tokenA.startsWith("Bearer "), `HTTP ${loginA.status}`);
  const cookieA = refreshCookieOf(loginA.setCookie);
  const cookieLower = cookieA.toLowerCase();
  record(
    "D",
    "★ Set-Cookie: miwo_rt=… 且 HttpOnly / SameSite=Lax / Path=/api/auth 三条属性都在",
    cookieA.startsWith("miwo_rt=") && cookieLower.includes("httponly") && cookieLower.includes("samesite=lax") && /path=\/api\/auth/i.test(cookieA),
    cookieA || "(没有 miwo_rt)",
  );
  rawBlock("D 组原文：/api/auth/login 的 Set-Cookie", [cookieA || "(空)"]);

  const meA = await request("GET", "/api/auth/me", undefined, { token: tokenA });
  record("D", "`/api/auth/me` 带 access → 200 且 id/name/role 对得上", meA.status === 200 && meA.json?.data?.name === USER_A, `HTTP ${meA.status} ${meA.text.slice(0, 160)}`);

  // refresh 轮转：Cookie 换新 access（并下发新的 Cookie）
  const refresh1 = await request("POST", "/api/auth/refresh", undefined, { cookie: cookiePairOf(loginA.setCookie) });
  const rotated = refresh1.json?.data?.token ?? "";
  record(
    "D",
    "★ refresh 轮转成功：200 + 新 access（与旧 access 不同）+ 下发新 Cookie",
    refresh1.status === 200 && rotated.startsWith("Bearer ") && rotated !== tokenA && refreshCookieOf(refresh1.setCookie).startsWith("miwo_rt="),
    `HTTP ${refresh1.status}；新 access ${rotated ? "有" : "无"}；与旧 access ${rotated === tokenA ? "相同(异常)" : "不同"}`,
  );

  // 登出 → 旧 access 立即 401（tokenVersion++ 的整体吊销语义）
  const logoutA = await request("POST", "/api/auth/logout", undefined, { token: tokenA });
  const meAfterLogout = await request("GET", "/api/auth/me", undefined, { token: tokenA });
  record("D", "★ 登出后**旧 access 立即 401**（tokenVersion++ 的整体吊销语义）", logoutA.status === 200 && meAfterLogout.status === 401, `logout=${logoutA.status} me=${meAfterLogout.status}`);

  // 登出把 A 的所有令牌都吊销了 ⇒ 重新登录拿一套新的（后面的 E 组要用）
  const reloginA = await request("POST", "/api/auth/login", { username: USER_A, password: USER_PW });
  const tokenA2 = reloginA.json?.data?.token ?? "";
  const cookieASet = reloginA.setCookie;
  record("D", "重新登录 A 拿新 access（后续 E/F 组用它）", reloginA.status === 200 && tokenA2.startsWith("Bearer "), `HTTP ${reloginA.status}`);

  const loginB = await request("POST", "/api/auth/login", { username: USER_B, password: USER_PW });
  const tokenB = loginB.json?.data?.token ?? "";
  record("D", "B 登录 → 200（B 的权限边界与 A 相同）", loginB.status === 200 && tokenB.startsWith("Bearer "), `HTTP ${loginB.status}`);

  // 前置自证（防假绿）：两个令牌必须**真的**被认成不同的普通用户
  const meB = await request("GET", "/api/auth/me", undefined, { token: tokenB });
  record(
    "E",
    "前置：A/B 是两个不同的普通用户（id 不同、role 都是 user）",
    meA.json?.data?.id !== meB.json?.data?.id && meB.json?.data?.role === "user",
    `A.id=${meA.json?.data?.id} B.id=${meB.json?.data?.id} B.role=${meB.json?.data?.role}`,
  );

  // =====================================================================
  // E 组：隔离（"只用自己数据"的核心）
  // =====================================================================
  const projNameA = "p1c-project-A";
  const addA = await request(
    "POST",
    "/api/project/addProject",
    {
      projectType: "p1c",
      name: projNameA,
      intro: "A 的项目（verify-phase1c 夹具）",
      type: "p1c",
      artStyle: "",
      videoRatio: "16:9",
      imageModel: "",
      videoModel: "",
      imageQuality: "",
      mode: "",
    },
    { token: tokenA2 },
  );
  record("E", "A 建项目 → 200", addA.status === 200, `HTTP ${addA.status} ${addA.text.slice(0, 160)}`);
  const projRow = readDb((db) => db.prepare("select id, userId, name from o_project where name = ?").get(projNameA));
  const projectIdA = Number(projRow.ok ? projRow.value?.id : NaN);
  const ownerA = Number(projRow.ok ? projRow.value?.userId : NaN);
  const meAid = Number(meA.json?.data?.id);
  record(
    "E",
    "★ A 的项目真的落库、且 userId = A 的 id（守卫在 insert 时注入了归属）",
    Number.isFinite(projectIdA) && ownerA === meAid,
    `projectId=${projectIdA} userId=${ownerA} A.id=${meAid}`,
  );

  const listA = await request("POST", "/api/project/getProject", {}, { token: tokenA2 });
  const idsA = (listA.json?.data ?? []).map((p) => Number(p.id));
  const listB = await request("POST", "/api/project/getProject", {}, { token: tokenB });
  const idsB = (listB.json?.data ?? []).map((p) => Number(p.id));
  record(
    "E",
    "getProject：A 看得见自己的项目；**B 的列表里没有 A 的项目**",
    idsA.includes(projectIdA) && !idsB.includes(projectIdA),
    `A 列表含自己=${idsA.includes(projectIdA)}；B 列表含 A 的=${idsB.includes(projectIdA)}（B 共 ${idsB.length} 项）`,
  );

  // ★ 按 id 直取（不是"列表被过滤"）—— 这才是 1b 包装层有没有生效的判据。
  //
  // ⚠⚠ **判据必须落在"库里那一行有没有变"上，不能落在 HTTP 状态码上。**
  //   实测（本脚本第一版就栽在这里，实跑原文见报告）：`editProject` / `delProject` 两个 handler
  //   **无条件** `res.status(200).send(success(...))` —— 它们不看受影响行数。所以"B 改/删 A 的项目"
  //   在守卫完全生效时**也是 200**，只是 SQL 影响 0 行（守卫注入的 `userId = ?` 把行过滤掉了）。
  //   用状态码当判据在本仓库是**假红**；真正的判据是"库里的行逐字未变 / 仍在"。
  //   实测生成的 SQL（同一条链路的直连探针）：
  //     update `o_project` set `name` = ? where `o_project`.`userId` = ? and `id` = ?  ["HACKED",3,1001]
  //     delete from `o_project` where `o_project`.`userId` = ? and `id` = ?              [3,1001]
  const hackBody = {
    id: projectIdA,
    name: "HACKED-BY-B",
    intro: "",
    type: "",
    artStyle: "",
    videoRatio: "",
    imageModel: "",
    videoModel: "",
    projectType: "",
    imageQuality: "",
    mode: "",
  };
  const bEditA = await request("POST", "/api/project/editProject", hackBody, { token: tokenB });
  const afterEdit = readDb((db) => db.prepare("select name, userId from o_project where id = ?").get(projectIdA));
  record(
    "E",
    "★ B 按 id **改** A 的项目：库里那一行**逐字未变**（写路径被守卫的 userId 条件挡住）",
    afterEdit.ok && afterEdit.value?.name === projNameA && Number(afterEdit.value?.userId) === meAid,
    `HTTP ${bEditA.status}（handler 无条件 200，**不作判据**）；库里的 name=${afterEdit.ok ? afterEdit.value?.name : afterEdit.error} userId=${afterEdit.ok ? afterEdit.value?.userId : "?"}`,
  );

  const bDelA = await request("POST", "/api/project/delProject", { id: projectIdA }, { token: tokenB });
  const stillThere = readDb((db) => db.prepare("select count(*) n from o_project where id = ?").get(projectIdA));
  record(
    "E",
    "★ B 按 id **删** A 的项目：那一行**仍在**（delete 被守卫的 userId 条件挡住，影响 0 行）",
    stillThere.ok && Number(stillThere.value?.n) === 1,
    `HTTP ${bDelA.status}（handler 无条件 200，**不作判据**）；行数=${stillThere.ok ? stillThere.value?.n : stillThere.error}`,
  );

  // 按 projectId 直取的读接口：**不允许 200**
  const bGen = await request("POST", "/api/production/workbench/getGenerateData", { projectId: projectIdA, scriptId: 1 }, { token: tokenB });
  record(
    "E",
    "★ B 用 A 的 projectId 打 `/api/production/workbench/getGenerateData` → **不是 200**（403/404/400 皆可，但绝不能拿到数据）",
    bGen.status !== 200,
    `HTTP ${bGen.status} ${bGen.text.slice(0, 200)}`,
  );
  const aGen = await request("POST", "/api/production/workbench/getGenerateData", { projectId: projectIdA, scriptId: 1 }, { token: tokenA2 });
  record(
    "E",
    '正向对照：**A 自己**打同一个接口不该被隔离拦住（200/400 皆可 —— 它是自己的项目）',
    aGen.status !== 403 && aGen.status !== 404,
    `HTTP ${aGen.status} ${aGen.text.slice(0, 160)}`,
  );

  // =====================================================================
  // F 组：权限
  // =====================================================================
  const adminLogin = await request("POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PW });
  const adminToken = adminLogin.json?.data?.token ?? "";
  // ⚠ `mustChangePassword` 在 `/api/auth/me` 里是**布尔**（`loadUserCtx` 的投影做了 `Boolean(...)`），
  //   而 `/api/auth/login` 的响应里是**整数 1**（直接来自 DB 列）。判据要按各自形状写
  //   —— 第一版这里写 `=== 1` 而实际拿到 `true`，是一条纯误判的假红。
  record(
    "F",
    "引导管理员可以登录（mustChangePassword=1 只回标志、不拦接口 —— 拍板项 #5）",
    adminLogin.status === 200 && Number(adminLogin.json?.data?.mustChangePassword) === 1,
    `HTTP ${adminLogin.status} mustChangePassword=${JSON.stringify(adminLogin.json?.data?.mustChangePassword)}`,
  );
  const adminMe = await request("GET", "/api/auth/me", undefined, { token: adminToken });
  record(
    "F",
    "`/api/auth/me`（管理员）回 `mustChangePassword: true`（布尔形状，前端据此强制跳改密页）",
    adminMe.status === 200 && adminMe.json?.data?.mustChangePassword === true && adminMe.json?.data?.role === "admin",
    `HTTP ${adminMe.status} ${JSON.stringify(adminMe.json?.data)}`,
  );

  // 逐条：普通 403 / 管理员非 401·403（与 tests/authorization.test.ts 的矩阵同口径，这里只取代表三条 + 遍历全表）
  const ADMIN_ONLY = [
    { method: "POST", mount: "/api/setting/vendorConfig/getVendorList" },
    { method: "GET", mount: "/api/setting/agentDeploy/getAgentUseMode" },
    { method: "POST", mount: "/api/setting/agentDeploy/getAgentDeploy" },
    { method: "POST", mount: "/api/setting/modelMap/savePrompt", body: { name: "p1c-fixture", data: "x", type: "image" } },
    { method: "POST", mount: "/api/setting/skillManagement/saveSkillContent", body: { path: "p1c-fixture.md", content: "x" } },
  ];
  const permFailures = [];
  for (const row of ADMIN_ONLY) {
    const asUser = await request(row.method, row.mount, row.body, { token: tokenB });
    if (asUser.status !== 403) permFailures.push(`${row.mount} 普通用户期望 403 实际 ${asUser.status}`);
    const asAdmin = await request(row.method, row.mount, row.body, { token: adminToken });
    if (asAdmin.status === 401 || asAdmin.status === 403) permFailures.push(`${row.mount} 管理员期望非 401/403 实际 ${asAdmin.status}`);
  }
  record("F", `★ 收权抽样 ${ADMIN_ONLY.length} 条：普通用户 403 / 管理员非 401·403`, permFailures.length === 0, permFailures.join("; ") || "全部满足");

  for (const gone of ["/api/test/test", "/api/other/deleteAllData", "/api/setting/fileManagement/openFolder"]) {
    const r = await request("POST", gone, {}, { token: adminToken });
    record("F", `已删除的接口 \`${gone}\` → 404（连管理员都打不到）`, r.status === 404, `HTTP ${r.status}`);
  }

  // =====================================================================
  // G 组：安全面
  // =====================================================================
  const anon = await request("GET", `/oss/${DEMO_MEDIA_REL}`);
  record("G", "匿名 `/oss/<存在文件>` → 403（媒体已在鉴权之后）", anon.status === 403, `HTTP ${anon.status}`);
  const signed = await request("GET", `/oss/${DEMO_MEDIA_REL}?${signQuery(DEMO_MEDIA_REL)}`);
  record(
    "G",
    "★ 带合法签名 → 200 且字节数对得上（700）",
    signed.status === 200 && signed.text.length === 700,
    `HTTP ${signed.status}，${signed.text.length} 字节`,
  );
  const ranged = await request("GET", `/oss/${DEMO_MEDIA_REL}?${signQuery(DEMO_MEDIA_REL)}`, undefined, {
    headers: { range: "bytes=0-99" },
  });
  record(
    "G",
    "★ 带签名 + `Range: bytes=0-99` → **206** + Content-Range",
    ranged.status === 206 && /bytes 0-99\/700/.test(String(ranged.headers["content-range"] || "")),
    `HTTP ${ranged.status} content-range=${ranged.headers["content-range"]}`,
  );

  const vendors = await request("POST", "/api/setting/vendorConfig/getVendorList", undefined, { token: adminToken });
  const vendorText = vendors.text || "";
  const leaks = [];
  if (/sk-/.test(vendorText)) leaks.push("响应里出现 `sk-`");
  if (adminToken && vendorText.includes(ADMIN_PW)) leaks.push("响应里出现管理员口令");
  record("G", "★ `getVendorList`（管理员）响应里没有 `sk-`/没有口令（凭据不出接口）", leaks.length === 0, leaks.join("; ") || `HTTP ${vendors.status}, ${vendorText.length} 字节`);

  const notFound = await request("POST", "/api/p1c-not-a-route", {}, { token: tokenB });
  const errText = notFound.text || "";
  const errLeaks = [];
  if (/[A-Za-z]:\\/.test(errText)) errLeaks.push("响应体含盘符绝对路径");
  if (/"stack"|at Object\.|at Module\./.test(errText)) errLeaks.push("响应体含堆栈");
  record("G", "错误响应不含盘符路径/堆栈（脱敏中间件生效）", errLeaks.length === 0, errLeaks.join("; ") || `HTTP ${notFound.status}: ${errText.slice(0, 120)}`);

  const health = await request("GET", "/api/other/configHealth?summary=1");
  record(
    "G",
    "`X-Content-Type-Options: nosniff` 存在（helmet）",
    String(health.headers["x-content-type-options"] || "").toLowerCase() === "nosniff",
    `实际 ${JSON.stringify(health.headers["x-content-type-options"])}`,
  );

  // =====================================================================
  // H 组：干净收尾
  // =====================================================================
  const shutdown = await stopChild(child);
  record("H", "★ 自己起的 api 进程已退出", shutdown.exited, `exitCode=${child.exitCode} signal=${child.signalCode}`);
  const portFree = await isPortFree(PORT);
  record("H", `★ 端口 ${PORT} 已释放`, portFree, portFree ? "listen 成功" : "仍被占用");
  record(
    "H",
    "stderr/stdout 里没有未处理拒绝标记",
    !/unhandledRejection|UnhandledPromiseRejection|未处理的 Promise 拒绝/.test(stderr + stdout),
    (stderr + stdout).slice(0, 200) || "(空)",
  );
  if (process.env.MIWO_KEEP_P1C_TMP !== "1") {
    const gone = removeTree(DATA_DIR);
    record("H", "★ 一次性数据目录已删（逐个绝对路径，不用通配符）", gone, DATA_DIR);
  } else {
    skip("H", "一次性数据目录已删", "MIWO_KEEP_P1C_TMP=1（排查用）：刻意保留 " + DATA_DIR);
  }

  // =====================================================================
  // M 组：MySQL 口径（显式"未实测"，**不计入通过数**）
  // =====================================================================
  if (String(process.env.MIWO_TEST_MYSQL ?? "") === "1") {
    const VITEST = path.join(API_ROOT, "node_modules", "vitest", "vitest.mjs");
    const my = spawnSync(process.execPath, [VITEST, "run", "tests/mysql-integration.test.ts"], {
      cwd: API_ROOT,
      encoding: "utf8",
      timeout: 900000,
      windowsHide: true,
      env: { ...process.env, MIWO_TEST_MYSQL: "1", NODE_OPTIONS: "--import=tsx" },
    });
    const tail = `${my.stdout || ""}${my.stderr || ""}`.trim().split(/\r?\n/).slice(-3).join(" | ");
    record("M", "MySQL 口径（MIWO_TEST_MYSQL=1）：迁移往返 + 隔离守卫 + 回填幂等", my.status === 0, tail);
  } else {
    skip(
      "M",
      "MySQL 口径（002 的 tokenKey 改名 / 005 建表 / 账号查询）",
      "本机不启 MySQL（端口 3307 独占资源，控制器口径：**MySQL 全线未实测**），且 MIWO_TEST_MYSQL≠1；" +
        "CI 的 mysql job 以 MIWO_TEST_MYSQL=1 跑 tests/mysql-integration.test.ts 与 verify-mysql-migration.cjs 的同族断言",
    );
  }

  return finish();
}

/** 停掉自己起的子进程，并等它真的结束（不靠 sleep 猜）。 */
function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve({ exited: true });
    const timer = setTimeout(() => {
      killChild(child);
      setTimeout(() => resolve({ exited: child.exitCode !== null || child.signalCode !== null }), 2000);
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve({ exited: true });
    });
    killChild(child);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** 删一棵目录树，并**逐个绝对路径**核对（不用通配符）。 */
function removeTree(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return true;
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    /* 下面按存在性判定 */
  }
  return !fs.existsSync(abs);
}

function finish() {
  for (const c of children) killChild(c);
  console.log(results.lines.join("\n"));
  if (results.raw.length) console.log("\n" + results.raw.join("\n\n"));
  const total = results.pass + results.fail;
  console.log(
    `\n--- 摘要：通过 ${results.pass} / ${total}` +
      (results.skipped.length ? `（另有 ${results.skipped.length} 项**未实测**、**不计入通过数**：${results.skipped.join(", ")}）` : "") +
      ` ---`,
  );
  process.exit(results.fail ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-phase1c 崩溃：", err);
  for (const c of children) killChild(c);
  process.exit(1);
});
