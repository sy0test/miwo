#!/usr/bin/env node
/**
 * 数据库**目标护栏**（Phase 1a / Task 11；控制器裁定 A = ★Ruling 131·机制加固）。
 *
 * ── 这个文件存在的唯一原因（已发生的事故，不是假想）──
 * Task 10 第一次跑 MySQL 探针时**漏设了 `MIWO_DB_DRIVER=mysql`**。后果不是报错，而是：
 *   默认驱动 = `sqlite`（`src/config.ts:120` 的 `optional(env,"MIWO_DB_DRIVER") ?? "sqlite"`）
 *   ＋ 默认数据目录 = `apps/api/data`（`apps/api/.env` 的 `MIWO_DATA_DIR=./data`）
 *   ⇒ 那个"探针"**静默打开了真实 dev 库 `apps/api/data/db2.sqlite` 并写进去**。
 *   最后靠"三份 sha256 与硬约束值相同的备份之一"覆盖才还原。
 *
 * 根因是**两条默认值叠加**：任何漏设驱动的脚本都会落到真实 dev 库。纪律靠不住，所以这里落机制。
 *
 * ── 本模块提供的两条**故意不对称**的护栏 ──
 *
 *   护栏 ① `requireDriver("mysql", what)` —— **凡意图使用 MySQL 的东西**（探针、迁移、
 *   导入、比对、集成测试的前置）必须在**任何连库动作之前**显式失败，**绝不静默回落 sqlite**。
 *   旧行为会把"根本没连 MySQL"伪装成"MySQL 有 bug"（`verify-mysql-migration.cjs` 的
 *   空转护栏 A 是同族先例，那边只覆盖了它自己一个脚本）。
 *
 *   护栏 ② `requireRepoDevDbAllowed(opts)` —— **禁止 `up`/`down`/`rollback` 默认打到
 *   `apps/api/data/db2.sqlite`**。判定是两条**机械**条件（不靠正则猜意图）：
 *     (a) env 里**没有** `MIWO_DATA_DIR` —— 也就是说这个路径不是调用方点名的，而是从
 *         `apps/api/.env` 或默认值**继承**来的；
 *     (b) 目标文件正好是 `<仓库>/apps/api/data/db2.sqlite`。
 *   两条同时成立才拦。"仓库根"用 `git rev-parse --show-toplevel` 拿，而不是从 `.env`
 *   反推 —— `.env` 就在仓库里，按它推位置是循环论证。
 *
 *   放行只需**一个显式开关**（任一）：
 *     · 命令行 `--allow-repo-dev-db`
 *     · 环境变量 `MIWO_ALLOW_REPO_DEV_DB=1`
 *   ⚠ 这两个都**不是**新的 `MIWO_*` 配置变量（裁定 5 / 本 Task 边界）：
 *     `MIWO_ALLOW_REPO_DEV_DB` 是**进程级一次性开关**（`config.ts` 不读它、它有值也不影响
 *     任何配置派生），与 `MIWO_GEN_DB_TYPES` 同类。
 *
 *   护栏 ③ `ensureRecoverablePoint(opts)` ——【Ruling 139】**放行开关不足以放行**：
 *     "显式放行 = 显式承担 + **留下可恢复点**"。`requireRepoDevDbAllowed()` 在语法层放行之后
 *     会**先**在仓库外（默认 `<仓库根>/../../.db-backups`）找到一份 sha256 相同的既有备份，
 *     或者现备一份并**校验拷贝的 sha256**；两条都做不到就**仍然拒绝**。
 *     为什么必须这样：本阶段 dev 库被误写过 **3 次**（Task 10 一次、Task 11 两次），
 *     三次都靠"**恰好**存在一份 sha256 相同的备份"救回 —— 可恢复性不能交给运气。
 *     它只读目标库（`readFileSync` / `copyFileSync`），**绝不打开、绝不改写** dev 库。
 *
 * ── 为什么放在 `scripts/` 而不是 `src/db/` ──
 *   `tools/check-tenant-exceptions.cjs` 把 `apps/api/src/**` 的 `.ts` 文件数钉成逐项快照
 *   （`scanScope.tsFilesScanned`）：往 `src/` 加一个 `.ts` 就要重跑 `--record` 并把新文件
 *   当成"隔离例外"逐条人工标注。本模块是**命令行护栏**、不是租户隔离策略的输入，放这里
 *   既不该占用那份清单，也避免把"给开发脚本加防护"变成"改租户例外清单"。
 *
 * ── 用法 ──
 *   const guard = require("./db-target-guard.cjs");
 *   guard.requireDriver("mysql", "MySQL 集成探针");       // 漏设 driver → 立刻红
 *   guard.requireRepoDevDbAllowed({ argv: process.argv.slice(2), what: "db:migrate" });
 *
 * ⚠ 本文件是纯 CJS、**不读 `@/config`**（命令行脚本可能在 config 之前就要拒绝），
 *   所以它自己解析 env，并如实复述 `config.ts` 的默认值（`sqlite`）。
 *   两边若哪天漂移，`apps/api/tests/db-driver.test.ts` 的同族断言会先红。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");

/** 仓库里那份**真实 dev 库**（`.gitignore` 忽略；被写坏过一次，不能再有第二次）。 */
function repoDevDbFile() {
  return path.join(API_ROOT, "data", "db2.sqlite");
}

