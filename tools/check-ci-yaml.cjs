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
 *      （全文匹配的旧断言可以被任意一处无关文字满足，等于没守）；
 *   7. 【Phase 1a / Task 9】`mysql` job 必须存在，且必须**真的跑** MySQL 分支：
 *      有 `services.mysql`（镜像 `mysql:8.x`、含 `--health-cmd`、含口令类 env、有 ports）、
 *      job 级 env 里 `MIWO_DB_DRIVER=mysql` 且 **`MIWO_TEST_MYSQL="1"`**、steps 里含
 *      `verify-mysql-migration.cjs` 与 `mysql-integration.test.ts`、且**不得**出现 `continue-on-error`。
 *      为什么：`tests/mysql-integration.test.ts` 由 `MIWO_TEST_MYSQL=1` 门控，缺 job 或缺这个变量
 *      **两种情况都是全绿** —— 那正是 Phase 0 抓过的"唯一事务守卫永不执行"（Ruling 26）的同族坑；
 *   8. 【Phase 1e / Task 5】api job 必须跑 seed 自检与 `verify-phase1e.cjs --no-http`，web job 必须
 *      在 `build-only` 后跑 `sync-web-build.cjs --self-test`，避免验收命令只存在于脚本或注释里。
 *
 * 用法：node tools/check-ci-yaml.cjs
 */
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const p = path.resolve(__dirname, "..", ".github", "workflows", "ci.yml");
const src = fs.readFileSync(p, "utf8");
const failures = [];

