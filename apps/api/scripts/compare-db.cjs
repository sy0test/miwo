#!/usr/bin/env node
/**
 * 两库比对（spec §12.2 T5 的"数据行数与关键字段抽样一致"）。
 *
 * 用法（都从 apps/api 下跑，或走 `pnpm.cmd run db:compare`）：
 *   node scripts/compare-db.cjs --src=<sqlite 路径> --manifest=<export 目录> [--sample=5]
 *
 * 比对口径（三段，全部落在 `src/db/legacy/import.ts` 里，可被单测覆盖）：
 *   1. **逐表行数**：源以 manifest 为准；目标实时 count。期望值不是"源行数"而是
 *      "导入后应有的行数"（`targetRowsBefore + inserted`，来自 `<dir>/import-report.json`）——
 *      因为 `o_setting.tokenKey` 按裁定**必须不搬**、超长行可能被主动丢，
 *      拿源行数当期望会把这几种**按设计的缺席**误判成数据丢失。
 *      （没有 import-report.json 时退化成严格口径：目标行数必须等于源行数。）
 *   2. **每表抽样 N 行**：按主键排序取"首 / 中 / 末 + 均匀分布"，逐列深比较
 *      （`valuesEqual`：不 trim 字符串、不把数字串当数字；bigint 归一化；浮点 1e-6 容差）。
 *   3. **缺席归因**：源行在目标里找不到时，只有 import-report 里登记过的
 *      "按设计没搬"（tokenKey / 超长丢弃 / 主键冲突）才不算差异，其余一律判红。
 *
 * 输出：`<dir>/source-samples.json`（源侧抽样）+ `<dir>/compare-report.json`（机器可读报告）。
 * 退出码：0 = 完全一致；1 = 有差异（打印差异清单）。
 *
 * ⚠ 源库以 `{ readonly: true }` 打开：比对同样不许写源库。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const argOf = (p, d) => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : d;
};
const SRC = path.resolve(API_ROOT, argOf("--src=", path.join("data", "db2.sqlite")));
const DIR = path.resolve(API_ROOT, argOf("--manifest=", path.join(".tmp-migrate", "export")));
const SAMPLE = Number(argOf("--sample=", "5"));

const MANIFEST = path.join(DIR, "manifest.json");
if (!fs.existsSync(MANIFEST)) {
  console.error(`缺 ${MANIFEST}，先跑 scripts/export-sqlite.cjs`);
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`源库不存在：${SRC}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

let Database;
try {
  Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
} catch {
  Database = require("better-sqlite3");
}

const srcSha = crypto.createHash("sha256").update(fs.readFileSync(SRC)).digest("hex");
const src = new Database(SRC, { readonly: true });

/** 源侧抽样：主键排序后的 首 / 中 / 末 + 均匀分布（去重）。 */
const samples = {};
for (const t of manifest.tables) {
  const info = src.prepare(`PRAGMA table_info("${t.name}")`).all();
  // sqlite 的 PRIMARY KEY 会带上 pk 序号（复合主键是 1..N）；`pk` 为 0 表示不是主键列。
  const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const order = (pk.length ? pk : [info[0].name]).map((c) => `"${c}"`).join(", ");
  const total = t.rows;
  if (!total) {
    samples[t.name] = { pk, rows: [] };
    continue;
  }
  const picks = new Set([0, Math.floor(total / 2), total - 1]);
  for (let i = 1; i <= SAMPLE; i += 1) picks.add(Math.min(total - 1, i * Math.floor(total / (SAMPLE + 1))));
  const rows = [];
  for (const off of [...picks].sort((a, b) => a - b)) {
    rows.push(src.prepare(`SELECT * FROM "${t.name}" ORDER BY ${order} LIMIT 1 OFFSET ?`).get(off));
  }
  samples[t.name] = { pk, rows };
}
src.close();
fs.writeFileSync(path.join(DIR, "source-samples.json"), JSON.stringify(samples, null, 2) + "\n", "utf8");
console.log(`[compare] 源侧抽样已写 ${path.join(DIR, "source-samples.json")}（每表 ${SAMPLE}+3 行）`);
console.log(`[compare] 源库 sha256：${srcSha}（只读打开）`);

// ---- 目标侧比对：跑一段 TS，复用 import.ts 的比对逻辑（与导入同源）----
const RUNNER = path.join(API_ROOT, ".tmp-migrate", "compare-runner.ts");
fs.mkdirSync(path.dirname(RUNNER), { recursive: true });
fs.writeFileSync(
  RUNNER,
  `import fs from "node:fs";
import path from "node:path";
import { createKnex, describeTarget, dialectOfConfig } from "@/db/connect";
import { compareRows, plansFromManifest } from "@/db/legacy/import";

const DIR = ${JSON.stringify(DIR)};

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
  const samples = JSON.parse(fs.readFileSync(path.join(DIR, "source-samples.json"), "utf8"));
  const reportPath = path.join(DIR, "import-report.json");
  const imported = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  console.log("[compare] 目标：" + describeTarget());
  console.log("[compare] 方言：" + dialectOfConfig());
  if (!imported) console.log("[compare] 无 import-report.json：行数用严格口径（目标必须等于源）");
  const dst = createKnex();
  try {
    const plans = await plansFromManifest(dst, manifest);
    const cmp = await compareRows({
      dst,
      manifest,
      samples,
      plans,
      outcomes: imported ? imported.outcomes : undefined,
      expectedAbsent: imported ? imported.expectedAbsent : undefined,
    });
    cmp.target = describeTarget();
    fs.writeFileSync(path.join(DIR, "compare-report.json"), JSON.stringify(cmp, null, 2), "utf8");
    for (const t of cmp.tables) {
      const mark = t.rowsMatch ? "OK " : "BAD";
      const delta = t.rowsDeltaVsSource === 0 ? "" : " 差 " + t.rowsDeltaVsSource;
      const miss = t.missingInTarget.length ? "，目标缺 " + t.missingInTarget.length + " 条抽样行" : "";
      const bad = t.mismatches.length ? "，✘ " + t.mismatches.length + " 处单元格不一致" : "";
      console.log("  [" + mark + "] " + t.table.padEnd(22) + " 源 " + String(t.sourceRows).padStart(6) + " / 目标 " + String(t.targetRows).padStart(6) + " / 期望 " + String(t.expectedTargetRows).padStart(6) + delta + "，抽样 " + t.samplesChecked + " 行" + miss + bad);
      for (const m of t.mismatches.slice(0, 5)) console.log("         ✘ " + m.column + " @" + JSON.stringify(m.pk) + "：" + m.reason);
      for (const m of t.missingInTarget.slice(0, 5)) console.log("         ⚠ 抽样行缺席 @" + JSON.stringify(m.pk) + "（" + m.reason + "）");
    }
    for (const n of cmp.notes) console.log("  note: " + n);
    console.log(cmp.ok ? "[compare] 行数与抽样单元格全部一致" : "[compare] ✘ 有差异（见 compare-report.json）");
    process.exit(cmp.ok ? 0 : 1);
  } finally {
    await dst.destroy();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
  "utf8",
);

const r = spawnSync(process.execPath, ["--import=tsx", RUNNER], { cwd: API_ROOT, stdio: "inherit", env: process.env });
process.exit(r.status === null ? 1 : r.status);
