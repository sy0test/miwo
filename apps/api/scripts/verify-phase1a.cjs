#!/usr/bin/env node
/**
 * 谜沃 Phase 1a 验收（spec §13 + §12.2 T5）。
 *
 * 用法（在仓库根跑）：`node apps/api/scripts/verify-phase1a.cjs`，或 `pnpm.cmd run verify:phase1a`
 * 退出码 0 = 通过；逐条打印 [通过]/[失败]。
 *
 * ── 两种口径：本机 vs CI（`--ci`）【Ruling 156 落地轮·裁定 B】──
 * 本脚本里有**两条本机专属**的检查，在**全新树（CI）上必然失败**，而 `ci.yml` 又强制跑它：
 *   ① 旧仓库 sha256 冻结读 `tools/.phase0-old-baseline.json`，该文件被 `.gitignore:12` 忽略
 *      （`git archive HEAD` 的全新树里 `Test-Path` = **False**）；
 *   ② `verify:legacy-freeze --check` 需要**仓库外**两个旧仓（无 remote 的 runner 上不可能有）。
 *   全新树里实跑过：**EXIT 1**。这不是"实现有问题"，而是"CI 跑了一条本机专属命令"。
 *
 * 处置（**没有削弱任何断言**）：加 `--ci`，把这两条**显式记为「CI 不适用」**并移出通过计数
 * （`[信息]` 前缀，不计入 `通过 N / M`）—— 它们在本机口径下**照旧是真判据**。
 * ⚠ **不是**静默跳过：现在 fail 是诚实的，所以这里也保持诚实 —— CI 模式下会**逐条打印**
 *   「CI 不适用 + 原因 + 本机该跑什么」，谁都能看见少了什么、以及为什么。
 *   （另两条路 —— 删掉这两条、或改成恒真 —— 都是把诚实换成了好看，已排除。）
 * 对应的 CI 命令是 `pnpm run verify:phase1a:ci`（= 本文件 + `--ci`）；本机命令不变。
 *
 * 断言分组：
 *   A 构件：迁移机制与工具链的产物存在
 *   B 库层：sqlite 空目录能起、迁移幂等、33 张表齐、退役表不存在
 *   C 数据层：导出 → 导入(dry-run) → 比对 三个脚本可执行且对 dev 库 EXIT 0
 *   D 静态 MySQL DDL：不连服务器也能证明 mysql 侧的 DDL 合法（自增/varchar 主键/唯一键）
 *   E 仓库卫生：门禁脚本全绿、无启动期写盘、旧仓库零改动
 *   F MySQL（可选）：若 MIWO_TEST_MYSQL=1 且有服务，跑 verify-mysql-migration.cjs
 *
 * ── 本脚本与 brief 原文的**四处**差异（都是实跑打出来的，理由写在各自断言旁）──
 *
 *   1. **C 组不是"只跑 export"**（brief 原文只跑导出，注释却写着"导出/导入/比对三个脚本"）。
 *      这里补上 `import-mysql.cjs`（**dry-run**，不写库）与 `compare-db.cjs`：
 *      一个只跑第一步的"数据层"验收，无法证明后两步；而 Task 6/8 的交付物恰恰是后两步。
 *      三处都显式给 `MIWO_DATA_DIR=<仓库 dev 数据目录>`，所以不会碰到"目标是不是 dev 库"的歧义。
 *
 *   2. **`export-sqlite.cjs` 必须带 `--import=tsx`**：它内部要用 knex 需要 `001_schema.ts`
 *      （`scripts/schema-limits.cjs` 的 `deriveTargetLimits`），纯 `node` 跑会
 *      `ERR_MODULE_NOT_FOUND: Cannot find package '@/db'`（**实测**，exit 1）。`package.json`
 *      的 `db:export` 早就写了 `--import=tsx`，brief 原文漏了。
 *
 *   3. **C 组容忍"没有 dev 库"**（CI 上 `apps/api/data/db2.sqlite` 被 .gitignore 忽略）：
 *      那时 C 组记一条**显式**结论（不是静默早退 —— 见控制器裁定 B / `tools/check-test-early-return.cjs`）。
 *
 *   4. **裁定 A / B / C 各有一组判别力自证**（A 在 A 组末尾、B 在 E 组、C 在 B 组）：
 *      门禁如果只断言"结论是对的"，就无法证明它**能变红**。三条都在下面显式构造。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const MIWO_ROOT = path.resolve(API_ROOT, "..", "..");
// 复用裁定 A 的护栏本体（它自己解析 env，不依赖 @/config，所以命令行脚本可以先用它拦下来）。
const guard = require("./db-target-guard.cjs");

/**
 * 【裁定 B】CI 口径。`--ci` 时把两条**本机专属**检查显式记为「CI 不适用」（见文件头）。
 * ⚠ 判据是**显式旗标**，不是 `process.env.CI`：环境变量在本地也能被设成任意值，
 *   而"这条检查到底跑没跑"必须是调用方**说出来**的（同 `--allow-repo-dev-db` 的口径）。
 */
const CI_MODE = process.argv.slice(2).includes("--ci");

const checks = [];
/**
 * 记一条判据。
 *
 * ⚠⚠ **【本文件最严重的一处历史缺陷，必做修复轮修掉】**
 * 原声明是 `const pass = (g, n, d) => …`（**只有 3 个形参**），而文件里有 **15 处**调用写成
 * `pass(g, n, 条件, 详情)` —— JS 会**静默丢弃**第 4 个实参，于是：
 *   · `条件` 从来没被求值过；
 *   · `详情` 也从来没被打印过；
 *   · `ok` 是**硬编码 `true`** ⇒ 这 15 条断言**恒真**。
 * 受害的恰恰是最要紧的那一批：**裁定 A 的全部"判别力自证"**（A 组 5 条）、
 * B 组的 `it.skipIf` 形态断言、C 组的"导出表集合逐名相等"/"源库 sha256 前后一致"、
 * 以及"dry-run 没有偷偷写库"（`applied === false`）等。
 * 也就是说：**这些"门禁"在改动前无论被测对象是什么样都会报通过** ——
 * 正是本阶段反复抓到的"看着在检查、其实什么都没查"的最恶劣形态（Ruling 120/156 同族）。
 *
 * 判别力证据（本修复轮的 F 自证暴露的）：把 `db-migrate.ts` 的未知旗标白名单整段注释掉，
 * 本脚本仍然打印 `通过 73 / 73`、EXIT 0 —— 因为那条断言的条件被丢进了这个不存在的第 4 参。
 *
 * 修法（**不改变任何调用点的语义**，只让它真的生效）：
 *   · 给 `pass`/`fail` 补上第 3 个形参 `cond`，把它变成**可选**的；
 *   · **有 4 个实参** ⇒ 第 3 个是**条件**、第 4 个是详情，`ok` 由条件决定；
 *   · **有 3 个实参** ⇒ 沿用旧语义（第 3 个是详情），保持既有的"信息性/结论性"调用点不变；
 *   · **有 2 个实参** ⇒ 只有名字、无详情（旧写法里也存在）。
 * ⚠ 这个"按实参个数分流"是**刻意**的：文件里同时存在这些写法，而**旧语义必须原样保留**
 *   （例如 `pass(G_DDL, "…全绿", 摘要)` 那类"条件已在上面的 if 里判过"的调用点）。
 *   为了不让这个分流再次退化成"静默丢弃"，下面**显式抛错**：实参个数不在 2..4 就直接红。
 */
function makeCheck(ok) {
  return function record(g, n, a, b) {
    const argc = arguments.length;
    if (argc < 2 || argc > 4) {
      // 宁可炸掉整个验收，也不接受"实参个数悄悄漂移"—— 那正是本条注释在防的事。
      throw new Error(
        `[verify-phase1a] ${ok ? "pass" : "fail"}() 的实参个数必须是 2（名）/ 3（名+详情）/ 4（名+条件+详情），实际 ${argc}：${String(n)}`,
      );
    }
    const hasCond = argc === 4;
    return checks.push({
      g,
      ok: hasCond ? Boolean(a) : ok,
      n,
      d: (hasCond ? b : a) || "",
    });
  };
}
const pass = makeCheck(true);
const fail = makeCheck(false);
/**
 * 【裁定 B】**信息性**结论：**不计入** `通过 N / M`，也永不判红。
 *
 * 为什么要单独一类（而不是复用 `pass`）：`pass` 会把"CI 上没跑这条本机专属检查"记成一条**通过**，
 * 于是摘要里的 `通过 N / M` 就掺了水 —— 读数字的人会以为"这条判据也过了"。
 * 用它的是 `--ci` 下那两条本机专属检查（旧仓库冻结基线 / legacy-freeze），
 * 它们会**显式打印**「CI 不适用 + 原因 + 本机该跑什么」，只是不冒充判据。
 */
const info = (g, n, d) => checks.push({ g, ok: true, info: true, n, d: d || "" });
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    cwd: opts.cwd || MIWO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
    // ⚠ 显式给 timeout：子进程挂住时要**变成一条失败**，而不是把整个验收挂在那里。
    timeout: opts.timeout || 600000,
    shell: opts.shell || false,
    windowsHide: true,
  });
/** 把 spawn 的 stdout/stderr 拼成一段可用于失败详情的文本。 */
const outOf = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const tail = (s, n) => String(s || "").slice(-n);

const G_FILES = "A 构件";
const G_DB = "B 库层";
const G_DATA = "C 数据层";
const G_DDL = "D MySQL DDL(静态)";
const G_HYGIENE = "E 仓库卫生";
const G_MYSQL = "F MySQL(可选)";

