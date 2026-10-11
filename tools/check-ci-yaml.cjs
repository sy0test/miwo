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
 *   4. api job 依次含 6 条仓库检查（copy / brand / eol / natives / **tenant-exceptions** / deploy）
 *      + 路由生成 + typecheck + 单测 + 打包；仓库检查必须紧跟 `pnpm install` 且排在其余步骤之前
 *      （**快速失败**；注意这与 `apps/web/dist` 是否存在**无关** —— check-copy 的 dist 断言查的是
 *      git 索引，构建后跑同样安全，"不能在其后跑"是旧的**事实错误**说法）；
 *   5. web job 是 `build-only`（vite build）→ `check-no-shadow`：**必须有 `build-only`、必须没有 `vue-tsc`**，
 *      且**不含** check-copy（职责划分，不是因为 dist 会让它失败）。Phase 0 刻意不做 web 类型检查
 *      （47 条上游继承类型错误、apps/web 属 Phase 3 前端重绘的替换对象）—— 这个"移除"必须与
 *      README 的留档同时存在，见第 6 条；
 *   6. `README.md` 的「已知问题 / Known issues」小节仍在、且**小节内**写明 `vue-tsc`、**47 条 / 17 个文件**
 *      的关键数字、以及 `Phase 3` 的**恢复条件**：防止"把红的步骤删掉、把原因也一起删掉"这种掩盖式通过
 *      （全文匹配的旧断言可以被任意一处无关文字满足，等于没守）。
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

// ---- api job：仓库检查的 6 条命令必须都在，且必须是"紧跟 install 的第一批步骤"（快速失败）----
const apiJob = (doc.jobs || {}).api;
if (apiJob) {
  const apiRuns = stepRuns(apiJob).join("\n");
  const apiRunArr = stepRuns(apiJob);
  for (const cmd of [
    "node tools/check-copy.cjs",
    "node tools/check-brand.cjs",
    "node tools/check-eol.cjs",
    "node tools/check-natives.cjs",
    "node tools/check-tenant-exceptions.cjs",
    "pnpm run verify:deploy",
  ]) {
    check(apiRuns.includes(cmd), `api job 缺少仓库检查命令: ${cmd}`);
  }
  // 顺序：install → 仓库检查 → 路由生成/typecheck/单测/打包。
  // 这是**快速失败**约束（仓库检查秒级、只读索引与源码），**不是** dist 存在性约束 ——
  // 见文件头第 4 条：check-copy 把 apps/web/dist 放在 mustNotBeTracked，查的是 git 索引。
  const iInstall = apiRunArr.findIndex((r) => r.includes("pnpm install --frozen-lockfile"));
  const iRepoCheck = apiRunArr.findIndex((r) => r.includes("node tools/check-copy.cjs"));
  const iAfter = apiRunArr.findIndex((r) =>
    /generate-router\.ts|@miwo\/api run typecheck|@miwo\/api test|@miwo\/api run build/.test(r),
  );
  check(iInstall >= 0, "api job 缺少 `pnpm install --frozen-lockfile` 步骤");
  check(
    iRepoCheck > iInstall && iAfter > iRepoCheck,
    "api job 顺序错误：仓库检查必须紧跟 install、并排在 路由生成/typecheck/单测/打包 之前（快速失败；与 apps/web/dist 是否存在无关）",
  );
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
    "web job 不重复跑 check-copy：仓库检查序列由 api job 统一负责。⚠ **不是**因为 `apps/web/dist` 的存在会让它失败 —— " +
      "check-copy 把 dist 放在 `mustNotBeTracked`（查 git 索引，不是磁盘存在性），构建后跑同样安全；" +
      "旧版这条断言给的理由是**事实错误**（Task 12 必做 3 已修正）",
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

/** 取某个二级标题（`## xxx`）的**小节正文**，到下一个 `## ` 标题为止。 */
function sectionBody(text, headingRe) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

// ⚠ 旧版这三条是**全文**匹配（`\bvue-tsc\b`、`/Phase 3/`），等于"整份 README 里出现过这两个词就算过"：
//   它守的正是 Phase 0 最大的一次范围变更（B2：把 web 类型门禁移除），却可以被任何一处无关文字满足。
//   现在锚定到小节内，并要求**关键数字**（47 条 / 17 个文件）与**恢复条件**字样都在 —— 那是这份
//   留档能被独立复核的唯一锚点（数字对不上，下游就不知道该恢复到什么程度）。
const known = sectionBody(readme, /^##\s+已知问题/);
check(!!known, "README.md 缺少「已知问题 / Known issues」小节：Phase 0 不做 web 类型检查的代价必须留档");
check(/\bvue-tsc\b/.test(known), "README.md「已知问题」小节内必须写明 apps/web 的 vue-tsc 类型错误清单");
check(/Phase 3/.test(known), "README.md「已知问题」小节内必须把它标为 Phase 3 前端重绘的前置清单项");
check(
  /47\s*条/.test(known) && /17\s*个文件/.test(known),
  "README.md「已知问题」小节内必须写明关键数字 **47 条 / 17 个文件**（复测口径与恢复判据都锚在这两个数上）",
);
check(
  /恢复条件/.test(known),
  "README.md「已知问题」小节内必须写明**恢复条件**（47 条清零 + 把 CI web job 的 build-only 换回 vue-tsc）",
);

if (failures.length) {
  console.error("check-ci-yaml 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("check-ci-yaml 通过（jobs: " + jobs.join(", ") + "）");
