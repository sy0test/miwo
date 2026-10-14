/**
 * 008_vendor_gate —— 厂商/类型分池的并发槽位 `o_gate`（spec §9.3「全局并发：按 vendor 分池的信号量」）。
 *
 * 为什么单独一张表，而不是复用 `o_job`：
 *   `o_job` 的一行 = 一个**可重试的任务**（有 payload / state / attempts / 结果）；
 *   槽位是"跨进程、毫秒级、可过期"的占位（没有 payload 语义）。混在一张表里会让
 *   领取 SQL 与所有统计口径都被污染（每个槽位都会出现在"我的任务"里）。
 *
 * 语义：池 `name`（如 `vendor:volcengine`、`type:image`）的活跃行数 < limit 才算拿到槽位；
 *   持有者崩溃 → `leaseUntil` 过期 → 被回收。与 `o_job` 同一套租约思想（不依赖进程内状态）。
 *
 * ⚠ `o_gate` 是 **platform** 策略（`src/db/policies.ts`）：它是跨进程的基础设施表，没有租户语义，
 *   也不允许用户直接读写（只有 worker 在系统身份下操作，见 `src/jobs/store.ts` 的说明）。
 */
import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

/** `o_gate` 的表定义（**唯一一份**；`up()` 与静态 DDL 断言共用它）。 */
export function gateTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T: Knex.CreateTableBuilder): void => {
    t.pk(T);
    T.string("name", 64).notNullable(); // 池名（`vendor:<id>` / `type:<task>` / `selftest`）
    T.string("holderId", 128).notNullable(); // 持有者（workerId 或 `api:<pid>:<uuid>`）
    t.ms(T, "acquiredAt").notNullable(); // 拿到槽位的时间（毫秒）
    t.ms(T, "leaseUntil").notNullable(); // 槽位租约到期（毫秒）；过期即可被回收
    t.ms(T, "updatedAt").notNullable(); // 最近一次续租/写入（毫秒）
    T.index(["name", "leaseUntil"], "o_gate_pool_index"); // 取池内活跃行数 + 回收过期行
    T.index(["holderId"], "o_gate_holder_index"); // 按持有者释放（worker 退出时）
  };
}

export default {
  name: "008_vendor_gate",
  async up(knex: Knex): Promise<void> {
    if (!(await knex.schema.hasTable("o_gate"))) {
      await knex.schema.createTable("o_gate", gateTableSpec(knex));
    }
  },
  async down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("o_gate");
  },
} satisfies Migration;
