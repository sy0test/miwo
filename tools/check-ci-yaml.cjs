#!/usr/bin/env node
/**
 * 门禁：`.github/workflows/ci.yml` 必须可被解析，且结构与顺序满足 Phase 0 的硬约束。
 *
 * 为什么需要：YAML 语法错误会让整个 workflow **静默不运行**（GitHub 只在 Actions 页面报错），
 * 而"job 名写错 / 顺序颠倒 / action 输入与 package.json 冲突"这类问题在本地不可见。
 *
 * 断言清单（每条都对应一个会让 CI 变红或静默失效的坑）：
 *   1. YAML 可解析；
 *   2. job 名为 api / web，且都有 checkout → pnpm/action-setup → setup-node(node 24) → frozen install；
 *   3. `pnpm/action-setup` **不带** `version` 输入（与根 package.json 的 `packageManager` 冲突会抛
 *      "Multiple versions of pnpm specified"）；
 *   4. api job 依次含 5 条仓库检查 + 路由生成 + typecheck + 单测 + 打包；
 *   5. web job 是 `build-only`（vite build）→ `check-no-shadow`：**必须有 `build-only`、必须没有 `vue-tsc`**，
 *      且**不含** check-copy。Phase 0 刻意不做 web 类型检查（47 条上游继承类型错误、apps/web 属 Phase 3
 *      前端重绘的替换对象）—— 这个"移除"必须与 README 的留档同时存在，见第 6 条；
 *   6. `README.md` 的「已知问题 / Known issues」小节仍在、且仍写明 `vue-tsc` 与 Phase 3 前置项：
 *      防止"把红的步骤删掉、把原因也一起删掉"这种掩盖式通过。
 *
 * 用法：node tools/check-ci-yaml.cjs
 */
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const p = path.resolve(__dirname, "..", ".github", "workflows", "ci.yml");
const doc = YAML.parse(fs.readFileSync(p, "utf8"));
const failures = [];

function check(cond, msg) {
  if (!cond) failures.push(msg);
}

/** 把 step 数组压成 "uses 或 run 的首行" 序列，便于做顺序断言。 */
function stepLabels(job) {
  return (job.steps || []).map((s) => (s.uses ? "uses:" + s.uses : "run:" + String(s.run || "").trim().split("\n")[0]));
}
function stepRuns(job) {
  return (job.steps || []).map((s) => String(s.run || ""));
}
function indexOfMatch(labels, re) {
  return labels.findIndex((l) => re.test(l));
}

check(doc && typeof doc === "object", "ci.yml 解析结果不是对象");
check(doc && doc.name === "ci", `顶层 name 期望 "ci"，实际 ${doc && JSON.stringify(doc.name)}`);
check(doc && Object.prototype.hasOwnProperty.call(doc, "on"), "缺少 on 触发器");

const jobs = Object.keys((doc && doc.jobs) || {});
check(jobs.includes("api") && jobs.includes("web"), `jobs 必须同时含 api 与 web，实际: ${jobs.join(", ")}`);

for (const name of ["api", "web"]) {
  const job = (doc.jobs || {})[name];
  if (!job) continue;
  const labels = stepLabels(job);
  const runs = stepRuns(job);
  const joined = labels.join(" | ");

  check(job["runs-on"] === "ubuntu-latest", `${name} job 的 runs-on 期望 ubuntu-latest，实际 ${job["runs-on"]}`);
  check(labels.includes("uses:actions/checkout@v4"), `${name} job 缺少 actions/checkout@v4`);
  check(labels.includes("uses:pnpm/action-setup@v4"), `${name} job 缺少 pnpm/action-setup@v4`);
  check(labels.includes("uses:actions/setup-node@v4"), `${name} job 缺少 actions/setup-node@v4`);

  const setupNode = (job.steps || []).find((s) => s.uses === "actions/setup-node@v4");
  const nodeVer = setupNode && setupNode.with && setupNode.with["node-version"];
  check(String(nodeVer) === "24", `${name} job 的 setup-node node-version 期望 24，实际 ${nodeVer}`);

  const actionSetup = (job.steps || []).find((s) => s.uses === "pnpm/action-setup@v4");
  check(
    !(actionSetup && actionSetup.with && actionSetup.with.version),
    `${name} job 的 pnpm/action-setup 不得传 version 输入（与 package.json 的 packageManager 冲突会抛 Multiple versions of pnpm specified）`,
  );

  check(
    runs.some((r) => r.includes("pnpm install --frozen-lockfile")),
    `${name} job 缺少 \`pnpm install --frozen-lockfile\``,
  );
  check(!/pnpm\.cmd/.test(joined), `${name} job 里出现了 Windows 专用的 pnpm.cmd`);
  check(
    !runs.some((r) => /^\s*pnpm run (typecheck|test)\s*$/.test(r)),
    `${name} job 不得调用根聚合脚本 pnpm run typecheck/test：必须用 \`pnpm --filter <pkg> run <script>\` 显式点名` +
      `（web 的脚本名是 type-check 而非 typecheck，聚合会静默跳过）`,
  );
}

