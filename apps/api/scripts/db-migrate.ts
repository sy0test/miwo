/**
 * 迁移的显式命令行入口（spec §5.2 的"迁移纪律"）。
 *
 * 用法（都从 apps/api 下跑，走 `pnpm.cmd run db:migrate*`）：
 *   --status          列出每条迁移的状态（done/pending）
 *   --down [n]        回滚最近 n 个批次（默认 1）
 *   --down --all      回滚全部
 *   --redo            回滚全部再重新跑到最新（**会重建所有表，破坏数据**，只在本机用）
 * 不带参数 = 跑到最新（与启动路径做的事相同，用于"先迁移再起服务"的部署流程）；
 * `--up` 与"不带参数"同义（显式写出来只是让调用点的意图可读）。
 *
 * ⚠ 这个脚本会连真实数据库（dev 默认 sqlite；`MIWO_DB_DRIVER=mysql` 时连 MySQL）。
 *    跑 --down/--redo 前先备份（Task 6 的导出脚本，或直接拷 db2.sqlite 到 .db-backups）。
 *    想拿一次性库试跑：把 `MIWO_DATA_DIR` 指到一个临时目录即可（env 优先于 .env 文件）。
 */
import { createKnex, describeTarget } from "@/db/connect";
import { migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
