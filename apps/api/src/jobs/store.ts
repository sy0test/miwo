/**
 * 任务队列的存储层（spec §9.2）—— 本组（Phase 1d Task 3）的核心。
 *
 * ── 四条不变式（每条都有对应用例）──
 *  I1 **领取是原子的**：候选查询之后，每条候选都要过一次**条件 UPDATE**
 *     （`where id=? and state='queued' and (leaseUntil is null or leaseUntil < now)`），
 *     `affected === 1` 才算领到。**正确性不依赖行锁**，所以 sqlite（无 SKIP LOCKED）与
 *     MySQL 跑同一套语义；mysql 分支额外用 `for update skip locked` 减少争抢（效率，**非正确性**）。
 *  I2 **幂等是原子的**：`dedupeActive` 是可空唯一列。enqueue 直接插，撞唯一键就回查既有活跃 job。
 *     终态一律把 `dedupeActive` 置 NULL —— NULL 不参与唯一约束，于是同键可以重投。
 *  I3 **租约到期即可回收**：`reclaimExpired()` 用两条条件 UPDATE（先判死、后回队列）完成，
 *     不读不写任何进程内状态 → 多 worker / 重启后都成立。这是 Phase 1a 删掉"启动时把'生成中'
 *     改判失败"之后的**替代机制**（spec §5.2 ②）。
 *  I4 **终态只能由持有者写**：`succeed`/`fail`/`progress`/`heartbeat` 都带 `workerId` 与
 *     `state='running'` 条件；租约被回收后这些调用 `affected=0`，不会覆盖别人的结果。
 *
 * ── 为什么每一处 DB 访问都跑在**特权系统身份**里（`runAsAuth`）──
 *   `o_job` / `o_gate` 是 **platform** 策略的表（`src/db/policies.ts` 有完整理由：worker 的
 *   `claim`/`reclaim` 必须**跨租户扫描**，而租户守卫会给 tenant 表注入 `userId = ctx.userId`）。
 *   而 platform 表的**写**要求 `ctx.role === "admin"`（spec §6.2）—— 于是有两条路：
 *     ① 命名导入裸 `systemDb`（`@/utils/db` 的唯一合法绕过口）；
 *     ② 用**已登记的特权原语** `runAsAuth()`（`src/db/noContext.ts`）在**同一个守卫**下写。
 *   本组选 ②：Phase 1c 的结论是"绕过口**不应该**变多"（`noContext.ts` 文件头），而 ②
 *   既不新增绕过口，又能被 `tools/check-authenticated-writers.cjs` 的**精确集合**（调用方文件
 *   + 处数）钉住。本文件因此是 `runAsAuth` 的**一个新登记调用方**（`count = 1`：只有下面
 *   `asSystem()` 这一处；所有公开方法都经它进出）。
 *   ⚠ 这**不是**提权：`asSystem()` 包住的只有队列表/槽位表的读写；业务 handler 一律走
 *   `withJobTenant()` + `u.db`（`src/jobs/tenant.ts`），拿的是 `role: "user"` 的租户 ctx。
 *   ⚠ `userId = 0`（系统身份）**不会**导致"看到全部租户行"：`o_job` 是 platform 表，守卫对它
 *   **不注入任何条件**；归属（`o_job.userId`）由入队方显式写入，用户可见的读取必须在路由层
 *   自己按 `ctx.userId` 过滤（见 `src/db/policies.ts` 的 `o_job` 登记注释）。
 *
 * ── 与 MySQL 方言有关的两处（离线编译证据见 `tests/job-store.test.ts`，**未连真机**）──
 *  · `for update skip locked` 只有 MySQL 8+/PG 9.5+ 支持，sqlite 上 knex 会**当场抛**
 *    ⇒ 必须先用 `sqldialect()` 分方言（用例把两种形态都钉住）。
 *  · 租约回收写成 `update ... where leaseUntil < ?`（**不是** `insert ... on duplicate key update`）：
 *    MySQL 的 `ON DUPLICATE KEY UPDATE` 没有 `WHERE`，条件更新只能用 `UPDATE ... WHERE`。
 */
