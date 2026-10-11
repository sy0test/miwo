#!/usr/bin/env node
/**
 * 记录旧仓库关键文件的 sha256 基线（Phase 0 的"旧仓库零改动"保证）。
 * 必须在 Phase 0 一开始执行。用法：node tools/record-old-baseline.cjs
 * 输出 tools/.phase0-old-baseline.json（gitignore，宿主相关）。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, ".phase0-old-baseline.json");
const KEYS = [
  "D:\\sy_workspace\\code\\toonflow-upstream\\src\\app.ts",
  "D:\\sy_workspace\\code\\toonflow-upstream\\src\\utils\\db.ts",
  "D:\\sy_workspace\\code\\toonflow-upstream\\src\\lib\\initDB.ts",
  "D:\\sy_workspace\\code\\toonflow-upstream\\src\\lib\\fixDB.ts",
  "D:\\sy_workspace\\code\\toonflow-upstream\\src\\router.ts",
  "D:\\sy_workspace\\code\\toonflow-upstream\\package.json",
  "D:\\sy_workspace\\code\\toonflow-web\\package.json",
  "D:\\sy_workspace\\code\\toonflow-web\\src\\App.vue",
];

const rec = {};
for (const p of KEYS) {
  if (!fs.existsSync(p)) {
    console.error("缺文件: " + p);
    process.exit(1);
  }
  rec[p] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n", "utf8");
console.log(`已记录 ${KEYS.length} 个旧仓库文件基线 -> tools/.phase0-old-baseline.json`);
