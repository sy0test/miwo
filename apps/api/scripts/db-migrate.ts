/**
 * 迁移的显式命令行入口（spec §5.2 的"迁移纪律"）。
 *
 * 用法（都从 apps/api 下跑，走 `pnpm.cmd run db:migrate*`）：
 *   --status          列出每条迁移的状态（done/pending）
 *   --down [n]        回滚最近 n 个批次（默认 1）
 *   --down --all      回滚全部
 *   --redo            回滚全部再重新跑到最新（**会重建所有表，破坏数据**，只在本机用）
 *   --allow-repo-dev-db  显式确认"目标就是仓库内真实 dev 库 apps/api/data/db2.sqlite"（见下）
 * 不带参数 = 跑到最新（与启动路径做的事相同，用于"先迁移再起服务"的部署流程）；
 * `--up` 与"不带参数"同义（显式写出来只是让调用点的意图可读）。
 *
 * ⚠ **这个脚本会连真实数据库**（dev 默认 sqlite；`MIWO_DB_DRIVER=mysql` 时连 MySQL）。
 *    跑 --down/--redo 前先备份（Task 6 的导出脚本，或直接拷 db2.sqlite 到 .db-backups）。
 *    想拿一次性库试跑：把 `MIWO_DATA_DIR` 指到一个临时目录即可（env 优先于 .env 文件）。
 *
 * ⚠⚠ **Task 11 / 控制器裁定 A（★Ruling 131）**：本脚本**任何**模式（含看起来只读的
 *    `--status`）都**拒绝**在"解析出的目标正好是 `apps/api/data/db2.sqlite` 且没有显式放行"时
 *    连库 —— 因为它与"忘了设环境变量"在命令行上长得一模一样，而 Task 10 就因此把那份真实 dev 库
 *    写坏过一次。两条放行途径：显式给 `MIWO_DATA_DIR=<目录>`（指向别处），或显式加
 *    `--allow-repo-dev-db`（/ `MIWO_ALLOW_REPO_DEV_DB=1`）。实现见 `scripts/db-target-guard.cjs`。
 *    ⚠ `--status` 为什么也不能免：knex 的 `migrate.status()` 会**建出** `knex_migrations_lock`，
 *      对老库跑一次就把那份库改了（Task 11 实测，详见 `main()` 里的注释）。
 */
import { createKnex, describeTarget } from "@/db/connect";
import { migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";
// ⚠ 数据库**目标护栏**（Task 11 / 控制器裁定 A：禁止 up/down/rollback 默认打到真实 dev 库）。
//    放在这里而不是 `src/` 里：`tools/check-tenant-exceptions.cjs` 把 `apps/api/src/**` 的
//    `.ts` 文件数钉成逐项快照，往那里加文件要重跑 `--record` 并占一条"租户隔离例外"名额 ——
//    而本护栏是命令行纪律，与租户隔离无关。类型来自同目录的 `db-target-guard.d.cts`。
import guard from "./db-target-guard.cjs";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // ⚠ 顺序刻意如此：**先在把连接建出来之前**判定目标，再 `createKnex()`。
  //    `createKnex()` 本身在 sqlite 分支上就会把库文件建出来/打开（可写），
  //    "连上再检查"等于已经把目标打开了 —— 那正是要避免的形态。
  //    已知的放行开关见 guard.OPT_IN_FLAGS。
  //
  // ⚠⚠ `--status` **也要过这条护栏**（Task 11 实测，别把它改成"只读就不拦"）：
  //    knex 的 `migrate.status()` 在 `knex_migrations_lock` 不存在时**会把它建出来**
  //    （`migrate/_migrate.js` 的 `_getLock` → `_ensureTable`）。实测：对老库（29 张表、
  //    没有 knex_migrations）跑一次 `--status`，文件 sha256 从 44716850… 变成 8C3C2F38…，
  //    多出 `knex_migrations` / `knex_migrations_lock` 两张表 —— 也就是这个"只读"命令
  //    把真实 dev 库改了。所以本脚本**没有**任何一条路径可以在未放行时碰那份文件。
  guard.requireRepoDevDbAllowed({ argv: args, what: "db:migrate" });
  if (args.includes("--allow-repo-dev-db")) console.log("[migrate] 已显式放行：--allow-repo-dev-db（目标可能是仓库内真实 dev 库）");
  const db = createKnex();
  console.log(`[migrate] 目标：${describeTarget()}`);
  try {
    if (args.includes("--status")) {
      const rows = await migrationStatus(db);
      for (const r of rows) console.log(`  ${r.state === "done" ? "[已执行]" : "[待执行]"} ${r.name}${r.batch ? ` (batch ${r.batch})` : ""}`);
      console.log(`[migrate] 共 ${rows.length} 条，待执行 ${rows.filter((r) => r.state === "pending").length} 条`);
      return;
    }
    if (args.includes("--down")) {
      const all = args.includes("--all");
      const nIdx = args.indexOf("--down") + 1;
      const n = all ? 1 : Number(args[nIdx] && !args[nIdx].startsWith("--") ? args[nIdx] : 1);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--down 的次数必须是 >=1 的整数，实际 "${args[nIdx]}"`);
      if (all) {
        const [batch, names] = await rollbackMigrations(db, true);
        console.log(`[migrate] 已回滚全部（batch ${batch}）：${names.join(", ") || "（无）"}`);
      } else {
        for (let i = 0; i < n; i += 1) {
          const [batch, names] = await rollbackMigrations(db);
          console.log(`[migrate] 已回滚批 ${batch}：${names.join(", ") || "（无）"}`);
          if (!names.length) break;
        }
      }
      return;
    }
    if (args.includes("--redo")) {
      const [b, n1] = await rollbackMigrations(db, true);
      console.log(`[migrate] redo：先回滚全部（batch ${b}）：${n1.join(", ") || "（无）"}`);
    }
    const [batch, names] = await runMigrations(db);
    console.log(`[migrate] 完成（batch ${batch}）：${names.length ? names.join(", ") : "无新迁移"}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[migrate] 失败：", err);
  process.exit(1);
});