// ⚠ YAML 解析失败必须**显式报错**（而不是让 `YAML.parse` 的 stack trace 直接砸出来）：
//    "结构被改坏"本身就是一条真实失败（GitHub 会让整个 workflow 静默不运行），
//    而一条说得清的报错才能让人区分"文件坏了"与"某条断言不满足"。
let doc = null;
try {
  doc = YAML.parse(src);
} catch (e) {
  console.error("check-ci-yaml 失败：");
  console.error("  - .github/workflows/ci.yml 不是合法 YAML，整份 workflow 会静默不运行：" + e.message.split("\n")[0]);
  process.exit(1);
}

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
function exactRunIndex(job, command) {
  return (job.steps || []).findIndex((s) => String(s.run || "").trim() === command);
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
    "node tools/check-tenant-policies.cjs",
    "node tools/check-mysql-dialect.cjs",
    "pnpm run verify:deploy",
  ]) {
    check(apiRuns.includes(cmd), `api job 缺少仓库检查命令: ${cmd}`);
  }
  // ---- Phase 1c / Task 10：三条**新接线**必须钉死（"没接线的验证 ≈ 没有验证"）----
  // 为什么这三条断言本身就是本轮教训的产物：`apps/api/scripts/build.ts` 的 external 缺
  // `@node-rs/argon2` 让生产构建坏了 8 个任务而无人发现，唯一原因是**验收清单里没有一条跑 build**；
  // 同理 `verify-phase1c-media.cjs` 早就写好了，但根 package.json 里**从来没有它的 script**
  // （`pnpm run verify:phase1c-media` 会 ERR_PNPM_NO_SCRIPT），CI 里也没有 ⇒ 它每轮都不跑。
  // ⚠ 判据写成"必须出现 `node tools/check-build.cjs`"（而不是"出现 verify:build"）：CI 里直跑
  //   cjs 与 package.json 的 script 是同一件事，但**直跑才不依赖 script 名字被改**。
  //
  // ⚠⚠ 这里刻意**从根 package.json 的 scripts 里读**要断言的命令，而不是手抄第三份清单：
  //    Task 10 之前 `verify:phase0` / `verify:phase1b` 等脚本在 package.json 里有、CI 里却
  //    **一个都没跑**（本任务之前的真实缺口），而"脚本存在"与"CI 真跑"是两回事。
  //    从 scripts 读 ⇒ 加一个 script 就自动要求 CI 同步，漏接会红（**多一个都拦得住**）。
  //    只做下限（"scripts 里的每条 verify:* 都必须在 api job 里出现"），不做"CI 里的 pnpm 行
  //    必须都在 scripts 里"——后者会把 `pnpm run verify:phase1a:ci` 这类 CI 专属口径误判。
  const rootPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  const rootScripts = rootPkg.scripts || {};
  /**
   * **显式豁免表**：登记"为什么这个 script 不该进 CI"。
   * ⚠ 每条必须有非空 reason（空 reason 判红）—— 这就是防"往豁免表里塞一行就绿"的那道闸。
   * ⚠ 表长被下面的 `EXEMPT_MAX` 钉住：**豁免表本身也是被断言的**（多一行就红）。
   */
  const CI_EXEMPT = {
    "verify:phase0": {
      reason:
        "**本机门禁**：A 组按 `tools/.phase0-old-baseline.json` 的 8 条 sha256 比对**仓库外**两个旧仓，" +
        "而基线被 `.gitignore:12` 忽略、旧仓在 runner 上不存在。**实测**（git archive HEAD 的全新树）" +
        "= EXIT 1「缺少 tools/.phase0-old-baseline.json」，通过数 33/34。README 的「已知问题」小节" +
        "第 1 条本来就写明「`pnpm run verify:phase0` 是「本机门禁」，CI 跑不了它」。",
    },
    "verify:legacy-freeze": {
      reason:
        "同上：`record-legacy-freeze.cjs --check` 需要仓库外两个旧仓，且它自己的口径是" +
        "「缺仓库**不算通过**」⇒ 无 remote 的 runner 上必然 EXIT 1。" +
        "CI 侧的替代口径是 `verify:phase1a:ci`（把这条显式记为「CI 不适用」）。",
    },
    "verify:manual-test": {
      reason:
        "**Windows 本机专用**：脚本是 `powershell -NoProfile … -File scripts/manual-test.ps1`，" +
        "CI 跑在 ubuntu-latest（无 powershell.exe）。它的用途是" +
        "「一条命令起本机可手动点的环境」，与自动化门禁是两件事（见 README）。",
    },
  };
  /** 豁免表长度的**精确**上界（新增一条必须同时改这里 —— 让"往表里塞一行"变成一次显式动作）。 */
  const EXEMPT_MAX = 3;
  const exemptNames = Object.keys(CI_EXEMPT);
  if (exemptNames.length > EXEMPT_MAX) {
    failures.push(
      `check-ci-yaml 的 CI_EXEMPT 有 ${exemptNames.length} 条，超过登记上界 ${EXEMPT_MAX}：` +
        `豁免表是"不跑的正当理由"清单，不是垃圾桶。要新增豁免，请连同这条上界一起改并说明理由。`,
    );
  }
  for (const [name, e] of Object.entries(CI_EXEMPT)) {
    if (!e || !String(e.reason || "").trim()) {
      failures.push(`CI_EXEMPT 的 \`${name}\` 没有 reason：空 reason 的豁免等于无理由不跑，判红`);
    }
    if (!(name in rootScripts)) {
      failures.push(`CI_EXEMPT 的 \`${name}\` 在根 package.json 里已不存在：豁免表必须跟着收缩（否则它会慢慢变成谎言）`);
    }
  }
  for (const [name, cmd] of Object.entries(rootScripts)) {
    if (!name.startsWith("verify:")) continue;
    // `:record` 是写入型脚本（会改仓库文件），本就不该进 CI；`*:ci` 是 CI 专属口径，由上面单独管。
    if (/:(record|ci)$/.test(name)) continue;
    if (new RegExp(`^\\s*pnpm run ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:ci)?\\s*$`, "m").test(apiRuns)) continue;
    if (String(cmd).includes("check-") || String(cmd).includes("verify-")) {
      const cjs = String(cmd).replace(/^node\s+/, "");
      if (apiRuns.includes(cjs)) continue;
    }
    // 需要在**全新树**（CI 的条件）上真跑过的才放行；本机专属的必须在 CI_EXEMPT 里登记。
    if (name in CI_EXEMPT) continue;
    failures.push(
      `根 package.json 的 script \`${name}\`（${cmd}）**一次都不会在 CI 里跑**：` +
        `脚本存在 ≠ 每轮被跑到（Task 10 的教训：verify-phase1c-media.cjs 存在了很久却从没接线）。` +
        `请把它加进 .github/workflows/ci.yml 的 api job，或在 CI_EXEMPT 里登记不跑的理由。`,
    );
  }
  check(
    apiRuns.includes("pnpm run verify:config"),
    "api job 缺少 `pnpm run verify:config`（= node tools/check-config-single-source.cjs）：" +
      "apps/api/src 下不得绕过 config.ts 直读环境变量",
  );
  check(
    apiRuns.includes("pnpm run verify:build"),
    "api job 缺少 `pnpm run verify:build`（= node tools/check-build.cjs）：**生产构建本身**必须是一条门禁" +
      "（Task 10 的教训：Task 2 引入 @node-rs/argon2 后 build 坏了 8 个任务，因为验收清单里没有一条跑 build）",
  );
  check(
    /^\s*pnpm run verify:phase1c-media\s*$/m.test(apiRuns),
    "api job 缺少 `pnpm run verify:phase1c-media`：Phase 1c 媒体验收（Task 7/8/9 的判别力脚本）" +
      "必须在 CI 里真的跑到 —— 它存在过很久却从来没被接进任何自动化环境",
  );
  // Phase 1c / Task 12：**Phase 1c 的唯一验收命令**（A–H 组：注册 / 登录 / 会话轮转与吊销 /
  // 跨租户隔离 / 收权矩阵抽样 / 媒体签名与 Range / 错误脱敏 / 干净收尾；M 组是**显式未实测**的 MySQL 口径）。
  // ⚠ 判据写成"必须出现 `pnpm run verify:phase1c`"，**不能**写成 `apiRuns.includes("verify:phase1c")`：
  //   后者会被 `pnpm run verify:phase1c-media` 这一行**字符串包含**（它是前者的前缀）而恒真 ——
  //   于是"有人把新命令删掉、只留媒体验收"这条就再也拦不住。`\s*$` + `m` 锚定整行才有效
  //   （与上面 `verify:phase1a:ci` 的反向断言同一个理由）。
  check(
    /^\s*pnpm run verify:phase1c\s*$/m.test(apiRuns),
    "api job 缺少 `pnpm run verify:phase1c`（Phase 1c 的唯一验收命令必须在 CI 里真的跑到；" +
      "它自己开一次性数据目录、跑真迁移链与真 db:bootstrap-admin CLI、起真应用打真 HTTP）",
  );
  // Phase 1d / Task 12：**Phase 1d 的唯一验收命令**必须在 api job 里真的跑到（A 结构 / B 静态方言 /
  // C sqlite 端到端 / D MySQL（api job 里显式 SKIP，真跑在 mysql job）/ E 门禁+既有验收）。
  // ⚠ 与上面 `verify:phase1c` 同一个坑：判据必须**整行锚定**，否则 `verify:phase1c-media` 之类的
  //   前缀会让它恒真。宽泛的"scripts 里的 verify:* 都要在 CI 里"那一条（下面的 for 循环）也覆盖它，
  //   但**不能替代**这条 —— 循环只证明"某处出现过"，锚定才证明"作为独立步骤跑过"。
  check(
    /^\s*pnpm run verify:phase1d\s*$/m.test(apiRuns),
    "api job 缺少 `pnpm run verify:phase1d`（Phase 1d 的唯一验收命令必须在 CI 里真的跑到）",
  );
  // Phase 1b / Task 8：策略门禁不仅要"在 CI 里"，还必须**真跑**（不许被 continue-on-error / `|| true` 变成永不失败）。
  // ⚠ 判据刻意严于"值为 true"：**出现这个键/写法就算失败** —— 那两样都是掩盖，不是通过。
  //   （mysql job 的同类断言在下面单独一段；这里管 api/web 两个 job。）
  for (const [jobName, job] of Object.entries({ api: apiJob, web: (doc.jobs || {}).web })) {
    if (!job) continue;
    const runs = stepRuns(job).join("\n");
    if (/continue-on-error/.test(runs)) failures.push(`ci.yml 的 ${jobName} job 步骤里出现 continue-on-error：那是掩盖，不是通过`);
    if (/\|\|\s*true/.test(runs)) failures.push(`ci.yml 的 ${jobName} job 步骤里出现 \`|| true\`：门禁被削弱（永不失败）`);
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
  // Phase 1b / Task 9：Phase 1b 的**唯一验收命令**必须在 api job 里真跑（交付物没进 CI = 零防漂移）。
  check(apiRuns.includes("pnpm verify:phase1b"), "api job 必须跑 `pnpm verify:phase1b`（Phase 1b 的唯一验收命令）");
  check(
    apiRuns.includes("pnpm --filter @miwo/api run typecheck"),
    "api job 缺少 `pnpm --filter @miwo/api run typecheck`",
  );
  check(apiRuns.includes("pnpm --filter @miwo/api test"), "api job 缺少 `pnpm --filter @miwo/api test`");
  check(apiRuns.includes("pnpm --filter @miwo/api run build"), "api job 缺少 `pnpm --filter @miwo/api run build`");

  // Phase 1e / Task 5：两条 api 验收必须是独立 run 步骤，顺序在单测之后、打包之前。
  const seedSelfTest = "node apps/api/scripts/seed-data-dir.cjs --self-test";
  const phase1eVerify = "node apps/api/scripts/verify-phase1e.cjs --no-http";
  const iApiTest = apiRunArr.findIndex((r) => r.includes("pnpm --filter @miwo/api test"));
  const iSeed = exactRunIndex(apiJob, seedSelfTest);
  const iPhase1e = exactRunIndex(apiJob, phase1eVerify);
  const iApiBuild = apiRunArr.findIndex((r) => r.includes("pnpm --filter @miwo/api run build"));
  check(iSeed >= 0, "api job 缺少 Phase 1e 的播种自检（seed-data-dir.cjs --self-test）");
  check(iPhase1e >= 0, "api job 缺少 Phase 1e 验收命令（verify-phase1e.cjs --no-http）");
  check(
    iApiTest >= 0 && iSeed > iApiTest && iPhase1e > iSeed && iApiBuild > iPhase1e,
    "api job 顺序错误：单测 → seed 自检 → verify-phase1e --no-http → 后端打包",
  );
  check(!/pnpm\s+(run\s+)?(dev|start)\b/.test(apiRuns), "api job 不得启动应用（dev/start），端到端启动验证属 Task 13");

  // Phase 1a / Task 11：Phase 1a 的**唯一验收命令**必须在 api job 里真的被跑到。
  // ⚠ 为什么这条断言不是"多余的"：`verify-phase1a.cjs` 是 sqlite 口径的收口断言集合
  //    （迁移机制/库层/数据层闭环/静态 DDL/仓库卫生）。**只加脚本、不加 CI 步骤**时，
  //    它在唯一的自动化环境里一次都不会跑 —— 正是本仓库反复抓到的
  //    "唯一的事务守卫永不执行"（Ruling 26）的同族坑。所以这里和 mysql job 那几条一样把它钉死。
  //
  // ⚠⚠ 【裁定 B】CI 上跑的必须是 **`verify:phase1a:ci`**（= 该脚本 + `--ci`），**不是**本机口径。
  //    `verify-phase1a.cjs` 里有两条**本机专属**检查，在全新树（`git archive HEAD`）上**必然失败**：
  //      ① 旧仓库 sha256 冻结读 `tools/.phase0-old-baseline.json`（被 `.gitignore:12` 忽略 → Test-Path False）；
  //      ② `verify:legacy-freeze --check` 需要仓库外两个旧仓（无 remote 的 runner 上不可能有）。
  //    实跑过：全新树里本机口径 = **EXIT 1**。`--ci` 把那两条**显式记为「CI 不适用」**并移出通过计数，
  //    **未削弱任何断言**（本机口径下它们照旧是真判据）。
  //    ⚠ 判据刻意是"**必须出现 `verify:phase1a:ci`**"，而不是"出现 `verify:phase1a` 即可"——
  //      后者会被 `verify:phase1a:ci` 这一行**字符串包含**（它是前者的前缀）而恒真，
  //      于是"有人把 CI 改回本机口径"就再也拦不住了。所以下面还要一条**反向**断言。
  check(
    /^\s*pnpm run verify:phase1a:ci\s*$/m.test(apiRuns),
    "api job 缺少 `pnpm run verify:phase1a:ci`（Phase 1a 的唯一验收命令必须在 CI 里真的跑到；" +
      "CI 口径 = 该脚本 + `--ci`，见 .github/workflows/ci.yml 该步的说明）",
  );
  check(
    !/^\s*pnpm run verify:phase1a\s*$/m.test(apiRuns),
    "api job 不得跑本机口径 `pnpm run verify:phase1a`（无 `--ci`）：它依赖被 gitignore 的旧仓基线与仓库外两个旧仓，" +
      "全新树里必然 EXIT 1。CI 口径是 `pnpm run verify:phase1a:ci`（那两条会被显式记为「CI 不适用」）",
  );
  // 形态门禁（裁定 B）也必须在**快速失败**的前半段里，而不是只在 verify:phase1a 内部被间接调用：
  // 仓库检查序列是"秒级、只读源码"，把用例形态放进这一批才能在 typecheck/test 之前拦住。
  check(
    apiRuns.includes("node tools/check-test-early-return.cjs"),
    "api job 缺少 `node tools/check-test-early-return.cjs`（控制器裁定 B：禁止用例里的静默早退形态）",
  );
}

