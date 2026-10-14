/**
 * 任务队列的类型契约（spec §9.2 / §9.3）。
 *
 * `JobRow` 与 `o_job` 的列**一一对应**（`src/db/migrations/007_job_queue.ts` 的 `jobTableSpec`）。
 * 本文件刻意**不 import knex**：store / worker / relay 都只依赖类型，测试里才能注入假时钟与假 DB。
 *
 * 状态机（6 个状态，两两成组）：
 *
 *     queued ──claim──▶ running ──succeed──▶ succeeded   （终态）
 *        ▲                 │
 *        │                 ├──fail（还有重试额度）──▶ queued（带 nextAttemptAt 退避）
 *        │                 └──fail（额度用尽）────▶ dead（终态；可 requeueDead 重投）
 *        └──reclaimExpired（租约到期）◀── running（持有者崩了）
 *
 *     queued / running ──cancel──▶ canceled（终态）
 *
 * 两条全局不变式（由 store 的 SQL 保证，本文件只声明语义）：
 *  · **终态 ⇒ `dedupeActive` 必须已置 NULL**（否则同键永远投不进新任务）；
 *  · **活跃态 ⇒ `dedupeActive` = `dedupeKey`**（非空才参与唯一约束，幂等锁因此是原子的）。
 */
export type JobState = "queued" | "running" | "succeeded" | "failed" | "dead" | "canceled";

/** 终态：不再被领取，且 `dedupeActive` 必须已置 NULL。 */
export const TERMINAL_STATES: readonly JobState[] = ["succeeded", "failed", "dead", "canceled"];
/** 活跃态：参与幂等去重（`dedupeActive` 非空）。 */
export const ACTIVE_STATES: readonly JobState[] = ["queued", "running"];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** `o_job` 的一行（列名与类型逐字对应迁移；时间列都是毫秒整数）。 */
export interface JobRow {
  id: number;
  /** 归属用户；平台/运维任务为 `null`（守卫不会给 platform 表注入它 —— 见 policies.ts 的登记理由）。 */
  userId: number | null;
  type: string;
  /** JSON 字符串（只存引用 id，不存 base64）。 */
  payload: string;
  state: JobState;
  /** 已领取次数（每次 claim +1；**不是**"已失败次数"）。 */
  attempts: number;
  maxAttempts: number;
  priority: number;
  /** 原始幂等键（审计用；终态后仍保留）。 */
  dedupeKey: string | null;
  /** 幂等锁：活跃期 = `dedupeKey`，终态 = NULL（可空唯一列）。 */
  dedupeActive: string | null;
  leaseUntil: number | null;
  heartbeatAt: number | null;
  workerId: string | null;
  /** 0..100。 */
  progress: number;
  /** 阶段文案（进度推送用）。 */
  stage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 退避：到点之前不会被再次领取。 */
  nextAttemptAt: number | null;
  lastError: string | null;
  result: string | null;
  /** 进度推送的游标（复合 `(updatedAt, id)`）。 */
  updatedAt: number;
}

/** handler 拿到的执行上下文（worker 组装；`signal` 在租约丢失/超时/进程退出时 abort）。 */
export interface JobContext {
  jobId: number;
  userId: number | null;
  type: string;
  /** 1 基：这是第几次尝试（领取时 `attempts` 已自增）。 */
  attempt: number;
  workerId: string;
  /** 租约丢失 / 超时 / 进程退出时会被 abort —— handler 必须尊重它。 */
  signal: AbortSignal;
  /** 写进度；返回 false 表示**租约已丢失**（handler 应当立刻停下）。 */
  progress(percent: number, stage?: string): Promise<boolean>;
  log(message: string): void;
}

export interface JobDefinition<P = unknown> {
  /** 注册表 key，也是 `o_job.type` 的值（稳定；改它等于换一种任务）。 */
  type: string;
  /** 单次尝试的墙钟上限；到点 worker 会 abort 并按失败处理。 */
  timeoutMs: number;
  /** 总尝试次数（含首次）。只有幂等安全的类型才允许 > 1。 */
  maxAttempts: number;
  /** `o_gate` 的池名（vendor 级限流；spec §9.3）。 */
  pool: string;
  /** 入队即校验（fail-fast；坏 payload 不许写进库）。 */
  parse(raw: unknown): P;
  /** 幂等键；返回 null 表示该类型不去重。 */
  dedupeKey(payload: P, userId: number | null): string | null;
  handle(ctx: JobContext, payload: P): Promise<unknown>;
  /**
   * 任务**永久失败**（dead/canceled）时的产物对账钩子（spec §5.2 ② 的替代机制）。
   * 由 `reconcile.ts` 在"死信 + 宽限期"之后调用；职责是把该任务写过的产物行从"生成中"
   * 改判为"生成失败"并写 errorReason。**必须幂等**（重复调用不改变结果）。
   *
   * ⚠ 可选：`reconcile.ts` 对没有该钩子的类型**跳过**（不改判任何产物行）—— 因为"哪些行是
   *   这次任务写的"只有类型自己知道，reconcile 不做猜测。
   * ⚠ 钩子里的 DB 访问走**它自己**的 `u.db`（受租户守卫）还是系统身份，由实现决定；
   *   reconcile 只负责把 `jobId`/`userId`/`reason` 如实传进来。
   */
  onAbandon?(payload: P, reason: string, info: { jobId: number; userId: number | null }): Promise<void>;
}

/**
 * 注册表要装"不同类型参数"的 definition，因此这里用 `any`。
 * ⚠ 这是**唯一**一处（本仓库没有 eslint 门禁，`noImplicitAny` 也不拦显式 any）；
 *   替代方案是把注册表写成 `JobDefinition<never>` 或泛型集合，两者都会把调用点的类型
 *   退化成 `unknown`，得不偿失。
 */
export type AnyJobDefinition = JobDefinition<any>;

export interface EnqueueInput {
  type: string;
  /** `null` = 平台任务（无租户 ctx）；业务任务必须给真实 userId。 */
  userId: number | null;
  payload: unknown;
  /** 越小越先；缺省 100。 */
  priority?: number;
  /** 覆盖类型自带的幂等键（极少用；用于"同一类型多把锁"的场景）。 */
  dedupeKey?: string;
}

export interface EnqueueResult {
  jobId: number;
  /** true = 命中了既有活跃任务（同 `dedupeKey`），没有新建。 */
  deduped: boolean;
}