/** 仓库里的 dev 数据目录与 dev 库（C 组显式用它，等价于 `pnpm db:export` 的默认目标）。 */
const DEV_DATA_DIR = path.join(API_ROOT, "data");
const DEV_DB = path.join(DEV_DATA_DIR, "db2.sqlite");

/**
 * 【M4 修复】脚本**一开头**就记下 dev 库的 sha256，E 组结尾拿它比对。
 *
 * 为什么必须在最开头：C 组（导出 / 闭环）**以 dev 库为源**，是本验收唯一可能碰到它的地方。
 * 只在这里记一次，才能回答"**是本验收把它写坏的吗**"——若在 C 组之后才记，写坏就已经被吸收进基线了。
 */
const sha256Of = (p) => (fs.existsSync(p) ? require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null);
const DEV_DB_BEFORE = sha256Of(DEV_DB);

/**
 * "指向某个 sqlite 一次性目标库"的**完整** env。
 *
 * ⚠ 为什么必须整套给：`import-mysql.cjs` / `compare-db.cjs` 会 spawn `--import=tsx` 的 runner，
 *    而 runner 会加载 `src/config.ts`（模块级 `export const config = loadConfig()`，fail-fast）。
 *    只给 `MIWO_DATA_DIR` 会直接 `ConfigError: 缺少必需环境变量 MIWO_ENV` —— **实测**踩过一次。
 *    （`MIWO_DB_DRIVER: "sqlite"` 也要显式给：裁定 A 的护栏把"没写驱动"当成危险信号。）
 */
function targetEnv(dataDir) {
  return {
    MIWO_ENV: "dev",
    MIWO_PORT: "10599",
    MIWO_HOST: "127.0.0.1",
    MIWO_JWT_SECRET: "phase1a-verification-secret-at-least-32-bytes",
    MIWO_DB_DRIVER: "sqlite",
    MIWO_DATA_DIR: dataDir,
  };
}
/**
 * **1a 的业务表清单**：27 张（`001_schema` 的 createTable 集合）。
 *
 * ⚠ 它现在有**两个**用途，别混：
 *   ① **全新一次性库**里跑完全部迁移后的业务表集合 —— 那是 33 张（Phase 1c Task 1 又建了 6 张），
 *      见 `EXPECT_TABLES_ALL_MIGRATIONS`；
 *   ② 与**老库导出物**比对时的口径 —— 见 `LEGACY_EXPORT_TABLES`（26 张，**不含 `o_user`**）。
 */
const EXPECT_TABLES = [
  "memories", "o_agentDeploy", "o_agentWorkData", "o_artStyle", "o_assets", "o_assets2Storyboard",
  "o_assetsRole2Audio", "o_event", "o_eventChapter", "o_image", "o_imageFlow", "o_modelPrompt",
  "o_novel", "o_project", "o_prompt", "o_script", "o_scriptAssets", "o_segment", "o_setting",
  "o_shot", "o_shotAssets", "o_storyboard", "o_tasks", "o_user", "o_vendorConfig", "o_video",
  "o_videoTrack",
];
/** 全部迁移跑完之后，**全新库**里的业务表 = 1a 的 27 张 + Phase 1c Task 1 的 6 张（005 四张 + 006 两张）。 */
const EXPECT_TABLES_ALL_MIGRATIONS = [
  ...EXPECT_TABLES,
  "o_account", "o_modelGrant", "o_invite", "o_loginAttempt", "o_auditLog", "o_userSetting",
];
/**
 * **老库搬迁范围**（= `scripts/export-sqlite.cjs` 的 `TABLES` 与 `src/db/legacy/import.ts` 的
 * `LEGACY_TABLES`，两处逐名一致）。
 *
 * ⚠【Phase 1c Task 1】27 → **26**：`o_user` 被移出搬迁范围 —— 老库那张表是明文口令的 3 列
 *   （`id`/`name`/`password`），而 `005_accounts` 之后目标是 §7.1 的 10 列
 *   （`username`/`passwordHash`/…）；按同名同列导入会因 NOT NULL 无默认值整表插不进去
 *   （实测 `SQLITE_CONSTRAINT_NOTNULL`），强插成功更糟（= 把明文口令带进新系统）。
 *   账号迁移归 `005_accounts` 的 up + bootstrap 流程。
 *   ⚠ 下面的断言用 `EXPECT_TABLES = LEGACY_EXPORT_TABLES + {o_user}` 把这条差**钉死**：
 *   多一张、少一张都红，而不是"随手改个数字"。
 */
const LEGACY_EXPORT_TABLES = EXPECT_TABLES.filter((t) => t !== "o_user");
/** 退役表（spec §5.4）：新库里**不许**出现。 */
const RETIRED_TABLES = ["o_skillList", "o_skillAttribution"];

// ---------- A ----------
for (const rel of [
  "apps/api/src/db/dialect.ts",
  "apps/api/src/db/connect.ts",
  "apps/api/src/db/migrations/index.ts",
  "apps/api/src/db/migrations/001_schema.ts",
  "apps/api/src/db/migrations/002_platform_seed.ts",
  "apps/api/src/db/migrations/seed/o_prompt.ndjson",
  "apps/api/src/db/legacy/import.ts",
  "apps/api/src/db/legacy/vendor-merge.ts",
  "apps/api/scripts/db-migrate.ts",
  "apps/api/scripts/mysql-local.ps1",
  "README.md", // 数据层手册的落点（原写 apps/api/README-db.md，该文件全仓不存在）
  "apps/api/tests/mysql-integration.test.ts",
  // ---- Task 11 新增（裁定 A/B 的机制本体，见下面各自的判别力自证）----
  "apps/api/scripts/db-target-guard.cjs",
  "apps/api/scripts/db-target-guard.d.cts",
  "tools/check-test-early-return.cjs",
]) {
  if (fs.existsSync(path.join(MIWO_ROOT, rel))) pass(G_FILES, `存在 ${rel}`, "已就位");
  else fail(G_FILES, `存在 ${rel}`, "缺失");
}