// ---- api job：仓库检查的 5 条命令必须都在（且在任何前端构建之前）----
const apiJob = (doc.jobs || {}).api;
if (apiJob) {
  const apiRuns = stepRuns(apiJob).join("\n");
  for (const cmd of [
    "node tools/check-copy.cjs",
    "node tools/check-brand.cjs",
    "node tools/check-eol.cjs",
    "node tools/check-natives.cjs",
    "pnpm run verify:deploy",
  ]) {
    check(apiRuns.includes(cmd), `api job 缺少仓库检查命令: ${cmd}`);
  }
  check(apiRuns.includes("node --import=tsx scripts/generate-router.ts"), "api job 缺少路由生成（幂等）步骤");
  check(
    apiRuns.includes("pnpm --filter @miwo/api run typecheck"),
    "api job 缺少 `pnpm --filter @miwo/api run typecheck`",
  );
  check(apiRuns.includes("pnpm --filter @miwo/api test"), "api job 缺少 `pnpm --filter @miwo/api test`");
  check(apiRuns.includes("pnpm --filter @miwo/api run build"), "api job 缺少 `pnpm --filter @miwo/api run build`");
  check(!/pnpm\s+(run\s+)?(dev|start)\b/.test(apiRuns), "api job 不得启动应用（dev/start），端到端启动验证属 Task 13");
}

// ---- web job：Phase 0 的门禁是 build-only（vite build），**不是** vue-tsc ----
const webJob = (doc.jobs || {}).web;
if (webJob) {
  const labels = stepLabels(webJob);
  const runs = stepRuns(webJob);
  const iBuildOnly = indexOfMatch(labels, /@miwo\/web run build-only/);
  const iShadow = indexOfMatch(labels, /check-no-shadow\.cjs/);
  check(iBuildOnly >= 0, "web job 缺少 `pnpm --filter @miwo/web run build-only`（Phase 0 的 web 门禁是 vite build）");
  check(iShadow >= 0, "web job 缺少 `node tools/check-no-shadow.cjs`");
  check(iBuildOnly >= 0 && iShadow > iBuildOnly, "web job 顺序错误：check-no-shadow 必须在 build-only 之后");
  check(
    !runs.some((r) => /vue-tsc/.test(r)),
    "web job 不得跑 vue-tsc：Phase 0 刻意移除 web 类型检查（47 条上游继承类型错误；apps/web 是 Phase 3 前端重绘的替换对象）。" +
      "恢复它必须同时改 ci.yml 文件头与 README「已知问题」，不能只删这条断言",
  );
  check(
    !runs.some((r) => /@miwo\/web\s+run\s+build\s*$/.test(r.trim())),
    "web job 不得跑 `@miwo/web run build`：该脚本内部是 `vue-tsc --build --force && vite build`，等于偷偷恢复类型检查",
  );
  check(
    !runs.some((r) => r.includes("check-copy.cjs")),
    "web job 不得跑 check-copy：它断言 apps/web/dist 不存在，而本 job 刚构建出 dist",
  );
}

// ---- B2 的"移除而非掩盖"必须留档：README 的「已知问题」小节与 Phase 3 追踪项必须还在 ----
const readmePath = path.resolve(__dirname, "..", "README.md");
let readme = "";
try {
  readme = fs.readFileSync(readmePath, "utf8");
} catch (e) {
  readme = "";
}
check(/^##\s+已知问题/m.test(readme), "README.md 缺少「已知问题 / Known issues」小节：Phase 0 不做 web 类型检查的代价必须留档");
check(/\bvue-tsc\b/.test(readme), "README.md「已知问题」小节必须写明 apps/web 的 vue-tsc 类型错误清单");
check(/Phase 3/.test(readme), "README.md「已知问题」小节必须把它标为 Phase 3 前端重绘的前置清单项");

if (failures.length) {
  console.error("check-ci-yaml 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-ci-yaml 通过（jobs: " + jobs.join(", ") + "）");
