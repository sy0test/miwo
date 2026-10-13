#!/usr/bin/env node
/**
 * 门禁：品牌收口（Phase 0 / Task 5「改名」+ Task 6「供应商数据 id 迁移」）。
 *
 * ── 这一版修掉的两个**结构性**缺陷（Task 12 终审 (a)/(b)）──
 *
 *  1. **规则是大小写敏感的 `ToonFlow`** ⇒ `Toonflow`（小写 f）整类逃逸。
 *     实测证据：`apps/web/index.html` 的 `<title>Toonflow</title>`、7 个 i18n 语言文件里
 *     的 `welcomeMsg`/`devtoolsDesc`/`openDevtoolFailed`、`vendorConfig.vue` 的告警文案
 *     —— 全部因为小写 f 而从未被判红。现在品牌匹配是**大小写不敏感**的单一 token。
 *
 *  2. **扫描范围是手工目录白名单**（旧的 `SCAN_DIRS`/`SCAN_FILES`）⇒ 新建的 `deploy/`、
 *     `tools/`、根 `README.md` 之外的任何目录都在范围外。实测证据：`deploy/README.md` 的
 *     两处 `ToonFlow` 从未被看到。现在扫描范围是**全仓 git 跟踪文件**（`git ls-files`），
 *     只跳过二进制与 `node_modules`/产物（它们本来就不在索引里）。
 *
 * ── 豁免机制（为什么这样设计）──
 *
 * 全仓 + 大小写不敏感之后，**合法的第三方/上游/机器标识**会一起被判红。它们必须被
 * **显式豁免**，而不是靠"把品牌写成小写"这种绕开规则的做法（根 README.md 原来就是这么写的，
 * 本轮已还原成正常大小写 + 逐条豁免）。
 *
 * 每条豁免 = { scope, match, min, reason }：
 *   · scope  —— 一个仓内相对路径，或一个 glob（`*`，只跨一级；`"*"` 表示全仓）。
 *   · match  —— 字面量字符串，或 { re, flags } 正则（自动补 `g`）。
 *   · min    —— **至少**要覆盖多少个品牌 token。达不到 = 豁免失效 = 红。
 *   · reason —— 人话理由。**空理由直接判红**（不允许"沉默的豁免"）。
 *
 * 三条结构性护栏（防止豁免被写成"万能白名单"）：
 *   A. 单条豁免的一次匹配跨度不得超过 `MAX_EXEMPT_SPAN` 字符 ⇒ 能吞掉整行/整文件的
 *      正则（例如 `.*` 加 dotAll，或 `[\s\S]+`）会被直接拒收。
 *   B. 每条豁免必须**真实命中**（覆盖 token 数 >= min，且 scope 至少命中一个文件），
 *      否则报红要求删除该死条目。
 *   C. 正则豁免不得匹配空串（否则 `lastIndex` 会原地打转、覆盖范围失控）。
 *
 * ⚠ 豁免只覆盖**它匹配到的那一段文本**（span containment），不是整个文件、也不是整行。
 *   要放宽到整个文件，你必须写出一个能匹配整文件的豁免 —— 那会被护栏 A 拒收。
 *
 * ── 保留的三条规则 ──
 *   1. 品牌 token（大小写不敏感）必须 0 处未被豁免；命中旧包名/旧目录名（toonflow-web /
 *      toonflow-upstream）时单独归类，给出更精确的报错。
 *   2. `toonflow://`（Electron 自定义协议）本阶段**不动**（Phase 1e 处理），
 *      但必须仍然存在 —— 共 0 处说明被误删了。
 *   3. 供应商数据 id 三方一致（`apps/api/data/vendor/<id>.ts` ↔ 三个源码引用文件），
 *      以及两个包名（`@miwo/api`、`@miwo/web`）。
 *
 * 用法：node tools/check-brand.cjs
 * 退出码 0 = 通过，1 = 失败（逐条打印失败原因）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// ───────────────────────────── 规则 ─────────────────────────────

/** 品牌 token。**大小写不敏感** —— 这是本版最重要的一行（旧版是 line.includes("ToonFlow")）。 */
const BRAND_RE = /toonflow/gi;
/** 旧包名 / 旧目录名。是 BRAND_RE 的子集，单列只为给出更精确的报错文案。 */
const LEGACY_RE = /toonflow-(?:web|upstream)/gi;
/** Electron 自定义协议（Phase 1e 才处理）。本阶段只要求"仍然存在"。 */
const PROTOCOL_RE = /toonflow:\/\//gi;