// ---------- A 尾：裁定 A 的**判别力自证**（不是"断言结论"，而是"证明它会红"）----------
{
  // (1) 护栏①：意图 MySQL 的脚本漏设 driver 时必须**响亮失败**，且信息里指名变量。
  let loud = null;
  let loudMsg = "";
  try {
    guard.requireDriver("mysql", "verify-phase1a 自证", { env: {} });
    loud = "allowed";
  } catch (e) {
    loud = e && e.code;
    loudMsg = String((e && e.message) || "");
  }
  pass(
    G_FILES,
    "A/裁定A 判别力①：漏设 MIWO_DB_DRIVER 时护栏拒绝执行（不回落 sqlite）",
    loud === "MIWO_DB_DRIVER_REQUIRED",
    `实际 ${loud}`,
  );
  // 反向：显式给了 mysql 就必须放行（否则这条护栏会把正常用法也打死）。
  let allowed = true;
  try {
    guard.requireDriver("mysql", "verify-phase1a 自证", { env: { MIWO_DB_DRIVER: "mysql" } });
  } catch {
    allowed = false;
  }
  // ⚠ 4 个实参 = (组, 名, **条件**, 详情)。3 个实参会被当成 (组, 名, 详情) 且恒通过 ——
  //    这条在改动前正是那样（`allowed` 被塞进详情位 ⇒ 条件从未生效）。见 `makeCheck()` 的注释。
  pass(G_FILES, "A/裁定A 反向：显式 MIWO_DB_DRIVER=mysql 时放行", allowed, `allowed=${allowed}`);

  // (2) 护栏②：目标解析成**仓库内真实 dev 库**时必须拒绝，且放行开关要真的能放行。
  const blocked = guard.repoDevDbVerdict({ env: {}, argv: [] });
  pass(
    G_FILES,
    `A/裁定A 判别力②：目标解析成仓库内 dev 库（${DEV_DB}）且未显式放行 → 拒绝`,
    blocked.blocked === true && blocked.resolved === DEV_DB,
    `blocked=${blocked.blocked} resolved=${blocked.resolved}`,
  );
  // ⚠⚠ 【判别力自证暴露的**真 bug**】原判据是 `MIWO_DATA_DIR: "./data"` 且注释写"仍然拒绝"。
  //    它在改动前恒真（条件被丢进第 4 参），修好 arity 后**立刻红了** —— 而红得**对**：
  //    `db-target-guard.cjs` 的 `resolvedSqliteFile()` 用 `path.resolve(MIWO_DATA_DIR)`，
  //    即**相对 `process.cwd()`** 解析。`db:*` 脚本的 cwd 是 `apps/api`，那时 `./data`
  //    确实解析成真实 dev 库；但**本验收脚本的 cwd 是仓库根**，`./data` 会解析成
  //    `<仓库根>/data/db2.sqlite`（**不是** dev 库）⇒ 护栏**正确地**放行。
  //    所以原判据把"cwd 相关的相对写法"当成了"绝对会被拦"，是**判据本身写错了**。
  //    修法（比原来**更强**、且与 cwd 无关）：直接给**绝对的** dev 数据目录 ——
  //    它表达的才是这条断言真正要说的那句话："**显式点名** dev 数据目录，仍然拒绝
  //    （解析结果才是判据，不是'写没写变量'）"。
  const stillBlocked = guard.repoDevDbVerdict({ env: { MIWO_DATA_DIR: DEV_DATA_DIR }, argv: [] });
  pass(
    G_FILES,
    "A/裁定A 判别力②（加强）：显式 MIWO_DATA_DIR=<dev 数据目录的绝对路径> **仍然**拒绝（解析结果才是判据，不是'写没写变量'）",
    stillBlocked.blocked === true && stillBlocked.resolved === DEV_DB,
    `blocked=${stillBlocked.blocked} resolved=${stillBlocked.resolved} reason=${stillBlocked.reason}`,
  );
  const optedIn = guard.repoDevDbVerdict({ env: {}, argv: ["--allow-repo-dev-db"] });
  pass(
    G_FILES,
    "A/裁定A 反向：显式开关（--allow-repo-dev-db）才放行（**语法层**；【Ruling 139】可恢复点由 requireRepoDevDbAllowed 建立）",
    // 比原来"只断言 blocked===false"更强：还要求 verdict 如实标出"这一层只是语法层放行、
    // 可恢复点由硬版本建立"。放行开关单独不再等于放行（见 db-target-guard.cjs 护栏 ③）。
    optedIn.blocked === false && !!optedIn.optIn && /可恢复点/.test(String(optedIn.optIn.recoverablePoint)),
    `blocked=${optedIn.blocked} optIn=${JSON.stringify(optedIn.optIn || null)}`,
  );
  const elsewhere = guard.repoDevDbVerdict({ env: { MIWO_DATA_DIR: os.tmpdir() }, argv: [] });
  pass(
    G_FILES,
    "A/裁定A 反向：MIWO_DATA_DIR 指向别处（一次性目录）时放行",
    elsewhere.blocked === false && elsewhere.resolved !== DEV_DB,
    `blocked=${elsewhere.blocked} resolved=${elsewhere.resolved}`,
  );
  // (3) 机制**接线**：护栏必须真的被那几个会写库的脚本 require —— 只写一个没人用的模块等于没加固。
  // ⚠⚠ 【判别力自证暴露的**真 bug**】原判据只认 `require("./db-target-guard.cjs")`，而两个 `.ts`
  //    脚本用的是 **`import guard from "./db-target-guard.cjs"`**（`module: CommonJS` +
  //    esModuleInterop，编译后才是 require）⇒ 这条断言对 `db-migrate.ts` / `db-repair-stuck.ts`
  //    **恒红**，只是原先被"条件丢进第 4 参"掩盖成了恒绿。现在两种形态都认。
  for (const rel of ["scripts/db-migrate.ts", "scripts/db-repair-stuck.ts", "scripts/import-mysql.cjs", "scripts/compare-db.cjs"]) {
    const p = path.join(API_ROOT, rel);
    let wired = false;
    let why = "文件不存在";
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, "utf8");
      const imported = /(?:require\(|import\s+\w+\s+from\s*)["']\.\/db-target-guard\.cjs["']/.test(src);
      const used = /requireRepoDevDbAllowed|repoDevDbVerdict/.test(src);
      wired = imported && used;
      why = wired
        ? ""
        : `文件里没有引用本护栏（require/import 皆可）或没有调用它的判定：imported=${imported} used=${used}`;
    }
    pass(G_FILES, `A/裁定A 接线：${rel} 真的调用了护栏`, wired, why);
  }

  // ---- 【裁定 A·必做】启动路径**也**必须过护栏（现有 A 组只证了 CLI 侧）----
  // 终审在 dev 库**副本**上实测过这条漏网：`grep apps/api/src/**` 是 0 处引用，
  // 默认配置（.env 的 MIWO_DATA_DIR=./data + 默认 sqlite）下 `pnpm dev` 就会走启动路径，
  // 把 29 表老库副本写成 31 表（sha256 44716850… → 8C3C2F38…，与 --status 改坏 dev 库**逐字节相同**）。
  // 这里的断言分两层，缺一不可：
  //   ① **接线**：`src/db/connect.ts` 必须在 `connect()` 里真的调用护栏（文本层）；
  //   ② **判别力**：把"已解析目标 = 仓库内 dev 库"直接喂给判定，必须 `blocked: true` ——
  //      证明这条接线用的**是同一套判定**，而不是"调了个函数但判据不同"。
  {
    const connectSrc = fs.existsSync(path.join(API_ROOT, "src", "db", "connect.ts"))
      ? fs.readFileSync(path.join(API_ROOT, "src", "db", "connect.ts"), "utf8")
      : "";
    const wired = /requireRepoDevDbAllowed/.test(connectSrc) && /assertTargetAllowed/.test(connectSrc);
    pass(
      G_FILES,
      "A/裁定A 启动路径接线：src/db/connect.ts 的 connect() 真的调用护栏（不是只有 CLI 侧接）",
      wired,
      wired ? "" : "connect.ts 里没有 assertTargetAllowed / requireRepoDevDbAllowed —— 启动路径又漏了",
    );
    // 判别力：把 config 解析出来的 driver/file **直接**喂给同一判定（就是 connect() 的入参形态）。
    const startupVerdict = guard.repoDevDbVerdict({
      env: {},
      argv: [],
      driver: "sqlite",
      file: DEV_DB,
    });
    pass(
      G_FILES,
      "A/裁定A 判别力③（启动路径）：config.db.file 解析成仓库内 dev 库且未显式放行 → 拒绝",
      startupVerdict.blocked === true && startupVerdict.resolved === DEV_DB,
      `blocked=${startupVerdict.blocked} resolved=${startupVerdict.resolved} reason=${startupVerdict.reason}`,
    );
    // 反向：显式放行 + 可恢复点 → 才放行（与 CLI 口径一字不差）。
    const startupOptIn = guard.repoDevDbVerdict({
      env: { MIWO_ALLOW_REPO_DEV_DB: "1" },
      argv: [],
      driver: "sqlite",
      file: DEV_DB,
    });
    pass(
      G_FILES,
      "A/裁定A 反向（启动路径）：MIWO_ALLOW_REPO_DEV_DB=1 才放行（且 verdict 如实标出可恢复点由硬版本建立）",
      startupOptIn.blocked === false && !!startupOptIn.optIn && /可恢复点/.test(String(startupOptIn.optIn.recoverablePoint)),
      `blocked=${startupOptIn.blocked} optIn=${JSON.stringify(startupOptIn.optIn || null)}`,
    );
    // 反向：mysql 分支不受影响（护栏按驱动分流，否则会把 CI 的 mysql job 全打死）。
    const mysqlVerdict = guard.repoDevDbVerdict({
      env: {},
      argv: [],
      driver: "mysql",
      file: DEV_DB,
    });
    pass(
      G_FILES,
      "A/裁定A 反向（启动路径）：driver=mysql 时不被 sqlite 护栏拦（分流正确，CI 的 mysql job 不受影响）",
      mysqlVerdict.blocked === false,
      `blocked=${mysqlVerdict.blocked} reason=${mysqlVerdict.reason}`,
    );
  }
}

