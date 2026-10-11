#!/usr/bin/env node
/**
 * 断言品牌改名完成，且供应商数据 id `toonflow` 未被误改。
 * 用法：node tools/check-brand.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["apps/api/src", "apps/api/scripts", "apps/web/src"];
const SCAN_FILES = ["README.md", "apps/api/package.json", "apps/web/package.json", "apps/web/index.html"];
const TEXT_EXT = new Set([".ts", ".vue", ".js", ".cjs", ".mjs", ".json", ".html", ".yml", ".yaml", ".md"]);
const SKIP_DIR = /node_modules|[\\/]dist[\\/]|[\\/]build[\\/]|[\\/]data[\\/]/;

const failures = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter(fs.existsSync)];

const brandHits = [];
const pkgNameHits = [];
const protocolHits = [];

for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes("ToonFlow")) brandHits.push(`${rel}:${i + 1}`);
    if (line.includes("toonflow-web") || line.includes("toonflow-upstream")) pkgNameHits.push(`${rel}:${i + 1}`);
    if (line.includes("toonflow://")) protocolHits.push(`${rel}:${i + 1}`);
  });
}

// 1) 品牌文案必须清零
if (brandHits.length) failures.push(`仍有 ${brandHits.length} 处 ToonFlow：\n      ` + brandHits.slice(0, 10).join("\n      "));
// 2) 旧包名/目录名必须清零
if (pkgNameHits.length) failures.push(`仍有 ${pkgNameHits.length} 处 toonflow-web/toonflow-upstream：\n      ` + pkgNameHits.slice(0, 10).join("\n      "));
// 3) toonflow:// 协议本阶段不动 —— 记录数量但不判失败，只要求没被顺手改成别的协议
if (protocolHits.length === 0) failures.push(`toonflow:// 共 0 处：Phase 0 不应删除它（Phase 1e 处理），请确认没有被误改`);

// 4) 供应商数据 id 的完整性：Task 5（改名）之后、Task 6（数据 id 迁移）之前必须是 `toonflow`；
//    Task 6 之后必须是 `miwo`。两条都接受，但必须"文件名、DB 引用文件"三方一致，且不能既无也无。
const ID_CANDIDATES = ["toonflow", "miwo"];
const idRefFiles = [
  "apps/api/src/routes/setting/agentDeploy/agentSetKey.ts",
  "apps/api/src/lib/fixDB.ts",
  "apps/api/src/routes/setting/vendorConfig/getVendorList.ts",
];
const foundIds = new Set();
for (const id of ID_CANDIDATES) {
  if (fs.existsSync(path.join(ROOT, `apps/api/data/vendor/${id}.ts`))) foundIds.add(id);
}
if (foundIds.size !== 1) {
  failures.push(`供应商适配器文件名必须恰好是 ${ID_CANDIDATES.join(" 或 ")} 之一，实际找到: ${[...foundIds].join(", ") || "无"}`);
} else {
  const id = [...foundIds][0];
  for (const rel of idRefFiles) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); continue; }
    if (!fs.readFileSync(p, "utf8").includes(id)) failures.push(`${rel} 里找不到供应商 id "${id}"（与 data/vendor/${id}.ts 不一致）`);
  }
}

// 5) 包名
for (const [rel, want] of [["apps/api/package.json", "@miwo/api"], ["apps/web/package.json", "@miwo/web"]]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); continue; }
  const name = JSON.parse(fs.readFileSync(p, "utf8")).name;
  if (name !== want) failures.push(`${rel} 的 name 期望 "${want}"，实际 "${name}"`);
}

if (failures.length) {
  console.error("check-brand 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`check-brand 通过（保留 toonflow:// ${protocolHits.length} 处，供应商 id 三方一致）`);
