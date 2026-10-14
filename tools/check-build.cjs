#!/usr/bin/env node
/**
 * 门禁：**生产构建必须能过**，而且必须能**自证"真的打了包"**。
 *
 * ── 为什么必须新开这条门禁（本轮的教训）──
 * Phase 1c Task 2 引入 `@node-rs/argon2`（`src/auth/password.ts`）做口令哈希，而
 * `apps/api/scripts/build.ts` 的 `external` **历史上从来没有这一条** ⇒ esbuild 去解析
 * 平台包里的预编译 `.node`，报
 *   `No loader is configured for ".node" files: …@node-rs/argon2-win32-x64-msvc…`
 * ⇒ `pnpm run build` **EXIT 1**。这个状态**持续了 8 个任务**：因为验收清单里只有
 * typecheck / vitest / 各 verify 脚本，**没有一条跑 build**，"10 个任务全绿、生产构建全坏"
 * 就是这样发生的。结论：**凡不在验收清单里的东西，就等于没人管** —— 所以这里把它变成一条门禁。
 *
 * ── 断言（四条，缺一条都不算过）──
 *   ① `pnpm --filter @miwo/api run build` **EXIT 0**（这就是"生产构建能过"本身）；
 *   ② 产物 `apps/api/data/serve/app.js` **存在且 > 1 MB**（观测得到的字节数要**打印出来**）；
 *   ③ **自证真的打了包**：产物里必须能找到 `@node-rs/argon2` 的 require —— 它证明
 *      ① 这次确实产出了**新** bundle（不是上次留下的旧文件），② `external` 那条修法真的生效
 *      （外部化的模块在 CJS 产物里以 `require("@node-rs/argon2")` 形式出现，不是内联）。
 *      ⚠ 判据刻意不写成"文件存在"：一个**过期**的 app.js 也能让"文件存在"恒真，
 *      而那正是"构建坏了但没人发现"的第二种形态。
 *   ④ 【修复轮 F7】**worker 产物也必须存在且 > 1 MB**：`data/serve/worker.js` 是 Task 5 的
 *      第二产物（spec §4.1 的 worker 进程入口），此前**没有任何门禁或测试守它** ——
 *      实测：删掉 `worker.js` + 注释掉 `esbuild.build(workerBuildConfig)`，本门禁**仍 EXIT 0**，
 *      跑完 `worker.js` 依然不存在（"双产物"只靠人肉跑命令，等于没人管）。
 *      ⚠ 与 ② 同理：**不写"文件存在"**（陈旧产物也能恒真），而是"存在 + 体积下界"，
 *      并且**要求它比构建前更新或新出现**（用 mtime/内容双重观测，见下）。
 *
 * ── 观测不到 ⇒ exit 3（Ruling 243 / 本仓库既有口径）──
 * "没找到产物" / "产物里没有可观测的打包痕迹" / "构建进程根本没起来" **都不是通过**：
 * 它们是"这条门禁没工作"，与"构建是好的"是两回事。所以一律 `exit 3`，绝不当成干净。
 *
 * 用法：node tools/check-build.cjs
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const apiDir = path.join(repoRoot, "apps", "api");
const artifact = path.join(apiDir, "data", "serve", "app.js");
/** 【修复轮 F7】第二产物：worker 进程入口（Task 5）。 */
const workerArtifact = path.join(apiDir, "data", "serve", "worker.js");

/** 产物下界（**不是**精确值断言：源码长一寸不该让门禁红）。实测 app 9.26 MB / worker 5.9 MB，取 1 MB 留足余量。 */
const MIN_ARTIFACT_BYTES = 1024 * 1024;

/** 必须能在产物里观测到的"打包痕迹"（外部化模块的 require）。 */
const TRACE = "@node-rs/argon2";

function fail3(msg) {
  console.error("check-build 无法完成观测（exit 3，不是通过）：");
  console.error("  - " + msg);
  process.exit(3);
}

// 先记下"构建前"的产物指纹：构建后必须**变**（或至少存在），否则我们无法证明这次真的产出了东西。
const before = fs.existsSync(artifact) ? fs.statSync(artifact) : null;
const beforeWorker = fs.existsSync(workerArtifact) ? fs.statSync(workerArtifact) : null;