/** 护栏 A：单次豁免匹配的最大跨度。 */
const MAX_EXEMPT_SPAN = 400;

// ───────────────────────────── 豁免清单 ─────────────────────────────
// 判定口径（Task 12 必做 2 第 1 步）：**命名「用户正在运行的这个产品」的才是本项目品牌，要改；
// 指第三方服务 / 上游项目 / 机器标识 / 许可证正文的一律豁免，且必须写明理由。**
const EXEMPTIONS = [
  // ── 上游 / 旧系统引用（不是本项目品牌） ──
  {
    scope: "README.md",
    match: "ToonFlow",
    min: 2,
    reason:
      "「本仓库由上游项目 ToonFlow 复制改造而来」——指被复制改造的来源项目，是合法上游项目名，不是本项目品牌。原文曾被写成小写 `Toonflow` 以绕开旧的大小写敏感规则，本轮已还原成正常大小写并在此显式豁免。⚠ min 由 1 提到 **2**（必做修复轮·裁定 B）：README 的「Phase 0 验收的执行边界」新增了一段说明 `verify:phase1a:ci` 与本机口径的差异，其中引用了用户机真实库路径 `%APPDATA%\\ToonFlow\\data\\db2.sqlite`（机器上的绝对路径，改不了）。",
  },
  {
    scope: "README.md",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 2,
    reason:
      "「Phase 0 验收的执行边界」一节必须写出两个旧仓库的**真实目录名**（`code/toonflow-upstream` / `code/toonflow-web`）才能说清 `verify:legacy-freeze --check` 为什么在 CI 上必然失败（无 remote 的 runner 上没有这两个仓）。这是旧仓库的真实目录名、不是本项目品牌。",
  },
  {
    scope: "README.md",
    match: "TOONFLOW_PROXY",
    min: 1,
    reason:
      "README 的「非 MIWO_ 环境变量」表里要如实列出 `TOONFLOW_PROXY` 这个名字（含「重命名已排 Phase 1c」的说明）。**不是**品牌文案：它是本机环境变量名，改名要等 Phase 1c 连同 apps/api/src/proxy.ts 一起做。",
  },
  {
    scope: "deploy/README.md",
    match: "ToonFlow",
    min: 2,
    reason:
      "「旧 ToonFlow 走 Windows `启动ToonFlow服务器.bat`（18080 端口）」——指与容器部署共存的**旧系统**，且 `启动ToonFlow服务器.bat` 是桌面上真实存在的文件名（改大小写就找不到、双击不了），故按原样保留并显式豁免。",
  },
  {
    scope: "apps/api/scripts/verify-phase0.cjs",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 2,
    reason:
      "Phase 0 验收脚本必须引用旧仓库目录名（toonflow-upstream / toonflow-web）才能按 tools/.phase0-old-baseline.json 的 8 条 sha256 证明它们未被改动：被比的路径只能是真实目录名，无法改写或推导替代。",
  },
  {
    scope: "tools/record-old-baseline.cjs",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 8,
    reason:
      "旧仓库 sha256 基线的记录工具；8 条基线的键就是旧仓库里 8 个文件的**绝对路径**，路径里必然含真实目录名。",
  },
  {
    scope: "apps/api/scripts/verify-phase1a.cjs",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 2,
    reason:
      "【裁定 B】本验收脚本的 `--ci` 分流必须写出两个旧仓库的**真实目录名**（`code/toonflow-{upstream,web}`）才能说清 `verify:legacy-freeze --check` 为什么在 CI 上必然失败（无 remote 的 runner 上没有这两个仓，而「缺仓库**不算通过**」是 `record-legacy-freeze.cjs` 自己的口径）。与 `apps/api/scripts/verify-phase0.cjs` 那条豁免同因：被校验的路径只能是真实目录名。",
  },
  {
    scope: "apps/api/scripts/export-sqlite.cjs",
    match: "ToonFlow",
    min: 3,
    reason:
      "搬迁脚本必须**硬拒绝**用户机正在使用的真实库 `%APPDATA%\\ToonFlow\\data\\db2.sqlite`（连只读打开都不做），所以要按真实目录名写出这条路径：注释里的说明、`path.join(process.env.APPDATA, \"ToonFlow\", \"data\")` 的安全闸门、以及拒绝时的报错文案，共 3 处。这是**机器上的绝对路径**（用户机数据目录名，由已部署的旧系统决定，本仓库改不了），不是本项目品牌文案。⚠ 不要为了绕开本门禁把目录名拆成两段字符串拼接 —— 那等于静默豁免，下一个人看不出这里有例外（同 `verify-phase0.cjs` 那条豁免的口径）。",
  },
  {
    scope: "tools/record-legacy-freeze.cjs",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 1,
    reason:
      "旧仓库冻结清单的生成/校验工具；旧仓库的默认位置就是这两个目录名（可用 --upstream/--web 覆盖）。该工具**只读**旧仓库。",
  },
  {
    scope: "tools/legacy-freeze.json",
    match: { re: "toonflow-(?:web|upstream)" },
    min: 1,
    reason: "冻结清单里记录的旧仓库相对路径（键用相对路径，随仓库入库以便复核）。",
  },
  {
    scope: "apps/api/src/agents/productionAgent/index.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 2,
    reason:
      "注释里引述**上游项目**的阶段 1 流水线（「与 toonflow 的…」「toonflow 阶段1 的技能自身红线」）——是上游实现对照说明，不是本项目 UI 文案；且该文件属 apps/api 业务源码，本轮硬约束不动业务逻辑。",
  },

  // ── 许可证正文（法律文本，不得改写） ──
  {
    scope: "apps/api/LICENSE",
    match: { re: "toonflow", flags: "gi" },
    min: 7,
    reason: "上游许可证正文（AGPL-3.0 + 附加条款，含中英对照）。**法律文本不得改写**，改了等于伪造许可条款。",
  },
  {
    scope: "apps/web/LICENSE",
    match: { re: "toonflow", flags: "gi" },
    min: 7,
    reason: "同上：上游许可证正文（与 apps/api/LICENSE 同一份）。法律文本不得改写。",
  },

  // ── 供应商适配模板资产（上游原样继承的第三方集成资产） ──
  {
    scope: "apps/api/data/vendor/*.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 37,
    reason:
      "13 个第三方 AI 供应商适配模板（atlascloud/deepseek/grsai/klingai/metoken/minimax/miwo/newapi/null/openai/vidu/volcengine/volcengineSd2）。其中的 Toonflow 有两个来源，都合法：(1) 模板署名与文件头「Toonflow AI供应商模板」指上游项目；(2) miwo.ts 指向**真实第三方中转服务**（baseUrl https://api.toonflow.net/v1，Task 12 明令不得改，改了功能就坏）；vidu.ts 的 devtools 提示、volcengineSd2.ts 的 author 是小写形态，同属此类。改动需同步 data/vendor/*.ts ↔ apps/api/src/lib/vendor.json ↔ apps/web/src/lib/vendorTemplate.ts ↔ 库内已落库的模板，属 Phase 1c 品牌/数据迁移范畴。",
  },
  {
    scope: "apps/api/src/lib/vendor.json",
    match: { re: "toonflow", flags: "gi" },
    min: 38,
    reason:
      "上面 13 个适配器模板的**入库快照**（vendor2json 的产物，逐字包含模板源码），与 data/vendor/*.ts 必须保持一致；单独改一边会让模板源与快照分叉。",
  },
  {
    scope: "apps/web/src/lib/vendorTemplate.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 3,
    reason: "前端内置的供应商适配模板（与 data/vendor/null.ts 同源），同上。",
  },

  // ── 机器标识（改了会破坏接口/构建/许可证扫描） ──
  {
    scope: "apps/api/src/routes/setting/about/checkUpdate.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 2,
    reason:
      "(1) `source: z.enum([\"toonflow\", ...])` 是**接口入参枚举值**，前端 about 页按同名枚举发起请求，改名即破坏接口契约；(2) `toonflow.oss-cn-beijing.aliyuncs.com` 是上游更新源的**真实 OSS 域名**（第三方服务地址）。",
  },
  {
    scope: "apps/web/src/components/setting/components/about.vue",
    match: { re: "toonflow", flags: "gi" },
    min: 16,
    reason:
      "(1) 上游仓库 URL `https://github.com|gitee.com/HBAI-Ltd/Toonflow-app` ×5（第三方/上游地址，页面里的**产品名已经是 MirrorWorld**，这 5 处从来不是品牌残留）；(2) `toonflow://` 协议（Phase 1e）；(3) 代码标识符与机器枚举值：`toonflowLogo` 变量、`UpdateSource = ... | \"toonflow\"`、`updateSource` 取值、sourceMap 键、`iconClass: \"toonflow\"`。均非用户可见品牌文案。",
  },
  {
    scope: "apps/web/src/pages/workbench/index.vue",
    match: "HBAI-Ltd/Toonflow-app",
    min: 2,
    reason: "上游仓库 URL ×2（第三方/上游地址）。",
  },
  {
    scope: "apps/web/src/pages/workbench/index.vue",
    match: "source: \"toonflow\"",
    min: 1,
    reason: "同上：检查更新接口的 `source` 枚举值（机器标识）。",
  },
  {
    scope: "apps/web/src/components/hello.vue",
    match: "HBAI-Ltd/Toonflow-app",
    min: 2,
    reason: "上游仓库 URL ×2（第三方/上游地址）。",
  },
  {
    scope: "apps/api/src/proxy.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 3,
    reason:
      "`TOONFLOW_PROXY` 环境变量名（含注释里的同名提及）。它的重命名已排 **Phase 1c**（Task 12 必做 7 记载）；本轮改它会让现网代理配置失效。",
  },
  {
    scope: "apps/api/src/routes/setting/dbConfig/exportData.ts",
    match: "toonflow-backup-",
    min: 1,
    reason:
      "导出的备份文件名前缀（`toonflow-backup-<ts>.json`）。属 apps/api/src 业务源码，本轮硬约束不动；且必须与前端 dbConfig.vue 的同名前缀保持一致，属 Phase 1c 品牌收口。",
  },
  {
    scope: "apps/web/src/components/setting/components/dbConfig.vue",
    match: "toonflow-backup-",
    min: 1,
    reason: "前端下载用的同一备份文件名前缀，必须与后端 exportData.ts 一致（见上一条）。",
  },
  {
    scope: "apps/api/src/routes/assets/getMaterialData.ts",
    match: { re: "Toonflow\u7247\u5c3e" },
    min: 1,
    reason:
      "API 响应里硬编码的片尾素材显示名 `Toonflow片尾`。属 apps/api/src 业务源码，本轮硬约束**明令不动业务逻辑**（仅必做 5 的 1 行），故留作 Phase 1c 品牌收口项。",
  },
  {
    scope: "apps/api/scripts/license.ts",
    match: "toonflow-serve",
    min: 1,
    reason: "许可证扫描的包名排除项（`excludeNames`，机器标识，指旧服务器包名）。",
  },
  {
    scope: "apps/web/scripts/license.ts",
    match: "toonflow-serve",
    min: 1,
    reason: "同上（前后端各一份 license 扫描脚本）。",
  },
  {
    scope: "apps/api/scripts/migrate-vendor-id.cjs",
    match: { re: "toonflow", flags: "gi" },
    min: 2,
    reason:
      "供应商数据 id 迁移工具本身必须包含**旧 id**（`const OLD_ID = \"toonflow\"`）才能把 `data/vendor/toonflow.ts` 迁成 `miwo.ts`；删掉它迁移就失效。",
  },
  {
    scope: "apps/api/src/db/legacy/vendor-merge.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 4,
    reason:
      "供应商 id **合并**迁移模块（Phase 0 deferred 项的修法）与上面的脚本同因：`mergeVendorId` 的 `oldId` 缺省值就是旧 id `toonflow`，注释里还要引述旧脚本那条会撞主键的 `UPDATE ... WHERE id='toonflow'` 才能说清为什么要合并。改掉这些字面量，迁移本身就无法执行。",
  },
  {
    scope: "apps/api/tests/vendor-merge.test.ts",
    match: { re: "toonflow", flags: "gi" },
    min: 8,
    reason:
      "合并语义的回归用例必须**真的**插入/查询旧 id 行：A 改名、C 合并（删旧行 + enable 取 max）、dry-run 不写、幂等、o_agentDeploy 一起改 —— 这五条判别力全部依赖 `toonflow` 这个字面量；换掉或参数化它就测不到「目标行已存在」的真实场景。",
  },

  // ── i18n：官方中转平台（第三方服务）与第三方产品名 ──
  {
    scope: "apps/web/src/locales/language/*.json",
    match: { re: "\"(?:fillKeyHeader|keyValid|toonflowNotFound)\"\\s*:\\s*\"[^\"]*\"" },
    min: 23,
    reason:
      "这三条 i18n 文案（填入官方 KEY / KEY 有效 / 官方中转站不存在）说的是**Toonflow 官方中转平台**——即 data/vendor/miwo.ts 指向的真实第三方中转服务（https://api.toonflow.net/v1）。Task 12 明令该服务的名字不得改。其中 `toonflowNotFound` 本身还是前端取值用的**键名**（改了文案就取不到）。",
  },
  {
    scope: "apps/web/src/locales/language/*.json",
    match: "Toonflow-Hub",
    min: 4,
    reason: "`Toonflow-Hub` 是第三方中转站产品名（Task 12 必做 2 明列为合法第三方名，不得改）。",
  },
  {
    scope: "*",
    match: { re: "toonflow:\\/\\/", flags: "gi" },
    min: 22,
    reason:
      "Electron 自定义协议 `toonflow://`（标题栏/打开浏览器/开发者工具等；收口当日实测 22 处 / 10 个文件）。**Phase 0 刻意不动**（Phase 1e 处理）；本规则另有「协议仍须存在」的独立断言，见文件末尾。要改这些处数（例如 Phase 1e 开始清理）必须同时改这条 min，不能悄悄漂移。",
  },

  // ── 门禁/工具脚本自身 ──
  {
    scope: "tools/check-brand.cjs",
    match: { re: "toonflow", flags: "gi" },
    min: 1,
    reason:
      "**本门禁自己**：规则定义、豁免清单与三条报错文案都必须写出被检测的品牌 token 与旧目录名。门禁无法自检（写出它才能检测它），故这条豁免只要求「真实命中」（min=1），不做精确计数。",
  },
  {
    scope: "tools/rename-brand.cjs",
    match: { re: "toonflow", flags: "gi" },
    min: 13,
    reason:
      "Task 5 的一次性改名工具（已执行完毕，留作可复核的改动凭据）：它的规则/保护串里必须含旧品牌与旧目录名，否则无法复现当初的改名。",
  },
];

