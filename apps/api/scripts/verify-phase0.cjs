#!/usr/bin/env node
/**
 * 谜沃 Phase 0 验收（spec §13 Phase 0 判据）。
 *
 * 五组断言：
 *   A. 旧仓库冻结 —— 按 tools/.phase0-old-baseline.json 的 8 条 sha256 逐条比对
 *      （这是"旧仓库零改动"的**唯一可靠证明**；脏文件数会被 gitignore/临时文件干扰，不能用）
 *   B. 构件存在 —— 新仓库的关键路径/文件齐全
 *   C. 应用能起 —— 用 MIWO_* 环境变量在**空闲端口**独立启动（独立数据目录），轮询就绪
 *   D. 鉴权与只读接口 —— configHealth?summary=1 必须 200 且是 JSON；无 token 访问受保护接口必须 401，访问 /oss 与 /assets 必须 403
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
// ⚠ **下界**（Task 5 独立审查修复 1）：期望行数原本**只从 seed/*.ndjson 现算**，
//    于是"种子文件被清空/被截断成 0 行"时 0 === 0 **恒真通过** —— 被测值和期望值同源推导，
//    互相掩护。这里把四份文件的**基线行数**写死成常量：文件一旦被截断，下界断言当场变红，
//    而不是"文件说什么就是什么"。002 侧还有一道（缺失/0 行直接抛错），两道互为约束。
const SEED_EXPECT = { "o_prompt.ndjson": 4, "o_agentDeploy.ndjson": 19, "o_setting.platform.ndjson": 4, "o_vendorConfig.templates.ndjson": 8 };

/**
 * `005_accounts`（Phase 1c Task 1）有意新增的**平台级** `o_setting` 键。
 * 逐个点名（而不是只比数量）——"多一个键"与"少一个键"都必须能报出**是哪个**。
 */
const TASK1_SETTING_KEYS = ["registrationMode", "allowDbAdminOps"];

/**
 * 迁移名册的**真相**：`src/db/migrations/index.ts` 的 `MIGRATIONS` 数组。
 *
 * ⚠ 解析**不能**单独当判据（Task 11 / 控制器裁定 C = ★Ruling 132，与 Ruling 63 同族）：
 *    Task 10 把期望值从"写死清单"改成"从 `index.ts` 现解析"，方向可以理解（追加迁移不该误报），
 *    但它引入了一个**期望值从被测对象推导**的回路 —— 有人**删掉**一个迁移时，`MIGRATIONS` 变小、
 *    解析出的期望值跟着变小、库里也确实少了那一条 ⇒ **两边一起缩小，断言不红**。
 *    那正是 Ruling 63 的形态（"期望值与被测值同源 ⇒ 恒真"）。
 *
 * 现在两道一起用（见 `MIGRATION_ALLOWLIST` 与下面的断言）：
 *   ① **硬编码 allowlist**：已知迁移名逐个写死在这里，断言"解析出的名册 **⊇** allowlist"。
 *      追加迁移只需往 allowlist 加一行（**有意的**行为）；删掉既有迁移会**立刻红**。
 *   ② 解析名册非空 + 与库里 `knex_migrations` 的名字集合**逐个相等**（含顺序的历史断言在
 *      `tests/migrations.test.ts` 的 `n1).toEqual(NAMES)`）。
 *
 * ⚠ **`o_setting` 的平台键数**（Phase 1c Task 1）：下面的断言原来写"恰好 4 个（= 种子文件行数，
 *   且没有 tokenKey）"。`005_accounts` 有意**新增**两个平台开关（§15 O1 的 `registrationMode`、
 *   §7.3 的 `allowDbAdminOps`），所以口径改成"种子 4 个 + Task 1 的 2 个 = 6 个"，并把新键**逐个点名**。
 *   这不是放宽：`settingKeys.length === wantSettings + TASK1_SETTING_KEYS.length` 仍是**精确**相等，
 *   同时"没有 tokenKey"这条判据原样保留（tokenKey 由 005 从库里删掉、改由 MIWO_JWT_SECRET 提供）。
 */
