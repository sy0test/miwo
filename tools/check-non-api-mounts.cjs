#!/usr/bin/env node
/**
 * 门禁：**所有非 `/api` 的 `app.use` 挂载点都必须显式登记**（多一个/少一个都红）。Phase 1c Task 10。
 *
 * ── 为什么需要它（Ruling 202/247 的"盲区家族"）──
 * `src/app.ts` 的鉴权边界是 `app.use("/api", …authenticate…)`。于是**任何非 `/api` 的挂载点默认匿名**：
 * 将来有人加一行 `app.use("/uploads", express.static(uploadsDir))`，它就是**静默裸奔**的
 * —— 而"文件服务不加守卫"恰好是本阶段反复出现的真漏洞形态（1b-11 的 `/oss` 就是这个形状）。
 * 现状经全量核对是合规的：`router.ts` 的挂载**全是 `/api/...`**（由 `/api` 那一条统一鉴权），
 * app.ts 里非 `/api` 的只有 `/oss`、`/assets`（有守卫）、`/skills`（有意公开）、
 * SPA 壳（有意公开）与几条无路径中间件。**"现在是对的"不等于"将来也是对的"** ——
 * 这条门禁把"现在"钉成一份**必须显式维护**的清单。
 *
 * ── 判据 ──
 *   ① **多一个就红**：`app.ts` 里出现、而清单里没有的挂载形态；
 *   ② **少一个就红**：清单里有、而源码里一处都找不到的形态；
 *   ③ 计数**逐个形态相等**（app.ts 的每一处 `app.use` 都必须被某个登记项吃到；
 *      `router.ts` 的 `/api/*` 是聚合形态，只要下界与"全部以 /api 开头"两条成立）；
 *   ④ `guarded` 的挂载点上必须**真的**能找到一个守卫标识（"登记成 guarded"不能只是一句话）；
 *   ⑤ 每条 `marker` 必须真在该文件里出现（防止登记项与代码脱钩）——**不断言行号**：
 *      行号会随无关改动漂移，那是噪声；"形态变了"才是信号，而形态由 path+count 表达。
 *
 * ── 观测不到 ⇒ exit 3（Ruling 243）──
 * "一条都没扫到"不等于"没有匿名挂载点"，那是"扫描没工作"。所以三段计数都有下界：
 * `/api` 挂载数、app.ts 的挂载点总数、以及"扫描真的解析了路径形态"。
 *
 * 用法：node tools/check-non-api-mounts.cjs
 */
const fs = require("fs");
const path = require("path");

const API_SRC = path.resolve(__dirname, "..", "apps", "api", "src");
const APP_FILES = ["app.ts", "router.ts"];
/** `/api` 路由表的下界（`router.ts` 由 scripts/generate-router.ts 生成，当前 183 条）。 */
const EXP_MIN_API_MOUNTS = 150;

/**
 * **显式登记表**（按 `file::path` 唯一）。
 *
 * `marker` 是复核用锚点：该文本必须真的出现在这个文件里（用来防止"登记项与代码脱钩"）；
 * 对 `<no path>` 的那些中间件，marker 是**唯一**能区分它们的办法。
 *
 * `exposure`：
 *   · `guarded` —— 挂载点上必须有守卫（`mediaAuthGuard` / `optionalMediaAuth` / `authenticate`）；
 *   · `public`  —— **有意公开**，且必须在 `INTENTIONALLY_PUBLIC` 里。
 */