// ---------- B：空目录启动 + 迁移幂等 + 表清单 ----------
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase1a-"));
  // ⚠ B 组**显式**设 sqlite：它验的是"空库能不能起"，与外部环境是不是 mysql 无关。
  //    （Task 11 Step 4 在 MySQL 口径下跑本脚本时，B 组仍然走 sqlite —— 这是有意的，报告里已说明。）
  const env = {
    MIWO_ENV: "dev",
    MIWO_PORT: "10599",
    MIWO_HOST: "127.0.0.1",
    MIWO_DATA_DIR: dataDir,
    MIWO_JWT_SECRET: "phase1a-verification-secret-at-least-32-bytes",
    MIWO_DB_DRIVER: "sqlite",
  };
  const m1 = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"], { cwd: API_ROOT, env });
  const m2 = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"], { cwd: API_ROOT, env });
  if (m1.status === 0 && /完成/.test(m1.stdout)) pass(G_DB, "首次迁移应用成功", m1.stdout.trim().split("\n").pop());
  else fail(G_DB, "首次迁移应用成功", tail(outOf(m1), 800));
  if (m2.status === 0 && /无新迁移/.test(m2.stdout)) pass(G_DB, "二次迁移幂等（无新迁移）", m2.stdout.trim().split("\n").pop());
  else fail(G_DB, "二次迁移幂等（无新迁移）", tail(outOf(m2), 800));

  // 表清单（用一次性探针脚本读库；读不到 / 解析不了都必须变成**失败断言**，不是抛裸栈）
  const probe = path.join(dataDir, "tables.cjs");
  let names = null;
  let probeErr = "";
  try {
    fs.writeFileSync(
      probe,
      `
const D = require(${JSON.stringify(path.join(API_ROOT, "node_modules", "better-sqlite3"))});
const db = new D(${JSON.stringify(path.join(dataDir, "db2.sqlite"))}, { readonly: true });
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name).filter(n => !n.startsWith("knex_"));
console.log(JSON.stringify(rows));
db.close();
`,
      "utf8",
    );
    const t = run(process.execPath, [probe]);
    if (t.status !== 0) probeErr = tail(outOf(t), 600);
    else names = JSON.parse(t.stdout.trim());
  } catch (e) {
    probeErr = String((e && e.stack) || e);
  }

  if (!names) {
    fail(G_DB, "能读到一次性库的表清单", probeErr || "探针没有输出可解析的 JSON（库没建出来？）");
  } else {
    // ⚠ 2026-10-12 / Phase 1c Task 1：口径从"001_schema 的 27 张"改成"**全部迁移**跑完后的 33 张"
    //   （005_accounts / 006_quota_grants 又建了 6 张）。判据强度不变：仍是**逐名相等 + 不多不少**。
    const EXPECT_FRESH = EXPECT_TABLES_ALL_MIGRATIONS;
    const missing = EXPECT_FRESH.filter((x) => !names.includes(x));
    const extra = names.filter((x) => !EXPECT_FRESH.includes(x));
    if (!missing.length && names.length === EXPECT_FRESH.length) pass(G_DB, `${EXPECT_FRESH.length} 张业务表齐（${names.length}）`);
    else fail(G_DB, `${EXPECT_FRESH.length} 张业务表齐`, `缺 ${missing.join(",") || "无"}；多 ${extra.join(",") || "无"}；总数 ${names.length}`);
    const retired = RETIRED_TABLES.filter((x) => names.includes(x));
    if (!retired.length) pass(G_DB, "退役表未创建（spec §5.4）");
    else fail(G_DB, "退役表未创建", retired.join(","));
  }

  // ---- 裁定 C（★Ruling 132）在**本脚本**侧的同族断言：迁移名册 ⊇ 硬编码 allowlist ----
  // ⚠ 与 `verify-phase0.cjs` 里那一条是**同一个判据的两处落点**，故意都留：
  //   `verify-phase0` 会在没有 dev 库的环境里也跑，本脚本则总是跑 —— 谁被跳过都不至于让
  //   "删掉一个迁移"这件事漏过去。
  const ALLOW = ["001_schema", "002_platform_seed", "003_vendor_asset_sync", "004_backfill_userid", "005_accounts", "006_quota_grants"];
  const idx = fs.existsSync(path.join(API_ROOT, "src", "db", "migrations", "index.ts"))
    ? fs.readFileSync(path.join(API_ROOT, "src", "db", "migrations", "index.ts"), "utf8")
    : "";
  const parsed = [...idx.matchAll(/from\s+["']@\/db\/migrations\/(\d{3}_[A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
  const missingFromParsed = ALLOW.filter((n) => !parsed.includes(n));
  pass(
    G_DB,
    `B/裁定C 解析名册包含全部 ${ALLOW.length} 条硬编码已知迁移（${ALLOW.join(" + ")}）`,
    parsed.length > 0 && missingFromParsed.length === 0,
    missingFromParsed.length
      ? `少了 ${JSON.stringify(missingFromParsed)}（解析到 ${JSON.stringify(parsed)}）—— 既有迁移被删/改名；有意删除必须同时改 verify-phase0/verify-phase1a 的 allowlist`
      : `解析到 ${JSON.stringify(parsed)}`,
  );

  // ---- 裁定 B（★Ruling 127）在测试文件上的**形态**断言 ----
  {
    const f = path.join(API_ROOT, "tests", "mysql-integration.test.ts");
    const src = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    // ① 那条搬迁用例必须是 `it.skipIf(条件)(...)` 形态（显式 skip，会进 vitest 摘要）。
    pass(
      G_DB,
      "B/裁定B 搬迁用例用显式 it.skipIf 门控（不是裸 return 静默早退）",
      /it\.skipIf\(!DEV_DB_PRESENT\)\s*\(/.test(src),
      src ? "没找到 it.skipIf(!DEV_DB_PRESENT)( ... ) 形态" : "文件不存在",
    );
    // ② 文件里**不许**再出现"到 dev 库路径的裸 return"（形态门禁的正则更强，这条是就地哨兵）。
    // ⚠⚠ 【判别力自证暴露的**真 bug**】原判据直接拿**原文**匹配，于是把文件头注释里那句
    //    "本文件原来在搬迁用例里写的是 `if (!fs.existsSync(devPath)) return;`"（**引述历史**）
    //    也当成了"仍存在静默早退守卫" ⇒ **恒红**（原先被 arity 缺陷掩盖成恒绿）。
    //    修法：先剥注释再匹配 —— 注释是留档，不是缺口（与 `check-dead-ddl` 的口径一致）。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    pass(
      G_DB,
      "B/裁定B 文件里没有 `if (!fs.existsSync(...)) return;` 形态的 dev 库守卫（剥注释后）",
      !/if\s*\(\s*!fs\.existsSync\([^)]*\)\s*\)\s*return\s*;/.test(code),
      "仍存在静默早退守卫（已剥注释；注释里的引述不算）",
    );
    // ③ skip 归因断言必须在 `d(...)` 之外（默认套件也跑），否则默认套件里的 skip 会有盲区。
    pass(
      G_DB,
      "B/裁定B skip 归因用例放在 describe 门控**之外**（默认套件也真的跑）",
      /^it\("skip 归因/m.test(src),
      "没有找到放在 d(...) 之外的 skip 归因用例",
    );
  }

  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 删不掉不掩盖上面的结论；%TEMP% 里的 miwo-phase1a-* 由系统清理 */
  }
}

// ---------- C：导出 / 导入(dry-run) / 比对（不真写目标库） ----------
{
  // ⚠ CI 上没有 dev 库（gitignored）→ **显式**记一条结论。
  //    这里刻意写 `if/else` 而不是 `return`：本文件自己在 E 组断言"不许有静默早退"，
  //    不能自己踩。见控制器裁定 B / tools/check-test-early-return.cjs。
  if (!fs.existsSync(DEV_DB)) {
    pass(G_DATA, "跳过 C 组：本机没有 dev 库快照（gitignored；CI 上必然如此），本地才会跑");
  } else {
    const out = path.join(API_ROOT, ".tmp-migrate", "phase1a-export");
    // ⚠ 必须带 `--import=tsx`：脚本内部要 knex 加载 `001_schema.ts`（见文件头差异 2）。
    // ⚠ `--allow-repo-out` 是**显式放行**（Ruling 113/125）：`export-sqlite.cjs` 默认拒绝把产物写进仓库
    //    （`o_setting.ndjson` 含真实 tokenKey）。这里的产物是**一次性**的，本组收尾会递归删掉它 —— 
    //    所以放行是"承担 + 有收尾"，不是绕过护栏。（另一处导出给的是 `os.tmpdir()`，在仓库外，不需要放行。）
    const e = run(process.execPath, ["--import=tsx", "scripts/export-sqlite.cjs", `--out=${out}`, "--allow-repo-out"], {
      cwd: API_ROOT,
      env: { MIWO_DATA_DIR: DEV_DATA_DIR },
    });
    const manifestPath = path.join(out, "manifest.json");
    if (e.status === 0 && fs.existsSync(manifestPath)) {
      let mf = null;
      try {
        mf = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (err) {
        fail(G_DATA, "解析导出 manifest.json", String((err && err.message) || err));
      }
      if (mf) {
        const rows = mf.tables.reduce((s, x) => s + x.rows, 0);
        pass(G_DATA, `导出 ${mf.tables.length} 张表 / ${rows} 行`, `duplicates=${mf.duplicates.length} badIds=${mf.badIds.length}`);
        if (mf.duplicates.length || mf.badIds.length) {
          fail(G_DATA, "导出无阻断项", `duplicates=${JSON.stringify(mf.duplicates)} badIds=${JSON.stringify(mf.badIds.slice(0, 3))}`);
        } else {
          pass(G_DATA, "导出无阻断项（无重复键 / 无越界 id）");
        }
        // 导出侧自带的"对源库只读"自证必须成立（否则这份产物不可信）。
        pass(
          G_DATA,
          "导出物自证：源库 sha256 前后一致（导出是只读的）",
          mf.sourceSha256Before === mf.sourceSha256After && !!mf.sourceSha256After,
          `before=${mf.sourceSha256Before} after=${mf.sourceSha256After}`,
        );
        // 搬迁范围的表集合必须**逐名相等**（含"不多不少"）。
        // ⚠【Phase 1c Task 1】口径从"001_schema 的 27 张"改成"搬迁范围 26 张"（不含 `o_user`），
        //   并同时断言 `搬迁范围 ∪ {o_user} == 001_schema 的 27 张` —— 于是"谁多搬/少搬一张"
        //   与"001_schema 变了"这两种情况都能被分开报出来。
        const got = mf.tables.map((t) => t.name).sort();
        const want = [...LEGACY_EXPORT_TABLES].sort();
        pass(
          G_DATA,
          `导出表集合与搬迁范围的 ${LEGACY_EXPORT_TABLES.length} 张表逐名相等（不含 o_user：见 export-sqlite.cjs 的说明）`,
          JSON.stringify(got) === JSON.stringify(want),
          `缺 ${JSON.stringify(want.filter((x) => !got.includes(x)))} / 多 ${JSON.stringify(got.filter((x) => !want.includes(x)))}`,
        );
        pass(
          G_DATA,
          `搬迁范围 ∪ {o_user} == 001_schema 的 ${EXPECT_TABLES.length} 张业务表（差集只有 o_user，逐名）`,
          JSON.stringify([...LEGACY_EXPORT_TABLES, "o_user"].sort()) === JSON.stringify([...EXPECT_TABLES].sort()),
          `搬迁范围 ${LEGACY_EXPORT_TABLES.length} 张 + o_user = ${LEGACY_EXPORT_TABLES.length + 1} 张；001_schema ${EXPECT_TABLES.length} 张`,
        );

        // ---- Ruling 93 对账（权威口径在**同一个** manifest 里现算，不手抄数字）----
        // ⚠ 为什么必须"现算"：报告里出现的 26/204/2372 与 fixture 里的 29/219/2408
        //    是**两个不同口径**（见 D 组），而人写的数字会漂移。这里把"导出物口径"钉成断言。
        //    fixture 口径的核对在 D 组（那边会断言两份清单**恰好差那两张退役表**）。
        {
          const cols = mf.tables.reduce((s, x) => s + (x.columns ? x.columns.length : 0), 0);
          // ⚠ 【M4 同类】这一条**只是把现算出来的数字念一遍**，没有任何判据 —— 属"信息行"。
          //    旧版用 `pass()` 记它，于是 `通过 60 / 60` 里混进了一条恒真项。改成 `info()`。
          //    真正的判据是下面那条"导出表集合与 001_schema 逐名相等"（它带 `want`/`got` 比对）。
          info(G_DATA, `Ruling93 导出物口径（权威、现算）：${mf.tables.length} 表 / ${cols} 列 / ${rows} 行`);
        }

        // ---- Ruling 93 对账：导出物口径 vs `tests/fixtures/legacy-column-stats.json` 口径 ----
        // 两个口径的差必须**恰好**是那两张退役表（`o_skillList` / `o_skillAttribution`）：
        //   · `export-sqlite.cjs` 的 `TABLES` 是"搬迁范围"（26 张；退役表与 `o_user` 都不搬）；
        //   · `gen-legacy-column-stats.cjs` 扫**整库** `sqlite_master`（29 张，因为老库里它们还在）。
        //   断言"差集恰好是这两张"就把"计数口径差异"与"数据漂移"分开了 ——
        //   漂移会让差集变成别的东西，而口径差异不会。
        {
          const fx = path.join(API_ROOT, "tests", "fixtures", "legacy-column-stats.json");
          if (!fs.existsSync(fx)) {
            fail(G_DATA, "Ruling93 口径对账：fixture 存在", fx);
          } else {
            let doc = null;
            let why = "";
            try {
              doc = JSON.parse(fs.readFileSync(fx, "utf8"));
            } catch (err) {
              why = String((err && err.message) || err);
            }
            if (!doc) {
              fail(G_DATA, "Ruling93 口径对账：fixture 可解析", why);
            } else {
              const fxTables = Object.keys(doc.stats || {});
              const expTables = mf.tables.map((t) => t.name);
              const onlyInFixture = fxTables.filter((t) => !expTables.includes(t)).sort();
              // ⚠【Phase 1c Task 1】期望差集 = 两张**退役表** + `o_user`：
              //   fixture（`gen-legacy-column-stats.cjs`）扫**整库**，而 `o_user` 已移出搬迁范围。
              //   三个名字**逐个写死**（不是"差集长度 == 3"）——多一个少一个都要报出是谁。
              const EXPECT_ONLY_IN_FIXTURE = [...RETIRED_TABLES, "o_user"].sort();
              pass(
                G_DATA,
                `Ruling93 口径对账：fixture 比导出物多出的表**恰好**是 ${EXPECT_ONLY_IN_FIXTURE.join(" + ")}（口径差异，不是漂移）`,
                JSON.stringify(onlyInFixture) === JSON.stringify(EXPECT_ONLY_IN_FIXTURE),
                `fixture=${fxTables.length} 表 / 导出物=${expTables.length} 表；只多出 ${JSON.stringify(onlyInFixture)}（期望 ${JSON.stringify(EXPECT_ONLY_IN_FIXTURE)}）`,
              );
              pass(
                G_DATA,
                `Ruling93 口径对账：fixture 的 source.sha256 与本机 dev 库一致或（无 dev 库时）自洽`,
                !doc.source ||
                  (doc.source.sha256 &&
                    (fs.existsSync(DEV_DB)
                      ? doc.source.sha256 === require("crypto").createHash("sha256").update(fs.readFileSync(DEV_DB)).digest("hex")
                      : /^[0-9a-f]{64}$/.test(doc.source.sha256))),
                `fixture.source=${JSON.stringify(doc.source)}`,
              );
              // ⚠ 【M4 同类】"两套口径都如实记录"是**陈述**、不是判据（上面那条 `onlyInFixture`
              //    才是真判据）。改成 `info()`，不掺进通过数。
              info(
                G_DATA,
                `Ruling93 口径对账：fixture 口径 = ${doc.source.tables} 表 / ${doc.source.columns} 列 / ${doc.source.rows} 行；` +
                  `导出物口径 = ${mf.tables.length} 表 / ${mf.tables.reduce((s, x) => s + (x.columns ? x.columns.length : 0), 0)} 列 / ${rows} 行（两套口径都如实记录）`,
              );
            }
          }
        }

        // ---- 导入：**dry-run**（不写任何库；--apply 才写）----
        //    ⚠ 目标指向**一次性目录**：`import-mysql.cjs` 现在挂了裁定 A 的护栏，
        //      而"目标解析成仓库 dev 库 + 未显式放行"会被它拒绝（**这是对的**）。
        //      这里要验的是"dry-run 路径跑得通且不写库"，所以给它一个真实但一次性的目标目录，
        //      而不是为了让它过就塞一个放行开关 —— 那会把护栏本身验没了。
        //    ⚠ env 必须**整套**给出（`MIWO_ENV`/`MIWO_PORT`/`MIWO_HOST`/`MIWO_JWT_SECRET` 都是必填）：
        //      `import-mysql.cjs` 会 spawn 一个 `--import=tsx` 的 runner，那个 runner 会加载
        //      `src/config.ts`（模块级 fail-fast）。只给 `MIWO_DATA_DIR` 会直接
        //      `ConfigError: 缺少必需环境变量 MIWO_ENV`（**实测**踩过一次）。
        const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase1a-dry-"));
        const i = run(process.execPath, ["scripts/import-mysql.cjs", `--in=${out}`], {
          cwd: API_ROOT,
          env: targetEnv(dryDir),
        });
        const iOut = outOf(i);
        // ⚠ 退出码口径（**实测**，`import-mysql.cjs` 的约定写在它文件头）：
        //    · 0 = dry-run 跑通（目标库已迁移时）；
        //    · 2 = **preflight 拒绝**（阻断项非空）—— 本组给的目标是**一次性空目录**，
        //      里面还没有迁移过的表，所以 26 条 `missing-target-table` 是**预期**结论。
        //      它恰恰证明"preflight 真的在拦"（而不是"空目标也放过去写"）。
        //    所以判据是 `{0,2}` **且**输出里明确出现 DRY-RUN 或被 preflight 拒绝，
        //    并且**另外**用 import-report 的 `applied === false` 钉住"一行都没写"。
        if ((i.status === 0 || i.status === 2) && (/DRY-RUN/.test(iOut) || /被 preflight 拒绝/.test(iOut))) {
          pass(
            G_DATA,
            `导入（dry-run，目标=一次性未迁移空库）EXIT ${i.status} 且明确未写库`,
            `预期判据：preflight 拦住 26 张缺表（不是"空库也放过去"）；${(iOut.match(/\[import\][^\n]*/g) || []).slice(-1)[0] || ""}`,
          );
        } else {
          fail(G_DATA, "导入（dry-run）跑通且明确未写库", tail(iOut, 900));
        }
        // 反向哨兵：dry-run 绝不许真的写库 —— import-report.json 里 applied 必须是 false。
        {
          const rep = path.join(out, "import-report.json");
          let applied = null;
          let why = "没有 import-report.json";
          if (fs.existsSync(rep)) {
            try {
              applied = JSON.parse(fs.readFileSync(rep, "utf8")).applied;
              why = "";
            } catch (err) {
              why = String((err && err.message) || err);
            }
          }
          pass(G_DATA, "dry-run 报告里 applied=false（没有偷偷写库）", applied === false, why || `applied=${applied}`);
        }
        try {
          fs.rmSync(dryDir, { recursive: true, force: true });
        } catch {
          /* 删不掉不掩盖结论 */
        }

        // ---- 真·端到端闭环（sqlite 口径）：空目标库 → 迁移 → **真导入** → 比对 EXIT 0 ----
        // ⚠ 为什么不是"dry-run 就算数"：dry-run 只证明 preflight 跑得通，**不证明数据真的搬得过去**。
        //    Task 6/8 的交付物是"导出 → 空库迁移 → 导入 → 比对一致"这条闭环，所以这里在**一次性目录**
        //    上把它整条跑一遍（真实数据、真写入、逐表行数 + 分层抽样逐列比较）。
        //    ⚠ 目标**必须**是一次性目录：`MIWO_DATA_DIR` 显式给出 ⇒ 裁定 A 的护栏放行；
        //      若哪天有人把它改成 apps/api/data，护栏会拒绝 —— 这正是它该有的行为。
        const tgtDir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase1a-target-"));
        const importOut = path.join(tgtDir, "export");
        let closed = false;
        let detail = "";
        // ① 重新导出一份到一次性目录（`import-mysql.cjs` 会把报告写在 `--in` 目录里，
        //    不污染 `.tmp-migrate/phase1a-export` 那份"只导出"的产物）
        const e2 = run(process.execPath, ["--import=tsx", "scripts/export-sqlite.cjs", `--out=${importOut}`], {
          cwd: API_ROOT,
          env: { MIWO_DATA_DIR: DEV_DATA_DIR },
        });
        // ② 空目标库先迁移（一次性目录；显式 MIWO_DATA_DIR ⇒ 裁定 A 的护栏放行）
        const mig = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"], {
          cwd: API_ROOT,
          env: targetEnv(tgtDir),
        });
        // ③ 真导入（--apply）
        const imp = run(process.execPath, ["scripts/import-mysql.cjs", `--in=${importOut}`, "--apply"], {
          cwd: API_ROOT,
          env: targetEnv(tgtDir),
        });
        // ④ 比对（目标 = 刚导入的一次性库；源 = 仓库 dev 库只读）
        const cmp = run(process.execPath, ["scripts/compare-db.cjs", `--src=${DEV_DB}`, `--manifest=${importOut}`], {
          cwd: API_ROOT,
          env: targetEnv(tgtDir),
        });
        closed = e2.status === 0 && mig.status === 0 && imp.status === 0 && cmp.status === 0;
        detail =
          `export=${e2.status} migrate=${mig.status} import=${imp.status} compare=${cmp.status}；` +
          `compare 末行：${tail(outOf(cmp), 300).trim().split("\n").slice(-1)[0]}`;
        pass(
          G_DATA,
          "真·闭环（一次性目标库）：导出 → 空库迁移 → 真导入 → 比对 EXIT 0",
          closed,
          closed ? detail : detail + "\n" + tail(outOf(cmp) + outOf(imp), 1500),
        );
        if (closed) {
          const rep = path.join(importOut, "import-report.json");
          let applied = null;
          try {
            applied = JSON.parse(fs.readFileSync(rep, "utf8")).applied;
          } catch {
            applied = null;
          }
          pass(G_DATA, "闭环里的导入报告 applied=true（这一次是真的写了一次性目标库）", applied === true, `applied=${applied}`);
        }
        try {
          fs.rmSync(tgtDir, { recursive: true, force: true });
        } catch {
          /* 删不掉不掩盖结论 */
        }
      }
    } else {
      fail(G_DATA, "导出 dev 库", tail(outOf(e), 900));
    }
    // ⚠ 收尾：删掉本组在 `.tmp-migrate` 下造的那份导出物。
    //    为什么必须删：`--out` 目录里的 `o_setting.ndjson` **含真实 `tokenKey`**
    //    （老库的 `o_setting` 里就有那一行），它是**密钥**。`.tmp-migrate/` 虽然整个被
    //    `.gitignore` 忽略，但那不是"可以留在磁盘上"的理由 —— 本 Task 的纪律是
    //    "用完删、并复核 Test-Path False"。只删自己造的这一个子目录，不动别的。
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      /* 删不掉不改判上面的结论；报告里会如实说明 */
    }
  }
}