function expectedMigrationNames() {
  const migrationsDir = path.join(API_ROOT, "src", "db", "migrations");
  const src = fs.readFileSync(path.join(migrationsDir, "index.ts"), "utf8");
  const imported = new Map();
  for (const line of src.split(/\r?\n/)) {
    const m = /^import\s+(\w+)\s+from\s+["']@\/db\/migrations\/(\d{3}_[A-Za-z0-9_]+)["']/.exec(line.trim());
    if (m) imported.set(m[1], path.join(migrationsDir, `${m[2]}.ts`));
  }
  const arr = /export\s+const\s+MIGRATIONS\s*:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!arr) return [];
  const body = arr[1].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  return body
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\w+$/.test(x))
    .map((alias) => {
      const migrationFile = imported.get(alias);
      if (!migrationFile || !fs.existsSync(migrationFile)) return null;
      const migrationSource = fs.readFileSync(migrationFile, "utf8");
      return /\bname\s*:\s*["']([^"']+)["']/.exec(migrationSource)?.[1] ?? null;
    })
    .filter(Boolean);
}

/**
 * **硬编码**的已知迁移名 allowlist（Task 11 / 控制器裁定 C）。
 *
 * ⚠ **删掉一行 = 削弱判据**，不要这么做。它是"解析名册 ⊇ 这个集合"里的那个**不动点**：
 *    唯一的合法改动是**追加**（有了新迁移就往末尾加一行，与 `MIGRATIONS` 数组同步）。
 *    ⚠ 这里刻意**不**写成"从 index.ts 推导的下界"，也不写成"长度 >= N"：前者是回路本身，
 *    后者在"删一个旧的、加一个新的"时仍然不红（数量守恒），而这两件事的语义完全相反。
 *    **逐名**写死才能同时锁住"没被删"和"没被换"。
 */
