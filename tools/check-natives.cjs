#!/usr/bin/env node
/**
 * 断言运行期原生模块在工作区里可加载（pnpm 10 默认跳过构建脚本，必须显式批准）。
 * 用法：node tools/check-natives.cjs
 */
const path = require("path");

const API = path.resolve(__dirname, "..", "apps", "api");
const targets = ["better-sqlite3", "sharp"];
const failures = [];

for (const name of targets) {
  try {
    const mod = require(require.resolve(name, { paths: [API] }));
    if (typeof mod === "function" || typeof mod === "object") console.log(`OK   ${name}`);
    else failures.push(`${name} 加载结果类型异常: ${typeof mod}`);
  } catch (e) {
    failures.push(`${name} 加载失败: ${e.message}`);
  }
}

if (failures.length) {
  console.error("check-natives 失败：");
  for (const f of failures) console.error("  - " + f);
  console.error("处置：确认根 package.json 的 pnpm.onlyBuiltDependencies 含这些包，然后重跑 pnpm.cmd install。");
  process.exit(1);
}
console.log("check-natives 通过（原生模块可加载）");