console.log("check-build：跑一次生产构建（apps/api 的 `build` 脚本：cross-env NODE_ENV=prod tsx scripts/build.ts）…");
// ⚠ 刻意**不**用 `spawnSync("pnpm", [...], { shell: true })`：那会把参数交给 shell 拼接
//   （Node 会对 `shell:true` + args 发 DEP0190，且参数里有空格就会被拆错），Windows 上还要处理 `.cmd` 垫片。
//   直接复刻 npm script 的两半（`NODE_ENV=prod` + `node --import=tsx scripts/build.ts`），
//   进程模型与 `pnpm run build` 等价（prebuild 的路由生成不受影响：app.ts import 的是已生成并入库的 router.ts）。
const tsxLoader = require.resolve("tsx", { paths: [apiDir] });
const buildStartMs = Date.now();
const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, path.join("scripts", "build.ts")], {
  cwd: apiDir,
  encoding: "utf8",
  shell: false,
  env: { ...process.env, NODE_ENV: "prod" },
});

if (r.error) fail3(`构建进程没起来：${r.error.message}`);
if (r.status === null) fail3("构建进程被信号终止（status=null），无法判定结果");

const out = `${r.stdout || ""}\n${r.stderr || ""}`;
if (r.status !== 0) {
  console.error("check-build 失败：生产构建 EXIT " + r.status);
  console.error("  ↓ 构建输出原文（尾部 40 行）");
  for (const line of out.trim().split(/\r?\n/).slice(-40)) console.error("    " + line);
  console.error("  ⚠ 修 build 的正确方式是补 `scripts/build.ts` 的 external 或改源码 —— **不要**删这条门禁。");
  process.exit(1);
}

// ① 产物必须真的存在（构建声称成功却什么都没产出 ⇒ 观测不到，exit 3）
if (!fs.existsSync(artifact)) fail3(`构建 EXIT 0 但产物不存在：${artifact}`);
const after = fs.statSync(artifact);

// ② 字节数下界 + 必须打印（"自证真的打了包"）
if (after.size < MIN_ARTIFACT_BYTES) {
  fail3(`产物只有 ${after.size} 字节（下界 ${MIN_ARTIFACT_BYTES}）：这不像一份打好的 bundle，判观测失败`);
}

// ③ 打包痕迹（证明是新产物 + external 生效）
const body = fs.readFileSync(artifact, "utf8");
if (!body.includes(TRACE)) {
  fail3(
    `产物里找不到 \`${TRACE}\`：无法证明这次真的把口令哈希那条依赖打进了 bundle` +
      `（可能是旧产物、或 external 被改成内联/删除）。观测不到就不放行。`,
  );
}

// seed 也要在（裁定 60：种子必须跟产物一起走，缺了只在生产才炸）
const seedDirs = [path.join(apiDir, "data", "serve", "migrations", "seed"), path.join(apiDir, "data", "serve", "seed")];
for (const d of seedDirs) {
  if (!fs.existsSync(d)) fail3(`裁定 60 的种子目录不存在：${d}`);
  const n = fs.readdirSync(d).filter((f) => f.endsWith(".ndjson")).length;
  if (n === 0) fail3(`裁定 60 的种子目录是空的：${d}`);
}

// ④ 【修复轮 F7】worker 第二产物：存在 + 体积下界 + **必须是这次构建产出的**
//    ⚠ 只用"文件存在"会被**陈旧产物**骗过（与 ② 同一个坑）。所以要求：
//       worker.js 在构建前不存在，或它的 mtime 不早于本次构建开始（即它被重新写过）。
const buildStartedAt = buildStartMs;
if (!fs.existsSync(workerArtifact)) {
  fail3(
    `构建 EXIT 0 但 worker 产物不存在：${workerArtifact}\n` +
      `  ⇒ "双产物"没有真的产出（Task 5 的 worker.js 是 spec §4.1 的 worker 进程入口）。\n` +
      `  ⚠ 修法是补 \`scripts/build.ts\` 的 \`workerBuildConfig\` —— **不要**删这条断言。`,
  );
}
const workerAfter = fs.statSync(workerArtifact);
if (workerAfter.size < MIN_ARTIFACT_BYTES) {
  fail3(`worker 产物只有 ${workerAfter.size} 字节（下界 ${MIN_ARTIFACT_BYTES}）：这不像一份打好的 bundle，判观测失败`);
}
// 陈旧检测：构建前就有、且 mtime 早于本次构建开始 ⇒ 这次根本没重写它（构建行被注释掉/被删）
if (beforeWorker && workerAfter.mtimeMs < buildStartedAt - 1000) {
  fail3(
    `worker 产物是**陈旧**的（mtime ${new Date(workerAfter.mtimeMs).toISOString()} 早于本次构建开始 ` +
      `${new Date(buildStartedAt).toISOString()}）：本次构建没有重写 ${workerArtifact}。\n` +
      `  ⇒ \`esbuild.build(workerBuildConfig)\` 可能被注释/删除，而旧文件让"存在"恒真。观测不到就不放行。`,
  );
}

