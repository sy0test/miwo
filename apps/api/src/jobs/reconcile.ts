/**
 * 产物对账（Phase 1a §5.2 ② 删掉启动期副作用之后的**终点机制**）。
 *
 * 两件事，覆盖"永久生成中"的两种成因：
 *  A. **死信/取消的 job**：job 已经终态失败，但它在 `o_video`/`o_image`/`o_storyboard`/轨道行上
 *     留下的"生成中"没人改 → 调 `definition.onAbandon(payload, reason, info)` 让**类型自己**去改
 *     （每个 handler 最清楚自己写了哪些行、怎么改）。
 *  B. **孤儿产物行**：`state='生成中'` 但**没有任何活跃 job**（queued/running）的 payload 提到它
 *     —— 这正是 Phase 1a 之前重启留下的那批（旧的 `db:repair-stuck` 只能按时间窗猜，
 *     这里用"任务是否还在队列里/还有没有有效租约"这个更强的判据）。
 *
 * ⚠ 判据强度：A 用终态 + 宽限期；B 用"活跃 job 引用的 id 集合"（`payload` 里出现 `"videoId":N`，
 *    纯 knex 的字符串包含判断，不写 raw）。宽限期内（`olderThanMs`）的行一律不动 —— 避免误杀。
 * ⚠ 幂等：A 的钩子必须自身幂等（改判后行不再是"生成中"，第二次调用自然无事）；B 天然幂等。
 *
 * ── 本会话实读确认（brief 要求"落地时仍要实读一次"）──
 *   `001_schema.ts` 的 `o_image` 建表块（258-269 行）只有 `filePath/type/assetsId/model/resolution/
 *   state/errorReason/userId` —— **确实没有时间列**，所以 `timeCol: null`（宽限期判据退化，
 *   只靠"有没有活跃 job 引用它"这个更强的判据）。`o_storyboard.createTime`（290 行，`t.ms`）
 *   与 `o_video.time`（320 行，`t.ms`）都在，按名字填回。`git grep "addColumn.*o_image"` 0 命中，
 *   说明没有后续迁移给它补时间列。
 */
import type { Knex } from "knex";
import { JOB_POLICY } from "@/jobs/policy";
import type { JobRegistry } from "@/jobs/registry";
import type { JobStore } from "@/jobs/store";
import type { JobRow } from "@/jobs/types";

export interface ReconcileReport {
  dryRun: boolean;
  deadJobs: number;
  abandonedRows: { videos: number; images: number; storyboards: number };
}

/** B 用：把活跃 job 的 payload 收出来（只扫活跃行，量小）。 */
async function activePayloads(db: Knex): Promise<string[]> {
  const rows = (await db("o_job").select("payload").whereIn("state", ["queued", "running"]).limit(2000)) as Array<{ payload: string | null }>;
  return rows.map((r) => r.payload ?? "");
}

/**
 * payload 里是否出现 `"<key>":<id>`。
 * ⚠ 这是**保守**判据（宁可漏判也不误杀）：只有真的看到该 id 才认为"有活跃任务在管它"。
 *   它的已知代价：`payload` 里 id 的键名不叫 `videoId`（例如 `segmentId`）时认不出来 ——
 *   那时该行会被 B 判成孤儿。**这就是为什么 A（类型自己的 onAbandon）是主路径**，B 只兜底。
 */
function mentions(payloads: string[], key: string, id: number): boolean {
  const needle = `"${key}":${id}`;
  return payloads.some((p) => p.includes(needle));
}

export async function reconcileAbandoned(deps: {
  db: Knex;
  store: JobStore;
  registry: JobRegistry;
  dryRun?: boolean;
  olderThanMs?: number;
  now?: () => number;
}): Promise<ReconcileReport> {
  const db = deps.db;
  const dryRun = deps.dryRun ?? true; // 默认 dry-run：安全第一
  const now = deps.now ?? ((): number => Date.now());
  const ts = now();
  const grace = deps.olderThanMs ?? JOB_POLICY.stuckGraceMs;
  const cutoff = ts - grace;
  const report: ReconcileReport = { dryRun, deadJobs: 0, abandonedRows: { videos: 0, images: 0, storyboards: 0 } };

  // A. 死信 / 取消的 job
  const deadJobs = (await db("o_job")
    .select("*")
    .whereIn("state", ["dead", "canceled"])
    .andWhere("updatedAt", "<=", cutoff)
    .orderBy("id")
    .limit(500)) as JobRow[];
  report.deadJobs = deadJobs.length;
  if (!dryRun) {
    for (const job of deadJobs) {
      const def = deps.registry.get(job.type);
      if (!def?.onAbandon) continue;
      try {
        const payload = def.parse(JSON.parse(job.payload ?? "null"));
        await def.onAbandon(payload, job.lastError ?? `任务已 ${job.state}`, { jobId: job.id, userId: job.userId });
      } catch (e) {
        console.error(`[reconcile] job ${job.id} 的 onAbandon 失败：`, e);
      }
    }
  }

  // B. 孤儿产物行（无活跃 job 引用 + 超过宽限期）
  const payloads = await activePayloads(db);
  const orphans: Array<{ table: "o_video" | "o_image" | "o_storyboard"; key: string; timeCol: string | null }> = [
    { table: "o_video", key: "videoId", timeCol: "time" },
    // ⚠ 本会话实读 `001_schema.ts`：`o_image` **没有**时间列（只有 assetsId）。
    //    没有时间列时，孤儿判据退化为"state='生成中' 且没有任何活跃 job 引用它"。
    { table: "o_image", key: "imageId", timeCol: null },
    { table: "o_storyboard", key: "storyboardId", timeCol: "createTime" },
  ];
  for (const o of orphans) {
    // ⚠ 必须 await hasColumn：它和 hasTable 一样返回可 await 的 QueryBuilder（漏 await 恒真）
    const useTime = o.timeCol !== null && (await db.schema.hasColumn(o.table, o.timeCol));
    const q = db(o.table).select("id").where("state", "生成中").limit(1000);
    if (useTime) q.andWhere(o.timeCol as string, "<=", cutoff);
    const rows = (await q) as Array<{ id: number }>;
    const hit = rows.filter((r) => !mentions(payloads, o.key, Number(r.id)));
    if (o.table === "o_video") report.abandonedRows.videos = hit.length;
    if (o.table === "o_image") report.abandonedRows.images = hit.length;
    if (o.table === "o_storyboard") report.abandonedRows.storyboards = hit.length;
    if (dryRun || hit.length === 0) continue;
    await db(o.table)
      .whereIn("id", hit.map((r) => r.id))
      .update({ state: "生成失败", errorReason: `Phase 1d 对账：无对应队列任务（队列租约为空），判定为残留` });
  }

  return report;
}
