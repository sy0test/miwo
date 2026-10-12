#!/usr/bin/env node
/**
 * 从 sqlite 源库导出平台种子为 NDJSON（spec §5.2 ④ 的输入）。
 * 用法（从 apps/api 下跑）：node scripts/dump-platform-seed.cjs [--db=路径] [--out=目录]
 *
 * **安全**：o_vendorConfig 只导出"空模板"白名单行；带凭据的行（grsai/newapi/metoken/volcengineSd2/null）
 *         一律跳过，并在输出里报告跳过原因。这一点是硬的 —— 凭据绝不能进仓库。
 *
 * ⚠ 本脚本**只读**源库（`readonly: true`），绝不写它；导出结果才是被提交的产物。
 */
const fs = require("fs");
const path = require("path");
const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="));
const outArg = args.find((a) => a.startsWith("--out="));
const SRC = dbArg ? dbArg.slice(5) : path.join(API_ROOT, "data", "db2.sqlite");
const OUT = outArg ? outArg.slice(6) : path.join(API_ROOT, "src", "db", "migrations", "seed");

let Database;
try { Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3")); }
catch { Database = require("better-sqlite3"); }
const db = new Database(SRC, { readonly: true });
fs.mkdirSync(OUT, { recursive: true });

const PLAN = [
  { table: "o_prompt", file: "o_prompt.ndjson" },
  { table: "o_agentDeploy", file: "o_agentDeploy.ndjson" },
];
const SETTING_PLATFORM_KEYS = ["shotsEngine", "shotsAutoRepair", "switchAiDevTool", "modelOnnxFile", "modelDtype"];
const VENDOR_EMPTY_TEMPLATE = ["miwo", "deepseek", "atlascloud", "volcengine", "minimax", "openai", "klingai", "vidu"];

function writeNdjson(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  fs.writeFileSync(path.join(OUT, file), body, "utf8");
  console.log(`${file}: ${rows.length} 行, ${Buffer.byteLength(body, "utf8")} B`);
}

for (const p of PLAN) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(p.table);
  if (!exists) { console.log(`跳过 ${p.table}：源库里没有这张表`); continue; }
  const rows = db.prepare(`SELECT * FROM ${p.table} ORDER BY id`).all();
  writeNdjson(p.file, rows);
}

{
  const rows = db.prepare("SELECT * FROM o_setting WHERE key IN (" + SETTING_PLATFORM_KEYS.map(() => "?").join(",") + ") ORDER BY key").all(...SETTING_PLATFORM_KEYS);
  writeNdjson("o_setting.platform.ndjson", rows);
  const all = db.prepare("SELECT key FROM o_setting ORDER BY key").all().map((r) => r.key);
  const skipped = all.filter((k) => !SETTING_PLATFORM_KEYS.includes(k));
  console.log(`o_setting：seed ${rows.length} 个平台键；跳过 ${skipped.length} 个（tokenKey + 用户级键，Phase 1c 处理）：${skipped.join(", ")}`);
  const missing = SETTING_PLATFORM_KEYS.filter((k) => !all.includes(k));
  if (missing.length) console.log(`o_setting：白名单里源库**不存在**的键（不 seed）：${missing.join(", ")}`);
}

{
  // 8 个空模板行：值一律用常量，不读源库（避免把 dev 库里的实验值带进仓库）
  const rows = VENDOR_EMPTY_TEMPLATE.map((id) => ({ id, inputValues: "{}", models: "[]", enable: 0 }));
  writeNdjson("o_vendorConfig.templates.ndjson", rows);
  const present = db.prepare("SELECT id, length(inputValues) il, enable FROM o_vendorConfig ORDER BY id").all();
  console.log("源库 o_vendorConfig 现状（**不导出**，仅供人工核对）：");
  for (const r of present) console.log(`  ${r.id}\tinputValues=${r.il}B\tenable=${r.enable}`);
}

db.close();
console.log(`\n⚠ 导出后必须**人工检查** ${OUT} 下的文件：o_agentDeploy.ndjson 里不应含 API key；`);
console.log("  o_prompt.ndjson 的每行必须是完整 JSON（用 `node -e \"require('fs').readFileSync(...,'utf8').split('\\n').filter(Boolean).forEach(l=>JSON.parse(l))\"` 自检）。");
