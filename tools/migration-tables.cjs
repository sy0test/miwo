#!/usr/bin/env node
/**
 * **建表清单解析器的单一来源**（Phase 1c Task 1）。
 *
 * 为什么要有这个文件：`apps/api/src/db/policies.ts` 的 `TABLE_POLICIES` 必须与"迁移真正建出来的表"
 * 逐项相等，而**后者没有可导入的运行时形态**（它是散在各迁移文件里的 schema builder 调用）。
 * 于是它只能靠源码解析 —— 而"同一件事解析两遍"必然漂移（本阶段已两次证明：手工清单必漂）。
 * 所以解析器**只有这一份**：
 *   · 门禁 `tools/check-tenant-policies.cjs` 直接 `require` 它；
 *   · 单测 `apps/api/tests/tenant-policies.test.ts` 也 `require` 它（两条落点，同一个实现）。
 *
 * ── 口径（每一条都有具体的迁移文件形状对应，不是"大概齐"）──
 *   1. **扫描范围 = `src/db/migrations/*.ts` 全部迁移**（findAllMigrations 按文件名升序）。
 *      ⚠ 1b 时期的门禁**只解析 `001_schema.ts`**，于是 `005/006` 建的表对门禁不可见 ⇒
 *      "策略表里的表不在建表清单里"当场红。这是本文件存在的直接原因。
 *   2. `deployedTables`（"最终落地的表"）= 所有 `createTable("x")` 的表名
 *      **减去**"创建之后又被 `renameTable(x, ...)` 改掉的**暂存表**"。
 *      暂存表必须命名为 `*_new` / `*_old`（我们自己的迁移约定，见 `005_accounts.ts`）：
 *      `up` 的 `o_user_new`、`down` 的 `o_user_old`。它们**不是**最终结构的一部分，
 *      给它们登记策略是错的（迁移结束时那张表并不存在）。
 *      ⚠ 只排除**真的被 renameTable 改过名**的表：一个叫 `o_x_new` 但从没被改名的表会**留在**
 *      `deployedTables` 里，照样要求登记策略（名字后缀不构成豁免）。
 *   3. `droppedTables`（退役表）= 所有 `dropTableIfExists("x")` 的表名。它对应
 *      `policies.DROPPED_TABLES`（spec §5.4 的两张）。
 *      ⚠ `dropTable("x")`（不带 IfExists）**不**计入：迁移里它是"重建 o_user 时删旧表"的**中转**动作，
 *      与"退役表"是两件事（把它算进来会让 `o_user` 被要求"已退役"，而它明明还在）。
 *   4. `stagingTables`（暂存表 = 被改名掉的）单独返回，供调用方断言"暂存表**不得**有策略"。
 *
 * ── 为什么正则而不是 AST ──
 *   与门禁既有风格一致（`createTable` 之后的表名是**字符串字面量**，形态固定）；
 *   ⚠ 已知边界：`createTable(变量)` / 模板串 / 单引号 / 换行成 `createTable(\n  "x"` 都**抽不到**。
 *   所以调用方必须做**下界自证**（解析到的表数 < 20 ⇒ exit 3，而不是"0 张 ⇒ 干净"）。
 *   当前仓库所有迁移都是 `createTable("x", ...)` 单行形态，实测覆盖 34 张（见验收报告）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "apps", "api", "src", "db", "migrations");

/** 迁移文件名的口径（与 `tests/migrations.test.ts` 的 `^\d{3}_.+\.ts$` 一致）。 */
const MIGRATION_FILE_RE = /^(\d{3})_[A-Za-z0-9_]+\.ts$/;

