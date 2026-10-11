#!/usr/bin/env node
/**
 * 守卫：apps/web 源码树里不得存在 vite.config 的"遮蔽候选"。
 *
 * 背景：vite 的 DEFAULT_CONFIG_FILES 顺序是 js → mjs → ts → cjs → mts → cts，同名 .js 会遮蔽 .ts。
 * 上游仓库遗留了一份过期的 vite.config.js（含 tsc 产物），已删除；tsconfig.node.json 的 emit 已
 * 重定向到 node_modules/.tmp，避免 `vue-tsc --build` 又把它写回源码树。本脚本用于在构建后验证这一点。
 *
 * 用法：node tools/check-no-shadow.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
// vite 的候选顺序里 .ts 是唯一允许存在的；其余任何同名候选都会遮蔽它
const FORBIDDEN = ["vite.config.js", "vite.config.mjs", "vite.config.cjs", "vite.config.mts", "vite.config.cts"];

const found = FORBIDDEN.filter((f) => fs.existsSync(path.join(WEB, f)));
if (found.length) {
  console.error("check-no-shadow 失败：apps/web 下存在会遮蔽 vite.config.ts 的文件：");
  for (const f of found) console.error("  - apps/web/" + f);
  console.error("处置：删除它们；并确认 apps/web/tsconfig.node.json 的 compilerOptions.outDir 仍指向 node_modules/.tmp。");
  process.exit(1);
}
if (!fs.existsSync(path.join(WEB, "vite.config.ts"))) {
  console.error("check-no-shadow 失败：apps/web/vite.config.ts 不存在（唯一合法的配置源）");
  process.exit(1);
}
console.log("check-no-shadow 通过（apps/web 只有 vite.config.ts，无遮蔽候选）");