/**
 * 仓库根。优先 `git rev-parse`（`--git-dir` 的形式在 worktree 下也稳），失败再退回两级目录。
 * ⚠ **不**从 `apps/api/.env` 的 `MIWO_DATA_DIR=./data` 反推 —— `.env` 本身就在仓库里，
 *   拿它证明"这个路径在仓库里"是循环论证。
 */
function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: API_ROOT,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return path.resolve(API_ROOT, "..", "..");
  }
}

/** 路径比较用的规范化：绝对化 + 盘符/大小写归一（Windows 上 `D:\a` 与 `d:/a` 是同一个文件）。 */
function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function envOf(opts) {
  return (opts && opts.env) || process.env;
}

/** env 里是否有**非空**值（与 `src/config.ts` 的 `optional()` 同口径：空串/纯空白算"未设置"）。 */
function envSet(env, key) {
  const v = env[key];
  return v !== undefined && String(v).trim() !== "";
}

/** 默认驱动器（与 `src/config.ts:120` 一字不差）。 */
function driverOf(opts) {
  const env = envOf(opts);
  return envSet(env, "MIWO_DB_DRIVER") ? String(env.MIWO_DB_DRIVER).trim() : "sqlite";
}

/**
 * 目标库描述（不含口令值 —— 报告/日志里绝不能出现密钥）。
 * ⚠ driver 为 mysql 时**不回读** `MIWO_DB_PASSWORD`，只报"是否已设置"。
 */
function describeTarget(opts) {
  const env = envOf(opts);
  const driver = driverOf(opts);
  if (driver === "mysql") {
    const host = String(env.MIWO_DB_HOST || "").trim() || "(未设)";
    const port = String(env.MIWO_DB_PORT || "").trim() || "(未设)";
    const user = String(env.MIWO_DB_USER || "").trim() || "(未设)";
    const name = String(env.MIWO_DB_NAME || "").trim() || "(未设)";
    const pw = envSet(env, "MIWO_DB_PASSWORD") ? "已设置" : "空";
    return `mysql://${user}@${host}:${port}/${name} (password=${pw})`;
  }
  const dataDir = envSet(env, "MIWO_DATA_DIR") ? String(env.MIWO_DATA_DIR) : "(未设 → 继承 .env)";
  const file = envSet(env, "MIWO_DATA_DIR")
    ? path.join(path.resolve(String(env.MIWO_DATA_DIR)), "db2.sqlite")
    : repoDevDbFile();
  return `sqlite://${file} (MIWO_DATA_DIR=${dataDir})`;
}

