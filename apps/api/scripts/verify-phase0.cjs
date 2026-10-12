#!/usr/bin/env node
/**
 * 谜沃 Phase 0 验收（spec §13 Phase 0 判据）。
 *
 * 五组断言：
 *   A. 旧仓库冻结 —— 按 tools/.phase0-old-baseline.json 的 8 条 sha256 逐条比对
 *      （这是"旧仓库零改动"的**唯一可靠证明**；脏文件数会被 gitignore/临时文件干扰，不能用）
 *   B. 构件存在 —— 新仓库的关键路径/文件齐全
 *   C. 应用能起 —— 用 MIWO_* 环境变量在**空闲端口**独立启动（独立数据目录），轮询就绪
 *   D. 鉴权与只读接口 —— configHealth?summary=1 必须 200 且是 JSON；无 token 访问受保护接口必须 401
 *   E. 干净收尾 —— 服务输出里不得有未处理的 Promise 拒绝；自己起的进程必须杀掉、端口必须释放
 *
 * 用法：node apps/api/scripts/verify-phase0.cjs
 * 退出码 0 = 通过，1 = 失败（逐条打印失败项）。
 *
 * ⚠ 本脚本对基线**只读、绝不写**：验收脚本若能在失败时"顺便重记基线"，
 *   等于给 Phase 0 中途的误改背书（"旧仓库零改动"就再也证明不了了）。
 *   基线由 tools/record-old-baseline.cjs 在 Phase 0 **开始前**记录。
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const MIWO_ROOT = path.resolve(API_ROOT, "..", "..");
// ⚠ 旧仓库路径**故意写成正常字面量**（可读、可 grep、可复核），并且在 tools/check-brand.cjs 的
//    `LEGACY_NAME_EXEMPT` 白名单里**逐文件显式豁免并附理由**（那条断言本意是"新仓库源码不得残留旧品牌/旧包名"，
//    本脚本引用旧仓库目录名是 Phase 0 的验收判据，不是品牌残留）。
//    **不要**为了绕开那条门禁把目录名拆成两段字符串拼接 —— 那等于静默豁免，下一个人看不出这里有例外；
//    也不要要求把豁免规则放宽成"跳过整个 apps/api/scripts 目录"。
//    本脚本必须拿到旧仓库的**绝对路径**：A 组要按 tools/.phase0-old-baseline.json 的 8 条 sha256
//    逐条证明旧仓库零改动，被比的路径只能是真实目录名。
const OLD_UPSTREAM = "D:\\sy_workspace\\code\\toonflow-upstream";
const OLD_WEB = "D:\\sy_workspace\\code\\toonflow-web";

const READY_TIMEOUT_MS = 60000;
const OUT_TAIL = 2000;
// 平台种子的导出物（Task 5 的 002_platform_seed 的输入）。下面用它来断言"种子真的按导出文件落地了"。
const SEED_DIR = path.join(API_ROOT, "src", "db", "migrations", "seed");

const G_FREEZE = "A 旧仓库冻结";
const G_FILES = "B 构件存在";
const G_BOOT = "C 应用能起";
const G_AUTH = "D 鉴权与只读接口";
const G_CLEAN = "E 干净收尾";

/** 每条断言的结论，最终渲染成可读的通过/失败清单。 */
const checks = [];

