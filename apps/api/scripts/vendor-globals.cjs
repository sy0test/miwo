#!/usr/bin/env node
/**
 * 只读：列出每个适配器引用了哪些沙箱全局（决定 `src/vendors/runtime.ts` 必须导出什么）。
 *
 * Phase 1c Task 8 Step 1。用法：`node apps/api/scripts/vendor-globals.cjs`
 * （默认扫 `apps/api/data/vendor`；`--dir=<相对/绝对路径>` 可指到别处，便于迁移后复核 `src/vendors`）。
 *
 * ⚠ 只打印，不写盘：本脚本存在的意义是让"runtime.ts 必须导出哪些名字"有**可复核的来源**，
 *   而不是靠人读 6471 行适配器。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const arg = process.argv.find((a) => a.startsWith("--dir="));
const DIR = arg ? path.resolve(API_ROOT, arg.slice("--dir=".length)) : path.join(API_ROOT, "data", "vendor");

/** 20 个沙箱全局（与旧 `utils/vm.ts` 的 sandbox 对象逐一对应）。 */
const GLOBALS = [
  "createOpenAI",
  "createDeepSeek",
  "createZhipu",
  "createQwen",
  "createAnthropic",
  "createOpenAICompatible",
  "createXai",
  "createMinimax",
  "createGoogleGenerativeAI",
  "zipImage",
  "zipImageResolution",
  "urlToBase64",
  "mergeImages",
  "pollTask",
  "fetch",
  "axios",
  "FormData",
  "logger",
  "jsonwebtoken",
  "crypto",
];

if (!fs.existsSync(DIR)) {
  console.error(`目录不存在：${DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((x) => x.endsWith(".ts")).sort();
let totalLines = 0;
let totalExports = 0;
const union = new Set();
for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), "utf8");
  const used = GLOBALS.filter((g) => new RegExp("(?<![.\\w$])" + g + "\\b").test(text));
  for (const g of used) union.add(g);
  const lines = text.split(/\r?\n/).length;
  const exp = (text.match(/^\s*exports\.[A-Za-z_$][\w$]*\s*=/gm) || []).length;
  totalLines += lines;
  totalExports += exp;
  console.log(`${f}\t${lines} 行\t${exp} 处 exports.\t${used.join(",")}`);
}
console.log(
  `合计：${files.length} 个文件、${totalLines} 行、${totalExports} 处 exports.、用到 ${union.size} 个沙箱全局` +
    `（${[...union].sort().join(", ")}）`,
);