const MANIFEST = [
  {
    file: "app.ts",
    path: "/api",
    marker: 'use("/api"',
    count: 1,
    exposure: "guarded",
    reason: "唯一的业务路由前缀；入口挂 `authenticate(…, \"/api\")`",
  },
  {
    file: "app.ts",
    path: "/oss",
    marker: '"/oss"',
    count: 1,
    exposure: "guarded",
    reason: "用户媒体；`optionalMediaAuth`（Bearer）+ `mediaAuthGuard`（短时签名），见 Task 7/10",
  },
  {
    file: "app.ts",
    path: "/assets",
    marker: '"/assets"',
    count: 1,
    exposure: "guarded",
    reason: "用户产物；与 `/oss` 同一守卫口径（Task 10 起同挂 `optionalMediaAuth`）",
  },
  {
    file: "app.ts",
    path: "/skills",
    marker: '"/skills"',
    count: 1,
    exposure: "public",
    reason: "产品自带的技能图标（随包发布、非用户数据）；spec §6.5 明确可公开，只放行图片扩展名",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "express.static(webDir",
    count: 1,
    exposure: "public",
    reason: "SPA 壳（挂根上、**在最后**）；锁掉它用户连登录页都打不开（spec §6.5 第 1 条）",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "helmet",
    count: 1,
    exposure: "public",
    reason: "安全头 `helmet(...)`；无路径。⚠ 必须在静态资源之前（否则 `/oss` 的图片响应不带 CORP 头，浏览器拒收）",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: '"dev"',
    count: 1,
    exposure: "public",
    reason: 'morgan 访问日志（`logger("dev")`）；无路径',
  },
  { file: "app.ts", path: "<no path>", marker: "express.json", zeroWidth: true, count: 1, exposure: "public", reason: "body 解析（100mb）；无路径" },
  { file: "app.ts", path: "<no path>", marker: "express.urlencoded", zeroWidth: true, count: 1, exposure: "public", reason: "body 解析；无路径" },
  { file: "app.ts", path: "<no path>", marker: "apiLimiter", count: 1, exposure: "public", reason: "限流（**在鉴权之前**：匿名也要被限流）；无路径" },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "NextFunction",
    count: 1,
    exposure: "public",
    reason: "API 404 处理器（`app.use((_, res, next: NextFunction) => …)`）；无路径，且**必须在所有挂载点之后**",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "corsOrigin",
    count: 1,
    exposure: "public",
    reason: "CORS（`cors({ origin: corsOrigin(), credentials: true })`）；无路径。⚠ 它必须在鉴权之前：预检 OPTIONS 不带凭据",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "helmet",
    count: 1,
    exposure: "public",
    reason: "安全头 `helmet(...)`；无路径。⚠ 必须在静态资源之前（否则 `/oss` 的图片响应不带 CORP 头，浏览器拒收）",
  },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "_mediaSig",
    count: 1,
    exposure: "public",
    reason: "日志脱敏中间件（脱敏 `exp`/`sig` 并把原始值另存 `req._mediaSig`）；无路径 = 不构成挂载点",
  },
  { file: "app.ts", path: "<no path>", marker: "tenantErrorHandler", count: 1, exposure: "public", reason: "租户错误处理器；无路径" },
  { file: "app.ts", path: "<no path>", marker: "authErrorHandler", count: 1, exposure: "public", reason: "鉴权错误处理器；无路径" },
  {
    file: "app.ts",
    path: "<no path>",
    marker: "errorHandler",
    count: 1,
    exposure: "public",
    reason: "兜底错误处理器（**必须是最后一个**）；无路径。⚠ marker 用**全词**匹配：裸 `errorHandler` 不许命中 `authErrorHandler`/`tenantErrorHandler`",
  },
  {
    file: "router.ts",
    path: "/api/*",
    marker: 'use("/api/',
    count: 176,
    exposure: "guarded",
    reason:
      "生成的路由挂载表（全部 `/api/...`，由 `app.use(\"/api\", …)` 统一鉴权）；由 scripts/generate-router.ts 产出。" +
      "⚠ Phase 1c Task 11：177 → **176**（旧登录路径 `/api/login/login` 整体退役：路由文件删除 + 白名单条目删除）。" +
      "改这个数字不是放宽判据：判据是\"清单与代码逐项相等\"，删挂载点就必须同步删数字。",
  },
];