/** 供 --help / 报错尾部复述：本仓库是 CJS/tsx，从 `apps/api` 下跑。 */
const HOWTO =
  "  本仓库的数据库脚本一律从 apps/api 下跑（tsx 只装在 @miwo/api）：\n" +
  '    $env:MIWO_DB_DRIVER="mysql"; $env:MIWO_DB_HOST="127.0.0.1"; $env:MIWO_DB_PORT="3307"\n' +
  '    $env:MIWO_DB_USER="miwo"; $env:MIWO_DB_PASSWORD="miwo"; $env:MIWO_DB_NAME="miwo_test"\n' +
  "    pnpm.cmd exec tsx scripts/db-migrate.ts";

/**
 * 护栏 ①：**意图使用 MySQL 的脚本，漏设 `MIWO_DB_DRIVER=mysql` 必须立刻失败**。
 *
 * 为什么口径是"恰好等于 mysql"而不是"以 mysql 开头"：`src/config.ts` 只认
 * `sqlite` / `mysql` 两个字面量，别的值会抛 `ConfigError`。这里提前把同一件事说清楚，
 * **并且不在错值上继续跑**（继续跑就是"拿默认 sqlite 冒充 MySQL"）。
 *
 * @param {string} want 期望的驱动器（当前只有 "mysql" 一种用法）
 * @param {string} what 调用方自述（出现在错误信息里，便于定位是哪个脚本拒绝的）
 * @param {{env?: NodeJS.ProcessEnv, exitCode?: number, log?: (s: string) => void}} [opts]
 */
function requireDriver(want, what, opts) {
  const env = envOf(opts);
  const log = (opts && opts.log) || ((s) => console.error(s));
  const got = envSet(env, "MIWO_DB_DRIVER") ? String(env.MIWO_DB_DRIVER).trim() : "";
  if (got === want) return;

  log(`${what}：拒绝执行 —— MIWO_DB_DRIVER 必须是 "${want}"，实际 "${got || "(未设置)"}"。`);
  log("  这是**硬护栏**（Task 11 / 控制器裁定 A：★Ruling 131 机制加固），不是提醒：");
  log(`  · 未设置时 src/config.ts 的默认值是 "sqlite"，脚本会**静默**去连 sqlite ——`);
  log("    本仓库的 sqlite 默认目标正是**真实 dev 库** apps/api/data/db2.sqlite；");
  log("    Task 10 就因为漏设这一个变量把那个文件写坏过一次。");
  log("  · 继续跑只会把「根本没连 MySQL」报成「MySQL 有 bug」（Ruling 120 同族：会空转的检查 = 没有检查）。");
  log(HOWTO);
  if (opts && typeof opts.exitCode === "number") process.exit(opts.exitCode);
  const e = new Error(`${what}: MIWO_DB_DRIVER 必须是 "${want}"，实际 "${got || "(未设置)"}"`);
  e.code = "MIWO_DB_DRIVER_REQUIRED";
  throw e;
}

/**
 * 解析"这个进程真正会连的那份 sqlite 文件"（与 `src/config.ts` 同一推导：`path.resolve(MIWO_DATA_DIR)`＋
 * `/db2.sqlite`）。`MIWO_DATA_DIR` 未设置时，退回**仓库内 dev 库**（因为 `MIWO_DATA_DIR` 是必填项，
 * 那种情况下能启动的唯一解释就是它来自 `apps/api/.env` 的 `./data` —— 从 `apps/api` 目录解析出来
 * 正好就是这份文件）。
 */
function resolvedSqliteFile(opts) {
  const env = envOf(opts);
  // ⚠ 【裁定 A】允许调用方**直接给出已解析的目标文件**（`opts.file`）。
  //   为什么需要：应用启动路径（`src/db/connect.ts` 的 `connect()`）拿到的是 `MiwoConfig`，
  //   它里面的 `db.file` 是 config.ts 已经 `path.resolve()` 过的绝对路径。若只按
  //   `MIWO_DATA_DIR` 重新推导，就会出现"配置里解析出来的文件"与"护栏判定的文件"两份真相
  //   （测试传假 config、cwd 不同、相对路径写法不同都会让两者漂移）。
  //   给了 `file` 就**以它为准**，判定对象与实际要打开的对象逐字同一个。
  if (opts && opts.file) return path.resolve(String(opts.file));
  if (!envSet(env, "MIWO_DATA_DIR")) return repoDevDbFile();
  const base = path.resolve(String(env.MIWO_DATA_DIR));
  return path.join(base, "db2.sqlite");
}

