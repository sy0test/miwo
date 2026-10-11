#!/usr/bin/env node
/**
 * 断言 Phase 0 的复制完整性。
 * 用法：node tools/check-copy.cjs
 * 退出码 0 = 通过，1 = 失败（打印每条失败原因）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const failures = [];

function countFiles(dir, filter) {
  if (!fs.existsSync(dir)) return -1;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += Math.max(0, countFiles(p, filter));
    else if (!filter || filter(p)) n += 1;
  }
  return n;
}

/**
 * 按 **git 跟踪** 的文件计数（不是磁盘计数）。
 *
 * 为什么必须用跟踪计数：`apps/web/src/types/{auto-imports,components}.d.ts` 由 vite 插件生成、
 * 被 .gitignore 忽略 —— 本地磁盘存在，但全新克隆不存在（实测 434 vs 跟踪 432）。
 * 用磁盘计数会在 CI 上**假失败**。同时跟踪计数还能顺带发现"该提交的文件没进索引"。
 */
function trackedFiles(prefix) {
  const out = require("child_process").execFileSync("git", ["ls-files", "-z", "--", prefix], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function countTrackedFiles(prefix, filter) {
  return trackedFiles(prefix).filter((rel) => !filter || filter(rel)).length;
}

function dirSizeMB(dir) {
  if (!fs.existsSync(dir)) return -1;
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += dirSizeMB(p) * 1024 * 1024;
    else sum += fs.statSync(p).size;
  }
  return Math.round((sum / 1024 / 1024) * 10) / 10;
}

function mustExist(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) failures.push(`缺文件/目录: ${rel}`);
}

function mustNotExist(rel) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) failures.push(`不该存在: ${rel}`);
}

/**
 * 负向断言（二）：**不得被提交** —— 查 git 索引，不查磁盘存在性。
 *
 * 为什么不能再用存在性断言：`node_modules`、`dist`、`build`、`data/oss`、`data/db2.sqlite`
 * 都是**运行/构建时合法存在**的路径 —— Task 4 拷入 dev 库、Task 6 `pnpm install`、
 * 应用启动时 mkdir `data/oss`、`vite build` 的产物。用存在性断言会让
 * "只剩 config.ts" 这条验收点永远不成立，也会让 CI 在 install 之后必然变红。
 *
 * 真正要防的是**把产物误提交进仓库**（克隆不变异性被破坏），所以判定方式是索引：
 * `git ls-files -- <path>` 有输出 = 已被跟踪 = 失败。带 `-f` 强制 add 也被抓得住。
 */
function mustNotBeTracked(rel) {
  if (trackedFiles(rel).length) failures.push(`不得被提交但已跟踪: ${rel}`);
}

function mustEqual(label, actual, expected) {
  if (actual !== expected) failures.push(`${label}: 期望 ${expected}，实际 ${actual}`);
}

function mustAtLeast(label, actual, min) {
  if (actual < min) failures.push(`${label}: 期望 >=${min}，实际 ${actual}`);
}

// ---- 必须存在 ----
for (const p of [
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/src/app.ts",
  "apps/api/src/config.ts", // Task 7 产出；本步失败属预期
  "apps/api/src/router.ts",
  "apps/api/src/lib/initDB.ts",
  "apps/api/src/utils/db.ts",
  "apps/api/scripts",
  "apps/api/data/skills",
  "apps/api/data/modelPrompt",
  "apps/api/data/vendor",
  "apps/web/package.json",
  "apps/web/src/main.ts",
  "apps/web/index.html",
]) mustExist(p);

// ---- 必须不存在（遮蔽/遗留：放错位置就一定错）----
for (const p of [
  "apps/api/electron-builder.yml",
  "apps/api/scripts/main.ts",
  "apps/api/docs",
  "apps/api/.codegraph",
  "apps/api/.superpowers",
  "apps/api/.github",
  "apps/web/yarn.lock",
  "apps/api/yarn.lock",
  // ⚠ 致命：vite.config.js 在 DEFAULT_CONFIG_FILES 里排在 vite.config.ts 之前，会**遮蔽** .ts
  //    （实测上游 vite/dist/node/constants.js 的 DEFAULT_CONFIG_FILES 顺序为 js → mjs → ts → …）
  "apps/web/vite.config.js",
  "apps/web/vite.config.d.ts",
]) mustNotExist(p);

// ---- 不得被提交（运行/构建产物；查索引，不查磁盘）----
for (const p of [
  "apps/api/node_modules",
  "apps/web/node_modules",
  "apps/api/dist",
  "apps/web/dist",
  "apps/api/build",
  "apps/api/.git",
  "apps/web/.git",
  "apps/api/data/oss",
  "apps/api/data/db2.sqlite",
  "apps/api/data/serve",
  "apps/api/data/web",
  "apps/api/data/version.txt",
]) mustNotBeTracked(p);

// ---- 数量断言（spec §3.1 实测：236 个 .ts）----
// 上游 src 有 236 个 .ts；本 Task 删掉死文件 src/socket/resTool copy.ts 后为 235。
// Task 7 新增 src/config.ts 后回到 236。用 git 跟踪计数（clone 不变异性）。
mustAtLeast("apps/api/src 下 .ts 文件数（git 跟踪）", countTrackedFiles("apps/api/src", (p) => p.endsWith(".ts")), 235);
// ⚠ 必须用 git 跟踪计数：磁盘上是 434，但那 2 个多出来的是 vite 插件生成、被 .gitignore 忽略的
//    src/types/{auto-imports,components}.d.ts，全新克隆只有 432 个 → 用磁盘计数会在 CI 上假失败。
mustAtLeast("apps/web/src 下文件数（git 跟踪）", countTrackedFiles("apps/web/src"), 432);
mustEqual("apps/api/data/vendor 下 .ts 适配器数", countFiles(path.join(ROOT, "apps/api/data/vendor"), (p) => p.endsWith(".ts")), 13);

// ---- 体积断言：只做上界泄漏检测 ----
// 复制完整性由上面的数量断言（src 下 .ts >= 235 等）覆盖。
// ⚠ 不要加体积下限：源码级复制实测约 1.5 MB，任何下限阈值都会在 Task 2/T4 阶段误报。
const apiMB = dirSizeMB(path.join(ROOT, "apps/api"));
if (apiMB > 40) failures.push(`apps/api 体积 ${apiMB} MB 超过 40 MB，疑似把产物/数据搬进来了`);

if (failures.length) {
  console.error("check-copy 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-copy 通过");