/**
 * `public` 的挂载形态白名单。
 * ⚠ 只允许 **`<no path>`（无路径中间件/处理器）与 `/skills`**：
 *   任何**带路径**的新增公开挂载点都必须在这里显式加一行并写明理由 —— 那正是这条门禁要拦的动作。
 */
const INTENTIONALLY_PUBLIC = new Set(["<no path>", "/skills"]);

/** 被判为"守卫"的中间件标识。 */
const GUARD_MARKERS = ["mediaAuthGuard", "optionalMediaAuth", "authenticate"];

const EXPECTED_MANIFEST_LEN = 18;

function fail3(msg) {
  console.error("check-non-api-mounts 无法完成观测（exit 3，不是通过）：");
  console.error("  - " + msg);
  process.exit(3);
}

if (MANIFEST.length !== EXPECTED_MANIFEST_LEN) {
  fail3(`MANIFEST 期望 ${EXPECTED_MANIFEST_LEN} 条，实际 ${MANIFEST.length}（这份表自身也被断言：改它要连着改这里）`);
}

/**
 * 逐行找挂载点：`.use(` 后先出现字符串字面量路径，或先出现标识符/括号（处理器实参）。
 *
 * ⚠ 必须**跳过注释行**：实测踩到 —— `app.ts` 的注释里写着
 *   `router.ts 里所有路由都是 app.use("/api/...")`，裸正则会把**注释里那句话**当成一个挂载点
 *   （扫出 19 个"挂载点"，其中 3 个是注释），于是门禁对着注释做断言。
 *   判据：`//` 或行首 `*`（块注释续行）出现的位置**早于** `.use(` ⇒ 这行是注释，跳过。
 */