/**
 * 护栏 ②：**禁止 `up`/`down`/`rollback` 默认打到仓库内真实 dev 库**。
 *
 * 判别力来自两条**机械**条件的合取（见文件头）：
 *   (a) **驱动分支是 sqlite**（`MIWO_DB_DRIVER` 未设置或恰为 `"sqlite"`）——
 *       `MIWO_DATA_DIR` 只影响 sqlite 分支；mysql 分支的护栏是 `requireDriver`。
 *   (b) **解析出的目标文件正好是 `<仓库根>/apps/api/data/db2.sqlite`** ——
 *       路径一律 `path.resolve()` 后比（`./data` 或 `apps/api/data` 这类相对写法会按
 *       **进程 cwd** 解析，而所有 `db:*` 脚本的 cwd 都是 `apps/api`）；大小写在 Windows 上归一。
 *   (c) **没有显式放行开关**（命令行 `--allow-repo-dev-db` 或 `MIWO_ALLOW_REPO_DEV_DB=1`）。
 * 三条同时成立才拦。
 *
 * ⚠ 为什么把 `MIWO_DATA_DIR` 显式与否**降级成"原因描述"而不是判据的一部分**：
 *   显式给出 `MIWO_DATA_DIR=./data`、或显式给出 `apps/api/data`，解析出来**还是那份真实 dev 库**，
 *   危害与"没设"完全一样。原版判据把它当豁免，于是 `MIWO_DATA_DIR=./data node scripts/import-mysql.cjs --apply`
 *   照样会写进 dev 库 —— 那不是"显式"，只是把同一件事多打了一遍。现在卡的是**最终解析结果**。
 *
 * 返回 `{checked, blocked, target, reason, ...}`；调用方拿到 `blocked: true` 就**不许**继续写库。
 *
 * @param {{env?: NodeJS.ProcessEnv, argv?: string[], what?: string, log?: (s: string) => void}} [opts]
 */