// ---- web job：Phase 0 的门禁是 build-only（vite build），**不是** vue-tsc ----
const webJob = (doc.jobs || {}).web;
if (webJob) {
  const labels = stepLabels(webJob);
  const runs = stepRuns(webJob);
  const iBuildOnly = indexOfMatch(labels, /@miwo\/web run build-only/);
  const iSyncSelfTest = exactRunIndex(webJob, "node apps/api/scripts/sync-web-build.cjs --self-test");
  const iShadow = indexOfMatch(labels, /check-no-shadow\.cjs/);
  check(iBuildOnly >= 0, "web job 缺少 `pnpm --filter @miwo/web run build-only`（Phase 0 的 web 门禁是 vite build）");
  check(iSyncSelfTest >= 0, "web job 缺少前端产物同步自检（sync-web-build.cjs --self-test）");
  check(iShadow >= 0, "web job 缺少 `node tools/check-no-shadow.cjs`");
  check(
    iBuildOnly >= 0 && iSyncSelfTest > iBuildOnly && iShadow > iSyncSelfTest,
    "web job 顺序错误：build-only → sync-web-build 自检 → check-no-shadow",
  );
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

// ---- Phase 1a / Task 9：mysql job 必须真实存在且**真的跑** MySQL 分支 ----
// 为什么这段断言存在（Ruling 26 的同族坑）：`tests/mysql-integration.test.ts` 由
// `MIWO_TEST_MYSQL=1` 门控（`describe.skipIf` 的等价写法），**没这个变量整个文件 skip**。
// 于是"CI 里没有 mysql job"和"有 job 但没设 MIWO_TEST_MYSQL"这两种情况**都是全绿**的，
// 而 MySQL 分支在唯一的自动化环境里一次都没被跑到 —— 正是 Phase 0 抓过的
// "唯一的事务守卫永不执行"。所以这里不只断言 job 存在，还把镜像/健康检查/env/steps 逐项钉死。
const mysqlJob = (doc.jobs || {}).mysql || null;
if (!mysqlJob) {
  failures.push("ci.yml 缺少 mysql job：Phase 1a 的 MySQL 分支必须在 CI 里真的被跑到（Phase 0 的遗留缺口）");
} else {
  const svc = mysqlJob.services && mysqlJob.services.mysql;
  if (!svc) {
    failures.push("ci.yml 的 mysql job 缺少 services.mysql（没有 MySQL 服务，测试只能 skip）");
  } else {
    if (!/^mysql:8\./.test(String(svc.image || ""))) {
      failures.push(`ci.yml 的 mysql service 镜像必须是 mysql:8.x，实际 "${svc.image}"`);
    }
    const opts = String(svc.options || "");
    if (!/--health-cmd/.test(opts)) {
      failures.push("ci.yml 的 mysql service 缺少 --health-cmd（runner 会在 DB 就绪前开始跑 steps）");
    }
    // 【Ruling 107·安全】口令纪律：service 必须是"独立容器 + 口令"，不得复用本机那种 root 无口令的实例。
    const svcEnv = svc.env || {};
    for (const k of ["MYSQL_ROOT_PASSWORD", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"]) {
      if (String(svcEnv[k] ?? "") === "") failures.push(`ci.yml 的 mysql service 缺少 env ${k}（口令/库名必须显式给出，不能沿用本机 root 无口令的写法）`);
    }
    if (/MYSQL_ALLOW_EMPTY_PASSWORD/i.test(JSON.stringify(svcEnv))) {
      failures.push("ci.yml 的 mysql service 出现 MYSQL_ALLOW_EMPTY_PASSWORD：那等于把本机「root 无口令」搬进 CI（Ruling 107）");
    }
    if (svc.ports === undefined || (Array.isArray(svc.ports) && svc.ports.length === 0)) {
      failures.push("ci.yml 的 mysql service 没有 ports：job 容器必须能连到 service");
    }
  }
  const env = mysqlJob.env || {};
  for (const k of ["MIWO_DB_DRIVER", "MIWO_DB_HOST", "MIWO_DB_PORT", "MIWO_DB_USER", "MIWO_DB_NAME", "MIWO_TEST_MYSQL"]) {
    if (String(env[k] ?? "") === "") failures.push(`ci.yml 的 mysql job 缺少 env ${k}`);
  }
  // 口令也要经 job 级 env 传给应用（否则 root 无口令那套会传染回来）
  for (const k of ["MIWO_DB_PASSWORD", "MIWO_JWT_SECRET"]) {
    if (String(env[k] ?? "") === "") failures.push(`ci.yml 的 mysql job 缺少 env ${k}`);
  }
  if (String(env.MIWO_DB_DRIVER) !== "mysql") {
    failures.push(`ci.yml 的 mysql job 的 MIWO_DB_DRIVER 必须是 mysql，实际 "${env.MIWO_DB_DRIVER}"`);
  }
  if (String(env.MIWO_TEST_MYSQL) !== "1") {
    failures.push(`ci.yml 的 mysql job 的 MIWO_TEST_MYSQL 必须是 "1"（否则集成测试会 skip，等于没跑）`);
  }
  const steps = JSON.stringify(mysqlJob.steps || []);
  for (const needle of ["verify-mysql-migration.cjs", "mysql-integration.test.ts"]) {
    if (!steps.includes(needle)) failures.push(`ci.yml 的 mysql job 的 steps 里找不到 "${needle}"`);
  }
  // Phase 1d / Task 12：**队列的 MySQL 口径**也必须在 mysql job 里真跑（Task 10 Step 6）。
  // 为什么单独钉：`job-mysql-integration.test.ts` 与 `job-chaos.cjs` 都由 MIWO_TEST_MYSQL 门控，
  // 少了这两步它们在唯一的自动化环境里**一次都不会跑**（Ruling 26 同族）。
  if (!steps.includes("job-mysql-integration.test.ts")) {
    failures.push("ci.yml 的 mysql job 缺少队列 MySQL 集成步骤（tests/job-mysql-integration.test.ts）");
  }
  if (!steps.includes("job-chaos.cjs")) {
    failures.push("ci.yml 的 mysql job 缺少多进程 chaos 步骤（apps/api/scripts/job-chaos.cjs）：租约回收/零丢失/上限只有真 MySQL 多进程才验得了");
  }
  // ⚠ Phase 1a / Task 11：mysql job **必须**先把合成 dev 库快照造出来。
  //   为什么把它钉死而不是"可选"：`tests/mysql-integration.test.ts` 的搬迁用例源库是
  //   `apps/api/data/db2.sqlite`（被 .gitignore 忽略，全新 checkout 上没有）。少了这一步，
  //   那条用例会被 `it.skipIf` 显式跳过，而 `verify-mysql-migration.cjs` 的断言 8 的判据是
  //   "0 skipped" ⇒ **CI 会红**（这正是裁定 B 要的效果：不再有"假装通过"）。
  //   两种修法里我们选了"给 CI 一份可用的源库"，而不是"放宽断言 8"。
  //   —— 这条断言防的是"有人把这一步删掉，然后忘了 CI 会红"。
  if (!steps.includes("gen-dev-db-fixture.cjs")) {
    failures.push(
      "ci.yml 的 mysql job 缺少 `gen-dev-db-fixture.cjs` 这一步：没有它，搬迁用例会被显式跳过，" +
        "而断言 8 要求 0 skipped ⇒ job 必红。别删这一步来'修'红色，那是在掩盖而不是通过。",
    );
  }
  const iFixture = JSON.stringify(mysqlJob.steps || []).indexOf("gen-dev-db-fixture.cjs");
  const iVerify = JSON.stringify(mysqlJob.steps || []).indexOf("verify-mysql-migration.cjs");
  if (iFixture >= 0 && iVerify >= 0 && !(iFixture < iVerify)) {
    failures.push("ci.yml 的 mysql job 顺序错误：必须先 gen-dev-db-fixture.cjs（造源库），再 verify-mysql-migration.cjs");
  }
  // ⚠ 判据刻意严于"值为 true"：**出现这个键就算失败**。`continue-on-error: false` 看起来无害，
  //    但它会让"这一步失败了 CI 也绿"变成一个随时可被改一个词翻过来的开关；这里不留这个开关。
  if (/continue-on-error/.test(steps)) {
    failures.push("ci.yml 的 mysql job 步骤里出现 continue-on-error：那是掩盖，不是通过");
  }
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
