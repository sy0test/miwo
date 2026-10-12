#!/usr/bin/env node
/**
 * 把供应商数据 id 从 `toonflow` 迁到 `miwo`（spec §4.2 规则 2）。
 * 幂等：重复执行无副作用。默认 dry-run，--apply 才写。
 * 用法：
 *   node apps/api/scripts/migrate-vendor-id.cjs                 # 预演
 *   node apps/api/scripts/migrate-vendor-id.cjs --apply         # 执行
 *   node apps/api/scripts/migrate-vendor-id.cjs --apply --db=<路径>
 *
 * ⚠ Phase 1a 起：**新库/真实库请用 `pnpm.cmd --filter @miwo/api exec tsx src/db/legacy/vendor-merge.ts --apply`**
 *   （合并语义，能处理"目标 id 已存在"的场景，见 src/db/legacy/vendor-merge.ts 的注释）。
 *   本脚本只保留给 sqlite dev 库的历史一次性迁移，且**已知会在"miwo 行已存在"时撞主键**。
 *   这一条是 Phase 0 ledger 明确要求并入 Phase 1a 的 deferred 项（Task 6 minor）。
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbArg = args.find((a) => a.startsWith("--db="));
const API_ROOT = path.resolve(__dirname, "..");
const DB_PATH = dbArg ? dbArg.slice(5) : path.join(API_ROOT, "data", "db2.sqlite");
const OLD_ID = "toonflow";
const NEW_ID = "miwo";

function step(msg) { console.log((APPLY ? "" : "[dry-run] ") + msg); }

// 1) 适配器文件改名
const oldFile = path.join(API_ROOT, "data", "vendor", `${OLD_ID}.ts`);
const newFile = path.join(API_ROOT, "data", "vendor", `${NEW_ID}.ts`);
if (fs.existsSync(newFile) && !fs.existsSync(oldFile)) {
  step(`适配器已是 ${NEW_ID}.ts，跳过文件改名`);
} else if (fs.existsSync(oldFile)) {
  step(`重命名 data/vendor/${OLD_ID}.ts -> data/vendor/${NEW_ID}.ts`);
  if (APPLY) fs.renameSync(oldFile, newFile);
} else {
  console.warn(`⚠ 找不到 data/vendor/${OLD_ID}.ts，跳过文件改名`);
}

// 2) DB 行迁移
if (!fs.existsSync(DB_PATH)) {
  console.warn(`⚠ 找不到数据库 ${DB_PATH}，跳过 DB 迁移`);
  process.exit(0);
}
let Database;
try {
  Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
} catch {
  try { Database = require("better-sqlite3"); } catch (e) {
    console.error("需要 better-sqlite3。请先在 apps/api 执行 pnpm.cmd install。");
    process.exit(1);
  }
}
const db = new Database(DB_PATH, { readonly: !APPLY });

const vendorRows = db.prepare("SELECT id FROM o_vendorConfig WHERE id = ?").all(OLD_ID);
const deployRows = db.prepare("SELECT COUNT(*) AS n FROM o_agentDeploy WHERE vendorId = ?").get(OLD_ID).n;
console.log(`o_vendorConfig 里 id='${OLD_ID}' 的行: ${vendorRows.length}`);
console.log(`o_agentDeploy 里 vendorId='${OLD_ID}' 的行: ${deployRows}`);

if (APPLY) {
  // ⚠ 先检测冲突再决定：本脚本用的是 `UPDATE ... SET id = NEW WHERE id = OLD`，目标行已存在时会撞主键。
  //   Phase 0 ledger 的 deferred 项要求并入 Phase 1a —— 合并语义在 src/db/legacy/vendor-merge.ts。
  const targetRows = db.prepare("SELECT COUNT(*) AS n FROM o_vendorConfig WHERE id = ?").get(NEW_ID).n;
  if (targetRows > 0) {
    console.error(
      `拒绝执行：o_vendorConfig 里 id='${NEW_ID}' 已存在（${targetRows} 行），` +
        `而本脚本用的是 UPDATE ... WHERE id='${OLD_ID}'，会撞主键。\n` +
        `请改用合并语义：pnpm.cmd --filter @miwo/api exec tsx src/db/legacy/vendor-merge.ts --apply`,
    );
    db.close();
    process.exit(1);
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE o_vendorConfig SET id = ? WHERE id = ?").run(NEW_ID, OLD_ID);
    db.prepare("UPDATE o_agentDeploy SET vendorId = ? WHERE vendorId = ?").run(NEW_ID, OLD_ID);
  });
  tx();
  console.log(`已迁移：o_vendorConfig ${vendorRows.length} 行、o_agentDeploy ${deployRows} 行`);
  const left = db.prepare("SELECT COUNT(*) AS n FROM o_vendorConfig WHERE id = ?").get(OLD_ID).n;
  if (left !== 0) { console.error(`迁移后仍存在 ${left} 行 ${OLD_ID}`); process.exit(1); }
} else {
  step(`将执行 UPDATE o_vendorConfig.id '${OLD_ID}' -> '${NEW_ID}'`);
  step(`将执行 UPDATE o_agentDeploy.vendorId '${OLD_ID}' -> '${NEW_ID}'`);
}
db.close();
console.log(APPLY ? "迁移完成" : "预演完成（未写盘）");