// ───────────────────────────── 文件收集 ─────────────────────────────

/** 全仓扫描：git **跟踪 + 未跟踪但未被忽略** 的文件。
 *  为什么含 `--others`：只扫索引的话，"新写了一个带品牌残留的文件、还没 git add"在本地看不见
 *  （实测踩过：新工具/新清单要 commit 之后 check-brand 才认识它们，形成"先有鸡还是先有蛋"）。
 *  `--exclude-standard` 把 node_modules / dist / data 等 .gitignore 规则排除在外，产物不会进来。 */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/** 二进制（前 8 KB 含 NUL 字节）不算文本，跳过并计数以便在输出里交代。 */
function readText(rel) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp("^" + esc + "$");
}

function toRegex(match) {
  if (typeof match === "string") {
    return new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  }
  const flags = match.flags && match.flags.includes("g") ? match.flags : (match.flags || "") + "g";
  return new RegExp(match.re, flags);
}

function collectMatches(text, re) {
  const out = [];
  const r = new RegExp(re.source, re.flags);
  let m;
  while ((m = r.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) r.lastIndex += 1;
  }
  return out;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

// ───────────────────────────── 扫描 ─────────────────────────────

const failures = [];
const files = trackedFiles();
// scope 语义（严格三选一）："*" = 全仓；含 `*` = glob（只跨一级）；其余 = **精确路径**。
// ⚠ 精确路径**绝不能**退化成"对所有文件生效" —— 那会让一条文件的豁免去顶别人的 token，
//   责任人错位（实测踩过：README.md 的 ToonFlow 豁免把 deploy/README.md 的 2 处也"吃掉"，
//   于是 deploy 那条豁免反而报"0 处未命中"）。这里用 matches(rel) 显式表达。
const scopes = EXEMPTIONS.map((e) => {
  if (e.scope === "*") return { e, matches: () => true };
  if (e.scope.includes("*")) {
    const re = globToRe(e.scope);
    return { e, matches: (rel) => re.test(rel) };
  }
  return { e, matches: (rel) => rel === e.scope };
});

// 预检：正则豁免不得匹配空串（护栏 C）。
for (const e of EXEMPTIONS) {
  if (!e.reason || !e.reason.trim()) failures.push(`豁免缺少理由（reason 为空）: ${e.scope} / ${JSON.stringify(e.match)}`);
  if (!(Number.isInteger(e.min) && e.min >= 1)) failures.push(`豁免缺少有效 min（必须 >=1）: ${e.scope} / ${JSON.stringify(e.match)}`);
  const re = toRegex(e.match);
  if (re.test("")) failures.push(`豁免正则不得匹配空串（护栏 C）: ${e.scope} / ${JSON.stringify(e.match)}`);
}

// ent[i] 与 scopes[i] 一一对应（同一个 EXEMPTIONS 下标）。
const ent = EXEMPTIONS.map((e, i) => ({ ...e, i, regex: toRegex(e.match), hits: 0, filesHit: new Set(), scopeFiles: 0 }));

const uncoveredBrand = [];
const uncoveredLegacy = [];
let protocolTotal = 0;
const exemptInventory = new Map(); // rel -> Set(exemption index)
let textFiles = 0;
let skippedBinary = 0;

for (const rel of files) {
  const text = readText(rel);
  if (text === null) {
    skippedBinary += 1;
    continue;
  }
  textFiles += 1;

  protocolTotal += collectMatches(text, PROTOCOL_RE).length;

  const brandTokens = collectMatches(text, BRAND_RE);
  if (!brandTokens.length) continue;

  // 本文件生效的豁免
  const active = [];
  for (let i = 0; i < ent.length; i += 1) {
    const s = scopes[i];
    const applies = scopes[i].matches(rel);
    if (!applies) continue;
    ent[i].scopeFiles += 1;
    active.push(ent[i]);
  }

  const spans = [];
  for (const e of active) {
    const ms = collectMatches(text, e.regex);
    for (const m of ms) {
      if (m.end - m.start > MAX_EXEMPT_SPAN) {
        failures.push(
          `豁免跨度过大（护栏 A，上限 ${MAX_EXEMPT_SPAN} 字符，实际 ${m.end - m.start}）: ${e.scope} / ${JSON.stringify(e.match)} 命中于 ${rel}:${lineOf(text, m.start)}`,
        );
      }
      spans.push({ ...m, entry: e });
    }
  }

  // ⚠ 归属规则：一个 token 归属于**所有**覆盖它的豁免（不是"第一个匹配到的"）。
  //   否则 min 会依赖豁免在清单里的先后顺序 —— 顺序一变就报"豁免失效"，那是假红。
  //   代价是一个 token 可能被两条豁免同时计入；每条豁免的 min 说的是"我自己覆盖了多少处"。
  const stillBad = [];
  for (const t of brandTokens) {
    const covering = spans.filter((s) => s.start <= t.start && t.end <= s.end);
    if (!covering.length) {
      stillBad.push(t);
      continue;
    }
    for (const c of covering) {
      c.entry.hits += 1;
      c.entry.filesHit.add(rel);
      const set = exemptInventory.get(rel) || new Set();
      set.add(c.entry.i);
      exemptInventory.set(rel, set);
    }
  }

  if (stillBad.length) {
    for (const t of stillBad) {
      const line = lineOf(text, t.start);
      const snippet = text.slice(t.start, t.start + 24).split(/\r?\n/)[0];
      const legacy = new RegExp(LEGACY_RE.source, "i").test(snippet);
      (legacy ? uncoveredLegacy : uncoveredBrand).push(`${rel}:${line}  …${snippet}…`);
    }
  }
}

// ── 护栏 B：豁免必须真实命中（scope 至少命中一个文件；覆盖 token 数 >= min） ──
for (const e of ent) {
  if (e.scopeFiles === 0) {
    failures.push(`豁免失效：scope "${e.scope}" 没有匹配到任何 git 跟踪文件 —— 请删除该死条目`);
  }
  if (e.hits < e.min) {
    failures.push(
      `豁免失效/过窄：scope "${e.scope}" / ${JSON.stringify(e.match)} 实际覆盖 ${e.hits} 处，低于 min=${e.min} —— 代码已变，请核对并更新或删除该条目`,
    );
  }
}

// ── 规则 1：品牌 token 必须清零 ──
if (uncoveredBrand.length) {
  failures.push(
    `仍有 ${uncoveredBrand.length} 处未豁免的品牌 token（大小写不敏感匹配 toonflow）：\n      ` + uncoveredBrand.slice(0, 15).join("\n      "),
  );
}
// ── 规则 1b：旧包名/旧目录名单独报（更精确的定位） ──
if (uncoveredLegacy.length) {
  failures.push(
    `仍有 ${uncoveredLegacy.length} 处未豁免的旧包名/旧目录名（toonflow-web / toonflow-upstream）：\n      ` + uncoveredLegacy.slice(0, 15).join("\n      "),
  );
}
// ── 规则 2：toonflow:// 协议本阶段不动，但不得被误删 ──
if (protocolTotal === 0) failures.push(`toonflow:// 共 0 处：Phase 0 不应删除它（Phase 1e 处理），请确认没有被误改`);

// ── 规则 3：供应商数据 id 的三方一致性 ──
// Task 5（改名）之后、Task 6（数据 id 迁移）之前必须是 `toonflow`；Task 6 之后必须是 `miwo`。
// 两条都接受，但适配器文件名与上面三个源码引用文件必须一致，且不能既无也无。
const ID_CANDIDATES = ["toonflow", "miwo"];
const idRefFiles = [
  "apps/api/src/routes/setting/agentDeploy/agentSetKey.ts",
  "apps/api/src/lib/fixDB.ts",
  "apps/api/src/routes/setting/vendorConfig/getVendorList.ts",
];
const foundIds = new Set();
for (const id of ID_CANDIDATES) {
  if (fs.existsSync(path.join(ROOT, `apps/api/data/vendor/${id}.ts`))) foundIds.add(id);
}
if (foundIds.size !== 1) {
  failures.push(`供应商适配器文件名必须恰好是 ${ID_CANDIDATES.join(" 或 ")} 之一，实际找到: ${[...foundIds].join(", ") || "无"}`);
} else {
  const id = [...foundIds][0];
  for (const rel of idRefFiles) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      failures.push(`缺文件: ${rel}`);
      continue;
    }
    if (!fs.readFileSync(p, "utf8").includes(id)) failures.push(`${rel} 里找不到供应商 id "${id}"（与 data/vendor/${id}.ts 不一致）`);
  }
}