function repoDevDbVerdict(opts) {
  const env = envOf(opts);
  const argv = (opts && opts.argv) || [];
  const dataDirExplicit = envSet(env, "MIWO_DATA_DIR");
  // ⚠ 【裁定 A】允许调用方直接给出**已解析的驱动**：应用启动路径拿的是 `MiwoConfig.db.driver`，
  //   它由 `config.ts` 从 env 派生，但测试会传假 config（例如 driver=mysql 而 env 里没有 MIWO_DB_DRIVER）。
  //   不认这个入参就会出现"配置说 mysql、护栏按 env 判成 sqlite"的错位 —— 而那正是本护栏
  //   最容易假绿的地方（它会去拦一个根本不会被打开的 sqlite 文件，或反过来放行）。
  const driver = (opts && opts.driver) || driverOf(opts);
  const root = repoRoot();
  const canonicalDevFile = path.join(root, "apps", "api", "data", "db2.sqlite");
  const resolved = resolvedSqliteFile(opts);
  const isDevFile = samePath(resolved, canonicalDevFile);
  const how = opts && opts.file
    ? "调用方给出的已解析目标文件（MiwoConfig.db.file）就是"
    : dataDirExplicit
      ? `MIWO_DATA_DIR=${String(env.MIWO_DATA_DIR)} 解析成`
      : "MIWO_DATA_DIR 未设置（继承 apps/api/.env 的 ./data）→ 解析成";

  // ⚠⚠ **必须按驱动分流**（Task 11 实测踩过）：`MIWO_DATA_DIR` 是**sqlite 分支**才用的路径
  //    （`config.ts` 的 mysql 分支根本不读它）。若不过滤驱动，`MIWO_DB_DRIVER=mysql` +
  //    `MIWO_DATA_DIR=apps/api/data` 会被误判成"要写真实 dev 库"而拒绝 ——
  //    那会把**所有** MySQL 用法（包括 CI 的 mysql job 与 Step 4 的验收）全打死。
  //    mysql 分支的护栏由 `requireDriver` 那一条负责，两条各管一个分支。
  if (driver !== "sqlite") {
    return {
      checked: true,
      blocked: false,
      target: describeTarget(opts),
      resolved,
      canonicalDevFile,
      driver,
      reason: `驱动是 ${driver}，` + "`MIWO_DATA_DIR` 不在该分支的使用范围内（本护栏只管 sqlite 目标）",
    };
  }

  if (!isDevFile) {
    return {
      checked: true,
      blocked: false,
      target: describeTarget(opts),
      resolved,
      canonicalDevFile,
      reason: `${how} ${resolved}，不是仓库内 dev 库`,
    };
  }
  const argvFlag = argv.includes("--allow-repo-dev-db");
  const envFlag = String(env.MIWO_ALLOW_REPO_DEV_DB || "") === "1";
  if (argvFlag || envFlag) {
    return {
      checked: true,
      blocked: false,
      target: describeTarget(opts),
      resolved,
      canonicalDevFile,
      driver,
      // ⚠⚠ 【Ruling 139】这里只是**语法层**放行：真正的强制在 `requireRepoDevDbAllowed()` ——
      //    它会先建立/复用"可恢复点"（备份），再放行；建不出来就**仍然拒绝**。
      //    把这一层留在 verdict 里（而不是在这里做 I/O）是为了让 verdict 保持纯函数：
      //    `verify-phase1a.cjs` 与单测都可以随便调它，不会顺手写盘。
      optIn: {
        flag: argvFlag ? "--allow-repo-dev-db" : "MIWO_ALLOW_REPO_DEV_DB=1",
        recoverablePoint: "未建立 —— requireRepoDevDbAllowed() 会先建立可恢复点（备份到仓库外）再放行",
      },
      reason: `已显式放行（${argvFlag ? "--allow-repo-dev-db" : "MIWO_ALLOW_REPO_DEV_DB=1"}）：${how} ${resolved}`,
    };
  }
  return {
    checked: true,
    blocked: true,
    target: describeTarget(opts),
    devFile: canonicalDevFile,
    resolved,
    canonicalDevFile,
    repoRoot: root,
    driver,
    reason: `${how} **仓库内真实 dev 库** ${resolved}，且没有显式放行（${OPT_IN_FLAGS.join(" / ")}）`,
  };
}

/**
 * 仓库外备份目录的**默认位置**：`<仓库根>/../../.db-backups`。
 *
 * ⚠ 为什么不放进仓库：本仓库的既有约定就是 `D:\sy_workspace\.db-backups\`（见根 `AGENTS.md`
 *   与 repo dev 库的历史备份命名）。放仓库里既会被 `check-copy` 的体积断言看到，
 *   也有被 `git add -A` 带进去的风险 —— 而"备份"本身必须比被测对象**更安全**。
 *   （本机布局：仓库根 `D:\sy_workspace\code\miwo` → 上两级 `D:\sy_workspace`。）
 */
function defaultBackupDir() {
  return path.resolve(repoRoot(), "..", "..", ".db-backups");
}

function fileSha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** 备份目录里所有**可能是 sqlite 备份**的文件（大小写归一后按命名约定筛）。
 *  ⚠ 匹配的是"名字里出现 `.sqlite` / `.sqlite3` / `.db` 且后面是 `.` 或结尾"——
 *    本机既有备份的命名有 `.sqlite` 结尾的，也有 `db2.sqlite.bak-pre-retire` 这种**中间**出现的，
 *    只按扩展名结尾筛会漏掉后者（而后者正是当年救回 dev 库的那批）。 */
function backupCandidates(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(sqlite3?|db)(\.|$)/i.test(e.name))
    .map((e) => path.join(dir, e.name));
}

