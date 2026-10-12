#!/usr/bin/env node
/**
 * 从 dev sqlite 库机械导出表结构的列清单，供 001_schema.ts 逐表核对。
 * 用法（从 apps/api 下跑）：node scripts/gen-schema-migration.cjs [--db=路径] [--table=o_xxx]
 * 只读：以 readonly 打开源库；不写任何文件。
 *
 * 映射规则（与 001_schema.ts 的 types() 一一对应，spec §5.3）：
 *   INTEGER + pk + AUTOINCREMENT        -> t.bigIncrements(name)              （types.pk）
 *   INTEGER + pk（无 AUTOINCREMENT）     -> t.bigInteger(name).unsigned()      （仅 o_user 与复合键成员）
 *   INTEGER + 无 pk                      -> t.integer(name)
 *   TEXT   + pk 或 被 idx/unique 引用     -> t.string(name, 191)
 *   TEXT   + 无约束                      -> t.text(name)     （MySQL 侧 longtext）
 *   varchar(N)                          -> t.string(name, N)
 *   float                               -> t.float(name)
 *   boolean                             -> t.tinyint(name)
 *
 * ⚠ 单位是"列/索引"而不是"整表"：本脚本**不知道** 001_schema.ts 里哪些是有意的新增列
 *   （userId / directorManual 的回填等），只负责把"现状库真有什么"摆出来。
 */
const path = require("path");
const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="));
const only = args.find((a) => a.startsWith("--table="));
const DB = dbArg ? dbArg.slice(5) : path.join(API_ROOT, "data", "db2.sqlite");
let Database;
try { Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3")); }
catch { Database = require("better-sqlite3"); }
const db = new Database(DB, { readonly: true });
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const out = [];
for (const t of tables) {
  if (only && t.name !== only.slice(8)) continue;
  const auto = /AUTOINCREMENT/i.test(t.sql || "");
  const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all();
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const idx = db.prepare(`PRAGMA index_list(${JSON.stringify(t.name)})`).all();
  const indexed = new Set();
  const uniques = [];
  const plains = [];
  for (const ix of idx) {
    const info = db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all().map((i) => i.name);
    info.forEach((c) => indexed.add(c));
    const isPkIdx = info.length === pk.length && info.every((c, i) => c === pk[i]);
    if (isPkIdx) continue;
    if (ix.unique) uniques.push(info); else plains.push(info);
  }
  out.push(`## ${t.name}  pk=[${pk.join(", ")}]${auto ? "  AUTOINCREMENT" : ""}`);
  for (const c of cols) {
    const isPk = c.pk > 0;
    const isSinglePk = isPk && pk.length === 1;
    const ty = String(c.type || "").toUpperCase();
    let line;
    if (isSinglePk && auto) line = `types.pk(t, ${JSON.stringify(c.name)})`;
    else if (isSinglePk) line = `t.bigInteger(${JSON.stringify(c.name)}).unsigned().primary()`;
    else if (/INT/.test(ty) && isPk) line = `t.bigInteger(${JSON.stringify(c.name)}).unsigned()   // 复合 PK 成员`;
    else if (/INT/.test(ty)) line = `t.integer(${JSON.stringify(c.name)})`;
    else if (/TEXT|CLOB/.test(ty) && (isPk || indexed.has(c.name))) line = `types.vstr(t, ${JSON.stringify(c.name)})`;
    else if (/TEXT|CLOB/.test(ty)) line = `types.text(t, ${JSON.stringify(c.name)})`;
    else if (/VARCHAR\((\d+)\)/i.test(ty)) line = `t.string(${JSON.stringify(c.name)}, ${RegExp.$1})`;
    else if (/REAL|FLOA|DOUB/.test(ty)) line = `types.floatCol(t, ${JSON.stringify(c.name)})`;
    else if (/BOOL/.test(ty)) line = `types.boolCol(t, ${JSON.stringify(c.name)})`;
    else line = `/* 未识别类型 "${c.type}"，人工判定 */ t.text(${JSON.stringify(c.name)})`;
    const nn = c.notnull ? ".notNullable()" : "";
    const dflt = c.dflt_value !== null && !isPk ? `.defaultTo(${c.dflt_value})` : "";
    out.push(`   ${c.name}\t${c.type}\t${nn}${dflt}\t=> ${line}${isPk && pk.length > 1 ? "" : ""}`);
  }
  for (const u of uniques) out.push(`   UNIQUE (${u.join(", ")})`);
  for (const p of plains) out.push(`   INDEX  (${p.join(", ")})`);
  out.push("");
}
db.close();
console.log(out.join("\n"));
console.log(`# 共 ${tables.length} 张表；本迁移应建 27 张（去掉 o_skillList / o_skillAttribution）`);