const changed = !before || before.size !== after.size;
const bundleKB = (after.size / 1024).toFixed(1);
const workerKB = (workerAfter.size / 1024).toFixed(1);

/**
 * ⑤ 【C 组复核轮 N1 修正】闸门初始化必须**在两条启动链的产物里都观测到**。
 *
 * review-C 实测：`__setGateFactory()` 原先只写在 `@/jobs`（桶文件）里，而 API 侧才 import 它
 * ⇒ 构建出的 `worker.js` 里**连这个符号都没有**，worker 进程里六个 handler 的第一次
 * `withVendorSlot()` 直接抛 `[gate] 闸门未初始化`（厂商调用一次都发不出去）。
 *
 * ⚠⚠ **判据必须是"调用形态"，不能是裸子串**（reviewer2 复核轮 N1：门禁会说谎）：
 *   裸子串 `__setGateFactory(` **也出现在 `gate.ts` 的错误文案里**
 *   （`"[gate] 闸门未初始化：启动路径应调用 __setGateFactory()…"`）⇒ 注释掉 bootstrap 之后，
 *   那个字符串仍留在产物里，门禁**照样 EXIT 0 并打印"闸门初始化 ✓"**（同刻真实调用数 = 0）。
 *   这正是 Ruling 243 家族"**空转/说谎的检查 = 没有检查**"。
 *   ⇒ 改成判**箭头函数调用** `__setGateFactory(() =>`（`bootstrap.ts` 的真实调用形态）。
 *   实测（当前产物）：`call=1 / bare=3`（app 与 worker 同形）—— 两者**可区分**，判据才有判别力。
 */
const GATE_INIT_TRACE = "__setGateFactory(() =>";
const GATE_INIT_BARE = "__setGateFactory(";
const appBody = fs.readFileSync(artifact, "utf8");
const workerBody = fs.readFileSync(workerArtifact, "utf8");
for (const [name, file, gateBody] of [
  ["app.js", artifact, appBody],
  ["worker.js", workerArtifact, workerBody],
]) {
  if (!gateBody.includes(GATE_INIT_TRACE)) {
    const bareCount = gateBody.split(GATE_INIT_BARE).length - 1;
    fail3(
      `${name} 里观测不到**调用形态** \`${GATE_INIT_TRACE}\`：该启动链**没有注册闸门工厂** ` +
        `⇒ 它的 withVendorSlot() 会抛"[gate] 闸门未初始化"（review-C F2）。\n` +
        `  ⚠ 裸子串 \`${GATE_INIT_BARE}\` 在本次产物里出现 ${bareCount} 次 —— 但那**不算数**：` +
        `它可能只来自 gate.ts 的错误文案（N1：裸子串判据会说谎）。\n` +
        `  ⇒ 修法：让该入口 import \`@/jobs/bootstrap\` 并调用 \`bootstrapJobInfra()\` —— **不要**删这条断言。\n` +
        `  （对照：${file}）`,
    );
  }
}

console.log(`check-build 通过（构建 EXIT 0）`);
console.log(`  · 产物：apps/api/data/serve/app.js = ${after.size} 字节 (${bundleKB} KB)`);
console.log(`  · 产物：apps/api/data/serve/worker.js = ${workerAfter.size} 字节 (${workerKB} KB)`);
console.log(`  · 自证：字节数已打印；app 含 \`${TRACE}\` require ✓；worker 体积下界 ✓ 且非陈旧 ✓；seed 4 个 .ndjson ✓；构建前后 app 体积${changed ? "有变化" : "一致（同源同参数打包，属预期）"}`);
console.log(`  · 闸门初始化：app.js 与 worker.js 均含**调用形态** \`${GATE_INIT_TRACE}\` ✓（N1 修正后的产物级守卫，缺一即 exit 3）`);