/**
 * 【Ruling 139】**"显式放行 = 显式承担 + 留下可恢复点"**。
 *
 * ── 为什么必须加固（已发生的事故，不是假想）──
 * 本阶段 dev 库被误写过 **3 次**（Task 10 一次、Task 11 两次：为做"裁定 A"的红绿，
 * `--allow-repo-dev-db --status` / `MIWO_ALLOW_REPO_DEV_DB=1 --status` 真的改写了
 * `apps/api/data/db2.sqlite`，29 表 → 31 表）。三次都是靠"**恰好**存在一份 sha256 相同的备份"救回来的
 * —— 也就是说，原来的放行开关把"能不能恢复"交给了运气。
 *
 * 现在：放行时**要么**复用一份 sha256 与当前 dev 库相同的既有备份，**要么**先把它备份到仓库外的
 * `.db-backups/` 并**校验拷贝的 sha256**；两者都做不到（目录建不出来 / 拷贝校验不一致）就**拒绝执行**。
 *
 * 返回 `{ ok: true, ... }` 或 `{ ok: false, error }`（调用方负责拒绝）。
 *
 * ⚠ 只读目标：全程只 `readFileSync` + `copyFileSync`，**不打开、不改写** dev 库。
 *
 * @param {{target?: string, backupDir?: string, log?: (s: string) => void, now?: () => number}} [opts]
 */
function ensureRecoverablePoint(opts) {
  const o = opts || {};
  const target = o.target || repoDevDbFile();
  const backupDir = o.backupDir || defaultBackupDir();
  const log = o.log || (() => {});
  const now = o.now || (() => Date.now());

  // 目标不存在 = 没有任何东西可丢（例如全新克隆 / CI）：放行，但如实说明没有建立可恢复点。
  if (!fs.existsSync(target)) {
    return { ok: true, target, reused: null, created: null, sha256: null, note: "目标文件不存在，无需备份" };
  }
  let sha256;
  try {
    sha256 = fileSha256(target);
  } catch (e) {
    return { ok: false, error: `读不出目标库的 sha256：${e && e.message}` };
  }

  // ① 复用：备份目录里已经有一份**内容完全相同**的？那就已经有一个可恢复点了。
  let reused = null;
  try {
    for (const p of backupCandidates(backupDir)) {
      if (samePath(p, target)) continue;
      try {
        if (fileSha256(p) === sha256) { reused = p; break; }
      } catch {
        /* 单个文件读不了不影响其它候选 */
      }
    }
  } catch (e) {
    return { ok: false, error: `扫不了备份目录 ${backupDir}：${e && e.message}` };
  }
  if (reused) return { ok: true, target, sha256, reused, created: null };

  // ② 现备一份（仓库外），并**校验拷贝**（拷贝本身也可能是错的，不能假设它成功）。
  const dest = path.join(backupDir, `${path.basename(target)}.allowdevdb-${now()}-${sha256.slice(0, 8)}.sqlite`);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(target, dest);
  } catch (e) {
    return { ok: false, error: `建不出可恢复点（${dest}）：${e && e.message}` };
  }
  let copiedSha = null;
  try {
    copiedSha = fileSha256(dest);
  } catch (e) {
    return { ok: false, error: `备份写完后读不回来（${dest}）：${e && e.message}` };
  }
  if (copiedSha !== sha256) {
    try { fs.unlinkSync(dest); } catch { /* 删不掉也照实报告 */ }
    return { ok: false, error: `备份校验不一致（${dest}：${copiedSha} != ${sha256}），已丢弃该备份` };
  }
  log(`[guard] 已建立可恢复点：${dest}`);
  log(`[guard]   sha256 校验一致：${sha256}`);
  return { ok: true, target, sha256, reused: null, created: dest };
}

/**
 * 护栏 ②的**硬版本**：`blocked` 就抛异常（默认）；给了 `exitCode` 就 `process.exit`。
 *
 * ⚠ 【Ruling 139】放行开关**不足以**放行：`requireRepoDevDbAllowed()` 会先建立/复用"可恢复点"
 *   （见 `ensureRecoverablePoint()`），建不出来就**照样拒绝**（`MIWO_REPO_DEV_DB_BLOCKED`）。
 *
 * @param {{env?: NodeJS.ProcessEnv, argv?: string[], what?: string, log?: (s: string) => void, exitCode?: number, backupDir?: string}} [opts]
 */
