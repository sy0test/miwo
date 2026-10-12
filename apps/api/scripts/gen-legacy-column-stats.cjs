#!/usr/bin/env node
/**
 * 机械记录「老库每列的实测值域」到 `tests/fixtures/legacy-column-stats.json`。
 *
 * 为什么要有这个文件：`001_schema.ts` 的**唯一结构真相**是 MySQL 目标类型，而"这个类型装不装得下
 * 老库的真实数据"只能靠**机械比对**才知道。此前那批"毫秒值写进 `int` 列"的缺口之所以漏了第三批
 * （`o_segment.projectId` / `o_shot.projectId`），根因就是判据是**手工清单**。本脚本 + fixture +
 * `tests/migration-column-fit.test.ts` 把判据换成"扫全库、逐列比对"，并且**在没有老库的机器上也能跑**
 * （fixture 是记录值域；测试再用源库 sha256 校验"记录值域 = 当前文件"）。
 *
 * 用法（从 apps/api 下跑）：
 *   node scripts/gen-legacy-column-stats.cjs            只打印摘要，不写文件
 *   node scripts/gen-legacy-column-stats.cjs --write    写 fixture（重新记录）
 *   node scripts/gen-legacy-column-stats.cjs --db=<路径> [--out=<路径>]
 *
 * ⚠ **只读**：源库一律以 `{ readonly: true, fileMustExist: true }` 打开（【Ruling 1】），不做任何写入；
 *   源库 sha256 同时记进 fixture —— 测试据此断言"记录的值域确实来自当前这个文件"。
 *
 * ⚠ 与 `tests/migration-column-fit.test.ts` 的分工：本脚本**只记录事实**（不做任何判定），
 *   判定在测试里、并且复用**生产代码**（`src/db/legacy/import.ts` 的 `outOfRangeValues` /
 *   `oversizeValues`），避免"判据两套实现、慢慢漂移"。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="));
const outArg = args.find((a) => a.startsWith("--out="));
const write = args.includes("--write");
const DB = dbArg ? dbArg.slice(5) : path.join(API_ROOT, "data", "db2.sqlite");
const OUT = outArg ? outArg.slice(6) : path.join(API_ROOT, "tests", "fixtures", "legacy-column-stats.json");

let Database;
try {
  Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
} catch {
  Database = require("better-sqlite3");
}

if (!fs.existsSync(DB)) {
  console.error("[legacy-stats] 源库不存在：" + DB);
  console.error("[legacy-stats] 老库快照不入库（apps/api/.gitignore 忽略 *.sqlite），CI 上没有它 —— 请在有老库的机器上重新记录。");
  process.exit(1);
}

/** 按 Unicode 码点计数（MySQL 的 VARCHAR 上限是**字符数**，不是 UTF-16 码元数）。 */
function charLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) i += 1;
    n += 1;
  }
  return n;
}

/** 声明类型是整数族（INTEGER / INT / BIGINT…）→ 它的字符串值要按数值解释（sqlite 的亲和性允许）。 */
const INT_DECLARED = /^(tinyint|smallint|mediumint|int|integer|bigint|unsigned big int|int2|int8)/i;

const db = new Database(DB, { readonly: true, fileMustExist: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const stats = {};
let totalRows = 0;
let columns = 0;
for (const table of tables) {
  const info = db.prepare("PRAGMA table_info(" + JSON.stringify(table) + ")").all();
  const rows = db.prepare("SELECT * FROM " + JSON.stringify(table)).all();
  totalRows += rows.length;
  const perTable = {};
  for (const col of info) {
    columns += 1;
    const declared = String(col.type || "").toUpperCase();
    let min = null;
    let max = null;
    let maxChars = null;
    for (const row of rows) {
      const v = row[col.name];
      if (v === null || v === undefined) continue;
      if (typeof v === "number" || typeof v === "bigint") {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (min === null || n < min) min = n;
        if (max === null || n > max) max = n;
      } else if (typeof v === "string") {
        if (INT_DECLARED.test(declared) && /^\s*[+-]?\d+\s*$/.test(v)) {
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          if (min === null || n < min) min = n;
          if (max === null || n > max) max = n;
        } else {
          const len = charLength(v);
          if (maxChars === null || len > maxChars) maxChars = len;
        }
      }
    }
    perTable[col.name] = {
      declared,
      rows: rows.length,
      min,
      max,
      maxChars,
    };
  }
  stats[table] = perTable;
}
db.close();

const doc = {
  note:
    "老库（未入库的快照）逐列实测值域，由 apps/api/scripts/gen-legacy-column-stats.cjs 机械生成，请勿手工编辑。" +
    " 重新记录：cd apps/api && node scripts/gen-legacy-column-stats.cjs --write",
  source: {
    path: path.relative(path.resolve(API_ROOT, "..", ".."), DB).split(path.sep).join("/"),
    sha256: crypto.createHash("sha256").update(fs.readFileSync(DB)).digest("hex"),
    bytes: fs.statSync(DB).size,
    tables: tables.length,
    columns,
    rows: totalRows,
  },
  stats,
};

console.log("[legacy-stats] 源库：" + DB);
console.log("[legacy-stats] sha256：" + doc.source.sha256);
console.log("[legacy-stats] 表 " + tables.length + " 张 / 列 " + columns + " 个 / 行 " + totalRows + " 行");

const overInt = [];
const overDeclared = [];
for (const table of Object.keys(stats)) {
  for (const col of Object.keys(stats[table])) {
    const s = stats[table][col];
    if (s.max !== null && s.max > 2147483647) overInt.push(table + "." + col + " max=" + s.max);
    const m = /^VARCHAR\((\d+)\)$/i.exec(s.declared);
    if (m && s.maxChars !== null && s.maxChars > Number(m[1])) {
      overDeclared.push(table + "." + col + " maxChars=" + s.maxChars + " > " + m[1]);
    }
  }
}
console.log("[legacy-stats] 实测最大值 > 2147483647（MySQL int 上界）的列：" + overInt.length);
for (const line of overInt) console.log("    " + line);
console.log("[legacy-stats] 实测字符数 > 自身声明 VARCHAR(N) 的列：" + overDeclared.length);
for (const line of overDeclared) console.log("    " + line);

if (!write) {
  console.log("[legacy-stats] 未写文件（加 --write 才写 " + OUT + "）");
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log("[legacy-stats] 已写：" + OUT + "（" + fs.statSync(OUT).size + " 字节）");
