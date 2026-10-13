/**
 * userId 回填 + `memories` 旧键改写 CLI（**默认 dry-run**）。
 *
 *   cd apps/api
 *   node --import=tsx scripts/backfill-userid.ts                                  # 只报告（不写库）
 *   node --import=tsx scripts/backfill-userid.ts --apply
 *   node --import=tsx scripts/backfill-userid.ts --apply --assign-to=1
 *   node --import=tsx scripts/backfill-userid.ts --apply --report=D:\tmp\backfill.json
 *
 * ⚠ 必须包 main()：本仓库是 CJS，tsx 下不能有顶层 await（Phase 1a 账本 Ruling 21）。
 *
 * ⚠⚠ **两条护栏**（都能防住"把真实 dev 库写坏"这一类事故）：
 *  ① `guard.requireRepoDevDbAllowed()`（Task 11 / Ruling 131）：目标解析成
 *     `apps/api/data/db2.sqlite` 且没有显式放行时**拒绝跑** —— 本脚本会**写数据**，
 *     不能像别的诊断脚本那样"连上再说"。放行只能显式给 `MIWO_DATA_DIR=<仓库外目录>`
 *     或显式 `--allow-repo-dev-db` / `MIWO_ALLOW_REPO_DEV_DB=1`（后者还要求先有可恢复点）。
 *  ② **未知旗标一律 exit 1**（Ruling 25 的同款纪律）：`--aply` 这种拼错如果 fall-through
 *     到 dry-run，操作者会以为"回填跑过了"而实际一行没写 —— 对一条会改数据的命令，
 *     "看着对但没生效"比报错糟得多。
 *
 * ⚠ 运维前置：**先备份**目标库到仓库外（见 `apps/api/README-db.md` 的"回填运维口径"）。
 */
import fs from "node:fs";
import { createKnex, describeTarget } from "@/db/connect";
import { assertBackfillConsistent, backfillUserIds, formatBackfillReport } from "@/db/legacy/backfill-userid";
// ⚠ 目标护栏：与 db:migrate 同一套判定（不要另写一份近似逻辑）
import guard from "./db-target-guard.cjs";

const KNOWN_FLAGS = ["--apply", "--allow-repo-dev-db"];
const KNOWN_PREFIXES = ["--assign-to=", "--report="];

const USAGE = [
  "用法（从 apps/api 下跑）：",
  "  node --import=tsx scripts/backfill-userid.ts [--apply] [--assign-to=<正整数>] [--report=<文件>]",
  "  不带 --apply  = DRY-RUN（只报告，不写库）",
  "  --assign-to= 把**孤儿**（推不出归属的行）归给指定 userId；不写就保持 NULL（谁都看不见）",
  "  --report=    把**完整 JSON**（BackfillReport；孤儿/多义名单不截断）写到文件",
  "  --allow-repo-dev-db  显式确认\"目标就是仓库内真实 dev 库\"（不建议；请优先用 MIWO_DATA_DIR 指到别处）",
].join("\n");

/** 未知旗标/非法取值一律 exit 1（Ruling 25：会改数据的命令不许"看着对但没生效"）。 */
function validateArgs(args: string[]): void {
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a) && !KNOWN_PREFIXES.some((p) => a.startsWith(p)));
  if (unknown.length) {
    console.error(`[backfill-userid] 拒绝执行 —— 未知旗标：${unknown.join(", ")}`);
    console.error("  ⚠ 本脚本会**写数据**；拼错的旗标静默降级成 dry-run 会让人以为回填跑过了（实际一行没写）。");
    console.error(USAGE);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (prefix: string): string | undefined => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  validateArgs(args);
  const apply = args.includes("--apply");
  const assignRaw = valueOf("--assign-to=");
  const assignTo = assignRaw === undefined ? undefined : Number(assignRaw);
  if (assignTo !== undefined && (!Number.isInteger(assignTo) || assignTo <= 0)) {
    console.error(`[backfill-userid] --assign-to 必须是正整数，实际 "${assignRaw}"`);
    process.exit(2);
  }
  // ⚠ 顺序刻意如此：**先把连接建出来之前**判定目标（createKnex 在 sqlite 分支就会打开/建文件）
  guard.requireRepoDevDbAllowed({ argv: args, what: "backfill-userid" });
  if (args.includes("--allow-repo-dev-db")) console.log("[backfill-userid] 已显式放行：--allow-repo-dev-db（目标可能是仓库内真实 dev 库）");
  const db = createKnex();
  try {
    console.log(`[backfill-userid] 目标库：${describeTarget()}；模式：${apply ? "APPLY（会写库）" : "DRY-RUN（不写库）"}`);
    if (apply) console.log("[backfill-userid] ⚠ 写库前请确认已备份目标库到仓库外（README-db.md「回填运维口径」）");
    const report = await backfillUserIds(db, { apply, assignTo });
    const text = formatBackfillReport(report);
    console.log(text);
    // 自检断言：dry-run 只报不抛；--apply 时"该填没填"或"键首段违规"会在这里响亮失败（非 0 退出）
    assertBackfillConsistent(report);
    const out = valueOf("--report=");
    if (out) {
      // ⚠ **写完整 JSON**（不是控制台那份文本）：控制台为了可读只点前 5 条孤儿/多义，
      //   而预裁定 1 要求"孤儿留 NULL + **报告**，归属由操作者显式决定" —— 名单被截断的话，
      //   操作者得自己写 SQL 才能枚举（审查 P3-1）。JSON 是 `BackfillReport` 全量、孤儿数组不截断。
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
      console.log(`[backfill-userid] 完整 JSON 报告已写入 ${out}（孤儿/多义名单不截断；控制台那份只点前 5 条）`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[backfill-userid] 失败：", err);
  process.exit(1);
});
