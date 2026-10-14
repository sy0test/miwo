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

/** B 用：把**活跃** job 的 payload 收出来（只扫活跃行，量小）。 */
async function activePayloads(db: Knex, now: number): Promise<string[]> {
  // ⚠ 【修复轮 F3】活跃 = `queued`（还没有租约概念）**或** `running` 且**租约未过期**。
  //    旧实现只 `whereIn(state, ["queued","running"])` ⇒ 一条"持有者崩了、租约已过期、还没人回收"
  //    的 running 会**永久**保护它的产物行，产物永远钉在"生成中" —— 这正是本机制要消灭的形态，
  //    也与本文件/账本 1d-4 的口径（"任务是否还在队列里/**还有没有有效租约**"）自相矛盾。
  //    用 SQL 的 `orWhere` 组合，避免把活跃集全捞进内存再过滤。
  const rows = (await db("o_job")
    .select("payload")
    .where((w) => {
      w.where("state", "queued").orWhere((r) => r.where("state", "running").andWhere("leaseUntil", ">", now));
    })
    .limit(2000)) as Array<{ payload: string | null }>;
  return rows.map((r) => r.payload ?? "");
}

/**
 * payload 里是否**按 JSON 键值**提到了 `key: id`（标量或数组元素）。
 *
 * ⚠ 【修复轮 F4】旧实现是裸子串 `p.includes(`"${key}":${id}`)` ⇒ **前缀盲点**：
 *   `"videoId":1` 会被 `"videoId":12` 命中 ⇒ 真孤儿被误保护（reviewer 实测 11/12）。
 *   现在解析 JSON 后**按数值 + 类型**比较：字符串 `"1"` 不算，数组元素算，嵌套对象递归。
 * ⚠ 坏 JSON **不抛**（脏 payload 只应"不保护"，不该让整次对账崩）。
 * ⚠ 导出只为测试直接钉住边界（前缀/数组/嵌套/空格/字符串/坏 JSON）。
 */
export function mentionsId(payloads: string[], key: string, id: number): boolean {
  const target = Number(id);
  const hit = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") return false;
    if (Array.isArray(v)) return v.some(hit);
    const o = v as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      const value = o[key];
      if (typeof value === "number" && value === target) return true; // 类型敏感：`"1"` 不算
      if (Array.isArray(value) && value.some((x) => typeof x === "number" && x === target)) return true;
    }
    return Object.values(o).some(hit);
  };
  for (const p of payloads) {
    if (!p) continue;
    try {
      if (hit(JSON.parse(p))) return true;
    } catch {
      // 坏 payload：不保护（也不崩）
    }
  }
  return false;
}

/**
 * 每张产物表的"生成中"行如何改判。
 * ⚠ 【修复轮 F1】**原因列名逐表不同**：`o_video`/`o_image` 是 `errorReason`，
 *   而 `o_storyboard` **只有 `reason`**（`001_schema.ts:283`；`git grep addColumn.*o_storyboard`
 *   0 命中）。旧实现给三张表统一写 `errorReason` ⇒ 对 `o_storyboard` 抛
 *   `no such column: errorReason` ⇒ 整次对账 rejects，且 B 段无事务 ⇒ 前面已改判的 `o_video`
 *   保持已提交（**半应用状态**）。
 * ⚠ `key` 是**真实 payload 键**（对齐 `task-7-brief.md:40-45`）：`o_storyboard` 的活跃任务
 *    payload 是 `{…, storyboardIds: number[]}`（复数数组），不是标量 `storyboardId`。
 */
interface OrphanSpec {
  table: "o_video" | "o_image" | "o_storyboard";
  key: string;
  timeCol: string | null;
  /** 失败原因列（逐表不同，见上）。 */
  reasonCol: string;
}

const ORPHAN_SPECS: readonly OrphanSpec[] = [
  { table: "o_video", key: "videoId", timeCol: "time", reasonCol: "errorReason" },
  // ⚠ `o_image` **没有**时间列（`001_schema.ts:258-269` 只有 assetsId）⇒ `timeCol: null`。
  { table: "o_image", key: "imageId", timeCol: null, reasonCol: "errorReason" },
  // ⚠ `storyboardIds`（复数数组，Task 7 真实形状）；原因列是 `reason`。
  { table: "o_storyboard", key: "storyboardIds", timeCol: "createTime", reasonCol: "reason" },
];

const ORPHAN_REASON = "Phase 1d 对账：无对应队列任务（队列租约为空），判定为残留";

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
  // ⚠ 【修复轮 F1】整段**逐表 try/catch**（与 A 段同一纪律）：一张表的列名/约束不对时，
  //    只跳过那一张，绝不让整次对账 rejects，也不留"前一张已提交、后一张没动"的半应用状态。
  //    （逐表隔离而不是整段事务：事务在 sqlite/MySQL 上都会把"一张坏表"放大成"全部回滚"，
  //     而对账的目标是**尽量多地恢复**，不是全有全无。真正的"全成功或全不改"由 `dryRun` 提供。）
  const payloads = await activePayloads(db, ts);
  for (const o of ORPHAN_SPECS) {
    try {
      // ⚠ 必须 await hasColumn：它和 hasTable 一样返回可 await 的 QueryBuilder（漏 await 恒真）
      const useTime = o.timeCol !== null && (await db.schema.hasColumn(o.table, o.timeCol));
      const q = db(o.table).select("id").where("state", "生成中").limit(1000);
      if (useTime) q.andWhere(o.timeCol as string, "<=", cutoff);
      const rows = (await q) as Array<{ id: number }>;
      const hit = rows.filter((r) => !mentionsId(payloads, o.key, Number(r.id)));
      if (o.table === "o_video") report.abandonedRows.videos = hit.length;
      if (o.table === "o_image") report.abandonedRows.images = hit.length;
      if (o.table === "o_storyboard") report.abandonedRows.storyboards = hit.length;
      if (dryRun || hit.length === 0) continue;
      const patch: Record<string, unknown> = { state: "生成失败" };
      patch[o.reasonCol] = ORPHAN_REASON; // ⚠ 列名逐表不同（`o_storyboard` 是 `reason`）
      await db(o.table)
        .whereIn("id", hit.map((r) => r.id))
        .update(patch);
    } catch (e) {
      console.error(`[reconcile] 表 ${o.table} 的孤儿改判失败（跳过该表，不影响其余表）：`, e);
    }
  }

  return report;
}
