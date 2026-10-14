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

/**
 * 递归磁盘字节数（**不做任何四舍五入**）。
 * ⚠ 旧版 `dirSizeMB` 每层把子目录四舍五入到 0.1 MB 再乘回字节
 *   （`sum += dirSizeMB(p) * 1024 * 1024`）⇒ 自带 ~0.5 MB 量化误差，是"边界抖动"的根因。
 */
function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += dirSizeBytes(p);
    else sum += fs.statSync(p).size;
  }
  return sum;
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
  "apps/api/src/config.ts",
  "apps/api/src/router.ts",
  "apps/api/src/utils/db.ts",
  "apps/api/scripts",
  "apps/api/data/skills",
  "apps/api/data/modelPrompt",
  "apps/api/src/vendors",
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
  // ⚠ 上游产品文档（shields 徽章、GitHub/Gitee/GitCode 链接、yarn 安装步骤），根 README.md 才是本仓库权威说明。
  "apps/api/README.md",
  "apps/web/README.md",
  // ⚠ 致命：vite.config.js 在 DEFAULT_CONFIG_FILES 里排在 vite.config.ts 之前，会**遮蔽** .ts
  //    （实测上游 vite/dist/node/constants.js 的 DEFAULT_CONFIG_FILES 顺序为 js → mjs → ts → …）
  "apps/web/vite.config.js",
  "apps/web/vite.config.d.ts",
  // ⚠ 嵌套 .git 必须用"存在性"断言，不能放进 mustNotBeTracked：
  //    **git 从不索引路径含 `.git` 成分的文件** —— 实测隔离仓库里 `git add -f -- apps/api/.git`
  //    与 `git add -f -- apps/api/.git/config` 都静默无效，`git ls-files` 仍为空。
  //    放进 mustNotBeTracked 等于让那两条断言**永远无法触发**（保护消失）；
  //    嵌套 .git 只在"误把整仓拷进来"时出现，属"放错位置就一定错"，归属必须是存在性断言。
  "apps/api/.git",
  "apps/web/.git",
  // ⚠ Phase 1c Task 8：适配器从 `data/vendor/*.ts`（沙箱执行的资产）改成编译期内置的
  //    `src/vendors/*.ts` ⇒ 这个目录**整体删除**。它是"运行期加载并执行用户代码"的入口，
  //    留着它（或让它在某次合并里回来）等于把 Tier 0 #1 那条通道恢复了一半。
  "apps/api/data/vendor",
]) mustNotExist(p);

// ---- 不得被提交（运行/构建产物；查索引，不查磁盘）----
// ⚠ 这份清单是**唯一真相**：它同时驱动 (a) `mustNotBeTracked` 的索引断言、(b) 下面体积断言的**排除集**。
//   不许再写第二份（本阶段反复的铁律：手工清单必漂）。
const UNCOMMITTABLE = [
  "apps/api/node_modules",
  "apps/web/node_modules",
  "apps/api/dist",
  "apps/web/dist",
  "apps/api/build",
  "apps/api/data/oss",
  "apps/api/data/db2.sqlite",
  "apps/api/data/serve",
  "apps/api/data/web",
  "apps/api/data/version.txt",
];
for (const p of UNCOMMITTABLE) mustNotBeTracked(p);

// ---- 数量断言（spec §3.1 实测：236 个 .ts）----
// 上游 src 有 236 个 .ts；本 Task 删掉死文件 src/socket/resTool copy.ts 后为 235。
// Task 7 新增 src/config.ts 后回到 236。用 git 跟踪计数（clone 不变异性）。
//
// ⚠⚠ 【Ruling 12·必做】**235 是当前下限**；下调必须随"真正删 `.ts`"的 Task 一并做，
//     禁止单独为"好看"下调。
//   为什么把这句话写在这里（而不是留在账本里）：计划 Task 1 Step 2 的 Expected 写的是 **234**，
//   而控制器裁定保留 **235** ⇒ brief / 实现 / 裁定三处口径不一致，Task 4/10 回看会困惑。
//   历史轨迹（每一步都对应一次**真实删除**，不是"调整阈值"）：
//     · 235（Phase 0 起点）→ 实测一度是 244，窗口宽到"连删 9 个 `.ts` 都不会红"；
//     · **Phase 1c Task 5 删除 3 个死文件**（`src/lib/initDB.ts`、`src/lib/fixDB.ts`、`src/core.ts`）
//       ⇒ 本次把下限从 235 调到**实测值 267**（`git ls-files -- apps/api/src` 里 `.ts` 计数：
//       删前 270 → 删后 267）。窗口由 9 收到 **0**：再删任何一个 `.ts` 都会当场红，这是**收紧**。
//     · 这是本文件里**唯一**允许被"删文件的 Task"改动的数字；新增 `.ts` 永远不会触发它。
mustAtLeast("apps/api/src 下 .ts 文件数（git 跟踪）", countTrackedFiles("apps/api/src", (p) => p.endsWith(".ts")), 267);
// ⚠ 必须用 git 跟踪计数：磁盘上是 434，但那 2 个多出来的是 vite 插件生成、被 .gitignore 忽略的
//    src/types/{auto-imports,components}.d.ts，全新克隆只有 432 个 → 用磁盘计数会在 CI 上假失败。
mustAtLeast("apps/web/src 下文件数（git 跟踪）", countTrackedFiles("apps/web/src"), 432);
// ⚠ Phase 1c Task 8：这条断言原来数的是 `data/vendor` 下的 13 个沙箱适配器（它已整体删除）。
//   口径换成"**编译期内置**的适配器 ≥13"：数的是 `src/vendors/*.ts`，用 **git 跟踪**计数
//   （与上面 `src` 那两条同口径 —— clone 不变异性）。为什么必须换成 `>=`：13 个适配器 + 
//   `runtime.ts` + `index.ts` = 15 个 `.ts`，其中 2 个是"接线"而不是适配器 ⇒ 用 `>=13` 表达
//   "适配器一个都不能少"，同时不把接线文件算成适配器。
mustAtLeast("apps/api/src/vendors 下 .ts 文件数（git 跟踪）", countTrackedFiles("apps/api/src/vendors", (p) => p.endsWith(".ts")), 13);