import type { Knex } from "knex";
import { releaseInTransaction, reservationIdForJobInTransaction, settleInTransaction } from "@/billing/ledger";
import { waitForAiBillingTasks } from "@/billing/context";
import { withJobTenant } from "@/jobs/tenant";
import { sqldialect } from "@/db/dialect";
import { runAsAuth } from "@/db/noContext";
import { JOB_POLICY, backoffMs, type JobPolicy } from "@/jobs/policy";
import type { JobRegistry } from "@/jobs/registry";
import type { EnqueueInput, EnqueueResult, EnqueueTransactionResult, JobRow, JobState } from "@/jobs/types";

type TerminalBillingOutcome = "success" | "failure" | "cancel";

async function settleTerminalJobBilling(
  trx: Knex.Transaction,
  job: Pick<JobRow, "id" | "userId">,
  outcome: TerminalBillingOutcome,
): Promise<void> {
  const userId = job.userId;
  if (userId === null || userId === undefined) return;

  await withJobTenant(userId, async () => {
    const freezes = await trx("o_ledger")
      .select("idempotencyKey")
      .where({ userId, type: "freeze", refType: "job", refId: String(job.id) });
    if (freezes.length === 0) return;

    const reservationId = await reservationIdForJobInTransaction(trx, { userId, jobId: String(job.id) });
    const usageRows = (await trx("o_usage")
      .select("costMicro", "usageStatus", "providerCallId")
      .where({ userId, jobId: String(job.id) })) as Array<{ costMicro: string | number | bigint; usageStatus: string; providerCallId: string }>;
    const admissions = (await trx("o_usageAdmission")
      .select("providerCallId")
      .where({ userId, jobId: String(job.id) })) as Array<{ providerCallId: string }>;
    const recordedCalls = new Set(usageRows.map((row) => row.providerCallId));
    if (usageRows.some((row) => row.usageStatus === "uncertain")
      || admissions.some((row) => !recordedCalls.has(row.providerCallId))) return;

    if (outcome === "success" || usageRows.length > 0) {
      const actualMicro = usageRows.reduce((sum, row) => sum + BigInt(String(row.costMicro)), 0n);
      await settleInTransaction(trx, {
        userId,
        reservationId,
        actualMicro,
        idempotencyKey: `job-settlement:${job.id}`,
      });
      return;
    }

    const reason = outcome === "cancel" ? "job-cancel" : "job-failure";
    await releaseInTransaction(trx, {
      userId,
      reservationId,
      reason,
      idempotencyKey: `${reason}:${job.id}`,
    });
  });
}

/** 唯一键冲突的错误码（sqlite / mysql2 两种形状；不靠 message 猜，但 message 也兜一层）。 */
const DUP_CODES = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY", "ER_DUP_ENTRY"]);

/**
 * 判断一个错误是不是"唯一键冲突"（enqueue 的原子幂等就是靠它）。
 * 覆盖：`{code}`、`{errno:1062}`、以及错误消息里的两种方言文案。
 */
export function isDuplicateKeyError(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; message?: unknown };
  if (typeof err?.code === "string" && DUP_CODES.has(err.code)) return true;
  if (err?.errno === 1062) return true;
  const msg = String(err?.message ?? "");
  return /UNIQUE constraint failed|Duplicate entry/i.test(msg);
}

export interface JobStoreDeps {
  /**
   * knex 实例。**生产传的是受守卫的 `u.db`**（`src/jobs/index.ts`）—— 传裸 knex 也不会错，
   * 因为本模块只用 `o_job` / `o_gate` 两张 platform 表，但那样就丢掉了"未声明表 fail-closed"的护栏。
   */
  db: Knex;
  registry: JobRegistry;
  /** 可注入时钟（测试用假时钟；生产缺省 `Date.now`）。 */
  now?: () => number;
  /** 可注入策略（测试覆盖单个字段；生产缺省 `JOB_POLICY`）。 */
  policy?: JobPolicy;
}

