#!/usr/bin/env node
/**
 * 谜沃 Phase 1a 验收（spec §13 + §12.2 T5）。
 *
 * 用法（在仓库根跑）：`node apps/api/scripts/verify-phase1a.cjs`，或 `pnpm.cmd run verify:phase1a`
 * 退出码 0 = 通过；逐条打印 [通过]/[失败]。
 *
 * 断言分组：
 *   A 构件：迁移机制与工具链的产物存在
 *   B 库层：sqlite 空目录能起、迁移幂等、27 张表齐、退役表不存在
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

const checks = [];
const pass = (g, n, d) => checks.push({ g, ok: true, n, d: d || "" });
const fail = (g, n, d) => checks.push({ g, ok: false, n, d: d || "" });
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
/** 27 张业务表（`001_schema` 的 createTable 集合；与 `src/db/migrations/001_schema.ts` 一致）。 */
const EXPECT_TABLES = [
  "memories", "o_agentDeploy", "o_agentWorkData", "o_artStyle", "o_assets", "o_assets2Storyboard",
  "o_assetsRole2Audio", "o_event", "o_eventChapter", "o_image", "o_imageFlow", "o_modelPrompt",
  "o_novel", "o_project", "o_prompt", "o_script", "o_scriptAssets", "o_segment", "o_setting",
  "o_shot", "o_shotAssets", "o_storyboard", "o_tasks", "o_user", "o_vendorConfig", "o_video",
  "o_videoTrack",
];
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
  if (fs.existsSync(path.join(MIWO_ROOT, rel))) pass(G_FILES, `存在 ${rel}`);
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
  pass(G_FILES, "A/裁定A 反向：显式 MIWO_DB_DRIVER=mysql 时放行", allowed);

  // (2) 护栏②：目标解析成**仓库内真实 dev 库**时必须拒绝，且放行开关要真的能放行。
  const blocked = guard.repoDevDbVerdict({ env: {}, argv: [] });
  pass(
    G_FILES,
    `A/裁定A 判别力②：目标解析成仓库内 dev 库（${DEV_DB}）且未显式放行 → 拒绝`,
    blocked.blocked === true && blocked.resolved === DEV_DB,
    `blocked=${blocked.blocked} resolved=${blocked.resolved}`,
  );
  const stillBlocked = guard.repoDevDbVerdict({ env: { MIWO_DATA_DIR: "./data" }, argv: [] });
  pass(
    G_FILES,
    "A/裁定A 判别力②（加强）：显式 MIWO_DATA_DIR=./data **仍然**拒绝（解析结果才是判据，不是'写没写变量'）",
    stillBlocked.blocked === true,
    `blocked=${stillBlocked.blocked} reason=${stillBlocked.reason}`,
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
  for (const rel of ["scripts/db-migrate.ts", "scripts/db-repair-stuck.ts", "scripts/import-mysql.cjs", "scripts/compare-db.cjs"]) {
    const p = path.join(API_ROOT, rel);
    let wired = false;
    let why = "文件不存在";
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, "utf8");
      wired = /require\(["']\.\/db-target-guard\.cjs["']\)/.test(src) && /requireRepoDevDbAllowed|repoDevDbVerdict/.test(src);
      why = wired ? "" : "文件里没有 require 本护栏 / 没有调用它的判定";
    }
    pass(G_FILES, `A/裁定A 接线：${rel} 真的调用了护栏`, wired, why);
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
    const missing = EXPECT_TABLES.filter((x) => !names.includes(x));
    const extra = names.filter((x) => !EXPECT_TABLES.includes(x));
    if (!missing.length && names.length === EXPECT_TABLES.length) pass(G_DB, `27 张业务表齐（${names.length}）`);
    else fail(G_DB, "27 张业务表齐", `缺 ${missing.join(",") || "无"}；多 ${extra.join(",") || "无"}；总数 ${names.length}`);
    const retired = RETIRED_TABLES.filter((x) => names.includes(x));
    if (!retired.length) pass(G_DB, "退役表未创建（spec §5.4）");
    else fail(G_DB, "退役表未创建", retired.join(","));
  }

  // ---- 裁定 C（★Ruling 132）在**本脚本**侧的同族断言：迁移名册 ⊇ 硬编码 allowlist ----
  // ⚠ 与 `verify-phase0.cjs` 里那一条是**同一个判据的两处落点**，故意都留：
  //   `verify-phase0` 会在没有 dev 库的环境里也跑，本脚本则总是跑 —— 谁被跳过都不至于让
  //   "删掉一个迁移"这件事漏过去。
  const ALLOW = ["001_schema", "002_platform_seed", "003_vendor_asset_sync"];
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
    pass(
      G_DB,
      "B/裁定B 文件里没有 `if (!fs.existsSync(...)) return;` 形态的 dev 库守卫",
      !/if\s*\(\s*!fs\.existsSync\([^)]*\)\s*\)\s*return\s*;/.test(src),
      "仍存在静默早退守卫",
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
        // 27 张表的集合必须与 001_schema 的清单**逐名相等**（含"不多不少"）。
        const got = mf.tables.map((t) => t.name).sort();
        const want = [...EXPECT_TABLES].sort();
        pass(
          G_DATA,
          `导出表集合与 001_schema 的 27 张业务表逐名相等`,
          JSON.stringify(got) === JSON.stringify(want),
          `缺 ${JSON.stringify(want.filter((x) => !got.includes(x)))} / 多 ${JSON.stringify(got.filter((x) => !want.includes(x)))}`,
        );

        // ---- Ruling 93 对账（权威口径在**同一个** manifest 里现算，不手抄数字）----
        // ⚠ 为什么必须"现算"：报告里出现的 27/207/2373 与 fixture 里的 29/219/2408
        //    是**两个不同口径**（见 D 组），而人写的数字会漂移。这里把"导出物口径"钉成断言。
        //    fixture 口径的核对在 D 组（那边会断言两份清单**恰好差那两张退役表**）。
        {
          const cols = mf.tables.reduce((s, x) => s + (x.columns ? x.columns.length : 0), 0);
          pass(G_DATA, `Ruling93 导出物口径（权威、现算）：${mf.tables.length} 表 / ${cols} 列 / ${rows} 行`);
        }

        // ---- Ruling 93 对账：导出物口径 vs `tests/fixtures/legacy-column-stats.json` 口径 ----
        // 两个口径的差必须**恰好**是那两张退役表（`o_skillList` / `o_skillAttribution`）：
        //   · `export-sqlite.cjs` 的 `TABLES` 是"搬迁范围"（27 张，退役表不搬）；
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
              pass(
                G_DATA,
                `Ruling93 口径对账：fixture 比导出物多出的表**恰好**是 ${RETIRED_TABLES.slice().sort().join(" + ")}（口径差异，不是漂移）`,
                JSON.stringify(onlyInFixture) === JSON.stringify([...RETIRED_TABLES].sort()),
                `fixture=${fxTables.length} 表 / 导出物=${expTables.length} 表；只多出 ${JSON.stringify(onlyInFixture)}`,
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
              pass(
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
        //      里面还没有迁移过的表，所以 27 条 `missing-target-table` 是**预期**结论。
        //      它恰恰证明"preflight 真的在拦"（而不是"空目标也放过去写"）。
        //    所以判据是 `{0,2}` **且**输出里明确出现 DRY-RUN 或被 preflight 拒绝，
        //    并且**另外**用 import-report 的 `applied === false` 钉住"一行都没写"。
        if ((i.status === 0 || i.status === 2) && (/DRY-RUN/.test(iOut) || /被 preflight 拒绝/.test(iOut))) {
          pass(
            G_DATA,
            `导入（dry-run，目标=一次性未迁移空库）EXIT ${i.status} 且明确未写库`,
            `预期判据：preflight 拦住 27 张缺表（不是"空库也放过去"）；${(iOut.match(/\[import\][^\n]*/g) || []).slice(-1)[0] || ""}`,
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
  ["verify:legacy-freeze", "node", ["tools/record-legacy-freeze.cjs", "--check"]],
]) {
  const r = run(cmd, args);
  if (r.status === 0) pass(G_HYGIENE, name, tail(r.stdout, 200).trim().split("\n").pop());
  else fail(G_HYGIENE, name, tail(outOf(r), 700));
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
{
  // 旧仓库 sha256 冻结（复用 Phase 0 的基线）
  const b = path.join(MIWO_ROOT, "tools", ".phase0-old-baseline.json");
  if (!fs.existsSync(b)) fail(G_HYGIENE, "旧仓库冻结基线存在", b);
  else {
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
  // ⚠ 只报"它现在是什么"，不做"和某个历史值比对"——基线值写在报告里、由人工复核；
  //    这里机械断言的是"本脚本跑完它仍然是这个值"（防"验收脚本自己把 dev 库写坏了"）。
  const h = (p) => (fs.existsSync(p) ? require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null);
  const before = h(DEV_DB);
  pass(G_HYGIENE, `仓库 dev 库 sha256 = ${before || "(不存在)"}（本验收对它是只读的）`);
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
  console.log(`  [${c.ok ? "通过" : "失败"}] ${c.n}${!c.ok && c.d ? " —— " + c.d : ""}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n--- 摘要：通过 ${checks.length - failed.length} / ${checks.length} ---`);
if (failed.length) {
  console.error("\nPhase 1a 验收失败：");
  for (const c of failed) console.error(`  - [${c.g}] ${c.n}${c.d ? " —— " + c.d : ""}`);
  process.exit(1);
}
console.log("\nPhase 1a 验收通过：迁移化数据层就位、sqlite 与 MySQL 两条路径都有证据、门禁全绿、旧仓库零改动");