const MIGRATION_ALLOWLIST = ["001_schema", "002_platform_seed", "003_vendor_asset_sync", "004_backfill_userid", "005_accounts", "006_quota_grants"];


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
const BASELINE = process.env.MIWO_PHASE0_BASELINE
  ? path.resolve(process.env.MIWO_PHASE0_BASELINE)
  : path.join(MIWO_ROOT, "tools", ".phase0-old-baseline.json");
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
  // Phase 1a / Task 11：启动路径的**结构真相**已从 `lib/{initDB,fixDB}.ts` 迁到
  // `src/db/migrations/`。那两个旧文件仍然存在（Phase 1c 才删），但它们**不再**是
  // "新仓库能起"的构件 —— 所以这里换成迁移目录的入口（条数不变：4 → 4，
  // ⚠ 是**替换**一条，不是新增/删除，别把总数改动）。
  for (const rel of ["apps/api/src/config.ts", "apps/api/src/router.ts", "apps/api/src/db/migrations/index.ts", "deploy/docker-compose.yml", "deploy/.env.example"]) {
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
 * ⚠ `seed/*.ndjson` 的期望行数**从文件现算**，同时**必须**满足 SEED_EXPECT 的下界/基线
 *   （Task 5 独立审查修复 1）：单靠"现算"会让"文件被清空"变成 0 === 0 的恒真通过。
 *
 * ⚠ 整个函数包在 try/catch 里（Task 5 独立审查修复 4）：种子目录缺失、文件读不到、
 *   better-sqlite3 装不上之类都必须变成**带标签的失败断言**，而不是让本脚本抛裸栈
 *   （裸栈会让 E 组"临时目录已清理"根本不执行 → %TEMP% 里留 boot 目录）。
 */
function inspectMigratedDb(dbFile) {
  if (!fs.existsSync(dbFile)) {
    fail(G_BOOT, `迁移建出了一次性库 ${dbFile}`, "文件不存在：db:migrate 没跑到建库这一步");
    return;
  }
  pass(G_BOOT, `迁移建出了一次性库 ${dbFile}`);

  let db = null;
  try {
    let Database;
    try {
      Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
    } catch {
      Database = require("better-sqlite3");
    }

    // 期望行数：**先**按 SEED_EXPECT 的基线核对文件本身（被清空 / 被截断当场红），再据此比对库里落地情况。
    const seedLines = {};
    let seedOk = true;
    for (const [name, want] of Object.entries(SEED_EXPECT)) {
      const p = path.join(SEED_DIR, name);
      let got = null;
      let why = "";
      try {
        got = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0).length;
      } catch (e) {
        why = `${p} 读不到：${e && e.message}`;
      }
      seedLines[name] = got;
      if (got === null) {
        seedOk = false;
        fail(G_BOOT, `种子文件 ${name} 存在且可读`, why);
      } else if (got < want) {
        seedOk = false;
        fail(G_BOOT, `种子文件 ${name} 至少有 ${want} 行（下界，防截断/清空）`, `实际 ${got} 行：${p}`);
      } else {
        pass(G_BOOT, `种子文件 ${name} ${got} 行（基线 ${want}）`);
      }
    }

    db = new Database(dbFile, { readonly: true });
    const applied = db.prepare("SELECT name FROM knex_migrations ORDER BY name").all().map((r) => r.name);
    // ⚠ 期望值来自 `MIGRATIONS`（源码真相）而不是写死的清单；解析失败必须响亮地红，不能 0 === 0 恒真。
    //    两边都按名字排序后比**集合**："库里恰好是这套名册、不多不少"才是这条要断言的事；
    //    执行顺序由 `tests/migrations.test.ts` 的 `n1).toEqual(NAMES)` 与幂等用例钉住（那里是顺序敏感的）。
    const parsed = expectedMigrationNames().sort();
    if (!record(G_BOOT, "能从 src/db/migrations/index.ts 解析出非空迁移名册", parsed.length > 0, `解析到 ${JSON.stringify(parsed)}`)) {
      /* 已记失败，继续跑后面的断言（后面的结论仍然要打印出来） */
    }

    // ---- 裁定 C（★Ruling 132）：解析名册 **⊇ 硬编码 allowlist** ----
    // ⚠ 这一条**故意**与上面那条"解析得出来"分开记：它们治的是两个不同的病。
    //   上面治"解析正则失效 ⇒ 空清单 vs 空清单恒真"；这一条治"期望值从被测对象推导 ⇒
    //   删掉一个迁移时期望也跟着缩小、于是不红"。缺了它，`MIGRATIONS` 少一项就查不出来。
    const missingFromParsed = MIGRATION_ALLOWLIST.filter((n) => !parsed.includes(n));
    record(
      G_BOOT,
      `解析名册包含全部 ${MIGRATION_ALLOWLIST.length} 条硬编码已知迁移（${MIGRATION_ALLOWLIST.join(" + ")}）`,
      missingFromParsed.length === 0,
      missingFromParsed.length
        ? `名册里**少了** ${JSON.stringify(missingFromParsed)} —— 既有迁移被删/被改名了。` +
          `⚠ 若这是**有意**删除，必须同时删掉 verify-phase0.cjs 的 MIGRATION_ALLOWLIST 里那一行（那是一次判据修改，不是一次"修复"）；` +
          `若只是新增迁移，往 allowlist 末尾**追加**一行即可。解析到 ${JSON.stringify(parsed)}`
        : `解析到 ${JSON.stringify(parsed)}`,
    );

    const appliedSorted = [...applied].sort();
    record(
      G_BOOT,
      `迁移名册 = ${parsed.join(" + ") || "(空)"}`,
      parsed.length > 0 && JSON.stringify(appliedSorted) === JSON.stringify(parsed),
      `实际 ${JSON.stringify(applied)}`,
    );

    // ---- o_prompt：行数 + **排序后的 type 集合**都要与导出文件一致 ----
    // ⚠ 原来标签写的是"type 同集合"、实际只比了行数：行数相等而 type 换了（例如种错表 / 种串了行）
    //    照样通过。这里改成真的比集合（Task 5 独立审查修复 4）。
    const promptTypes = db.prepare("SELECT type FROM o_prompt ORDER BY type").all().map((r) => r.type);
    let wantPromptTypes = null;
    try {
      wantPromptTypes = fs
        .readFileSync(path.join(SEED_DIR, "o_prompt.ndjson"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l).type)
        .sort();
    } catch (e) {
      fail(G_BOOT, "o_prompt 导出文件可解析出 type 集合", `${e && e.message}`);
    }
    if (wantPromptTypes) {
      record(
        G_BOOT,
        `o_prompt 种子 ${wantPromptTypes.length} 行已落地，且 type 集合与导出文件一致`,
        JSON.stringify(promptTypes) === JSON.stringify(wantPromptTypes),
        `实际 ${promptTypes.length} 行：[${promptTypes.join(",")}]；期望 [${wantPromptTypes.join(",")}]`,
      );
    }

    const agents = db.prepare("SELECT COUNT(*) AS c FROM o_agentDeploy").get().c;
    const wantAgents = seedLines["o_agentDeploy.ndjson"];
    record(G_BOOT, `o_agentDeploy 种子 ${wantAgents} 行已落地`, seedOk && agents === wantAgents, `实际 ${agents} 行`);

    const settingKeys = db.prepare("SELECT key FROM o_setting ORDER BY key").all().map((r) => r.key);
    const wantSettings = seedLines["o_setting.platform.ndjson"];
    record(
      G_BOOT,
      `o_setting 只有 ${wantSettings} 个种子平台键 + Task 1 的 ${TASK1_SETTING_KEYS.length} 个开关（共 ${wantSettings + TASK1_SETTING_KEYS.length}）、且**没有 tokenKey**（JWT 密钥走配置）`,
      seedOk &&
        settingKeys.length === wantSettings + TASK1_SETTING_KEYS.length &&
        !settingKeys.includes("tokenKey") &&
        TASK1_SETTING_KEYS.every((k) => settingKeys.includes(k)),
      `实际 ${JSON.stringify(settingKeys)}`,
    );

    const engine = db.prepare("SELECT value FROM o_setting WHERE key = 'shotsEngine'").get();
    record(G_BOOT, "o_setting.shotsEngine = v2（结构化分镜默认开）", !!engine && engine.value === "v2", `实际 ${engine ? engine.value : "(缺)"}`);

    const vendors = db.prepare("SELECT id, inputValues, models, enable FROM o_vendorConfig ORDER BY id").all();
    const wantVendors = seedLines["o_vendorConfig.templates.ndjson"];
    const allEmpty = vendors.length > 0 && vendors.every((r) => r.inputValues === "{}" && r.models === "[]" && r.enable === 0);
    record(
      G_BOOT,
      `o_vendorConfig ${wantVendors} 个空模板行（带凭据的行没有进仓库、也没有进新库）`,
      seedOk && vendors.length === wantVendors && allEmpty,
      `实际 ${vendors.length} 行：${vendors.map((r) => `${r.id}(enable=${r.enable},${r.inputValues.length}B)`).join(" ")}`,
    );
  } catch (e) {
    // 兜底：任何未预料的异常（种子目录不存在 / 依赖缺失 / 库被写坏）都变成一条带标签的失败断言。
    fail(G_BOOT, "一次性库检查（inspectMigratedDb）正常跑完", `抛出异常：${(e && e.stack) || e}`);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* 关不掉就算了，别让它盖掉上面的断言结果 */
      }
    }
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
   *   2. `skills/` `modelPrompt/` 两个**只读静态资产目录**（`configHealth` 的技能计数与启动期读取
   *      依赖它们；**不复制** `db2.sqlite`）。
   *      ⚠ Phase 1c Task 8：原来还有 `vendor/`（沙箱执行的适配器文件）。适配器已改成**编译期内置**的
   *        `src/vendors/*.ts`（esbuild 打进产物）⇒ 运行期不再有 `data/vendor`，这里也不再拷它。
   *        上面两个目录是**必需**的：缺了说明 checkout 不完整（旧写法 `if existsSync` 是静默跳过，
   *        会让下面的"skills 31"断言变成空转 —— 现在直接 fail）。
   *      （`vendor/` 若将来又出现，仍会被一并拷进去 —— 保留那个可选分支只是为了别把老数据目录弄坏。）
   *
   * ⚠ **Task 5 起不再需要那段临时种子脚手架**（`scripts/verify-phase0-seed-min.ts`，已随本 Task 删除）：
   *    `002_platform_seed` 是它的正式接替者 —— 一次 `db:migrate` 就把平台种子（提示词 / Agent 部署 /
   *    平台键 / 供应商空模板）种好。而 `o_setting.tokenKey` 按 Phase 1c 的方向**不进库**：
   *    JWT 密钥取自配置 `MIWO_JWT_SECRET`（见 `src/app.ts` 鉴权中间件），所以"新库里没有 tokenKey"
   *    是**预期状态**、不是缺口。删除脚手架后 `verify-phase0` 仍然全绿，正是"002 的种子完整 + 启动
   *    路径不再依赖库里的密钥"这两件事的**联合证据**。
   */
  // ⚠ 一次性数据目录的创建/拷贝也可能抛（磁盘满、路径无权限、资产被占用）。
  //    Task 5 独立审查修复 4：抛之前必须**先把刚建出来的目录删掉**，否则 %TEMP% 里会留一个
  //    `miwo-phase0-boot-*` 残骸；而 `mkdtempSync` 的路径也没法在 finally 里补删（那时 dataDir 还没赋值）。
  let dataDir;
  try {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase0-boot-"));
    // ⚠ 必需目录缺失必须**红**（不是静默跳过）：它们是"受控资产在 checkout 里"的判据，
    //   缺了的话后面 configHealth 的计数断言会在"空目录"上假绿。
    for (const sub of ["skills", "modelPrompt"]) {
      const src = path.join(API_ROOT, "data", sub);
      if (!fs.existsSync(src)) throw new Error(`受控资产目录缺失：${src}`);
      copyDirRecursive(src, path.join(dataDir, sub));
    }
    // `vendor/`：Phase 1c Task 8 之后正常不存在（适配器已编译期内置）⇒ 可选，存在才拷。
    for (const sub of ["vendor"]) {
      const src = path.join(API_ROOT, "data", sub);
      if (fs.existsSync(src)) copyDirRecursive(src, path.join(dataDir, sub));
    }
  } catch (e) {
    if (dataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* 删不掉就如实记一条失败 */
      }
    }
    fail(G_BOOT, "创建一次性数据目录并拷入只读静态资产", `抛出异常：${(e && e.message) || e}；目录 ${dataDir || "(未创建)"} ${dataDir && fs.existsSync(dataDir) ? "仍在" : "已清理"}`);
    return;
  }
  pass(G_BOOT, `使用一次性数据目录（空库 + 只读静态资产）${dataDir}`);

  const bootEnv = {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_PORT: String(port),
    MIWO_HOST: "127.0.0.1",
    MIWO_DATA_DIR: dataDir,
    // ⚠ Phase 1a / Task 11：本脚本是"全新空目录 + 空库能不能起"的验收，**必须显式用 sqlite**。
    //    否则 `apps/api/.env` 里若设了 `MIWO_DB_DRIVER=mysql`，它就会去连一个可能不存在的 MySQL，
    //    把"空库能起"验成"MySQL 连不上"。数据目录已经是一次性目录，驱动也必须同样是一次性的。
    MIWO_DB_DRIVER: "sqlite",
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

  // ⚠ 从此处起必须在 finally 里收干净（Task 5 独立审查修复 4）：
  //    原实现把"删一次性目录"写在应用就绪分支的 finally 里 —— 只要走 `return`
  //    （迁移失败 / 起不来之外的分支）就**不经过**那里，`%TEMP%\miwo-phase0-boot-*` 会残留。
  let child = null;
  try {
    child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
      cwd: API_ROOT,
      // ⚠ 与 db:migrate / 种子脚本用的是**同一个 env**（同一个一次性库）
      env: bootEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    // spawn 同步失败（例如 execPath 不可执行、资源耗尽）：记一条带标签的失败，进程没起来。
    fail(G_BOOT, "启动应用子进程（tsx src/app.ts）", `spawn 抛出异常：${(e && e.message) || e}`);
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitedEarly = false;
  if (child) {
    child.stdout.on("data", (d) => (stdoutBuf += d.toString()));
    child.stderr.on("data", (d) => (stderrBuf += d.toString()));
    child.on("exit", () => {
      exitedEarly = true;
    });
  }

  const healthUrl = `http://127.0.0.1:${port}/api/other/configHealth?summary=1`;
  try {
    // 等待端口就绪：**轮询**而不是固定 sleep（最多 60s）
    let ready = false;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (child && Date.now() < deadline) {
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
        child === null
          ? "应用子进程没能启动（见上一条断言），无法轮询"
          : exitedEarly
            ? `应用进程提前退出。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}`
            : `超时未就绪。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}`,
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

      // 免登录摘要里必须带上"装全没装全"的文件计数（Task 8 实测 skills:31）
      const files = json && json.data && json.data.files ? json.data.files : null;
      if (!files) {
        fail(G_AUTH, "摘要含文件计数 files", `未取到 data.files：${res.body.slice(0, 200)}`);
      } else {
        // ⚠ Phase 1c Task 8：`vendor` 的值从"数据目录下的 .ts 数"改成 `builtin:<n>`
        //   （适配器是编译期内置的，数据目录里已经**没有** vendor/ 了 —— 再数目录会得 -1，
        //   被读成"资产没装全"，那是假红）。断言口径同步改成"内置注册表里有 13 个"。
        record(G_AUTH, "内置供应商适配器数 13（src/vendors，编译期内置）", files.vendor === "builtin:13", `实际 ${files.vendor}`);
        record(G_AUTH, "data/skills 技能数 31", files.skills === 31, `实际 ${files.skills}`);
      }

      // 未带 token 的受保护接口必须 401（鉴权仍在）
      const guarded = await get(`http://127.0.0.1:${port}/api/project/getProject`);
      record(G_AUTH, "无 token 访问 /api/project/getProject 返回 401", guarded.status === 401, `实际 ${guarded.status}`);

      // mediaAuthGuard 在查找对象前拒绝匿名访问，因此这里故意使用不存在的对象 key。
      for (const prefix of ["/oss", "/assets"]) {
        const media = await get(`http://127.0.0.1:${port}${prefix}/__verify-phase0-nonexistent__`);
        record(G_AUTH, `匿名 GET ${prefix}/不存在对象返回 403`, media.status === 403, `实际 ${media.status}`);
      }
    }
  } finally {
    // ---- E. 必须杀掉自己起的进程，不能留占端口的孤儿 ----
    if (child) {
      const killed = await stopChild(child);
      record(G_CLEAN, "自己起的应用进程已退出", killed, `pid ${child.pid} 仍在运行`);
    } else {
      // spawn 就没成功：没有进程可杀，这条断言记为通过（"没有孤儿进程"是真的），
      // 启动失败本身已经在上面的 G_BOOT 里单独记了一条失败。
      pass(G_CLEAN, "自己起的应用进程已退出（spawn 未成功，无进程可杀）");
    }
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