function scanFile(file) {
  const p = path.join(API_SRC, file);
  if (!fs.existsSync(p)) fail3(`找不到 ${p}`);
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const commentAt = (() => {
      const slashes = line.indexOf("//");
      const star = line.trimStart().startsWith("*") ? 0 : -1;
      const cands = [slashes, star].filter((x) => x >= 0);
      return cands.length ? Math.min(...cands) : -1;
    })();
    const useAt = line.indexOf(".use(");
    if (useAt < 0 || (commentAt >= 0 && commentAt < useAt)) continue;

    const inline = /\.use\(\s*(["'])([^"']*)\1/.exec(line);
    if (inline) {
      sites.push({ file, line: i + 1, idx: i, path: inline[2], text: callText(lines, i) });
      continue;
    }
    if (/\.use\(\s*$/.test(line)) {
      const lit = /^\s*(["'])([^"']*)\1/.exec(lines[i + 1] || "");
      sites.push({ file, line: i + 1, idx: i, path: lit ? lit[2] : "<no path>", text: callText(lines, i) });
      continue;
    }
    if (/\.use\(\s*[A-Za-z_(]/.test(line)) {
      sites.push({ file, line: i + 1, idx: i, path: "<no path>", text: callText(lines, i) });
    }
  }
  return { lines, sites };
}

/** 取挂载点那一行起、到本次调用右括号闭合为止的文本（用于判"有没有守卫"、以及 marker 归属）。 */
function callText(lines, idx) {
  let depth = 0;
  const out = [];
  for (let j = idx; j < Math.min(lines.length, idx + 40); j++) {
    out.push(lines[j]);
    for (const ch of lines[j]) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    // ⚠ 单行调用（`app.use(apiLimiter);`）在**第一行**就闭合 ⇒ 必须立刻停。
    //   写成 `depth <= 0 && j > idx` 会把后面**所有**挂载点都吃进这一段文本
    //   （实测踩到：12 个无路径挂载点全都"包含"彼此的 marker ⇒ 每条登记项都报"实际 12 处"）。
    if (depth <= 0) break;
  }
  return out.join("\n");
}

const scanned = {};
for (const f of APP_FILES) scanned[f] = scanFile(f);

// ---------- 自证观测（Ruling 243）：三段下界 ----------
const allSites = Object.values(scanned).flatMap((s) => s.sites);
const apiSites = allSites.filter((s) => s.path === "/api" || s.path.startsWith("/api/"));
if (apiSites.length < EXP_MIN_API_MOUNTS) {
  fail3(`只扫到 ${apiSites.length} 条 /api 挂载（下界 ${EXP_MIN_API_MOUNTS}）：扫描可能没工作`);
}
const appSites = scanned["app.ts"].sites;
if (appSites.length < 14) fail3(`app.ts 只扫到 ${appSites.length} 个 .use 挂载点（应有 ≥19 个）：扫描可能没工作`);
const appNoPath = appSites.filter((s) => s.path === "<no path>").length;
if (appNoPath < 10) fail3(`app.ts 只扫到 ${appNoPath} 个无路径 .use（应有 ≥13 个）：扫描可能没工作`);

/**
 * marker 的匹配：**全词**（前后不能是标识符字符），防 `errorHandler` 命中 `authErrorHandler`。
 * `zeroWidth: true`（= marker 是完整表达式、后面紧跟 `(`）⇒ **只要求左边界**：
 * 否则 `express.json(` 这种"以 `(` 结尾"的 marker 永远匹配不上（`(` 不是标识符字符，但整体后面
 * 也需要"非标识符字符"，而 `(` 之后是 `{` ⇒ 这个判据本身没坏，只是没必要）。
 */
function markerMatch(text, marker, zeroWidth) {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = "(^|[^A-Za-z0-9_$])";
  return zeroWidth ? new RegExp(`${left}${esc}`).test(text) : new RegExp(`${left}${esc}([^A-Za-z0-9_$]|$)`).test(text);
}

const failures = [];
/** 已经被某个登记项"吃到"的挂载点（用来做判据 ① 的补集）。 */
const claimed = new Set();

for (const m of MANIFEST) {
  const fileSites = scanned[m.file].sites;
  // ⚠ 分支判据刻意用 `path === "<no path>"`，**不用** `typeof count`：
  //   实测踩到 —— 给无路径项写 `count: 1` 时它会走"按路径取 `<no path>`"那条分支，
  //   于是把**全部 12 个**无路径挂载点算成同一个形态，每条登记项都报"实际 12 处"。
  //   语义：无路径形态用 **marker** 定位（marker 必须**恰好**命中一处）；带路径形态用 path + count。
  let sites;
  if (m.path === "<no path>") {
    sites = fileSites.filter((s) => s.path === "<no path>" && markerMatch(s.text, m.marker, m.zeroWidth));
  } else if (m.path === "/api/*") {
    sites = fileSites.filter((s) => s.path === "/api" || s.path.startsWith("/api/"));
  } else {
    sites = fileSites.filter((s) => s.path === m.path);
  }

  if (sites.length === 0) {
    failures.push(
      `MANIFEST 里的 \`${m.path}\`（${m.file}，marker=${JSON.stringify(m.marker)}）在源码里**一处都找不到**：` +
        `清单必须是"当前挂载面"的写照，删了挂载点就要删清单（否则它会慢慢退化成一份与代码无关的文档）。`,
    );
    continue;
  }
  const want = typeof m.count === "number" ? m.count : 1;
  if (sites.length !== want) {
    failures.push(
      `MANIFEST 登记 \`${m.path}\`（${m.file}，marker=${JSON.stringify(m.marker)}）应为 **${want}** 处，实际 **${sites.length}** 处` +
        `（位置≈${sites.map((s) => s.line).join(", ")}）—— 清单必须与代码逐项一致。`,
    );
  }
  if (m.path === "<no path>") {
    for (const s of sites) claimed.add(`${s.file}:${s.line}`);
  } else {
    for (const s of sites) claimed.add(`${s.file}:${s.line}`);
  }

  // ---- 判据 ④：exposure 与代码一致 ----
  if (m.exposure === "public") {
    if (!INTENTIONALLY_PUBLIC.has(m.path)) {
      failures.push(`\`${m.path}\` 登记成 public，但不在 INTENTIONALLY_PUBLIC 里：有意公开必须**逐条**给出理由`);
    }
  } else if (m.exposure !== "guarded") {
    failures.push(`MANIFEST 的 \`${m.path}\` exposure=\`${m.exposure}\` 不是 public/guarded 之一`);
  } else if (m.path === "/api/*") {
    // ⚠ 聚合形态**不做**"逐个挂载点必须有守卫"的断言：这些路由按设计**不带**守卫中间件，
    //   它们是被 `app.use("/api", …authenticate…)` 那条**统一**保护的（守卫在第 1 项 `/api` 上）。
    //   在这里逐个要求守卫 = 一条永远红且理由错误的断言。真正的判据是：
    //   ① 第 1 项 `/api` 必须找到 `authenticate`；② 本文件必须全是 `/api` 前缀（见判据 ⑥）。
  } else {
    for (const s of sites) {
      if (!GUARD_MARKERS.some((g) => s.text.includes(g))) {
        failures.push(
          `${s.file}:${s.line} 的 \`${m.path}\` 登记为 guarded，但该挂载点上**找不到**任何守卫` +
            `（找不到 ${GUARD_MARKERS.join(" / ")}）—— "登记成 guarded"不能只是一句话。`,
        );
      }
    }
  }
}

// ---------- 判据 ①：源码里出现、清单里没吃到的形态 ----------
for (const s of allSites) {
  if (claimed.has(`${s.file}:${s.line}`)) continue;
  failures.push(
    `${s.file}:${s.line} 出现了**未登记**的挂载点：路径=${s.path === "<no path>" ? "（无路径中间件）" : s.path}，` +
      `原文=${JSON.stringify((scanned[s.file].lines[s.line - 1] || "").trim().slice(0, 80))}。` +
      `\`app.use("/api", …)\` 是鉴权边界 ⇒ 非 \`/api\` 的挂载点**默认匿名**。` +
      `有意公开的请加进 tools/check-non-api-mounts.cjs 的 MANIFEST 与 INTENTIONALLY_PUBLIC；` +
      `是用户数据的请**先挂守卫再登记**（Ruling 202/247：静默的匿名挂载点就是 1b-11 那个漏洞的形态）。`,
  );
}

// ---------- 判据 ⑥：`router.ts` 必须全是 /api（聚合形态成立的前提）----------
const routerNonApi = scanned["router.ts"].sites.filter(
  (s) => s.path !== "<no path>" && s.path !== "/api" && !s.path.startsWith("/api/"),
);
if (routerNonApi.length) {
  failures.push(
    `router.ts 里出现了非 /api 的挂载：${routerNonApi.map((s) => `${s.line}:${s.path}`).join(", ")} —— ` +
      `生成器（scripts/generate-router.ts）应只产出 /api/... 前缀；这条是聚合形态 \`router.ts::/api/*\` 成立的前提。`,
  );
}

if (failures.length) {
  console.error("check-non-api-mounts 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

const nonApiApp = appSites.filter((s) => s.path !== "/api" && !s.path.startsWith("/api/"));
console.log(
  `check-non-api-mounts 通过：/api 挂载 ${apiSites.length} 条（其中 router.ts 全部 /api 前缀）；` +
    `app.ts 挂载点 ${appSites.length} 个，其中非 /api 带路径 ${nonApiApp.filter((s) => s.path !== "<no path>").length} 个` +
    `（${nonApiApp.filter((s) => s.path !== "<no path>").map((s) => s.path).join(" / ")}）；` +
    `无路径中间件 ${appNoPath} 个 —— 全部与显式 MANIFEST（${MANIFEST.length} 项）逐项一致` +
    `（有意公开：${[...INTENTIONALLY_PUBLIC].join(" / ")}）`,
);
