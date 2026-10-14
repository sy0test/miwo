#!/usr/bin/env node
/**
 * 门禁：`apps/api/src` 下不得出现"绕过 `config.ts` 直读环境变量"。Phase 1c Task 10（`pnpm run verify:config`）。
 *
 * ── 为什么必须新开一条门禁（而不是信任 check-deploy-config.cjs）──
 * `tools/check-deploy-config.cjs` 的 `inCode` 是**只从 `config.ts` 里 match 出来的**（该脚本 :98），
 * 所以"config.ts 读了什么"它管得住，而"**别的文件**绕过 config.ts 直读 env"它完全看不见：
 * 实测（Task 10 改动**之前**）`utils/oss.ts:82` 的 `process.env.ossURL`、`utils/ffmpeg.ts:15/16/19`、
 * `routes/redraw/analyzeSource.ts:33`、`proxy.ts:98-99` 全都在界外 —— 而 README 曾声称
 * "配置唯一入口是 config.ts"。这条门禁就是那句话的机器化。
 *
 * ── 断言 ──
 *   1. 递归扫 `apps/api/src/**\/*.ts`（排除 `.d.ts`），找 `process.env.<NAME>`；
 *   2. `config.ts` 本身：允许任何 `MIWO_` 前缀（**它就是那个"唯一入口"，读 env 是它的职责**）；
 *   3. 其它文件：`MIWO_` 前缀**不自动放行** —— 唯一的正当读法是 `import { config }`。
 *      ⚠ 这一条比 brief 的初稿**更严**，理由是实测：初稿的"前缀即契约"让
 *      `src/db/migrations/003_vendor_asset_sync.ts:37` 的 `process.env.MIWO_DATA_DIR` 直接过关 ——
 *      那是**货真价实的绕过**（同一个变量的真相有两个读取点），只是它恰好带了 `MIWO_` 前缀。
 *      "前缀即契约"本意是"config 的字段都叫 MIWO_*"，不是"任何叫 MIWO_* 的读法都合法"。
 *   4. 允许：出现在显式豁免表 `ALLOWED` 里的（每条必须带非空 reason，空 reason 判红）；
 *   5. 允许：出现在**赋值左侧**的（`process.env.NODE_ENV = …` 是写不是读 —— `config.ts` 就是这么同步
 *      `NODE_ENV` 给 Express/knex 的）；
 *   6. 违规逐条打印 `文件:行  变量名`，退出码 1。
 *
 * ── 观测不到 ⇒ exit 3（Ruling 243）──
 * "一个 `process.env` 都没扫到"不等于"没有直读"（更可能是扫描坏了）；扫到的文件数也有下界。
 *
 * 用法：node tools/check-config-single-source.cjs
 *      node tools/check-config-single-source.cjs --root=<目录>   # 扫别的根（用例做判别力自证用；
 *                                                              #   缺省 = 仓库根，行为完全不变）
 *      node tools/check-config-single-source.cjs --min-files=N  # 覆盖文件数下界（同上，只给用例用）
 */
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : null;
};
/**
 * `--root` 指向"仓库根"（其下有 `apps/api/src`）。
 * ⚠ 它与 `--min-files` 一起存在，是为了让**单测能在临时目录里跑这条门禁的两端**
 *   （见 `apps/api/tests/config-single-source.test.ts`）。没有这两个参数时行为**逐字不变**。
 */
const ROOT = argOf("root") ? path.resolve(argOf("root")) : REPO_ROOT;
const API_SRC = path.join(ROOT, "apps", "api", "src");
/** `config.ts` 在扫到的相对路径里的形态（用 `/` 分隔）。 */
const CONFIG_REL = "apps/api/src/config.ts";

const MIN_FILES_SCANNED = argOf("min-files") ? Number(argOf("min-files")) : 120;
/** 观测到的 `process.env` 读取总数下界（"一个都没扫到"不等于"没有直读"）。 */
const MIN_ENV_READS_OBSERVED = 1;

/**
 * **显式豁免表**：名字 → 不改名的理由（**必须非空**）。
 *
 * 前四条是 undici 的 `EnvHttpProxyAgent` 的标准变量名 —— `proxy.ts:99` 读它们、
 * `:120-121` 写它们、`:122` 用它装配 dispatcher。改成 `MIWO_*` 等于让代理配置**彻底失效**，
 * 所以它们是"有意不改名"，而不是"忘了收口"。
 *
 * 第五条（`MIWO_DATA_DIR`）是**迁移脚本的特例**：`003_vendor_asset_sync.ts` 的 `up()`/`down()`
 * 由 knex 迁移器在 `config` 之外调用（迁移文件必须能被"只读迁移器"独立加载，不能依赖应用级单例），
 * 而它要的只是"数据根在哪"。⚠ 这是一条**登记在案的例外**，不是"因为带了 MIWO_ 前缀所以放行"。
 *
 * 第六条（`MIWO_GEN_DB_TYPES`）是**门控变量**，不是配置：`utils/db.ts:41` 用它决定"要不要把
 * `genDbTypesReady` 这个 db 就绪信号暴露给 `scripts/gen-db-types.ts`"。它**不该进 config**
 * （它不是可调配置，而是"这次是哪个脚本在跑"的开关；`config.env === "dev"` 那一半已经在 config 里了），
 * 也**不该进 `.env.example`**（`verify:deploy` 的规则 1 会把它当"必须真实赋值的配置"）。
 */