/**
 * 交付物体积（MB）：`apps/api` 下**排除 `UNCOMMITTABLE`**（= 本 gate 自己已声明"本地可有、不得提交"
 * 的运行/构建产物）之后的**文件字节数**，**只在最后四舍五入一次**。
 *
 * ⚠ **为什么改量纲**（Task 7 授权修复，Lead 裁定 (i)；规范：*跨量纲的断言必须量"意图量"*）：
 *   旧实现量的是**整个 `apps/api` 的磁盘占用**，于是把 gate **自己允许存在**的产物也算成违规：
 *   `data/web`（34.37 MB，本地服务器快照）+ `data/db2.sqlite`（2.86 MB，只读快照）+ `build/`（0.29 MB）
 *   已吃掉约 37.6 MB 的预算 ⇒ 预算剩 ~2.4 MB。更糟的是旧实现**逐层把子目录四舍五入到 0.1 MB 再累加**
 *   （`dirSizeMB(p) * 1024 * 1024`），自带 ~0.5 MB 量化误差 ⇒ 边界落在 ±0.05 MB/层 的噪声里：
 *   几十 KB 的源码改动就能让结果从 `40.0` 抖到 `40.1` ⇒ **随机红**（比恒红更坏：它训练人忽略门禁）。
 *
 * ⚠ **阈值重算（显式，不是偷偷放大）**：旧数字 `40` 的含义是"**磁盘**占用上限"，它把 37.6 MB
 *   允许产物算在内 ⇒ 换算到**新量纲**（只量交付物、排除那些产物）等价于"交付物上限约 2.4 MB"。
 *   实测本仓库交付物 = **3.0 MB**（`src` ~1.5 + `scripts` ~0.54 + `tests` ~0.38 + `data/{skills,vendor,modelPrompt}` ~0.63）。
 *   新阈值取 **12 MB**（≈ 当前值的 4 倍，给源码/测试/文档的正常增长留余量），并且**比旧口径更严**：
 *   在**全新 clone**（磁盘 6.25 MB）上，旧口径要等误提交的产物累计到 ~33.7 MB 才红，
 *   新口径**误提交 ≥12 MB 就红** ⇒ 在"抓住大产物"这个真正要防的维度上是**收紧**，不是放宽。
 *   ⚠ 旧数字 `40` **不要**再拿来做比较（量纲不同：磁盘 vs 交付物）。
 */
const API_DELIVERABLE_LIMIT_MB = 12;

const uncommittableAbs = new Set(
  UNCOMMITTABLE.filter((p) => p === "apps/api" || p.startsWith("apps/api/")).map((p) => path.join(ROOT, p)),
);

/** 该绝对路径是否落在 `UNCOMMITTABLE` 的任一前缀之下。 */
function isUncommittable(abs) {
  for (const u of uncommittableAbs) {
    if (abs === u || abs.startsWith(u + path.sep)) return true;
  }
  return false;
}

/** 交付物字节数（递归；跳过 `UNCOMMITTABLE`；不四舍五入）。 */
function deliverableBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (isUncommittable(p)) continue;
    if (e.isDirectory()) sum += deliverableBytes(p);
    else sum += fs.statSync(p).size;
  }
  return sum;
}

// ---- 体积断言：只做上界泄漏检测 ----
// 复制完整性由上面的数量断言（src 下 .ts >= 235 等）覆盖。
// ⚠ 不要加体积下限：源码级复制实测约 1.5 MB，任何下限阈值都会在 Task 2/T4 阶段误报。
const excludedBytes = dirSizeBytes(path.join(ROOT, "apps/api")) - deliverableBytes(path.join(ROOT, "apps/api"));
const apiMB = Math.round((deliverableBytes(path.join(ROOT, "apps/api")) / 1024 / 1024) * 10) / 10;
const excludedMB = Math.round((excludedBytes / 1024 / 1024) * 10) / 10;
if (apiMB > API_DELIVERABLE_LIMIT_MB) {
  failures.push(
    `apps/api 交付物 ${apiMB} MB 超过 ${API_DELIVERABLE_LIMIT_MB} MB（已排除本地产物 ${excludedMB} MB：${UNCOMMITTABLE.join(", ")}），疑似把产物/数据搬进来了`,
  );
}

if (failures.length) {
  console.error("check-copy 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-copy 通过");