// ── 规则 4：包名 ──
for (const [rel, want] of [
  ["apps/api/package.json", "@miwo/api"],
  ["apps/web/package.json", "@miwo/web"],
]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    failures.push(`缺文件: ${rel}`);
    continue;
  }
  const name = JSON.parse(fs.readFileSync(p, "utf8")).name;
  if (name !== want) failures.push(`${rel} 的 name 期望 "${want}"，实际 "${name}"`);
}

if (failures.length) {
  console.error("check-brand 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

// ── 通过：把"扫了什么、豁免了什么"全部打印出来（CI 日志里可复核，不搞沉默的豁免） ──
const exemptFiles = [...exemptInventory.keys()].sort();
console.log(
  `check-brand 通过（全仓扫描 ${files.length} 个 git 跟踪文件，其中文本 ${textFiles}、跳过二进制 ${skippedBinary}；` +
    `品牌 token 全部被 ${ent.length} 条显式豁免覆盖；保留 toonflow:// ${protocolTotal} 处；供应商 id 三方一致）`,
);
for (const e of ent) {
  console.log(`  · 豁免[${e.scope}] ${JSON.stringify(e.match)} → 覆盖 ${e.hits} 处/${e.filesHit.size} 个文件（min ${e.min}）`);
}
console.log(`  · 命中豁免的文件共 ${exemptFiles.length} 个：`);
for (const f of exemptFiles) console.log(`      ${f}  ← ${[...exemptInventory.get(f)].map((i) => ent[i].scope).join(" , ")}`);