// ---------- D：静态 MySQL DDL ----------
{
  const t = run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/migration-ddl-mysql.test.ts", "--reporter=dot"], { cwd: API_ROOT });
  if (t.status === 0) pass(G_DDL, "MySQL DDL 静态断言全绿", t.stdout.trim().split("\n").slice(-2).join(" | "));
  else fail(G_DDL, "MySQL DDL 静态断言全绿", tail(outOf(t), 1500));
}

// ---------- D2：【Ruling 26·必做】慢用例（唯一的事务守卫）必须**真的执行** ----------
/**
 * ── 为什么必须在这里跑（这是"门禁真漏洞"，不是优化项）──
 * `tests/migrations.test.ts` 里那条"up 必须用 trx"的慢用例（180s 超时，实测 ~60s 才抛
 * `KnexTimeoutError`）是**唯一**能证明"迁移事务守卫真会红"的自动化证据。它由 `MIWO_TEST_SLOW=1` 门控，
 * 而改动前该变量**只出现在 `migrations.test.ts` 与 README 文本里** —— CI 与两个验收脚本
 * **都不设它** ⇒ 默认 `pnpm test`（本机与 CI）**永远 skip** 它 ⇒ **唯一的事务守卫永不执行**。
 * 这与本阶段反复抓到的"一条永不执行的守卫等于没有守卫"（Ruling 26/76/104/120）是同一类。
 *
 * ── 判据（两层，缺一不可）──
 *   ① `MIWO_TEST_SLOW=1` 下 `migrations.test.ts` EXIT 0；
 *   ② 摘要里**不许出现 skipped** —— 只有真跑到那条慢用例，它才会从 `1 skipped` 变成 `0 skipped`
 *      且 passed 数 +1（6 → 7）。只看 EXIT 0 是不够的：门控若失效（比如变量名拼错），
 *      慢用例会安静地 skip 而整套仍然全绿 —— 那正是要防的假绿。
 */
{
  const SLOW_ENV = { ...process.env, MIWO_TEST_SLOW: "1" };
  const s = run(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "tests/migrations.test.ts", "--reporter=dot"],
    { cwd: API_ROOT, env: SLOW_ENV, timeout: 400000 },
  );
  const sOut = outOf(s);
  // ⚠ vitest 在 0 skipped 时**不打印** "skipped" 字样（实测），所以判据是"没有非零 skipped"。
  // ⚠⚠ 解析必须锚在 **`Tests` 那一行**上：默认 reporter 里先出现的是
  //    `Test Files  1 passed (1)`，朴素的 `/(\d+)\s+passed/` 会先命中它 → 拿到 `1` 而不是 `7`
  //    （实测踩过：passed=1 让 `>=7` 判红，而慢用例其实**跑成功了**）。
  const summaryLine = (sOut.match(/^\s*Tests\s+.*$/m) || [""])[0];
  const skipped = Number((summaryLine.match(/(\d+)\s+skipped/i) || [])[1] || 0);
  const passed = Number((summaryLine.match(/(\d+)\s+passed/i) || [])[1] || 0);
  if (s.status === 0 && skipped === 0 && passed >= 7) {
    pass(G_DDL, `Ruling26 慢用例（唯一事务守卫）真的执行：MIWO_TEST_SLOW=1 → ${passed} passed / 0 skipped`, `EXIT 0`);
  } else {
    fail(
      G_DDL,
      "Ruling26 慢用例（唯一事务守卫）真的执行（MIWO_TEST_SLOW=1，0 skipped，>=7 passed）",
      `EXIT ${s.status} passed=${passed} skipped=${skipped}（skipped>0 说明门控失效、守卫没跑）\n` + tail(sOut, 900),
    );
  }
}