export interface JobStore {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  enqueueInTransaction(trx: Knex.Transaction, input: EnqueueInput): Promise<EnqueueTransactionResult>;
  claim(opts: { workerId: string; limit: number }): Promise<JobRow[]>;
  heartbeat(id: number, workerId: string): Promise<boolean>;
  progress(id: number, workerId: string, percent: number, stage?: string): Promise<boolean>;
  succeed(id: number, workerId: string, result: unknown): Promise<boolean>;
  fail(id: number, workerId: string, message: string): Promise<JobState>;
  cancel(id: number, reason?: string): Promise<boolean>;
  reclaimExpired(): Promise<{ requeued: number; dead: number }>;
  activeCounts(): Promise<{ global: number; perUser: Record<string, number> }>;
  /**
   * 读单个任务。**作用域必填**（N3）：`get(id, { scope: { userId } })` 或 `{ scope: { all: true } }`。
   * 缺 scope ⇒ tsc 红；运行时形状不对 ⇒ 抛。
   */
  get(id: number, scope: JobScope): Promise<JobRow | null>;
  /**
   * 列举任务。**作用域是必填的**（review-C F5）：`{scope:{userId}}` = 用户可见读取；
   * `{scope:{all:true}}` = 显式系统/全量。两个分支都不可省 —— 见实现处的长注释（1d-3）。
   */
  list(filter: JobListFilter): Promise<JobRow[]>;
  stats(): Promise<Record<string, number>>;
  requeueDead(id: number): Promise<boolean>;
}

/**
 * `list()` 的过滤条件。`scope` 是**必填的判别联合**（不是可选字段）：
 * 这样"忘写作用域"在 **tsc 阶段**就红，而不是等到生产上跨租户泄漏。
 */
export type JobListFilter = { state?: JobState; type?: string; limit?: number } & { scope: JobScope };

/**
 * 读取 `o_job` 的作用域（**必填**，C 组复核轮 F5 + N3）。
 *   · `{ userId: number }` —— 用户可见读取（路由层必须传 `ctx.userId`）；
 *   · `{ all: true }`     —— **显式**声明"系统/全量"（运维 CLI、对账、测试）。
 */
export type JobScope = { userId: number } | { all: true };

/**
 * 运行时的作用域校验：返回"要按哪个 userId 过滤"（`undefined` = 显式全量）。
 * ⚠ 类型层已经强制必填；这一层是给**绕过类型**的 JS 调用方（`as never`、CLI 动态调用）兜底 ——
 *   形状不对一律**抛**，绝不允许"默认全量"。
 */
export function requireUserScope(scope: unknown, who: string): number | undefined {
  const s = scope as { userId?: unknown; all?: unknown } | undefined;
  if (s && typeof s.userId === "number") return s.userId;
  if (s && s.all === true) return undefined;
  throw new Error(
    `[job] ${who}() 必须显式选择作用域：{ scope: { userId } } 或 { scope: { all: true } }` +
      `（1d-3：o_job 是 platform 表，守卫不注入 userId）`,
  );
}

/**
 * 候选查询（**导出供静态断言**，不执行）。
 *
 * `lock = true` 时追加 `for update skip locked` —— 只有 MySQL 支持；sqlite 上 knex 会抛
 * （实测：**链式构建不抛**，`toSQL()`/执行时才抛
 *  `.skipLocked() is currently only supported on MySQL 8.0+ and PostgreSQL 9.5+`），
 * 所以调用方**必须**先用 `sqldialect()` 判定 —— 只在 try/catch 里包"构建"是抓不住的。
 *
 * ⚠ 老实说清它的强度：候选查询是**独立一条语句**（autocommit），`for update` 的锁只覆盖这一条
 *   语句本身，所以它带来的收益是"减少候选争抢"，**不是**正确性来源 —— 正确性始终来自
 *   `claim()` 里那条条件 UPDATE（`affected === 1`）。要拿到"事务级跳过锁"需要把候选查询与条件
 *   更新放进同一个 transaction，那属多实例优化（Phase 3）；本阶段单实例 + 条件 UPDATE 已足够
 *   （`tests/job-store.test.ts` 的 20 路并发用例覆盖）。
 *
 * 候选条件（三条都必须有）：
 *   · `state = 'queued'`（只有排队中的能被领）；
 *   · `nextAttemptAt is null or nextAttemptAt <= now`（退避未到点的**不**能被领）；
 *   · `leaseUntil is null or leaseUntil < now`（僵尸 `running` 刚被回收成 queued 时，
 *     它上一轮的租约可能还没到期 —— 这一条保证"回收语义"与"领取语义"一致）。
 */
