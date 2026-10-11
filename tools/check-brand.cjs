#!/usr/bin/env node
/**
 * 断言品牌改名完成，且供应商数据 id 保持一致：适配器文件名 `apps/api/data/vendor/<id>.ts`
 * ↔ 三个源码引用文件（`agentSetKey.ts` / `fixDB.ts` / `getVendorList.ts`）；
 * 另校验两个包名（`@miwo/api`、`@miwo/web`）。**脚本只读源码文件，不读数据库。**
 * （Task 6 迁移前为 `toonflow`、迁移后为 `miwo`，两种取值都接受）。
 * 用法：node tools/check-brand.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["apps/api/src", "apps/api/scripts", "apps/web/src"];
const SCAN_FILES = ["README.md", "apps/api/package.json", "apps/web/package.json", "apps/web/index.html"];
const TEXT_EXT = new Set([".ts", ".vue", ".js", ".cjs", ".mjs", ".json", ".html", ".yml", ".yaml", ".md"]);
const SKIP_DIR = /node_modules|[\\/]dist[\\/]|[\\/]build[\\/]|[\\/]data[\\/]/;

/**
 * 「旧仓库目录名」这条断言的**显式豁免白名单**（逐文件，不是逐目录）。
 *
 * 为什么需要这一条：`apps/api/scripts/verify-phase0.cjs` 必须引用旧仓库的**绝对路径**
 * （`…\code\toonflow-upstream` / `…\code\toonflow-web`）才能按 `tools/.phase0-old-baseline.json`
 * 的 8 条 sha256 证明那两个仓库零改动 —— 那是 Phase 0 的验收判据，不是品牌残留。
 *
 * ⚠ 规则必须**显式、可复核、带理由**。下面这些做法一律禁止（那是把门禁藏起来，不是满足它）：
 *    · 把目录名拆成两段字符串拼接，让字面量不以字面量出现 —— 等价于**静默豁免**，
 *      下一个人看不出这里有例外，而门禁的"红"本来是想提醒"这里有旧品牌名"；
 *    · 写成"跳过整个 apps/api/scripts 目录"这类**过宽**规则，或只静默 `continue`。
 * ⚠ 豁免**只作用于**下面第 2 条断言（旧包名/旧目录名）；`ToonFlow` 文案断言、
 *    `toonflow://` 协议计数**不受**豁免影响（第 1/3 条照旧全量扫）。
 * ⚠ 每条豁免都必须**真实命中**（见扫描后的断言）：文件不存在、或一处都没命中 → 报失败，
 *    避免留下"其实不需要豁免"的死条目。
 */
const LEGACY_NAME_EXEMPT = [
  {
    file: "apps/api/scripts/verify-phase0.cjs",
    reason:
      "Phase 0 验收脚本必须引用旧仓库目录名（toonflow-upstream / toonflow-web）才能证明它们未被改动：它按 tools/.phase0-old-baseline.json 的 8 条 sha256 逐条比对，被比的路径只能是真实目录名，无法改写或推导替代。",
  },
];

const failures = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter(fs.existsSync)];

const brandHits = [];
const pkgNameHits = [];
const protocolHits = [];
// 每条豁免实际命中的旧目录名处数（用于下面的"豁免必须真实命中"断言）。
const exemptByFile = new Map(LEGACY_NAME_EXEMPT.map((e) => [e.file, e]));
const exemptHits = new Map(LEGACY_NAME_EXEMPT.map((e) => [e.file, 0]));

for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  const relKey = rel.split(path.sep).join("/");
  const exempt = exemptByFile.has(relKey);
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes("ToonFlow")) brandHits.push(`${rel}:${i + 1}`);
    if (line.includes("toonflow-web") || line.includes("toonflow-upstream")) {
      // 只有白名单里的那个文件允许出现旧目录名；其余文件（含同目录的兄弟文件）照旧红。
      if (exempt) exemptHits.set(relKey, exemptHits.get(relKey) + 1);
      else pkgNameHits.push(`${rel}:${i + 1}`);
    }
    if (line.includes("toonflow://")) protocolHits.push(`${rel}:${i + 1}`);
  });
}

// 0) 豁免条目必须真实存在且真的命中 —— 防止"过宽/失效"的豁免长期潜伏。
const exemptSummary = [];
for (const e of LEGACY_NAME_EXEMPT) {
  const hits = exemptHits.get(e.file) || 0;
  exemptSummary.push(`${e.file}（命中 ${hits} 处）`);
  if (!fs.existsSync(path.join(ROOT, e.file))) {
    failures.push(`豁免条目指向的文件不存在: ${e.file}（豁免已失效，请删除该条目）`);
  } else if (hits === 0) {
    failures.push(`豁免条目 ${e.file} 一处旧目录名都没命中（豁免已失效，请删除该条目）`);
  }
}

// 1) 品牌文案必须清零
if (brandHits.length) failures.push(`仍有 ${brandHits.length} 处 ToonFlow：\n      ` + brandHits.slice(0, 10).join("\n      "));
// 2) 旧包名/目录名必须清零（`LEGACY_NAME_EXEMPT` 里逐文件显式豁免的除外）
if (pkgNameHits.length) failures.push(`仍有 ${pkgNameHits.length} 处 toonflow-web/toonflow-upstream：\n      ` + pkgNameHits.slice(0, 10).join("\n      "));
// 3) toonflow:// 协议本阶段不动 —— 记录数量但不判失败，只要求没被顺手改成别的协议
if (protocolHits.length === 0) failures.push(`toonflow:// 共 0 处：Phase 0 不应删除它（Phase 1e 处理），请确认没有被误改`);

// 4) 供应商数据 id 的完整性：Task 5（改名）之后、Task 6（数据 id 迁移）之前必须是 `toonflow`；
//    Task 6 之后必须是 `miwo`。两条都接受，但适配器文件名与上面三个源码引用文件必须一致，且不能既无也无。
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
    if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); continue; }
    if (!fs.readFileSync(p, "utf8").includes(id)) failures.push(`${rel} 里找不到供应商 id "${id}"（与 data/vendor/${id}.ts 不一致）`);
  }
}

// 5) 包名
for (const [rel, want] of [["apps/api/package.json", "@miwo/api"], ["apps/web/package.json", "@miwo/web"]]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); continue; }
  const name = JSON.parse(fs.readFileSync(p, "utf8")).name;
  if (name !== want) failures.push(`${rel} 的 name 期望 "${want}"，实际 "${name}"`);
}

if (failures.length) {
  console.error("check-brand 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `check-brand 通过（保留 toonflow:// ${protocolHits.length} 处，供应商 id 三方一致；显式豁免旧目录名：${exemptSummary.join("、") || "无"}）`,
);