// ---------- E：门禁 + 无启动期写盘 + 旧仓库零改动 ----------
for (const [name, cmd, args] of [
  ["check-copy", "node", ["tools/check-copy.cjs"]],
  ["check-brand", "node", ["tools/check-brand.cjs"]],
  ["check-eol", "node", ["tools/check-eol.cjs"]],
  ["check-natives", "node", ["tools/check-natives.cjs"]],
  ["check-ci-yaml", "node", ["tools/check-ci-yaml.cjs"]],
  ["check-tenant-exceptions", "node", ["tools/check-tenant-exceptions.cjs"]],
  // ⚠ Task 11 新增两条（裁定 A/B 的形态门禁）：
  //   · check-test-early-return：禁止"用例体最外层的守卫式 return"（裁定 B）；
  //   · check-dead-ddl：启动链不得再引用退役的 initDB/fixDB（Phase 1a / Task 4 的裁定 3）。
  ["check-test-early-return", "node", ["tools/check-test-early-return.cjs"]],
  ["check-dead-ddl", "node", ["tools/check-dead-ddl.cjs"]],
  ["verify:deploy", "node", ["tools/check-deploy-config.cjs"]],
  // ⚠ 【裁定 B】`verify:legacy-freeze --check` **不在这个循环里**了：它需要**仓库外**两个旧仓
  //    （`code/toonflow-upstream` / `code/toonflow-web`），无 remote 的 CI runner 上不可能有 →
  //    全新树里实跑 **EXIT 1**。它被移到下面单独一块，按 `--ci` 分流（本机照旧真判据）。
  //    ⚠ 这不是"删掉一条检查"：本机口径（不带 `--ci`）跑的是**逐字同一命令、同一判据**。
]) {
  const r = run(cmd, args);
  if (r.status === 0) pass(G_HYGIENE, name, tail(r.stdout, 200).trim().split("\n").pop());
  else fail(G_HYGIENE, name, tail(outOf(r), 700));
}
// ---- 【裁定 B】本机专属检查①：旧仓库冻结（需要仓库外两个旧仓）----
{
  if (CI_MODE) {
    info(
      G_HYGIENE,
      "CI 不适用：verify:legacy-freeze（需要仓库外两个旧仓 code/toonflow-upstream 与 code/toonflow-web）",
      "无 remote 的 runner 上不存在这两个仓 ⇒ `--check` 必然 EXIT 1（缺仓库**不算通过**，见 record-legacy-freeze.cjs 文件头）。" +
        "本机请跑 `pnpm.cmd run verify:legacy-freeze`",
    );
  } else {
    const r = run("node", ["tools/record-legacy-freeze.cjs", "--check"]);
    if (r.status === 0) pass(G_HYGIENE, "verify:legacy-freeze", tail(r.stdout, 200).trim().split("\n").pop());
    else fail(G_HYGIENE, "verify:legacy-freeze", tail(outOf(r), 700));
  }
}
{
  // ⚠ brief 原文这条是**裸字符串**匹配 `/tempOnsert/.test(file)` —— 实测**在当前树上恒红**，
  //    命中的三处全是**注释**（`lib/fixDB.ts` 的两行说明、`lib/initDB.ts` 的迁移说明、
  //    `db/legacy/vendor-merge.ts` 的历史说明），没有一处是代码。
  //    恒红的门禁会被下一次"顺手放宽"掉，所以这里**改成精确判据**（不是删掉它）：
  //    剥掉注释与字符串字面量之后，`src/**/*.ts` 里**不得**再出现 `tempOnsert` 代码引用。
  //    这比原文**更严**：原文只要注释里没写这个词就通过（哪怕代码里真的又长出一条回插路径）；
  //    现在代码里出现就红，注释里解释历史则照旧放行（注释是留档，不是缺口）。
  const r = run(
    "node",
    [
      "-e",
      [
        "const fs=require('fs'),p=require('path');",
        "const SRC=p.join(process.cwd(),'apps/api/src');",
        "const strip=(s)=>s.replace(/\\/\\*[\\s\\S]*?\\*\\//g,' ').replace(/\\/\\/[^\\n]*/g,' ')",
        "  .replace(/`(?:[^`\\\\]|\\\\.)*`/g,' ').replace(/\"(?:[^\"\\\\]|\\\\.)*\"/g,' ').replace(/'(?:[^'\\\\]|\\\\.)*'/g,' ');",
        "const hits=[];",
        "(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);",
        "if(e.isDirectory())w(q);else if(q.endsWith('.ts')&&/tempOnsert/.test(strip(fs.readFileSync(q,'utf8'))))hits.push(q);}})(SRC);",
        "console.log(JSON.stringify(hits));",
      ].join(""),
    ],
    { cwd: MIWO_ROOT },
  );
  let hits = null;
  try {
    hits = JSON.parse((r.stdout || "[]").trim() || "[]");
  } catch {
    hits = null;
  }
  if (hits && !hits.length) pass(G_HYGIENE, "无 tempOnsert 代码引用（剥注释后；Phase 0 deferred 已消除）");
  else fail(G_HYGIENE, "无 tempOnsert 代码引用（剥注释后）", hits ? hits.join(", ") : tail(outOf(r), 500));
}
// ---- 【裁定 B】本机专属检查②：旧仓库 sha256 冻结（需要被 gitignore 的本机基线）----
{
  const b = path.join(MIWO_ROOT, "tools", ".phase0-old-baseline.json");
  if (CI_MODE) {
    info(
      G_HYGIENE,
      "CI 不适用：旧仓库 sha256 冻结基线（tools/.phase0-old-baseline.json 被 .gitignore 忽略）",
      `全新树（git archive HEAD）里 Test-Path = False（该文件记的是本机旧仓库的**绝对路径**，属机器特定凭证）。` +
        `本机请跑 \`node apps/api/scripts/verify-phase0.cjs\` 或本脚本不带 --ci`,
    );
  } else if (!fs.existsSync(b)) {
    fail(G_HYGIENE, "旧仓库冻结基线存在", b);
  } else {
    const crypto = require("crypto");
    const rec = JSON.parse(fs.readFileSync(b, "utf8"));
    const bad = Object.entries(rec).filter(
      ([p, h]) => !fs.existsSync(p) || crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") !== h,
    );
    if (!bad.length) pass(G_HYGIENE, `旧仓库 ${Object.keys(rec).length} 个关键文件未改动`);
    else fail(G_HYGIENE, "旧仓库未改动", bad.map(([p]) => p).join(", "));
  }
}
{
  // 仓库 dev 库必须**逐字节未变**（Task 11 的硬约束：它只读）。
  // ⚠⚠ 【M4 修复】原版这一行是**无条件 `pass` 且没有前后比对**（恒真）——它只打印"现在是什么"，
  //    于是**本验收自己把 dev 库写坏**这件事永远不会被发现（而 C 组恰恰会读写 dev 库：
  //    导出、闭环里的比对都以它为源）。恒真的"检查"比没有检查更糟：它会被读成一条判据。
  //    现在改成**真断言**：脚本开头记 `before`，这里比 `after`。
  const after = sha256Of(DEV_DB);
  if (DEV_DB_BEFORE === null && after === null) {
    // CI 上没有 dev 库（gitignored）→ 没有"前后一致"可言。记一条**信息行**（不计入通过数），
    // 因为它不构成判据（"文件不存在"既不能证明只读、也不能证伪）。
    info(G_HYGIENE, "仓库 dev 库不存在（gitignored；CI 上必然如此）→ 本条无前后可比", "本机才有这条判据");
  } else if (after === DEV_DB_BEFORE) {
    pass(G_HYGIENE, `仓库 dev 库 sha256 前后逐字节一致（本验收对它是只读的）：${after}`);
  } else {
    fail(
      G_HYGIENE,
      "仓库 dev 库前后逐字节一致（本验收对它是只读的）",
      `**本验收把它写坏了**：before=${DEV_DB_BEFORE} after=${after}（C 组的导出/比对都拿它当源，只读是硬约束）`,
    );
  }
}