/** `createTable("x"` —— 表名必须是紧跟左括号的双引号字面量（见文件头的已知边界）。 */
const CREATE_RE = /createTable\(\s*"([A-Za-z0-9_]+)"/g;
/**
 * `renameTable("from", "to"` —— 只关心被改掉的 `from`。
 * ⚠ `\s*` 跨行（改名语句在 005 里就是写成两行的），所以**不能**用逐行解析。
 */
const RENAME_RE = /renameTable\(\s*"([A-Za-z0-9_]+)"\s*,\s*"([A-Za-z0-9_]+)"/g;
/**
 * `dropTableIfExists("x"` —— **退役表**（有意不带 `dropTable`，理由见文件头 3）。
 * ⚠ **必须用否定前瞻**：`dropTableIfExists("o_user")` 里含子串 `dropTable("o_user")`，
 *   不带 `(?!IfExists)` 的 `dropTable\(` 正则会把它一起吃掉 —— 那样"重建中转删除"与"退役删除"
 *   就再也分不开了（实测：005 的 down 里 6 张新表全被误判成退役表）。
 */
const DROP_IF_EXISTS_RE = /dropTableIfExists\(\s*"([A-Za-z0-9_]+)"/g;

/** 迁移文件名升序（= `MIGRATIONS` 数组的顺序，Ruling 24 的数组守卫另有断言）。 */
function findAllMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
}

function uniqSorted(list) {
  return [...new Set(list)].sort();
}

/**
 * 剥注释（**保持行号**：被剥掉的字符用空格补齐，换行不动）。
 *
 * ⚠ 必须剥：迁移文件里到处是解释性的注释，例如 `005_accounts.ts` 里就写着
 *   「`renameTable("a", "b")` 只能看到字符串字面量」—— 不剥注释会把**注释里举例的函数调用**
 *   当成真的调用（实测踩到：`renamedAway` 里凭空多出一个表名 `a`）。
 *   与 `tools/check-tenant-exceptions.cjs` / `check-mysql-dialect.cjs` 的 `stripComments` 同一口径。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

/**
 * 解析全部迁移，返回：
 *   { files, perFile, createdTables, renamedAway, deployedTables, droppedTables, retiredTables, stagingTables }
 * 全部按名字排序（便于逐项比对与打印）。
 *   · `droppedTables` = 所有 `dropTableIfExists` 的表名（含 down 里回滚自建表的正当用法）；
 *   · `retiredTables` = 其中**从没被本仓迁移创建过**的那些 = spec §5.4 的退役表
 *     （对应 `policies.DROPPED_TABLES`；门禁比对的是它，不是 `droppedTables`）。
 */
function collectMigrationTables() {
  const files = findAllMigrations();
  const createdTables = [];
  const renamedAway = [];
  const droppedTables = [];
  const perFile = {};
  for (const file of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // ⚠ 判据一律基于**剥注释后**的文本（见 stripComments 的注释）。
    // ⚠⚠ 每个文件都用**新建的**正则实例（不要复用模块级 `/g` 常量）：`String.prototype.matchAll`
    //   会把 `lastIndex` 写回**原正则对象**，复用同一个 `/g` 对象会让第二个文件从"上个文件停下的
    //    偏移"开始扫 —— **静默漏掉前半张表**（实测踩到：`o_user_new` 因此从暂存表里消失、
    //    `o_userSetting` 直接从建表清单里漏掉，而门禁照样绿）。
    const src = stripComments(raw);
    const created = [...src.matchAll(new RegExp(CREATE_RE.source, "g"))].map((m) => m[1]);
    const renamed = [...src.matchAll(new RegExp(RENAME_RE.source, "g"))].map((m) => m[1]);
    const dropped = [...src.matchAll(new RegExp(DROP_IF_EXISTS_RE.source, "g"))].map((m) => m[1]);
    createdTables.push(...created);
    renamedAway.push(...renamed);
    droppedTables.push(...dropped);
    perFile[file] = { created: uniqSorted(created), renamedAway: uniqSorted(renamed), dropped: uniqSorted(dropped) };
  }
  const renamedSet = new Set(renamedAway);
  // ⚠ 暂存表口径：既"被创建过"又"被 renameTable 改掉过"。只满足后者（改了别人建的表）不算。
  const stagingTables = uniqSorted(createdTables.filter((t) => renamedSet.has(t)));
  const deployedTables = uniqSorted(createdTables.filter((t) => !renamedSet.has(t)));
  const createdSet = new Set(createdTables);
  // ⚠ **退役表**口径必须再减一层：`dropTableIfExists` 在迁移里有两个正当用途 ——
  //   ① 清掉**老库**里的退役表（spec §5.4：`o_skillList` / `o_skillAttribution`，本迁移**不建**它们）；
  //   ② `down` 里回滚**本迁移自己建的表**（005/006 的 down 都是这种形状）。
  //   只有 ① 才是"退役"；把 ② 也当成退役会让"策略表 ↔ 退役清单"永久对不上。
  //   判据："被 IfExists 删过 **且从没被创建过**" = 退役表。
  const retiredTables = uniqSorted(droppedTables.filter((t) => !createdSet.has(t)));
  return {
    files,
    perFile,
    createdTables: uniqSorted(createdTables),
    renamedAway: uniqSorted(renamedAway),
    deployedTables,
    droppedTables: uniqSorted(droppedTables),
    retiredTables,
    stagingTables,
  };
}

module.exports = { ROOT, MIGRATIONS_DIR, MIGRATION_FILE_RE, findAllMigrations, collectMigrationTables };
