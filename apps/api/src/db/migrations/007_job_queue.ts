/**
 * 007_job_queue —— 生成任务队列表 `o_job`（spec §9.2）。
 *
 * 设计要点（每一条都有 spec 依据或本会话实测依据）：
 *  1. `state` 是字符串枚举（`queued` / `running` / `succeeded` / `failed` / `dead` / `canceled`）。
 *     `dead` 是对 spec §9.2 枚举的**扩展**（"失败重试与死信"要求）：区分"用尽重试、需人工介入"
 *     与"这一次失败了、还会再试"。
 *  2. `dedupeActive` 是**可空唯一列**：活跃期 = `dedupeKey`，进终态时置 NULL。
 *     幂等靠"插入撞唯一键"实现（原子、不依赖读-改-写）；NULL 不参与唯一约束，
 *     所以同一个 `dedupeKey` 在**终态之后**可以再次入队。
 *     本会话 sqlite 实测：两行 NULL 可共存；同键第二条 → `SQLITE_CONSTRAINT_UNIQUE`
 *     （MySQL 侧对应 `ER_DUP_ENTRY` / errno 1062，由 `isDuplicateKeyError()` 一并识别）。
 *  3. **所有毫秒时间列走 `t.ms()` → MySQL `bigint unsigned`**（sqlite 侧 `bigint`）。
 *     ⚠ 绝不能用 `T.integer`：MySQL 的 `int` 是 32 位（上限 2147483647），装不下 `Date.now()`
 *     （~1.79e12）。这是本组"毫秒时间列宽度"要求在新表上的落点。
 *  4. `payload` 走 `t.text()`（MySQL `longtext`）：**只存引用 id 的 JSON，不存 base64**。
 *  5. 四个索引各有一个明确消费者：
 *     `o_job_claim_index` `(state, priority, id)` —— 领取的候选排序（priority 小者先，同优先级按 id 先来先服务）；
 *     `o_job_lease_index` `(state, leaseUntil)` —— 租约到期回收（spec §5.2 ② 的替代机制）；
 *     `o_job_user_index`  `(userId, state)`  —— 按用户计数（每用户并发上限）与"我的任务"；
 *     `o_job_type_index`  `(type, state)`    —— 按类型统计与运维。
 *  6. `userId` **可空**：平台/运维任务（如 `selftest.sleep`）没有租户；业务任务一律带 userId。
 *     注意本表是 **platform** 策略（见 `src/db/policies.ts` 的登记理由），因此守卫**不会**
 *     自动注入/回填 `userId` —— 归属由入队方显式写入，读取方（路由）必须自己按 ctx.userId 过滤。
 *
 * ⚠ `jobTableSpec` 被 `apps/api/tests/migration-job-queue.test.ts` 直接用来做 **MySQL 静态 DDL**
 *   断言（`createKnex({client:"mysql2"}).schema.createTable(...).toSQL()`，不需要 MySQL 服务端）。
 *   所以表定义**只能**写在这个导出的函数里，不要在 `up()` 里另抄一份（两份真相必漂）。
 */
import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

/** `o_job` 的表定义（**唯一一份**；`up()` 与静态 DDL 断言共用它）。 */
export function jobTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T: Knex.CreateTableBuilder): void => {
    t.pk(T); // bigint unsigned auto_increment（sqlite: integer primary key autoincrement）
    t.u64(T, "userId"); // 归属（worker 建租户 ctx 用，spec §6.4）；平台任务为 NULL
    T.string("type", 64).notNullable(); // 任务类型（`src/jobs/registry.ts` 里的 key）
    t.text(T, "payload"); // JSON 字符串（只存引用 id）
    T.string("state", 16).notNullable(); // queued|running|succeeded|failed|dead|canceled
    T.integer("attempts").notNullable().defaultTo(0); // 每次领取 +1
    T.integer("maxAttempts").notNullable().defaultTo(1); // 由任务类型定义决定
    T.integer("priority").notNullable().defaultTo(100); // 越小越先
    T.string("dedupeKey", 191); // 原始幂等键（审计用；终态后仍保留）
    T.string("dedupeActive", 191).unique("o_job_dedupe_active_unique"); // 幂等锁（终态置 NULL）
    t.ms(T, "leaseUntil"); // 租约到期（毫秒）
    t.ms(T, "heartbeatAt"); // 最后一次心跳（诊断"是死是活"）
    T.string("workerId", 128); // 领取者标识
    T.integer("progress").notNullable().defaultTo(0); // 0..100
    T.string("stage", 64); // 阶段文案（进度推送用）
    t.ms(T, "createdAt").notNullable(); // 入队时间
    t.ms(T, "startedAt"); // 首次领取时间
    t.ms(T, "finishedAt"); // 终态时间
    t.ms(T, "nextAttemptAt"); // 退避：到点才能被再次领取
    t.text(T, "lastError"); // 最近一次失败原因（写入前截断 ≤1000 字符）
    t.text(T, "result"); // 成功产物摘要（JSON）
    t.ms(T, "updatedAt").notNullable(); // 进度推送的游标（复合 (updatedAt, id)）
    T.index(["state", "priority", "id"], "o_job_claim_index");
    T.index(["state", "leaseUntil"], "o_job_lease_index");
    T.index(["userId", "state"], "o_job_user_index");
    T.index(["type", "state"], "o_job_type_index");
  };
}

export default {
  name: "007_job_queue",
  async up(knex: Knex): Promise<void> {
    // ⚠ 必须 `await` hasTable：它返回的是可 await 的 QueryBuilder（**恒真**），
    //    漏了 await 会让"表已存在"永远成立，空库直接崩（Phase 1a Ruling 31 的真实 bug）。
    if (!(await knex.schema.hasTable("o_job"))) {
      await knex.schema.createTable("o_job", jobTableSpec(knex));
    }
  },
  async down(knex: Knex): Promise<void> {
    // 精确撤销 up：只删本迁移建的那张表（`dropTableIfExists` 而不是 `dropTable`，
    // 让"已被人工删掉"的库也能回滚成功 —— `tools/migration-tables.cjs` 的退役表口径
    // 是"被 IfExists 删过 **且从没被创建过**"，本表被创建过，所以不会被误判成退役表）。
    await knex.schema.dropTableIfExists("o_job");
  },
} satisfies Migration;