// ---------- G：【★Ruling 156】裁定落地核对 ----------
/**
 * ── 这一节存在的唯一原因（结构性教训，不是"再补几条断言"）──
 * 本阶段终审发现 **5 条标为「必做」的裁定从未落地，且无人登记**：
 *   Ruling 12（`check-copy` 235 注释 + 计划就地标注）、Ruling 24（`MIGRATIONS` 顺序守卫）、
 *   **Ruling 25（`db-migrate` 未知旗标白名单；实测 `--dow` → EXIT 0 且真的把 3 条迁移全应用了）**、
 *   Ruling 26（`MIWO_TEST_SLOW` 排进 CI/验收）、Ruling 8+16（两处 deploy 陈旧陈述）。
 * 根因不是"忘了做"，而是**没有任何机制**检查"这条裁定后来有没有真的落进代码"——
 * 账本越写越长，代码不跟，**账本变成自我安慰**。
 *
 * 所以本节给每条"必做"裁定各附一条**可执行的机械断言**：把"裁定是否落地"变成
 * **门禁能回答的问题**，而不是靠人复读账本。
 *
 * ⚠ **判别力要求（每条都必须能因"撤掉对应修复"而红）**：断言一律锚在**修复本身的产物**上
 *   （CLI 的真实退出码 / 数组的真实顺序 / 配置文件里的真实字面量 / 文档里的真实更正），
 *   **不许**写成"断言某个文件存在"这种撤掉修复也照样绿的形式。
 *
 * ⚠ **边界（如实登记在 README deferred #22）**：本节只能防"已登记的必做裁定被忘掉"，
 *   防不了"根本没登记"。1b 起每加一条必做裁定，必须同时在本节加一条断言。
 */
