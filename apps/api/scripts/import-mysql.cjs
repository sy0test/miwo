#!/usr/bin/env node
/**
 * 把 `export-sqlite.cjs` 的产物导入目标库（**MySQL 或 sqlite 都支持** —— 后者用于本机自证）。
 *
 * 用法（都从 apps/api 下跑，或走 `pnpm.cmd run db:import`）：
 *   # MySQL 目标（部署路径）
 *   $env:MIWO_DB_DRIVER="mysql"; $env:MIWO_DB_HOST="127.0.0.1"; ...
 *   node scripts/import-mysql.cjs [--in=目录] [--table=o_xxx] [--apply] [--allow-oversize]
 *
 *   # sqlite 目标（本机一次性库自证；本机没有 MySQL 服务端时的替代口径）
 *   $env:MIWO_DATA_DIR="%TEMP%\miwo-target"; node scripts/import-mysql.cjs --apply
 *
 * **默认 dry-run**（只打印计划与校验结果）；`--apply` 才写。
 *
 * 前置（硬性，任一不满足即拒绝）：
 *   1. `manifest.json` 里 `duplicates` / `badIds` 必须为空（导出侧已阻断，这里再兜一道）
 *   2. 目标库的业务表必须**全空**（迁移刚建好）—— 四张平台种子表例外：`002_platform_seed`
 *      已经插过行，导入对它们"跳过已存在"（见 `src/db/legacy/import.ts` 文件头的交接条款）
 *   3. 目标库必须已有全部目标表（先跑 `db:migrate`）
 *   4. 目标列**表示不了的值**：目标方言是 **mysql** 时阻断（严格模式会 `Data too long` /
 *      `Out of range value`），sqlite 只登记；`--allow-oversize` 表示"已确认可丢这些行"
 *      → 改为**整行丢弃并逐条登记**（绝不截断、绝不夹断）
 *
 * 退出码：0 = 成功（含 dry-run）；1 = 自身/环境错误；2 = preflight 拒绝（阻断项）；
 *         3 = 写入完成但【Ruling 43】id 类型漂移（读回来不是 number）。
 *
 * ⚠ 为什么"写一个临时 runner 再 spawn tsx"，而不是在 .cjs 里重写连接参数：
 *   连接装配（charset / timezone / bigNumber / pool）**只有一处定义**（`src/db/connect.ts`），
 *   导入用的连接必须与 app 用的**逐字一致**——否则 `bigNumberStrings` 之类一漂移，
 *   搬进去的 id 类型就与运行期读出来的不一样。runner 写在 `.tmp-migrate/` 下（已 gitignore），
 *   每次运行重新生成，**不是**仓库产物。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const argOf = (p, d) => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : d;
};
const IN = path.resolve(API_ROOT, argOf("--in=", path.join(".tmp-migrate", "export")));
const ONLY = argOf("--table=", null);
const APPLY = args.includes("--apply");
const ALLOW_OVERSIZE = args.includes("--allow-oversize");
const RUNNER = path.join(API_ROOT, ".tmp-migrate", "import-runner.ts");

const MANIFEST = path.join(IN, "manifest.json");
if (!fs.existsSync(MANIFEST)) {
  console.error(`缺 ${MANIFEST}，先跑 scripts/export-sqlite.cjs`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
if ((manifest.duplicates || []).length || (manifest.badIds || []).length) {
  console.error("拒绝导入：manifest 里有阻断项（duplicates / badIds）—— 见 manifest.json");
  process.exit(2);
}
if (manifest.sourceSha256After && manifest.sourceSha256Before !== manifest.sourceSha256After) {
  console.error("拒绝导入：这份导出物的源库 sha256 前后不一致（导出不是只读的），产物不可信");
  process.exit(2);
}
if (manifest.sourceSha256After === null || manifest.sourceSha256After === undefined) {
  console.warn("⚠ manifest 里没有 sourceSha256After：这份导出物早于「只读自证」那条断言，建议重新导出");
}

// ⚠ `MIWO_GEN_DB_TYPES` **不是新增变量**（它在 `src/utils/db.ts` 里已存在，`gen-db-types.ts` 会置 1）。
//    这里显式置 0 只是防御：导入 runner 绝不该顺带触发"生成 DB 类型"的副作用。
process.env.MIWO_GEN_DB_TYPES = "0";

fs.mkdirSync(path.dirname(RUNNER), { recursive: true });
fs.writeFileSync(
  RUNNER,
  `import fs from "node:fs";
import path from "node:path";
import { createKnex, describeTarget, dialectOfConfig } from "@/db/connect";
import { importExport } from "@/db/legacy/import";

const IN = ${JSON.stringify(IN)};
const ONLY = ${JSON.stringify(ONLY)};
const APPLY = ${APPLY};
const ALLOW_OVERSIZE = ${ALLOW_OVERSIZE};

async function main() {
  console.log("[import] 目标：" + describeTarget());
  console.log("[import] 方言：" + dialectOfConfig());
  const dst = createKnex();
  try {
    const r = await importExport({
      dst,
      dir: IN,
      only: ONLY,
      apply: APPLY,
      allowOversize: ALLOW_OVERSIZE,
      log: (m) => console.log(m),
    });
    fs.writeFileSync(
      path.join(IN, "import-report.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), target: describeTarget(), dialect: dialectOfConfig(), ...r }, null, 2),
      "utf8",
    );
    console.log("[import] 报告已写 " + path.join(IN, "import-report.json"));
    if (r.blocking.length) { console.error("[import] 被 preflight 拒绝（" + r.blocking.length + " 条阻断项）"); process.exit(2); }
    if (!r.applied) { console.log("[import] DRY-RUN 完成（未写库）"); return; }
    if (r.idTypeDrift.length) { console.error("[import] id 类型漂移 " + r.idTypeDrift.length + " 处（Ruling 43 违规）"); process.exit(3); }
    console.log("[import] 完成");
  } finally {
    await dst.destroy();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
  "utf8",
);

console.log(`[import] 导出物：${IN}`);
console.log(`[import] 模式：${APPLY ? "APPLY（会写目标库）" : "DRY-RUN（不写）"}${ALLOW_OVERSIZE ? " [allow-oversize: 跳过超长行]" : ""}`);
const r = spawnSync(process.execPath, ["--import=tsx", RUNNER], { cwd: API_ROOT, stdio: "inherit", env: process.env });
process.exit(r.status === null ? 1 : r.status);