export function buildClaimQuery(db: Knex, opts: { now: number; limit: number; lock: boolean }): Knex.QueryBuilder {
  const q = db("o_job")
    .select("id")
    .where("state", "queued")
    .andWhere((w) => w.whereNull("nextAttemptAt").orWhere("nextAttemptAt", "<=", opts.now))
    .andWhere((w) => w.whereNull("leaseUntil").orWhere("leaseUntil", "<", opts.now))
    .orderBy([{ column: "priority" }, { column: "id" }])
    .limit(opts.limit);
  return opts.lock ? q.forUpdate().skipLocked() : q;
}

export function createJobStore(deps: JobStoreDeps): JobStore {
  const db = deps.db;
  const now = deps.now ?? ((): number => Date.now());
  const P: JobPolicy = deps.policy ?? JOB_POLICY;
  const registry = deps.registry;

  /**
   * **本文件唯一的特权原语调用点**（`tools/check-authenticated-writers.cjs` 按文件+处数登记）。
   * 所有公开方法都经由它，所以"谁能用系统身份写 platform 表"这个问题在这里只有一个答案。
   */
  function asSystem<T>(fn: () => Promise<T>): Promise<T> {
    return runAsAuth(fn);
  }

  async function enqueue(input: EnqueueInput, connection: Knex | Knex.Transaction = db): Promise<EnqueueResult> {
    const def = registry.get(input.type);
    if (!def) throw new Error(`[job] 未注册的任务类型 "${input.type}"`);
    const payload = def.parse(input.payload); // fail-fast：坏 payload 不许进库
    const json = JSON.stringify(payload ?? null);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > P.maxPayloadBytes) {
      throw new Error(`[job] payload 超过上限 ${P.maxPayloadBytes} 字节（实际 ${bytes}）；队列只存引用 id，不要把 base64 塞进来`);
    }
    const key = input.dedupeKey ?? def.dedupeKey(payload, input.userId ?? null);
    const ts = now();
    const row = {
      userId: input.userId ?? null,
      type: def.type,
      payload: json,
      state: "queued" as JobState,
      attempts: 0,
      maxAttempts: def.maxAttempts,
      priority: input.priority ?? 100,
      dedupeKey: key,
      dedupeActive: key,
      progress: 0,
      stage: null,
      createdAt: ts,
      updatedAt: ts,
      nextAttemptAt: null,
    };
    try {
      const inserted = (await connection("o_job").insert(row)) as unknown;
      const id = Number(Array.isArray(inserted) ? inserted[0] : inserted);
      return { jobId: id, deduped: false };
    } catch (e) {
      if (!key || !isDuplicateKeyError(e)) throw e;
      // 命中活跃同键任务：回查既有 job（这是"插入撞唯一键"的原子去重路径）
      const existing = (await connection("o_job").where("dedupeActive", key).first()) as JobRow | undefined;
      if (existing) return { jobId: Number(existing.id), deduped: true };
      throw e; // 极罕见：唯一键冲突但读不到（并发事务未提交）→ 交给调用方重试
    }
  }

  /**
   * 活跃计数：**只算"租约仍有效"的 running**（僵尸行不占额度 —— 否则一个崩掉的 worker
   * 会让整个队列永久卡在"没有空槽"）。
   */
  async function activeCounts(): Promise<{ global: number; perUser: Record<string, number> }> {
    const ts = now();
    const rows = (await db("o_job")
      .select("userId")
      .count({ n: "*" })
      .where("state", "running")
      .andWhere("leaseUntil", ">", ts)
      .groupBy("userId")) as Array<{ userId: number | null; n: number | string }>;
    const perUser: Record<string, number> = {};
    let global = 0;
    for (const r of rows) {
      const n = Number(r.n);
      global += n;
      if (r.userId !== null && r.userId !== undefined) perUser[String(r.userId)] = n;
    }
    return { global, perUser };
  }

  /**
   * 租约到期回收（I3）。两条条件 UPDATE，顺序**不能颠倒**：
   *  ① 额度用尽的 → `dead`（终态；`dedupeActive` 置 NULL，允许同键重投）；
   *  ② 其余 → 回 `queued`（`attempts` **保留** —— 它是"已经试过几次"的账）。
   * 只回收 `leaseUntil < now` 的行：**心跳仍新鲜的 running 绝不能被回收**（用例钉住这一条）。
   *
   * ⚠ 为什么先 SELECT 再按 id 更新，而不是写 `whereColumn("attempts", ">=", "maxAttempts")`：
   *   `whereColumn` 在 knex 3 的 **TypeScript 类型里不存在**（运行时存在，实测
   *   `select * from o_job where state = ? and attempts >= maxAttempts`），用它会让 typecheck 红。
   *   两条 UPDATE **都重复条件**（`state='running'` 且 `leaseUntil < ts`），所以即使 SELECT 之后
   *   有人续了租约/别人先回收了，这些行也不会被误动（`affected` 如实反映真正动了多少行）。
   *   "谁该判死"的判定用 SELECT 的快照：`running` 期间 `attempts` 不会变（只有 claim 才 +1，
   *   而 claim 要求 `state='queued'`），所以两个 worker 并发回收会得到**同一个**结论。
   */
  async function reclaimExpired(): Promise<{ requeued: number; dead: number }> {
    const ts = now();
    return db.transaction(async (trx) => {
      const expired = (await trx("o_job")
        .select("id", "userId", "attempts", "maxAttempts")
        .where("state", "running")
        .andWhere("leaseUntil", "<", ts)) as Array<Pick<JobRow, "id" | "userId" | "attempts" | "maxAttempts">>;
      const exhausted = expired.filter((r) => Number(r.attempts) >= Number(r.maxAttempts));
      const retryableIds = expired.filter((r) => Number(r.attempts) < Number(r.maxAttempts)).map((r) => Number(r.id));

      let dead = 0;
      for (const row of exhausted) {
        const affected = (await trx("o_job")
          .where({ id: row.id, state: "running" })
          .andWhere("leaseUntil", "<", ts)
          .update({
            state: "dead",
            dedupeActive: null,
            finishedAt: ts,
            updatedAt: ts,
            leaseUntil: null,
            workerId: null,
            lastError: "租约到期且已用尽重试次数",
          })) as number;
        if (affected === 1) {
          await settleTerminalJobBilling(trx, row, "failure");
          dead += 1;
        }
      }
      let requeued = 0;
      if (retryableIds.length) {
        requeued = (await trx("o_job")
          .whereIn("id", retryableIds)
          .andWhere("state", "running")
          .andWhere("leaseUntil", "<", ts)
          .update({
            state: "queued",
            workerId: null,
            leaseUntil: null,
            heartbeatAt: null,
            nextAttemptAt: ts,
            updatedAt: ts,
            lastError: "租约到期，任务被回收",
          })) as number;
      }
      return { requeued, dead };
    });
  }

  async function claim(opts: { workerId: string; limit: number }): Promise<JobRow[]> {
    if (opts.limit <= 0) return [];
    const ts = now();
    await reclaimExpired(); // 先回收：不然僵尸 running 会一直占着额度
    const counts = await activeCounts();
    const globalFree = Math.min(opts.limit, Math.max(0, P.globalMaxRunning - counts.global));
    if (globalFree <= 0) return [];

    // mysql 支持 `for update skip locked`；sqlite 上调 `.skipLocked()` 会**抛错**（knex 实测），必须分方言。
    const lock = sqldialect(db) === "mysql";
    const candidates = (await buildClaimQuery(db, { now: ts, limit: P.claimBatch, lock })) as Array<{ id: number }>;

    const claimed: JobRow[] = [];
    const perUser: Record<string, number> = { ...counts.perUser };
    for (const c of candidates) {
      if (claimed.length >= globalFree) break;
      // 按用户上限（**JS 侧**过滤）：避免一个用户吃满全局槽位 —— 这是**公平性**，
      // 真正的准入在下面的条件 UPDATE（`affected === 1`），与过滤无关。
      const row0 = (await db("o_job").where("id", c.id).first()) as JobRow | undefined;
      if (!row0 || row0.state !== "queued") continue;
      if (row0.userId !== null && row0.userId !== undefined) {
        const used = perUser[String(row0.userId)] ?? 0;
        if (used >= P.perUserMaxRunning) continue;
      }
      const leaseUntil = ts + P.leaseMs;
      const affected = (await db("o_job")
        .where("id", c.id)
        .andWhere("state", "queued")
        .andWhere((w) => w.whereNull("leaseUntil").orWhere("leaseUntil", "<", ts))
        .update({
          state: "running",
          workerId: opts.workerId,
          leaseUntil,
          heartbeatAt: ts,
          startedAt: ts,
          updatedAt: ts,
          nextAttemptAt: null,
          attempts: db.raw("?? + 1", ["attempts"]),
        })) as number;
      if (affected !== 1) continue; // 被别人抢走 / 已取消 → 跳过（**不报错**：并发下的正常结果）
      const row = (await db("o_job").where("id", c.id).first()) as JobRow;
      claimed.push(row);
      if (row.userId !== null && row.userId !== undefined) perUser[String(row.userId)] = (perUser[String(row.userId)] ?? 0) + 1;
    }
    return claimed;
  }

  /** 心跳：续租 + 记 `heartbeatAt`。只有**当前持有者**且仍是 `running` 才成功（I4）。 */
  async function heartbeat(id: number, workerId: string): Promise<boolean> {
    const ts = now();
    const affected = (await db("o_job")
      .where({ id, workerId, state: "running" })
      .update({ leaseUntil: ts + P.leaseMs, heartbeatAt: ts, updatedAt: ts })) as number;
    return affected === 1;
  }

  /** 写进度**并续租**（长任务里进度更新就是心跳）；返回 false = 租约已丢失，handler 必须停下。 */
  async function progress(id: number, workerId: string, percent: number, stage?: string): Promise<boolean> {
    const ts = now();
    const patch: Record<string, unknown> = {
      progress: Math.max(0, Math.min(100, Math.round(percent))),
      heartbeatAt: ts,
      leaseUntil: ts + P.leaseMs,
      updatedAt: ts,
    };
    if (stage !== undefined) patch.stage = String(stage).slice(0, 64);
    const affected = (await db("o_job")
      .where({ id, workerId, state: "running" })
      .update(patch)) as number;
    return affected === 1;
  }

  /** 成功（终态）：队列转换和账单结算同事务提交；`dedupeActive` 置 NULL ⇒ 同键可以再次入队。 */
  async function succeed(id: number, workerId: string, result: unknown): Promise<boolean> {
    const candidate = (await db("o_job").where({ id, workerId, state: "running" }).first()) as JobRow | undefined;
    if (candidate?.userId !== null && candidate?.userId !== undefined) {
      await waitForAiBillingTasks({ userId: Number(candidate.userId), jobId: String(candidate.id), requestId: "job-settlement" });
    }
    return db.transaction(async (trx) => {
      const row = (await trx("o_job").where({ id, workerId, state: "running" }).first()) as JobRow | undefined;
      if (!row) return false;
      const ts = now();
      const affected = (await trx("o_job")
        .where({ id, workerId, state: "running" })
        .update({
          state: "succeeded",
          dedupeActive: null,
          progress: 100,
          finishedAt: ts,
          updatedAt: ts,
          lastError: null,
          leaseUntil: null,
          workerId: null,
          result: result === undefined ? null : JSON.stringify(result),
        })) as number;
      if (affected !== 1) return false;
      await settleTerminalJobBilling(trx, row, "success");
      return true;
    });
  }

  /**
   * 失败：还有额度 → 回 `queued` 并写退避；额度用尽 → `dead`（终态）。
   *
   * ⚠ 返回值是**该 job 现在的状态**（`"queued"` / `"dead"`），不是"这次调用做了什么"：
   *   worker 需要据此决定"要不要继续等"。
   * ⚠ 若租约已丢失（`affected = 0`：被回收 / 被取消 / 换了持有者），本函数**不覆盖**
   *   别人的结果，并回读当前真实状态返回（读不到就当 `"failed"` 兜底）。
   */
  async function fail(id: number, workerId: string, message: string): Promise<JobState> {
    return db.transaction(async (trx) => {
      const ts = now();
      const errText = String(message ?? "").slice(0, 1000);
      const row = (await trx("o_job").where({ id, workerId }).first()) as JobRow | undefined;
      if (!row || row.state !== "running") {
        const cur = (await trx("o_job").where("id", id).first()) as JobRow | undefined;
        return cur ? cur.state : "failed";
      }
      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.maxAttempts);
      if (attempts >= maxAttempts) {
        const affected = (await trx("o_job")
          .where({ id, workerId, state: "running" })
          .update({ state: "dead", dedupeActive: null, finishedAt: ts, updatedAt: ts, lastError: errText, leaseUntil: null, workerId: null })) as number;
        if (affected === 1) {
          await settleTerminalJobBilling(trx, row, "failure");
          return "dead";
        }
      } else {
        const attempt = Math.max(1, attempts);
        const affected = (await trx("o_job")
          .where({ id, workerId, state: "running" })
          .update({
            state: "queued",
            workerId: null,
            leaseUntil: null,
            heartbeatAt: null,
            nextAttemptAt: ts + backoffMs(attempt),
            updatedAt: ts,
            lastError: errText,
          })) as number;
        if (affected === 1) return "queued";
      }
      // 竞态（租约在这一瞬间被回收/取消）：不覆盖，不结算，回读真实状态。
      const cur = (await trx("o_job").where("id", id).first()) as JobRow | undefined;
      return cur ? cur.state : "failed";
    });
  }

  /** 取消：状态转换和预留释放同事务提交；只有 `queued` / `running` 可取消，且幂等。 */
  async function cancel(id: number, reason?: string): Promise<boolean> {
    return db.transaction(async (trx) => {
      const row = (await trx("o_job").where("id", id).whereIn("state", ["queued", "running"]).first()) as JobRow | undefined;
      if (!row) return false;
      const ts = now();
      const affected = (await trx("o_job")
        .where("id", id)
        .whereIn("state", ["queued", "running"])
        .update({
          state: "canceled",
          dedupeActive: null,
          finishedAt: ts,
          updatedAt: ts,
          leaseUntil: null,
          workerId: null,
          lastError: reason ? String(reason).slice(0, 1000) : null,
        })) as number;
      if (affected !== 1) return false;
      await settleTerminalJobBilling(trx, row, "cancel");
      return true;
    });
  }

  /**
   * 读单个任务 —— ⚠⚠ **调用方同样必须显式选择作用域**（C 组复核轮 **N3**：F5 只上了 `list()`）。
   *
   * 为什么：与 `list()` 同源 —— `o_job` 是 **platform** 表，守卫不注入 `userId`，而本方法跑在
   * `asSystem()` 里 ⇒ 不加条件时**任何人都能按 id 读到任何人的任务**（reviewer2 实测：
   * `ctx.userId=1001` 读 `id=12` 拿到了 `userId=1002` 的那一行，含 `payload` 原文）。
   * ⇒ `scope` 必填：`{userId}`（用户可见读取，路由层传 `ctx.userId`）或 `{all:true}`（显式系统读）。
   * 运行时不满足形状 ⇒ **抛**（防 JS 调用方绕过类型）。
   */
  async function get(id: number, scope: JobScope): Promise<JobRow | null> {
    const userId = requireUserScope(scope, "get");
    const q = db("o_job").where("id", id);
    if (typeof userId === "number") q.andWhere("userId", userId);
    const row = (await q.first()) as JobRow | undefined;
    return row ?? null;
  }

  /**
   * 列举任务 —— ⚠⚠ **调用方必须显式选择作用域**（review-C F5 / 账本 1d-3）。
   *
   * 为什么：`o_job` 是 **platform** 表 ⇒ 租户守卫**不注入** `userId` 条件，而本方法整体跑在
   * `asSystem()` 的系统身份里 ⇒ **不带 `userId` 的调用会看到所有租户的行**（返回行还含 `payload`
   * 原文 = 用户提示词）。本阶段还没有用户可见的读取路由（所以尚未泄漏），但那是**地雷**：
   * 下一个人接上 `list()` 就是跨租户泄漏。
   *
   * ⇒ 类型上强制二选一（两个字段都是必填的联合分支，**缺一个就编译不过**）：
   *   · `{ scope: { userId: number } }` —— 用户可见读取（路由层必须传 `ctx.userId`）；
   *   · `{ scope: { all: true } }`     —— **显式**声明"系统/全量"（运维 CLI、对账、测试）。
   * 运行时再兜一层：`scope` 形状不对 ⇒ 抛错（防止 JS 调用方绕过类型）。
   */
  async function list(filter: JobListFilter): Promise<JobRow[]> {
    const userId = requireUserScope(filter?.scope, "list");
    const q = db("o_job").select("*").orderBy("id", "desc").limit(Math.max(1, Math.min(filter.limit ?? 50, 500)));
    if (typeof userId === "number") q.andWhere("userId", userId);
    if (filter.state) q.andWhere("state", filter.state);
    if (filter.type) q.andWhere("type", filter.type);
    return (await q) as JobRow[];
  }

  /**
   * **系统级**统计（按 state 计数，**跨全部租户**）。
   *
   * ⚠ 命名/文档上显式标注"系统级"（C 组复核轮 **N3**）：它没有、也**不该有** `scope` 参数 ——
   *   它的用途是运维看板（"队列里各状态多少条"）与 chaos/verify 断言，本身就是全量口径。
   *   ⚠⚠ **用户可见的读取绝不许用它**（返回的是别人的量）：那种场景必须 `list({scope:{userId}})`。
   *   若将来要按用户展示统计，必须新增一个带 `scope` 的方法，**不要**给这个方法加可选参数
   *   （可选参数 = 又一条"忘了传就全量"的地雷）。
   */
  async function stats(): Promise<Record<string, number>> {
    const rows = (await db("o_job").select("state").count({ n: "*" }).groupBy("state")) as Array<{ state: string; n: number | string }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = Number(r.n);
    return out;
  }

  /**
   * 死信重投（运维入口）：`dead` → `queued`，`attempts` 归零，并**重新占住幂等锁**
   * （同一把锁，避免"重投后又被并发的同键入队"跑成两条）。
   * 若该键已被别的活跃任务占着（唯一键冲突）⇒ 返回 false（可诊断），不把锁抢过来。
   */
  async function requeueDead(id: number): Promise<boolean> {
    const ts = now();
    const row = (await db("o_job").where("id", id).first()) as JobRow | undefined;
    if (!row || row.state !== "dead") return false;
    try {
      const affected = (await db("o_job")
        .where({ id, state: "dead" })
        .update({
          state: "queued",
          attempts: 0,
          dedupeActive: row.dedupeKey,
          nextAttemptAt: ts,
          updatedAt: ts,
          lastError: null,
          finishedAt: null,
        })) as number;
      return affected === 1;
    } catch (e) {
      if (isDuplicateKeyError(e)) return false; // 已有同键活跃任务 → 拒绝重投
      throw e;
    }
  }

  /**
   * 公开面：**每个方法都整体跑在特权系统身份里**（见文件头"为什么"）。
   * 把包装放在这一层（而不是每个方法体内部）是为了让"唯一调用点"在源码里肉眼可查。
   */
  return {
    enqueue: (input) => asSystem(() => enqueue(input)),
    enqueueInTransaction: (trx, input) => asSystem(async () => {
      const result = await enqueue(input, trx);
      return { jobId: String(result.jobId), created: !result.deduped };
    }),
    claim: (opts) => asSystem(() => claim(opts)),
    heartbeat: (id, workerId) => asSystem(() => heartbeat(id, workerId)),
    progress: (id, workerId, percent, stage) => asSystem(() => progress(id, workerId, percent, stage)),
    succeed: (id, workerId, result) => asSystem(() => succeed(id, workerId, result)),
    fail: (id, workerId, message) => asSystem(() => fail(id, workerId, message)),
    cancel: (id, reason) => asSystem(() => cancel(id, reason)),
    reclaimExpired: () => asSystem(() => reclaimExpired()),
    activeCounts: () => asSystem(() => activeCounts()),
    get: (id, scope) => asSystem(() => get(id, scope)),
    list: (filter) => asSystem(() => list(filter)),
    stats: () => asSystem(() => stats()),
    requeueDead: (id) => asSystem(() => requeueDead(id)),
  };
}
