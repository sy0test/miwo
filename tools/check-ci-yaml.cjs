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
 *   5. web job 的顺序为 build → vue-tsc --build → check-no-shadow，且**不含** check-copy。
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
    `${name} job 不得调用根脚本 pnpm run typecheck/test（根脚本内部是 pnpm.cmd，Linux 上不可用）`,
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

// ---- web job：build → vue-tsc --build → check-no-shadow（顺序即断言）----
const webJob = (doc.jobs || {}).web;
if (webJob) {
  const labels = stepLabels(webJob);
  const iBuild = indexOfMatch(labels, /@miwo\/web run build/);
  const iTsc = indexOfMatch(labels, /vue-tsc --build/);
  const iShadow = indexOfMatch(labels, /check-no-shadow\.cjs/);
  check(iBuild >= 0, "web job 缺少 `pnpm --filter @miwo/web run build`");
  check(iTsc >= 0, "web job 缺少 `vue-tsc --build`");
  check(iShadow >= 0, "web job 缺少 `node tools/check-no-shadow.cjs`");
  check(iBuild >= 0 && iTsc > iBuild, "web job 顺序错误：vue-tsc --build 必须在 build 之后（d.ts 要先由构建生成）");
  check(iTsc >= 0 && iShadow > iTsc, "web job 顺序错误：check-no-shadow 必须在 vue-tsc --build 之后");
  check(
    !stepRuns(webJob).some((r) => r.includes("check-copy.cjs")),
    "web job 不得跑 check-copy：它断言 apps/web/dist 不存在，而本 job 刚构建出 dist",
  );
}

if (failures.length) {
  console.error("check-ci-yaml 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-ci-yaml 通过（jobs: " + jobs.join(", ") + "）");
