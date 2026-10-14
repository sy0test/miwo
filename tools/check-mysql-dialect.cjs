#!/usr/bin/env node
/**
 * MySQL 方言门禁（Phase 1b 收尾轮 / 终审 ③-A）：**本机 sqlite 绿 ≠ 真实路径不坏**。
 *
 * 背景（终审抓到、本机全绿的两个必坏点）：
 *   ① `order by \`rowid\` asc` —— `rowid` 是 **SQLite 隐式列**，MySQL 没有 ⇒ `ER_BAD_FIELD_ERROR`（500）；
 *      它在 4 个生产路由里，正好压在"分镜资产顺序 → 图片/视频提示词"这条核心链上。
 *   ② `select \`id\`,\`name\` … group by \`name\`` —— MySQL 8 默认 `ONLY_FULL_GROUP_BY` ⇒ `ER_1055`。
 *
 * 判据（**不需要 MySQL 服务器**）：
 *   A. **硬**：`apps/api/src/**` 的**剥注释后**文本里不得出现 `rowid` / `_rowid_`（SQLite 隐式列）。
 *   B. **硬（简单形态）**：`apps/api/src/routes/**` 里凡有字面量 `.groupBy("x", …)` 的文件，其字面量
 *      `.select(…)` 列表里的**裸列名**必须落在 groupBy 里；含 `.raw(`（可能是合法聚合/子查询）或
 *      `.select(knex.raw…)`/`*` 的文件只**警告**（避免假红 —— 见 `getEvent.ts` 的 GROUP_CONCAT）。
 *   C. **离线编译探针**：用 `knex({client:"mysql2"})` + `toSQL()` 打印两条 SQL，说明"为什么这是 MySQL 方言问题"
 *      （`order by \`rowid\`` 会被当成普通列名）。⚠ **未连真机**：只证明生成的 SQL 形态，不证明服务端行为。
 *
 * 退出码：0 = 干净；1 = 命中；**3 = 检查自身没跑起来**（扫不到源文件 / 载不到 knex —— 观测不到 ≠ 干净）。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "apps", "api", "src");
const ROUTES = path.join(SRC, "routes");
const failures = [];
const warnings = [];

/** 剥注释（保持行号：被剥掉的字符用空格补齐）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out); // 显式递归（不依赖 glob 的 ** 语义）
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(SRC).sort();
if (files.length < 100) {
  console.error(`check-mysql-dialect 无法完成：只扫到 ${files.length} 个 .ts（预期 >100）—— "观测不到"不等于"干净"。`);
  process.exit(3);
}

const ROWID_RE = /\b(rowid|_rowid_)\b/;
const GROUPBY_RE = /\.groupBy\(\s*(["'`])([^"'`]+)\1/g;
const SELECT_RE = /\.select\(\s*([^)]*)\)/g;
/** 统计"判据 B 真的解析到了列名"（观测不到 ⇒ exit 3，绝不当成干净 —— Ruling 243 精神）。 */
let groupByFiles = 0;
let parsedColumns = 0;
/** SQLite 隐式列/伪列（MySQL 没有）。`oid` 太通用、不列。 */

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const text = stripComments(fs.readFileSync(abs, "utf8"));
  text.split(/\r?\n/).forEach((line, i) => {
    if (ROWID_RE.test(line)) {
      failures.push(`${rel}:${i + 1} 出现 SQLite 隐式列 rowid（MySQL 没有这一列 ⇒ ER_BAD_FIELD_ERROR）：${line.trim()}`);
    }
  });

  // B：只在 routes/** 上做"未分组列"启发式
  if (!abs.startsWith(ROOT + path.sep + path.relative(ROOT, ROUTES))) continue;
  const groups = [...text.matchAll(GROUPBY_RE)].map((m) => m[2].trim());
  if (groups.length === 0) continue;
  const selects = [...text.matchAll(SELECT_RE)].map((m) => m[1]);
  if (selects.some((s) => /\.raw\(|knex\.raw|\*/.test(s))) {
    warnings.push(`${rel}: 有 groupBy 但 select 里含 raw/* ⇒ 只警告（可能是合法聚合/子查询，未做语义判定）`);
    continue;
  }
  groupByFiles += 1;
  const cols = new Set();
  for (const s of selects) {
    for (const raw of s.split(",")) {
      // ⚠ 必须**剥掉引号/反引号**：`select("taskClass", "o_tasks.id")` 解析出来是带引号的 token，
      //   不剥的话列名永远匹配不上 ⇒ 判据 B 会**恒真**（实测：R2 篡改注入未分组列却 exit 0 = 假绿）。
      const name = raw
        .trim()
        .split(/\s+as\s+/i)[0]
        .trim()
        .replace(/^["'`]|["'`]$/g, "")
        .trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) continue; // 只判"裸列名"
      cols.add(name);
      parsedColumns += 1;
    }
  }
  const missing = [...cols].filter((c) => !groups.includes(c));
  if (missing.length) {
    failures.push(
      `${rel} 的 select 含未分组列 ${missing.join(", ")}（groupBy 只有 ${groups.join(", ")}）` +
        ` —— MySQL 8 的 ONLY_FULL_GROUP_BY 会报 ER_1055`,
    );
  }
}

// 自证：判据 B 必须**真的解析到过列名**；`groupByFiles>0 而 parsedColumns==0` 说明解析器失灵（假绿）。
if (groupByFiles > 0 && parsedColumns === 0) {
  console.error(
    `check-mysql-dialect 无法完成：判据 B 一个列名都没解析出来（groupBy 文件 ${groupByFiles} 个）` +
      ` —— "观测不到"不等于"干净"（解析器失灵会让未分组列永远绿）。`,
  );
  process.exit(3);
}

// C：离线编译探针（未连真机）
let knex = null;
for (const p of [path.join(ROOT, "apps", "api", "node_modules", "knex"), path.join(ROOT, "node_modules", "knex")]) {
  try {
    knex = require(p);
    break;
  } catch {
    /* 换下一个候选路径 */
  }
}
if (typeof knex !== "function") {
  console.error("check-mysql-dialect 无法完成：载不到 knex ⇒ 离线编译探针没跑（观测不到 ≠ 干净）。");
  process.exit(3);
}
const my = knex({ client: "mysql2" });
const sqlRowid = my("o_assets2Storyboard").select("assetId").orderBy("rowid").toSQL().sql;
const sqlFixed = my("o_assets2Storyboard").select("assetId").orderBy("assetId").toSQL().sql;
const sqlBadGroup = my("o_project").select("id", "name").groupBy("name").toSQL().sql;
const sqlFixedGroup = my("o_project").select("name").min("id as id").groupBy("name").toSQL().sql;

if (failures.length) {
  console.error("check-mysql-dialect 失败：");
  for (const f of failures) console.error("  - " + f);
  for (const w of warnings) console.error("  ⚠ " + w);
  console.error(`  （离线编译对照，**未连真机**：坏写法 ${sqlRowid} / ${sqlBadGroup}）`);
  process.exit(1);
}
for (const w of warnings) console.warn("  ⚠ " + w);
console.log(
  `check-mysql-dialect 通过（${files.length} 个 .ts 无 SQLite 隐式列；routes 的 groupBy 形态合法）；` +
    `离线编译对照（**未连真机**）：rowid 写法会被当成普通列「${sqlRowid}」→ 已改为「${sqlFixed}」；` +
    `groupBy 坏写法「${sqlBadGroup}」→ 已改为「${sqlFixedGroup}」`,
);