const ALLOWED = {
  HTTPS_PROXY: "undici 的 EnvHttpProxyAgent 只认标准代理变量名（proxy.ts 读 :99 / 写 :120-121 / 装配 :122）；改名即失效",
  https_proxy: "同上（小写形式是 POSIX 习惯，undici 两个都认）",
  HTTP_PROXY: "同上",
  http_proxy: "同上",
  MIWO_DATA_DIR:
    "迁移文件 src/db/migrations/003_vendor_asset_sync.ts:37 由 knex 迁移器独立加载（不能依赖应用级 config 单例）；它只读「数据根在哪」",
  MIWO_GEN_DB_TYPES:
    "门控变量（不是可调配置）：utils/db.ts:41 决定是否暴露 genDbTypesReady 给 scripts/gen-db-types.ts；进 config 或 .env.example 都会改变它的语义（后者还会让 verify:deploy 规则 1 报错）",
};

function fail3(msg) {
  console.error("check-config-single-source 无法完成观测（exit 3，不是通过）：");
  console.error("  - " + msg);
  process.exit(3);
}

/** 递归收集 `src` 下的 `.ts`（**排除** `.d.ts`；必须显式递归 —— 目录搜索不是默认行为）。 */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

if (!fs.existsSync(API_SRC)) fail3(`找不到 ${API_SRC}`);
const files = collect(API_SRC);
if (files.length < MIN_FILES_SCANNED) {
  fail3(`只扫到 ${files.length} 个 .ts（下界 ${MIN_FILES_SCANNED}）：扫描很可能没工作`);
}

/** 把块注释/行注释剥掉（**保留行号**）：注释里提到 `process.env.X` 不是"直读"。 */
function stripComments(line) {
  // 只处理行内 // 与整行 * 续行；本仓库里没有"代码里嵌 /* */"的形状用到 process.env
  const s = line.trimStart().startsWith("*") ? "" : line;
  const i = s.indexOf("//");
  return i >= 0 ? s.slice(0, i) : s;
}

const violations = [];
const allowedHits = [];
const prefixHits = [];
let envReadsObserved = 0;
let configTsObserved = false;

// ⚠ 赋值左侧：`process.env.FOO = …`（写）不算"直读"。
//   判据：`= ` 出现在 `process.env.FOO` **之后**、且中间没有比较运算符（`==`/`===`/`!=`/`>=`/`<=`）。
function isAssignment(line, matchEnd) {
  const rest = line.slice(matchEnd);
  return /^\s*=(?!=)/.test(rest);
}

for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const isConfigTs = rel === CONFIG_REL;
  if (isConfigTs) configTsObserved = true;
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    const re = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      envReadsObserved++;
      if (isAssignment(line, m.index + m[0].length)) continue; // 写，不是读
      // 唯一入口自己有资格读任何 MIWO_*；**其它文件没有**（见文件头第 3 条的收紧理由）。
      if (isConfigTs && name.startsWith("MIWO_")) {
        prefixHits.push(`${rel}:${i + 1}  ${name}`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ALLOWED, name)) {
        if (!String(ALLOWED[name] || "").trim()) {
          violations.push(`${rel}:${i + 1}  ${name} —— 豁免表里这一条**没有 reason**：空 reason 的豁免等于无理由放行`);
        } else {
          allowedHits.push(`${rel}:${i + 1}  ${name}`);
        }
        continue;
      }
      violations.push(`${rel}:${i + 1}  ${name}`);
    }
  });
}

if (!configTsObserved) fail3(`扫描没覆盖 ${CONFIG_REL}：这条门禁的前提就是它`);
if (envReadsObserved < MIN_ENV_READS_OBSERVED) {
  fail3(`一个 process.env 读取都没观测到（下界 ${MIN_ENV_READS_OBSERVED}）：扫描可能没工作`);
}

if (violations.length) {
  console.error("check-config-single-source 失败：apps/api/src 下存在绕过 config.ts 的环境变量直读：");
  for (const v of violations) console.error("  - " + v);
  console.error("");
  console.error("  修法：把读取搬进 `apps/api/src/config.ts`（新增一个 `MIWO_` 字段），消费点改成读 `config.*`。");
  console.error("  若名字**刻意不能改**（例如第三方库只认标准变量名），请加进本脚本的 ALLOWED 并写明理由。");
  console.error("  ⚠ 不要靠「加一行豁免」过关：豁免表每一条都要有理由，且它是这份契约的**全部**例外面。");
  process.exit(1);
}

console.log(
  `check-config-single-source 通过：扫描 ${files.length} 个 .ts / 观测到 ${envReadsObserved} 处 process.env 读取`
    + `（config.ts 内部读 ${prefixHits.length} 处、显式豁免 ${allowedHits.length} 处、赋值左侧（写）${envReadsObserved - prefixHits.length - allowedHits.length} 处）；`
    + `豁免名单：${Object.keys(ALLOWED).join(" / ")}；违规 0`,
);
