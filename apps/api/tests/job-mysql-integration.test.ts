/**
 * 队列存储层的 **MySQL 专属语义**（Phase 1d Task 10 Step 3；门控 `MIWO_TEST_MYSQL=1`）。
 *
 * ⚠ **本机不启 MySQL（3307 独占）⇒ 整组 skip**；CI 的 mysql job 设 `MIWO_TEST_MYSQL=1` 真跑。
 *   skip 必须**可见**（下面打印原因），且 `verify:phase1d --require-mysql` 会把 SKIP 判 FAIL
 *   （Ruling 26：永不执行的守卫 = 没有守卫）。
 *
 * 为什么这些用例只能在 MySQL 上验：
 *  · 可空唯一列允许多个 NULL —— sqlite 与 MySQL 的行为**恰好一致**，但"真受影响行数/errno"只有真机给得出；
 *  · `for update skip locked` 只有 MySQL 8+/PG 9.5+ 支持（sqlite 上 knex 会当场抛，见 store.ts 注释）；
 *  · 迁移往返（up → 存在 → down → 不存在）在真方言上跑一次才叫验过。
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createKnex } from "@/db/connect";
import { runMigrations, rollbackMigrations } from "@/db/migrations";
import { createJobRegistry } from "@/jobs/registry";
import { buildClaimQuery, createJobStore } from "@/jobs/store";
import { selftestSleep } from "@/jobs/handlers/selftest";

const ENABLED = process.env.MIWO_TEST_MYSQL === "1";
if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.warn("[job-mysql] 跳过 MySQL 集成用例（未设 MIWO_TEST_MYSQL=1）—— 本机不启 MySQL；真跑在 CI 的 mysql job");
}

let db: Knex | null = null;
const open = (): Knex => (db ??= createKnex());
afterAll(async () => {
  if (db) await db.destroy();
});

describe.skipIf(!ENABLED)("job store 的 MySQL 专属语义", () => {
  it("迁移往返：up → o_job/o_gate 存在 → down → 都不存在", async () => {
    const conn = open();
    await runMigrations(conn);
    expect(await conn.schema.hasTable("o_job")).toBe(true);
    expect(await conn.schema.hasTable("o_gate")).toBe(true);
    await rollbackMigrations(conn, true);
    expect(await conn.schema.hasTable("o_job")).toBe(false);
    expect(await conn.schema.hasTable("o_gate")).toBe(false);
  });

  it("★ 可空唯一列允许多个 NULL（两条终态行都能插入）；同键活跃行则撞 ER_DUP_ENTRY", async () => {
    const conn = open();
    await runMigrations(conn);
    await conn("o_job").del();
    const now = Date.now();
    const base = { userId: 1, type: "selftest.sleep", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1, priority: 1, progress: 100, createdAt: now, updatedAt: now };
    await conn("o_job").insert({ ...base, dedupeKey: "a", dedupeActive: null });
    await conn("o_job").insert({ ...base, dedupeKey: "b", dedupeActive: null });
    expect(Number((await conn("o_job").whereNull("dedupeActive").count({ n: "*" }).first())!.n)).toBe(2);
    await conn("o_job").insert({ ...base, dedupeKey: "k", dedupeActive: "k" });
    await expect(conn("o_job").insert({ ...base, dedupeKey: "k", dedupeActive: "k" })).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const store = createJobStore({ db: conn, registry: createJobRegistry([selftestSleep]) });
    await store.enqueue({ type: "selftest.sleep", userId: 1, payload: { ms: 1, tag: "dup" } });
    expect((await store.enqueue({ type: "selftest.sleep", userId: 1, payload: { ms: 1, tag: "dup" } })).deduped).toBe(true);
    await conn("o_job").del();
  });

  it("★ `for update skip locked` 真能执行（本机只有静态 SQL 文本，这里是真机）", async () => {
    const conn = open();
    await runMigrations(conn);
    const sql = buildClaimQuery(conn, { now: Date.now(), limit: 1, lock: true }).toSQL().sql;
    expect(sql).toContain("for update skip locked");
    const got = await conn.transaction(async (trx) => buildClaimQuery(trx, { now: Date.now(), limit: 1, lock: true }));
    expect(Array.isArray(got)).toBe(true);
  });

  it("★ 租约回收在真方言上的 affected 行数可信（判死 / 回队列各一条条件 UPDATE）", async () => {
    const conn = open();
    await runMigrations(conn);
    await conn("o_job").del();
    const now = Date.now();
    await conn("o_job").insert([
      { userId: 1, type: "selftest.sleep", payload: "{}", state: "running", attempts: 1, maxAttempts: 1, priority: 1, progress: 0, createdAt: now, updatedAt: now, leaseUntil: now - 1, dedupeKey: "d1", dedupeActive: "d1" },
      { userId: 2, type: "selftest.sleep", payload: "{}", state: "running", attempts: 1, maxAttempts: 3, priority: 1, progress: 0, createdAt: now, updatedAt: now, leaseUntil: now - 1, dedupeKey: "d2", dedupeActive: "d2" },
    ]);
    const store = createJobStore({ db: conn, registry: createJobRegistry([selftestSleep]) });
    const r = await store.reclaimExpired();
    expect(r).toEqual({ requeued: 1, dead: 1 });
    await conn("o_job").del();
  });
});