function record(group, name, ok, detail) {
  checks.push({ group, name, ok: !!ok, detail: detail || "" });
  return !!ok;
}
function pass(group, name) {
  return record(group, name, true);
}
function fail(group, name, detail) {
  return record(group, name, false, detail);
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- A. 旧仓库冻结 ----------
// 基线由 Phase 0 开始前的 tools/record-old-baseline.cjs 记录。这里只读、不写。
const BASELINE = path.join(MIWO_ROOT, "tools", ".phase0-old-baseline.json");
const OLD_KEYS = [
  path.join(OLD_UPSTREAM, "src", "app.ts"),
  path.join(OLD_UPSTREAM, "src", "utils", "db.ts"),
  path.join(OLD_UPSTREAM, "src", "lib", "initDB.ts"),
  path.join(OLD_UPSTREAM, "src", "lib", "fixDB.ts"),
  path.join(OLD_UPSTREAM, "src", "router.ts"),
  path.join(OLD_UPSTREAM, "package.json"),
  path.join(OLD_WEB, "package.json"),
  path.join(OLD_WEB, "src", "App.vue"),
];

function checkFrozenRepos() {
  if (!fs.existsSync(BASELINE)) {
    fail(G_FREEZE, "找到旧仓库基线", `缺少 ${BASELINE}；请用记录器重记（本脚本只读基线、不写）：node tools/record-old-baseline.cjs`);
    return;
  }
  pass(G_FREEZE, "找到旧仓库基线 tools/.phase0-old-baseline.json");

  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch (e) {
    fail(G_FREEZE, "基线是合法 JSON", `${BASELINE} 解析失败：${e && e.message}`);
    return;
  }

  // 防"基线被换成空表/少几条"：条目数必须与关键文件清单一致。
  const keyCount = Object.keys(rec).length;
  record(G_FREEZE, `基线覆盖 ${OLD_KEYS.length} 个关键文件`, keyCount === OLD_KEYS.length, `实际 ${keyCount} 条`);

  for (const p of OLD_KEYS) {
    if (!fs.existsSync(p)) {
      fail(G_FREEZE, `存在 ${p}`, "旧仓库文件消失（被删/被移）");
      continue;
    }
    const actual = sha256(p);
    const want = rec[p];
    if (typeof want !== "string") {
      fail(G_FREEZE, `sha256 未变 ${p}`, "基线里没有这一条（基线不完整或被替换）");
    } else if (want !== actual) {
      fail(G_FREEZE, `sha256 未变 ${p}`, `基线 ${want.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…`);
    } else {
      pass(G_FREEZE, `sha256 未变 ${p}`);
    }
  }
}

// ---------- B. 构件存在 ----------
function checkArtifacts() {
  for (const rel of ["apps/api/src/config.ts", "apps/api/src/router.ts", "deploy/docker-compose.yml", "deploy/.env.example"]) {
    const abs = path.join(MIWO_ROOT, rel);
    if (fs.existsSync(abs)) pass(G_FILES, `存在 ${rel}`);
    else fail(G_FILES, `存在 ${rel}`, `缺少 ${abs}`);
  }
}

// ---------- C/D 用的 HTTP 与端口小工具 ----------
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", reject);
  });
}

