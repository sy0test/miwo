/**
 * 队列运维 CLI（Phase 1d Task 10）。用法（**必须在 `cd apps/api` 下跑**：tsx 只装在 @miwo/api）：
 *
 *   pnpm.cmd run job:admin -- --stats
 *   pnpm.cmd run job:admin -- --list --state=dead --limit=20
 *   pnpm.cmd run job:admin -- --requeue=<jobId>
 *   pnpm.cmd run job:admin -- --reclaim                 # dry-run：只列出会回收的行
 *   pnpm.cmd run job:admin -- --reclaim --apply
 *   pnpm.cmd run job:admin -- --reconcile               # dry-run（默认）
 *   pnpm.cmd run job:admin -- --reconcile --apply
 *   pnpm.cmd run job:admin -- --enqueue-selftest --count=3 --users=2
 *   pnpm.cmd run job:admin -- --cancel=<jobId> --reason="运营取消"
 *
 * ⚠ **未知旗标一律拒绝**（Phase 1a Ruling 25）：一条会改库的命令"静默执行默认动作"是危险的 ——
 *   打错一个字就变成 `--stats` 之外的别的动作，甚至真的写库。所以先扫参数，不认识的直接 EXIT 2。
 * ⚠ 写操作一律**默认 dry-run**（`--apply` 才落库）：`--reclaim` / `--reconcile` 都遵守。
 * ⚠ 本 CLI 是**系统级**工具（跨租户）：读 o_job 一律显式 `{scope:{all:true}}`（C 组复核轮 F5/N3）。
 */
import { config } from "@/config";
import u from "@/utils";
import type { Knex } from "knex";
import { getJobStore } from "@/jobs";
import { jobRegistry } from "@/jobs/registry";
import { reconcileAbandoned } from "@/jobs/reconcile";

const KNOWN = [
  "--stats",
  "--list",
  "--requeue",
  "--reclaim",
  "--reconcile",
  "--enqueue-selftest",
  "--cancel",
  "--apply",
  "--dry-run",
] as const;

const args = process.argv.slice(2);
const withValue = (p: string): string | undefined => args.find((a) => a.startsWith(`${p}=`))?.slice(p.length + 1);
const has = (f: string): boolean => args.includes(f);

async function main(): Promise<void> {
  for (const a of args) {
    const bare = a.split("=")[0];
    if (!(KNOWN as readonly string[]).includes(bare)) {
      console.error(`[job-admin] 未知参数 "${a}"。可用：${KNOWN.join(" ")}`);
      console.error("[job-admin] 例子：pnpm.cmd run job:admin -- --stats");
      process.exit(2); // ⚠ 2 = "参数错"，与 1（运行失败）区分开，便于脚本断言
    }
  }

  console.log(`[job-admin] 目标：env=${config.env} driver=${config.db.driver} dataDir=${config.dataDir}`);
  const store = getJobStore();
  const db = u.db as unknown as Knex;

  if (has("--stats") || args.length === 0) {
    console.log("[job-admin] 状态统计：", JSON.stringify(await store.stats()));
    console.log("[job-admin] 在跑（全局/按用户）：", JSON.stringify(await store.activeCounts()));
    return;
  }

  if (has("--list")) {
    const rows = await store.list({
      state: withValue("--state") as never,
      limit: Number(withValue("--limit") ?? 20),
      scope: { all: true }, // 运维 CLI = 系统级读取（显式声明，1d-3/N3）
    });
    for (const r of rows) {
      console.log(
        `  #${r.id} ${r.type} state=${r.state} attempts=${r.attempts}/${r.maxAttempts} user=${r.userId} progress=${r.progress} err=${(r.lastError ?? "").slice(0, 120)}`,
      );
    }
    console.log(`[job-admin] 共 ${rows.length} 行`);
    return;
  }

  if (has("--requeue")) {
    const id = Number(withValue("--requeue"));
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`[job-admin] --requeue 需要一个正整数 jobId，收到 "${withValue("--requeue")}"`);
      process.exit(2);
    }
    const ok = await store.requeueDead(id);
    console.log(ok ? `[job-admin] #${id} 已重投` : `[job-admin] #${id} 不是 dead（或同键仍被占用），未重投`);
    return;
  }

  if (has("--cancel")) {
    const id = Number(withValue("--cancel"));
    if (!Number.isInteger(id) || id <= 0) {
      console.error(`[job-admin] --cancel 需要一个正整数 jobId，收到 "${withValue("--cancel")}"`);
      process.exit(2);
    }
    const ok = await store.cancel(id, withValue("--reason"));
    console.log(`[job-admin] 取消 #${id}：${ok ? "成功" : "不动（已终态或不存在）"}`);
    return;
  }

  if (has("--reclaim")) {
    const apply = has("--apply");
    const rows = (await db("o_job")
      .select("id", "state", "attempts", "maxAttempts", "leaseUntil")
      .where("state", "running")
      .andWhere("leaseUntil", "<", Date.now())) as Array<{ id: number; attempts: number; maxAttempts: number; leaseUntil: number }>;
    for (const r of rows) console.log(`  将回收 #${r.id}（attempts ${r.attempts}/${r.maxAttempts}，租约已过期）`);
    if (!apply) {
      console.log(`[job-admin] dry-run：${rows.length} 行；加 --apply 才写库`);
      return;
    }
    const r = await store.reclaimExpired();
    console.log(`[job-admin] 已回收：重排 ${r.requeued}，判死 ${r.dead}`);
    return;
  }

  if (has("--reconcile")) {
    const apply = has("--apply");
    const report = await reconcileAbandoned({
      db,
      store,
      registry: jobRegistry,
      dryRun: !apply,
      olderThanMs: Number(withValue("--older-than-ms") ?? 1_800_000),
    });
    console.log(`[job-admin] 对账：${JSON.stringify(report)}${apply ? "" : "（dry-run；加 --apply 才写库）"}`);
    return;
  }

  if (has("--enqueue-selftest")) {
    const count = Math.max(1, Number(withValue("--count") ?? 1));
    const users = Math.max(1, Number(withValue("--users") ?? 1));
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const { jobId } = await store.enqueue({
        type: "selftest.sleep",
        userId: (i % users) + 1,
        payload: { ms: 500, tag: `admin-${Date.now()}-${i}` },
      });
      ids.push(jobId);
    }
    console.log(`[job-admin] 已入队 ${ids.length} 条 selftest：${ids.join(",")}（用 --list 看进度）`);
    return;
  }

  console.error("[job-admin] 没有可执行的命令（用 --stats 试一下）");
  process.exit(2);
}

main().catch((e) => {
  console.error("[job-admin] 失败：", e);
  process.exit(1);
});