const G_RULINGS = "G 裁定落地核对";
{
  // ---- Ruling 25 ↔ "`--dow` 必须 EXIT 1"（未知旗标白名单）----
  // 最强形式：**真的把 CLI 跑起来**。判据是退出码 + 输出里点名那个未知旗标。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-ruling25-"));
    const r = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts", "--dow"], {
      cwd: API_ROOT,
      env: targetEnv(dir),
    });
    const o = outOf(r);
    // 反向对照（必须同时成立，否则"EXIT 1"可能是被别的原因打红的 —— 那就不是判别力）：
    // 同一个一次性目录、不带旗标 → 必须 EXIT 0 且真的跑完迁移。
    const ok = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"], {
      cwd: API_ROOT,
      env: targetEnv(dir),
    });
    pass(
      G_RULINGS,
      'Ruling25（必做）：`db:migrate --dow` 必须 EXIT 1 且点名未知旗标（不许 fall-through 到「跑到最新」）',
      r.status === 1 && /未知旗标/.test(o) && /--dow/.test(o),
      `EXIT=${r.status}（期望 1）；输出 ${tail(o, 300)}`,
    );
    pass(
      G_RULINGS,
      "Ruling25 反向对照：同一目标不带旗标必须 EXIT 0 且真的跑完迁移（证明上面那条不是被别的原因打红）",
      ok.status === 0 && /完成/.test(outOf(ok)),
      `EXIT=${ok.status}；${tail(outOf(ok), 200)}`,
    );
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉不掩盖结论 */
    }
  }

  // ---- Ruling 24 ↔ "乱序 `MIGRATIONS` 必须红"（顺序守卫）----
  // 判据分两层：① 清单**实际顺序**是升序（机械解析 index.ts，不是抄数字）；
  //             ② `migrations.test.ts` 里那条 `toEqual([...NAMES].sort())` 还在（守卫真的进了套件）。
  {
    const idxPath = path.join(API_ROOT, "src", "db", "migrations", "index.ts");
    const src = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "";
    // ① 解析 import 别名 → 迁移名，再按 `MIGRATIONS` 数组里的出现顺序取出名字。
    const alias = new Map();
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["']@\/db\/migrations\/(\d{3}_[A-Za-z0-9_]+)["']/g)) {
      alias.set(m[1], m[2]);
    }
    const arrStart = src.indexOf("export const MIGRATIONS");
    const arrEnd = arrStart >= 0 ? src.indexOf("];", arrStart) : -1;
    const arrBody = arrStart >= 0 && arrEnd > arrStart ? src.slice(arrStart, arrEnd) : "";
    const ordered = [];
    for (const m of arrBody.matchAll(/^\s*([A-Za-z_]\w*)\s*,\s*$/gm)) {
      if (alias.has(m[1])) ordered.push(alias.get(m[1]));
    }
    const sorted = [...ordered].sort();
    pass(
      G_RULINGS,
      `Ruling24（必做）：MIGRATIONS 数组顺序必须是升序（knex 不排序；乱序会静默按错序执行）`,
      ordered.length >= 3 && JSON.stringify(ordered) === JSON.stringify(sorted),
      `数组顺序 ${JSON.stringify(ordered)}；升序应为 ${JSON.stringify(sorted)}（解析到 ${alias.size} 个 import）`,
    );
    // ② 守卫必须真的在测试套件里（只解析顺序不够：数组可能是"恰好有序"而没人守它）
    const tPath = path.join(API_ROOT, "tests", "migrations.test.ts");
    const tSrc = fs.existsSync(tPath) ? fs.readFileSync(tPath, "utf8") : "";
    pass(
      G_RULINGS,
      "Ruling24 接线：tests/migrations.test.ts 里必须有 `expect(NAMES).toEqual([...NAMES].sort())`（守卫进了套件）",
      /expect\(NAMES\)\.toEqual\(\[\.\.\.NAMES\]\.sort\(\)\)/.test(tSrc),
      tSrc ? "没找到那条断言" : "测试文件不存在",
    );
    // ③ 反向哨兵：`makeMigrationSource` **不得**偷偷 sort（那会掩盖数组写错、让 --status 与真实执行顺序脱钩）
    const migSrc = src;
    pass(
      G_RULINGS,
      "Ruling24 反向哨兵：makeMigrationSource 不得偷偷 sort()（那会掩盖数组写错）",
      !/getMigrations[\s\S]{0,200}?\.sort\(/.test(migSrc),
      "getMigrations 里出现了 sort() —— 掩盖数组写错，违反 Ruling 24 的显式禁令",
    );
  }

  // ---- Ruling 26 ↔ "CI/验收脚本里出现 `MIWO_TEST_SLOW=1`"（唯一事务守卫必须真的执行）----
  {
    const ciPath = path.join(MIWO_ROOT, ".github", "workflows", "ci.yml");
    const ciSrc = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, "utf8") : "";
    // 判据：ci.yml 里必须**真的**把 MIWO_TEST_SLOW 设成 "1"（不是注释里提一句）。
    const ciSets = /^\s*MIWO_TEST_SLOW:\s*["']?1["']?\s*$/m.test(ciSrc);
    pass(
      G_RULINGS,
      "Ruling26（必做）：.github/workflows/ci.yml 里必须真的设置 MIWO_TEST_SLOW: \"1\"（不是注释里提一句）",
      ciSets,
      ciSrc ? (ciSets ? "" : "ci.yml 里没有生效的 MIWO_TEST_SLOW: \"1\" —— 唯一的事务守卫在 CI 上永不执行") : "ci.yml 不存在",
    );
    // 本脚本自己也要跑（D2 组）：判据是**本节所在文件**里有那段带 MIWO_TEST_SLOW 的慢用例调用。
    const selfSrc = fs.readFileSync(__filename, "utf8");
    pass(
      G_RULINGS,
      "Ruling26 接线：verify:phase1a 自己也要真跑慢用例（D2 组设 MIWO_TEST_SLOW=1 并断言 0 skipped）",
      /MIWO_TEST_SLOW:\s*"1"/.test(selfSrc) && /skipped === 0/.test(selfSrc),
      "本脚本里没有 D2 的慢用例调用 / 没有 0 skipped 断言",
    );
  }

  // ---- Ruling 12 ↔ "`check-copy.cjs` 含该注释"（235 下限 + 禁止单独下调）----
  {
    const ccPath = path.join(MIWO_ROOT, "tools", "check-copy.cjs");
    const ccSrc = fs.existsSync(ccPath) ? fs.readFileSync(ccPath, "utf8") : "";
    pass(
      G_RULINGS,
      "Ruling12（必做）：tools/check-copy.cjs 在阈值处含「235 是当前下限；下调必须随真正删 .ts 的 Task」注释",
      // ⚠ 三个判据分别锚在：注释的两句关键话 + **真正生效的那次 `mustAtLeast(..., 235)` 调用**。
      //    最后一个不能用 `/mustAtLeast\([\s\S]{0,80}?,\s*235\)/`：那个正则会被**函数定义行**
      //    （`function mustAtLeast(label, actual, min) {`）之后的正文抢先命中（实测恒真/恒假都不对）。
      //    改成逐行找"以 `mustAtLeast(` 开头的调用行、且该行以 `, 235);` 结尾"。
      /235 是当前下限/.test(ccSrc) &&
        /禁止单独为/.test(ccSrc) &&
        ccSrc.split(/\r?\n/).some((l) => /^\s*mustAtLeast\(/.test(l) && /,\s*235\);\s*$/.test(l)),
      ccSrc ? "注释或 235 阈值缺失" : "check-copy.cjs 不存在",
    );
    // 计划文件里的就地标注（本机路径；CI 上没有该文件 → 记信息行，不算判据）
    const planPath = "D:\\sy_workspace\\docs\\superpowers\\plans\\2026-10-12-miwo-phase1a-mysql-migrations.md";
    if (fs.existsSync(planPath)) {
      const plan = fs.readFileSync(planPath, "utf8");
      pass(
        G_RULINGS,
        "Ruling12 接线：计划 Task 1 Step 2 的 Expected 已就地标注「已被控制器裁定覆盖：保持 235」",
        /已被控制器裁定覆盖：保持 235/.test(plan),
        "计划文件里没有那条就地标注",
      );
    } else {
      info(G_RULINGS, "Ruling12 接线：计划文件不在本机（CI/全新树没有 docs/）→ 本条无对象", planPath);
    }
  }

  // ---- Ruling 8+16 ↔ "两处陈旧断言已改"（deploy/ 的两句假话）----
  {
    const dReadme = path.join(MIWO_ROOT, "deploy", "README.md");
    const dCompose = path.join(MIWO_ROOT, "deploy", "docker-compose.yml");
    const rSrc = fs.existsSync(dReadme) ? fs.readFileSync(dReadme, "utf8") : "";
    const cSrc = fs.existsSync(dCompose) ? fs.readFileSync(dCompose, "utf8") : "";
    // ⚠ 判据是"**不再是活的主张**"：必须出现更正标记，且旧句子不得以肯定语气留下。
    // ⚠ 同 ②：更正说明必然引述旧句（"旧版本这里写着『…』"），所以判据是
    //    "旧句只作为被引述的旧文出现 + 有更正标记"，不是"全文不含旧句"（后者恒红）。
    //    ⚠ 被引述的旧句**跨行**（标记在上一行、旧句在下一行），所以不能按"单行同时含两者"判；
    //      改成"旧句**之前**的一段窗口里必须有更正标记"。
    const staleIdx = rSrc.indexOf("硬编码 `better-sqlite3`");
    const staleQuoted = staleIdx < 0 || /已更正·Ruling 8\+16/.test(rSrc.slice(Math.max(0, staleIdx - 600), staleIdx));
    pass(
      G_RULINGS,
      "Ruling8+16（必做）①：deploy/README.md 不再**主张**「utils/db.ts 仍硬编码 better-sqlite3」且已就地更正",
      /已更正·Ruling 8\+16/.test(rSrc) && staleQuoted,
      rSrc
        ? `更正标记=${/已更正·Ruling 8\+16/.test(rSrc)}；旧句下标=${staleIdx}；旧句之前 600 字内有更正标记=${staleQuoted}`
        : "deploy/README.md 不存在",
    );
    // ⚠ 判据是"**不再是活的主张**"，不是"文件里不许出现这几个字"：
    //    更正说明**必然要引述旧句子**（"旧注释写『…』"），所以拿"全文不含旧句"当判据会**恒红**。
    //    正确的判据：① 有更正标记；② 旧句子**只出现在带更正标记的那一段里**（作为被引述的旧文），
    //    不得以肯定语气独立存在。实现：逐行看，凡是含旧句的行，必须同时含更正标记。
    const staleLines = cSrc.split(/\r?\n/).filter((l) => /应用根本不消费这一组变量/.test(l));
    const staleIsQuoted = staleLines.every((l) => /已更正·Ruling 8\+16|旧注释写/.test(l));
    pass(
      G_RULINGS,
      "Ruling8+16（必做）②：deploy/docker-compose.yml 不再**主张**「Phase 1a 之前应用根本不消费这一组变量」（旧句只能作为被引述的旧文出现）",
      /已更正·Ruling 8\+16/.test(cSrc) && staleIsQuoted,
      cSrc
        ? `更正标记=${/已更正·Ruling 8\+16/.test(cSrc)}；含旧句的行数=${staleLines.length}，其中作为被引述旧文的=${staleLines.filter((l) => /已更正·Ruling 8\+16|旧注释写/.test(l)).length}`
        : "deploy/docker-compose.yml 不存在",
    );
    // 反向哨兵：两处都必须**同时**改（Ruling 16 明确要求"别只改一处"）。
    pass(
      G_RULINGS,
      "Ruling8+16 反向哨兵：两处**一起**改（Ruling 16 明确禁止只改一处）",
      /已更正·Ruling 8\+16/.test(rSrc) && /已更正·Ruling 8\+16/.test(cSrc),
      `README=${/已更正·Ruling 8\+16/.test(rSrc)} compose=${/已更正·Ruling 8\+16/.test(cSrc)}`,
    );
  }
}

// ---------- F：可选 MySQL ----------
if (process.env.MIWO_TEST_MYSQL === "1") {
  const r = run(process.execPath, ["scripts/verify-mysql-migration.cjs"], { cwd: API_ROOT });
  if (r.status === 0) pass(G_MYSQL, "真 MySQL 验收 8/8", outOf(r).trim().split("\n").slice(-1)[0]);
  else fail(G_MYSQL, "真 MySQL 验收 8/8", tail(outOf(r), 2000));
} else {
  pass(G_MYSQL, "跳过（未设 MIWO_TEST_MYSQL=1）—— CI 的 mysql job 会真跑");
}

// ---------- 渲染 ----------
let group = "";
for (const c of checks) {
  if (c.g !== group) {
    group = c.g;
    console.log(`\n== ${group} ==`);
  }
  // ⚠ 【M4】信息行用 `[信息]` 前缀且**不计入通过数**：让摘要里的 `通过 N / M` 只反映真判据。
  //    旧版把"dev 库现在是这个哈希"这种**无条件 pass** 也计进 60/60，等于给数字掺水。
  const tag = c.info ? "信息" : c.ok ? "通过" : "失败";
  console.log(`  [${tag}] ${c.n}${!c.ok && c.d ? " —— " + c.d : ""}${c.info && c.d ? " —— " + c.d : ""}`);
}
// 通过数只数**真判据**（`info` 行既不进分子也不进分母）。
const judged = checks.filter((c) => !c.info);
const infoCount = checks.length - judged.length;
const failed = judged.filter((c) => !c.ok);
console.log(
  `\n--- 摘要：通过 ${judged.length - failed.length} / ${judged.length}${infoCount ? `（另有 ${infoCount} 条信息行，不计入）` : ""} ---`,
);
if (CI_MODE) console.log("--- 口径：CI（--ci）—— 本机专属检查已显式记为「CI 不适用」且不计入通过数 ---");
if (failed.length) {
  console.error("\nPhase 1a 验收失败：");
  for (const c of failed) console.error(`  - [${c.g}] ${c.n}${c.d ? " —— " + c.d : ""}`);
  process.exit(1);
}
console.log("\nPhase 1a 验收通过：迁移化数据层就位、sqlite 与 MySQL 两条路径都有证据、门禁全绿、旧仓库零改动");