function requireRepoDevDbAllowed(opts) {
  const v = repoDevDbVerdict(opts);
  const log = (opts && opts.log) || ((s) => console.error(s));
  let finalReason = v.reason;
  if (!v.blocked) {
    if (v.optIn) {
      const what = (opts && opts.what) || "迁移脚本";
      const point = ensureRecoverablePoint({
        target: v.resolved,
        backupDir: opts && opts.backupDir,
        log,
      });
      if (!point.ok) {
        const msg =
          `${what}：拒绝执行 —— 已显式放行（${v.optIn.flag}），但**建不出可恢复点**：${point.error}。\n` +
          `  【Ruling 139】"显式放行 = 显式承担 + 留下可恢复点"：本阶段 dev 库已被误写 3 次，\n` +
          "  三次都靠「恰好有一份 sha256 相同的备份」救回 —— 放行不再允许把可恢复性交给运气。\n" +
          `  目标：${v.resolved}\n` +
          `  备份目录：${(opts && opts.backupDir) || defaultBackupDir()}（可写、可建，才能放行）`;
        log(msg);
        if (opts && typeof opts.exitCode === "number") process.exit(opts.exitCode);
        const e = new Error(`${what}: 已显式放行但建不出可恢复点（${point.error}）`);
        e.code = "MIWO_RECOVERABLE_POINT_REQUIRED";
        throw e;
      }
      finalReason = point.reused
        ? `已显式放行（${v.optIn.flag}）且**复用既有可恢复点** ${point.reused}（sha256 ${point.sha256}）`
        : `已显式放行（${v.optIn.flag}）且**先建立了可恢复点** ${point.created}（sha256 ${point.sha256}）`;
      log(`[guard] ${finalReason}`);
    }
    return { ...v, reason: finalReason };
  }
  const what = (opts && opts.what) || "迁移脚本";
  log(`${what}：拒绝执行 —— ${v.reason}。`);
  log(`  解析出的目标：${v.target}`);
  log("  这是**硬护栏**（Task 11 / 控制器裁定 A：禁止 up/down/rollback 默认打到真实 dev 库）：");
  log("  两条默认值叠加（默认驱动 = sqlite、默认数据目录 = apps/api/data）意味着");
  log("  「忘了设环境变量」与「故意对 dev 库跑迁移」在命令行上长得一模一样。");
  log("  要跑就必须**显式**说出目标，二者任一：");
  log(`    · 显式给数据目录（推荐，指向一次性目录）：MIWO_DATA_DIR=<目录>`);
  log("    · 显式确认就是要动这份 dev 库：加 --allow-repo-dev-db 或 MIWO_ALLOW_REPO_DEV_DB=1");
  log("      ⚠ 【Ruling 139】这条路会**先**把 dev 库备份到仓库外（或在仓库外找到一份 sha256 相同的备份），");
  log("        备份建不出来 / 校验不一致 → 仍然拒绝。");
  log("  动它之前也可以自己先备份：Copy-Item apps/api/data/db2.sqlite D:\\sy_workspace\\.db-backups\\<名字>");
  if (opts && typeof opts.exitCode === "number") process.exit(opts.exitCode);
  const e = new Error(`${what}: 目标解析成仓库内真实 dev 库（${v.devFile}）且未显式放行`);
  e.code = "MIWO_REPO_DEV_DB_BLOCKED";
  throw e;
}

/** `--help`/错误信息尾部用得上：本 Task 新增的两个开关到底是什么。 */
const OPT_IN_FLAGS = ["--allow-repo-dev-db", "MIWO_ALLOW_REPO_DEV_DB=1"];

module.exports = {
  API_ROOT,
  HOWTO,
  OPT_IN_FLAGS,
  defaultBackupDir,
  describeTarget,
  driverOf,
  ensureRecoverablePoint,
  repoDevDbFile,
  repoDevDbVerdict,
  repoRoot,
  requireDriver,
  requireRepoDevDbAllowed,
  resolvedSqliteFile,
  samePath,
};
