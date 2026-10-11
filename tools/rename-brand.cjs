#!/usr/bin/env node
/**
 * 品牌与包名改名。默认 dry-run；--apply 才写盘。
 * 规则（spec §4.2）：
 *   1. zh-CN.json 里的 ToonFlow -> 谜沃
 *   2. 其余文件里的 ToonFlow -> MirrorWorld
 *   3. toonflow-web -> miwo-web；toonflow-upstream -> miwo-api
 *   4. 绝不触碰小写 toonflow（供应商数据 id）与 toonflow:// 协议
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const SCAN_DIRS = ["apps/api/src", "apps/api/scripts", "apps/web/src"];
const SCAN_FILES = ["apps/api/package.json", "apps/web/package.json", "apps/web/index.html"];
const TEXT_EXT = new Set([".ts", ".vue", ".js", ".cjs", ".mjs", ".json", ".html", ".yml", ".yaml", ".md"]);
const SKIP_DIR = /node_modules|[\\/]dist[\\/]|[\\/]build[\\/]|[\\/]data[\\/]/;

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

/** 保护 toonflow:// 协议不被 toonflow-web 规则命中 */
const PROTO = "\u0000PROTO\u0000";

function transform(rel, text) {
  let t = text.replace(/toonflow:\/\//g, PROTO);
  t = t.replace(/toonflow-web/g, "miwo-web").replace(/toonflow-upstream/g, "miwo-api");
  const brand = /[\\/]zh-CN\.json$/.test(rel) ? "谜沃" : "MirrorWorld";
  t = t.replace(/ToonFlow/g, brand);
  return t.replace(new RegExp(PROTO, "g"), "toonflow://");
}

const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter(fs.existsSync)];
let changed = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const before = fs.readFileSync(f, "utf8");
  const after = transform(rel, before);
  if (after === before) continue;
  changed += 1;
  if (APPLY) {
    fs.writeFileSync(f, after, "utf8");
    console.log(`改写 ${rel}`);
  } else {
    console.log(`[dry-run] 将改写 ${rel}`);
  }
}
console.log(`${APPLY ? "已改写" : "将改写"} ${changed} 个文件`);
