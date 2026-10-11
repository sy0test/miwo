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

// ---- 必须不存在（产物/历史/运行时/旧文档）----
for (const p of [
  "apps/api/node_modules",
  "apps/api/dist",
  "apps/api/build",
  "apps/api/.git",
  "apps/api/.codegraph",
  "apps/api/.superpowers",
  "apps/api/docs",
  "apps/api/data/oss",
  "apps/api/data/db2.sqlite",
  "apps/api/data/serve",
  "apps/api/data/web",
  "apps/api/electron-builder.yml",
  "apps/api/scripts/main.ts",
  "apps/web/node_modules",
  "apps/web/.git",
  "apps/web/dist",
  // 旧仓库工具链遗留：新仓库用 pnpm workspaces，yarn 锁不再被任何东西读取
  "apps/web/yarn.lock",
  "apps/api/yarn.lock",
  // ⚠ 致命：vite.config.js 在 DEFAULT_CONFIG_FILES 里排在 vite.config.ts 之前，会**遮蔽** .ts
  //    （实测上游 vite/dist/node/constants.js 的 DEFAULT_CONFIG_FILES 顺序为 js → mjs → ts → …）
  "apps/web/vite.config.js",
  "apps/web/vite.config.d.ts",
  // 旧仓库 CI（release.yml 是 electron-builder 发布链路，spec §5.4 已废弃）
  "apps/api/.github",
]) mustNotExist(p);

// ---- 数量断言（spec §3.1 实测：236 个 .ts）----
// 上游 src 有 236 个 .ts；本 Task 删掉死文件 src/socket/resTool copy.ts 后为 235。
// Task 7 新增 src/config.ts 后回到 236。这里断言 235（复制完整性另有 sha256 保真核对兜底）。
mustAtLeast("apps/api/src 下 .ts 文件数", countFiles(path.join(ROOT, "apps/api/src"), (p) => p.endsWith(".ts")), 235);
// 上游 apps/web/src 实测 434 个文件；门槛要贴着实测值，太松（如 124）等于没有完整性保护。
mustAtLeast("apps/web/src 下文件数", countFiles(path.join(ROOT, "apps/web/src")), 434);
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