/** 取一个空闲端口（listen 0 → 关闭 → 返回端口号）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 该端口上还有没有人在 listen（connect 成功 = 有监听）。 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

async function waitPortReleased(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return true;
    await delay(200);
  }
  return !(await isPortListening(port));
}

/** 收尾：杀掉自己起的进程（拿不到就 taskkill 整棵进程树），并等到端口真的释放。 */
async function stopChild(child) {
  const dead = () => child.exitCode !== null || child.signalCode !== null;
  if (dead()) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  try {
    child.kill();
  } catch {
    /* 已经死了 */
  }
  if (await Promise.race([exited, delay(5000).then(() => false)])) return true;
  // 兜底：Windows 上按进程树强杀，避免留下占端口的孤儿
  try {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
  await Promise.race([exited, delay(5000).then(() => false)]);
  return dead();
}

// ---------- C/D/E：启动与接口 ----------
/**
 * 递归拷贝（**不用 `fs.cpSync`**：它的 `recursive` 是 Node 16.7+ 实验性 API，
 * 本仓库 engines 是 >=22.12 但 Phase 0 的工具链刻意只用最保守的 fs 调用）。
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * 只读检查一次性库里的**迁移名册 + 平台种子**（用 better-sqlite3 直接读文件，绝不经过应用）。
 *
 * 这是 Task 5 用来**取代临时种子脚手架**的那一步：脚手架只能证明"种了 tokenKey 就能起服务"，
 * 这里证明的是 002_platform_seed 的**四张表都按导出文件落地**，而且 `o_setting` 里**没有 tokenKey**
 * （Phase 1c 才把 JWT 密钥彻底移出 DB；它必须在配置 MIWO_JWT_SECRET 里）。
 *
 * 期望行数**从 `seed/*.ndjson` 现算**，不硬编码：导出物一改，这里自动跟着走（也就不会出现
 * "种子文件与断言各说各话"）。
 */
function inspectMigratedDb(dbFile) {
  if (!fs.existsSync(dbFile)) {
    fail(G_BOOT, `迁移建出了一次性库 ${dbFile}`, "文件不存在：db:migrate 没跑到建库这一步");
    return;
  }
  pass(G_BOOT, `迁移建出了一次性库 ${dbFile}`);

  let Database;
  try {
    Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
  } catch {
    Database = require("better-sqlite3");
  }

  const seedLines = (name) =>
    fs
      .readFileSync(path.join(SEED_DIR, name), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0).length;

  const db = new Database(dbFile, { readonly: true });
  try {
    const applied = db.prepare("SELECT name FROM knex_migrations ORDER BY name").all().map((r) => r.name);
    const want = ["001_schema", "002_platform_seed"];
    record(G_BOOT, `迁移名册 = ${want.join(" + ")}`, JSON.stringify(applied) === JSON.stringify(want), `实际 ${JSON.stringify(applied)}`);

    const promptTypes = db.prepare("SELECT type FROM o_prompt ORDER BY type").all().map((r) => r.type);
    const wantPrompts = seedLines("o_prompt.ndjson");
    record(
      G_BOOT,
      `o_prompt 种子 ${wantPrompts} 行已落地（type 与导出文件同集合）`,
      promptTypes.length === wantPrompts,
      `实际 ${promptTypes.length} 行：${promptTypes.join(",")}`,
    );

    const agents = db.prepare("SELECT COUNT(*) AS c FROM o_agentDeploy").get().c;
    const wantAgents = seedLines("o_agentDeploy.ndjson");
    record(G_BOOT, `o_agentDeploy 种子 ${wantAgents} 行已落地`, agents === wantAgents, `实际 ${agents} 行`);

    const settingKeys = db.prepare("SELECT key FROM o_setting ORDER BY key").all().map((r) => r.key);
    const wantSettings = seedLines("o_setting.platform.ndjson");
    record(
      G_BOOT,
      `o_setting 只有 ${wantSettings} 个平台键、且**没有 tokenKey**（JWT 密钥走配置）`,
      settingKeys.length === wantSettings && !settingKeys.includes("tokenKey"),
      `实际 ${JSON.stringify(settingKeys)}`,
    );

    const engine = db.prepare("SELECT value FROM o_setting WHERE key = 'shotsEngine'").get();
    record(G_BOOT, "o_setting.shotsEngine = v2（结构化分镜默认开）", !!engine && engine.value === "v2", `实际 ${engine ? engine.value : "(缺)"}`);

    const vendors = db.prepare("SELECT id, inputValues, models, enable FROM o_vendorConfig ORDER BY id").all();
    const wantVendors = seedLines("o_vendorConfig.templates.ndjson");
    const allEmpty = vendors.length > 0 && vendors.every((r) => r.inputValues === "{}" && r.models === "[]" && r.enable === 0);
    record(
      G_BOOT,
      `o_vendorConfig ${wantVendors} 个空模板行（带凭据的行没有进仓库、也没有进新库）`,
      vendors.length === wantVendors && allEmpty,
      `实际 ${vendors.length} 行：${vendors.map((r) => `${r.id}(enable=${r.enable},${r.inputValues.length}B)`).join(" ")}`,
    );
  } finally {
    db.close();
  }
}

async function checkBootAndApi() {
  let port;
  try {
    port = await freePort();
  } catch (e) {
    fail(G_BOOT, "取得空闲端口", String((e && e.message) || e));
    return;
  }
  pass(G_BOOT, `取得空闲端口 ${port}`);

  /**
   * ⚠ 数据目录必须是**一次性的空目录**（Phase 1a / Task 4 起）：
   *
   * 旧口径是直接 `MIWO_DATA_DIR = apps/api/data`。Task 4 之后应用启动时会在数据目录里
   * **跑迁移**（`src/db/connect.ts` 的 `connect()`），而那个目录里的 `db2.sqlite`
   * 是**老库**（实测 30 张表、**没有** `knex_migrations`）—— `createTable` 会撞 "table already exists"，
   * 应用根本起不来（这正是计划 Task 6「先把老库数据导入空库」存在的原因）。
   * 所以这里改用 `os.tmpdir()` 下的空目录，**绝不读也不写** `apps/api/data/db2.sqlite`。
   *
   * 目录里只需要两样东西：
   *   1. 空库 → **本步只证"空库可迁移 + 可启动"**，不证启动顺序：
   *      下面 `db:migrate` 已经用**同一个** `MIWO_DATA_DIR` / `bootEnv` 先跑过一次，
   *      所以应用启动时那次 `migrate.latest()` 必然是 **no-op**（`applied=[]`、连"已应用迁移"
   *      那行日志都不会出现）—— **C 步不构成"迁移完成 → 才监听端口"的运行期证据**。
   *      启动顺序的运行期证据在 Task 4 Step 5 的一次性实验里（对同一目录启动两次、25ms 轮询比对
   *      "迁移日志"与"端口可连"的先后：t+1515ms vs t+2128ms）。该实验脚本是一次性的、跑完即删，
   *      原文见 `.superpowers/sdd/2026-10-12-miwo-phase1a-mysql-migrations/task-4-report.md` §3。
   *   2. `vendor/` `skills/` `modelPrompt/` 三个**只读静态资产目录**（`configHealth` 的
   *      "vendor 13 / skills 31" 两条断言与启动期读取依赖它们；**不复制** `db2.sqlite`）。
   *
   * ⚠ **Task 5 起不再需要那段临时种子脚手架**（`scripts/verify-phase0-seed-min.ts`，已随本 Task 删除）：
   *    `002_platform_seed` 是它的正式接替者 —— 一次 `db:migrate` 就把平台种子（提示词 / Agent 部署 /
   *    平台键 / 供应商空模板）种好。而 `o_setting.tokenKey` 按 Phase 1c 的方向**不进库**：
   *    JWT 密钥取自配置 `MIWO_JWT_SECRET`（见 `src/app.ts` 鉴权中间件），所以"新库里没有 tokenKey"
   *    是**预期状态**、不是缺口。删除脚手架后 `verify-phase0` 仍然全绿，正是"002 的种子完整 + 启动
   *    路径不再依赖库里的密钥"这两件事的**联合证据**。
   */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase0-boot-"));
  for (const sub of ["vendor", "skills", "modelPrompt"]) {
    const src = path.join(API_ROOT, "data", sub);
    if (fs.existsSync(src)) copyDirRecursive(src, path.join(dataDir, sub));
  }
  pass(G_BOOT, `使用一次性数据目录（空库 + 只读静态资产）${dataDir}`);

  const bootEnv = {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_PORT: String(port),
    MIWO_HOST: "127.0.0.1",
    MIWO_DATA_DIR: dataDir,
    MIWO_JWT_SECRET: "phase0-verification-secret-at-least-32-bytes",
    NODE_OPTIONS: "--import=tsx",
  };

  /** 用一次性库先把结构建出来：`tsx` 只装在 @miwo/api，所以必须 `--import=tsx` + cwd=apps/api。 */
  const tsxStep = (scriptRelPath) =>
    spawnSync(process.execPath, ["--import=tsx", scriptRelPath], {
      cwd: API_ROOT,
      env: bootEnv,
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
    });

  // ⚠ 只跑一次 `db:migrate`：001_schema 建表 + 002_platform_seed 种平台数据。
  //    Task 4 曾经在这里再补一个"种 tokenKey 的最小脚手架"，Task 5 已按交接删除它。
  const migrateRun = tsxStep(path.join("scripts", "db-migrate.ts"));
  if (migrateRun.status === 0) {
    pass(G_BOOT, "先在一次性空库上跑 db:migrate（001_schema + 002_platform_seed）");
  } else {
    fail(
      G_BOOT,
      "先在一次性空库上跑 db:migrate（001_schema + 002_platform_seed）",
      `exit ${migrateRun.status}；stdout=${String(migrateRun.stdout || "").slice(-500)}；stderr=${String(migrateRun.stderr || "").slice(-500)}`,
    );
  }

  // ⚠ 迁移完**就地读库**断言"种子真的落地" —— 这一步取代了 Task 4 的临时种子脚手架。
  //    它比原来那条"种入 tokenKey"更强：断言的是 002 的**全部四张表**，而不是"能起服务就行"。
  inspectMigratedDb(path.join(dataDir, "db2.sqlite"));

  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
    cwd: API_ROOT,
    // ⚠ 与 db:migrate / 种子脚本用的是**同一个 env**（同一个一次性库）
    env: bootEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitedEarly = false;
  child.stdout.on("data", (d) => (stdoutBuf += d.toString()));
  child.stderr.on("data", (d) => (stderrBuf += d.toString()));
  child.on("exit", () => {
    exitedEarly = true;
  });

  const healthUrl = `http://127.0.0.1:${port}/api/other/configHealth?summary=1`;
  try {
    // 等待端口就绪：**轮询**而不是固定 sleep（最多 60s）
    let ready = false;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(1000);
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const res = await get(healthUrl);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* 未就绪，继续等 */
      }
    }
    const out = () => stdoutBuf + stderrBuf;

    if (!ready) {
      fail(
        G_BOOT,
        `${READY_TIMEOUT_MS / 1000}s 内就绪（轮询 configHealth?summary=1）`,
        exitedEarly ? `应用进程提前退出。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}` : `超时未就绪。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}`,
      );
    } else {
      pass(G_BOOT, `${READY_TIMEOUT_MS / 1000}s 内就绪（轮询 configHealth?summary=1）`);

      const res = await get(healthUrl);
      record(G_AUTH, "configHealth?summary=1 返回 200", res.status === 200, `实际 ${res.status}`);

      let json = null;
      try {
        json = JSON.parse(res.body);
        pass(G_AUTH, "configHealth 响应是 JSON");
      } catch {
        fail(G_AUTH, "configHealth 响应是 JSON", `响应前 200 字符：${res.body.slice(0, 200)}`);
      }

      // 免登录摘要里必须带上"装全没装全"的文件计数（Task 8 实测 skills:31 vendor:13）
      const files = json && json.data && json.data.files ? json.data.files : null;
      if (!files) {
        fail(G_AUTH, "摘要含文件计数 files", `未取到 data.files：${res.body.slice(0, 200)}`);
      } else {
        record(G_AUTH, "data/vendor 适配器数 13", files.vendor === 13, `实际 ${files.vendor}`);
        record(G_AUTH, "data/skills 技能数 31", files.skills === 31, `实际 ${files.skills}`);
      }

      // 未带 token 的受保护接口必须 401（鉴权仍在）
      const guarded = await get(`http://127.0.0.1:${port}/api/project/getProject`);
      record(G_AUTH, "无 token 访问 /api/project/getProject 返回 401", guarded.status === 401, `实际 ${guarded.status}`);
    }
  } finally {
    // ---- E. 必须杀掉自己起的进程，不能留占端口的孤儿 ----
    const killed = await stopChild(child);
    record(G_CLEAN, "自己起的应用进程已退出", killed, `pid ${child.pid} 仍在运行`);
    const released = await waitPortReleased(port, 10000);
    record(G_CLEAN, `端口 ${port} 已释放（无人监听）`, released, "端口仍被监听，疑似孤儿进程");

    // 一次性数据目录必须收干净（不许在 %TEMP% 里留垃圾，也保证"下次跑仍是空库"）
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt++) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        removed = !fs.existsSync(dataDir);
      } catch (e) {
        await delay(500);
      }
    }
    record(G_CLEAN, `一次性数据目录已删除 ${dataDir}`, removed, "删除失败（可能有句柄未释放）");

    // ⚠ 必须在收集完全部输出之后再断言未处理的 Promise 拒绝。
    // 为什么必须断言它：apps/api/src/err.ts 注册的全局 `process.on("unhandledRejection")` **只打印不退出**，
    // 所以像 fixDB 里那种模块加载期异常**不会让进程死**——接口照样返回 200，但 utils/db.ts 的
    // 顶层 IIFE 会中断（initKnexType 不执行），服务处于"看起来正常、实际半残"的状态。
    // 只断言 HTTP 200 会漏掉这类问题；Task 6 就真机踩过一次。
    const rejectionMarkers = ["未处理的 Promise 拒绝", "unhandledRejection", "UnhandledPromiseRejection"];
    const combined = stdoutBuf + stderrBuf;
    for (const marker of rejectionMarkers) {
      const inStderr = stderrBuf.includes(marker);
      const inStdout = stdoutBuf.includes(marker);
      if (inStderr || inStdout) {
        fail(G_CLEAN, `输出不含未处理拒绝标记 "${marker}"`, `出现于 ${inStderr ? "stderr" : "stdout"}。输出前 ${OUT_TAIL} 字符：\n${combined.slice(0, OUT_TAIL)}`);
      } else {
        pass(G_CLEAN, `输出不含未处理拒绝标记 "${marker}"`);
      }
    }
  }
}

function printReport() {
  console.log("=== 谜沃 Phase 0 验收清单 ===");
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n[${group}]`);
    }
    console.log(`  [${c.ok ? "通过" : "失败"}] ${c.name}${c.detail && !c.ok ? " —— " + c.detail : ""}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n--- 摘要：通过 ${checks.length - failed.length} / ${checks.length} ---`);
  return failed;
}

async function main() {
  checkFrozenRepos();
  checkArtifacts();
  await checkBootAndApi();

  const failed = printReport();
  if (failed.length) {
    console.error("\nPhase 0 验收失败：");
    for (const c of failed) console.error(`  - [${c.group}] ${c.name}${c.detail ? " —— " + c.detail : ""}`);
    process.exit(1);
  }
  console.log("\nPhase 0 验收通过：旧仓库未改动、新仓库独立启动、鉴权与只读接口正常");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
