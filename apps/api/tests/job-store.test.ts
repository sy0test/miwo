/**
 * job store 的回归网（spec §9.2）——本组最重要的一张网。
 *
 * 覆盖五组：
 *  A. **入队与幂等**：落库字段、同键去重（串行 + 20 路并发）、终态后可重投、fail-fast 校验；
 *  B. **领取**：条件 UPDATE 的原子性（2 路 / **20 路**真并发恰好一个赢）、全局上限、按用户上限、退避；
 *  C. **租约**：心跳延长租约、过期回收（**只回收过期行**）、用尽重试判死、租约丢失后不许覆盖结果；
 *  D. **方言形态**：mysql 编译出 `for update skip locked`；sqlite 调用即抛（不连服务端）；
 *  E. **生产接线**：真 `u.db`（受守卫）+ `runAsAuth` 特权身份 —— 并证明 `o_job`/`o_gate`
 *     登记成 **platform** 是**必需**的（换成 tenant 则跨租户 claim 一条都领不到）。
 *
 * ⚠ 时钟一律是**假时钟**（`makeClock`）：租约/退避/回收的用例必须确定，绝不靠真实等待。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { TABLE_POLICIES, policyOf } from "@/db/policies";
import { runWithTenant, currentTenant } from "@/db/tenant-context";
import { makeTenantAware } from "@/db/tenant-guard";
import { runMigrations } from "@/db/migrations";
import { JOB_POLICY, type JobPolicy } from "@/jobs/policy";
import { createJobRegistry, type JobRegistry } from "@/jobs/registry";
import { buildClaimQuery, createJobStore, isDuplicateKeyError, type JobStore } from "@/jobs/store";
import { withJobTenant } from "@/jobs/tenant";
import type { JobDefinition, JobState } from "@/jobs/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-store-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

/** 假时钟：租约/退避测试必须确定，绝不能靠真实等待。 */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): number => {
      t += ms;
      return t;
    },
    set: (v: number): number => {
      t = v;
      return t;
    },
  };
}

const sleepDef: JobDefinition<{ ms: number; tag?: string }> = {
  type: "test.sleep", timeoutMs: 60_000, maxAttempts: 2, pool: "test",
  parse: (raw) => raw as { ms: number; tag?: string },
  dedupeKey: (p, userId) => (p.tag ? `${userId}:test.sleep:${p.tag}` : null),
  handle: async () => null,
};

let seq = 0;
async function setup(policy: Partial<JobPolicy> = {}) {
  seq += 1;
  const file = path.join(TMP, `s${seq}.sqlite`);
  const db = createKnex(cfg(file));
  await runMigrations(db);
  const clock = makeClock();
  const registry: JobRegistry = createJobRegistry([sleepDef]);
  const store = createJobStore({ db, registry, now: clock.now, policy: { ...JOB_POLICY, ...policy } });
  return { db, store, clock, registry, file };
}

describe("A. 入队与幂等（spec §9.2）", () => {
  it("enqueue 写一行 queued，并把 attempts/progress/时间戳填对", async () => {
    const { db, store, clock } = await setup();
    const { jobId, deduped } = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1 } });
    expect(deduped).toBe(false);
    const row = await store.get(jobId);
    expect(row && row.state).toBe("queued");
    expect(row && row.attempts).toBe(0);
    expect(row && row.maxAttempts).toBe(sleepDef.maxAttempts);
    expect(row && row.progress).toBe(0);
    expect(row && row.dedupeActive).toBeNull(); // 没给 tag ⇒ dedupeKey 为 null ⇒ 不占幂等锁
    expect(row && row.createdAt).toBe(clock.now());
    expect(row && row.updatedAt).toBe(clock.now());
    expect(row && row.userId).toBe(7);
    await db.destroy();
  });

  it("★ 幂等：同 dedupeKey 的第二次 enqueue 返回既有 jobId（不新建）", async () => {
    const { db, store } = await setup();
    const a = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "x" } });
    const b = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "x" } });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.jobId).toBe(a.jobId);
    expect(Number((await db("o_job").count({ n: "*" }).first())!.n)).toBe(1);
    await db.destroy();
  });

  it("★ 幂等并发：20 个并发 enqueue 同键 → 恰好 1 行、1 个非 deduped", async () => {
    const { db, store } = await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "race" } })),
    );
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => !r.deduped).length).toBe(1);
    expect(Number((await db("o_job").count({ n: "*" }).first())!.n)).toBe(1);
    await db.destroy();
  });

  it("★ 终态之后同键可以再次入队（dedupeActive 置 NULL 才使这一条成立）", async () => {
    const { db, store } = await setup();
    const a = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "again" } });
    const claimed = await store.claim({ workerId: "w1", limit: 5 });
    expect(claimed.map((j) => j.id)).toEqual([a.jobId]);
    expect(await store.succeed(a.jobId, "w1", { ok: true })).toBe(true);
    const b = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "again" } });
    expect(b.deduped).toBe(false);
    expect(b.jobId).not.toBe(a.jobId);
    await db.destroy();
  });

  it("入队即校验：未注册类型与超限 payload 都必须抛错（不写库）", async () => {
    const { db, store } = await setup();
    await expect(store.enqueue({ type: "nope", userId: 1, payload: {} })).rejects.toThrow(/未注册/);
    await expect(
      store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "x".repeat(JOB_POLICY.maxPayloadBytes) } }),
    ).rejects.toThrow(/payload/);
    expect(Number((await db("o_job").count({ n: "*" }).first())!.n)).toBe(0);
    await db.destroy();
  });

  it("入队的 priority 缺省 100、显式值生效（决定领取顺序）", async () => {
    const { db, store } = await setup();
    const late = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    const soon = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 }, priority: 1 });
    expect((await store.get(late.jobId))!.priority).toBe(100);
    const claimed = await store.claim({ workerId: "w1", limit: 5 });
    expect(claimed.map((j) => j.id)).toEqual([soon.jobId, late.jobId]); // priority 小者先，同值按 id
    await db.destroy();
  });
});

describe("B. 领取的原子性与额度（spec §9.2 I1）", () => {
  it("★ 领取是条件 UPDATE：同一条 job 被两个并发领取者争抢时只有一个赢", async () => {
    const { db, store } = await setup();
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "one" } });
    const [a, b] = await Promise.all([store.claim({ workerId: "wA", limit: 1 }), store.claim({ workerId: "wB", limit: 1 })]);
    const got = [...a, ...b];
    expect(got.length).toBe(1);
    const row = await store.get(got[0].id);
    expect(row && row.state).toBe("running");
    expect(row && row.attempts).toBe(1); // 领取即 +1
    expect(row && row.leaseUntil).toBe(got[0].leaseUntil);
    expect(row && row.workerId).toBe(got[0].workerId);
    expect(row && row.startedAt).toBe(row && row.startedAt); // 首次领取时间已写入
    expect(row && row.startedAt).not.toBeNull();
    await db.destroy();
  });

  it("★★ 20 路真并发 claim：只有恰好一个领取者拿到那唯一一条任务（其余全空）", async () => {
    // 额度放到很大 —— 否则"全局/按用户上限"会先挡住，测不到真正的领取竞态。
    const { db, store } = await setup({ globalMaxRunning: 1000, perUserMaxRunning: 1000 });
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "race" } });
    // Promise.all：20 个 claim 会在任何一条 UPDATE 落地之前全部启动（真并发窗口）
    const results = await Promise.all(Array.from({ length: 20 }, (_v, i) => store.claim({ workerId: `w${i}`, limit: 1 })));
    const winners = results.flat();
    expect(winners.map((j) => j.id)).toEqual([jobId]); // 恰好一条、恰好一个赢家
    expect(results.filter((r) => r.length === 1).length).toBe(1);
    expect(results.filter((r) => r.length === 0).length).toBe(19);
    const row = (await store.get(jobId))!;
    expect(row.state).toBe("running");
    expect(row.attempts).toBe(1); // 只被领取了一次（不是被 20 个各 +1）
    await db.destroy();
  });

  it("★★ 两个**独立连接**（模拟两个 worker 进程）并发 claim 同一条任务：仍然只有一个赢", async () => {
    const { db, store, file, registry } = await setup({ globalMaxRunning: 1000, perUserMaxRunning: 1000 });
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "two-procs" } });
    const db2 = createKnex(cfg(file)); // 同一个 sqlite 文件、另一个连接
    const store2 = createJobStore({ db: db2, registry });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => store.claim({ workerId: "procA", limit: 1 })),
      ...Array.from({ length: 5 }, () => store2.claim({ workerId: "procB", limit: 1 })),
    ]);
    expect(results.flat().map((j) => j.id)).toEqual([jobId]);
    expect((await store.get(jobId))!.attempts).toBe(1);
    await db2.destroy();
    await db.destroy();
  });

  it("按用户上限：同一用户已有 2 个 running 时，第 3 条不会被领取（JS 侧过滤）", async () => {
    const { db, store } = await setup({ globalMaxRunning: 10, perUserMaxRunning: 2 });
    for (const tag of ["a", "b", "c"]) await store.enqueue({ type: "test.sleep", userId: 5, payload: { ms: 1, tag } });
    const first = await store.claim({ workerId: "w1", limit: 10 });
    expect(first.length).toBe(2); // 第 3 条被按用户上限挡住
    const second = await store.claim({ workerId: "w2", limit: 10 });
    expect(second.length).toBe(0); // 仍然挡着（2 个 running 未终态）
    await db.destroy();
  });

  it("全局上限：globalMaxRunning = 1 时每次最多领 1 条", async () => {
    const { db, store } = await setup({ globalMaxRunning: 1, perUserMaxRunning: 5 });
    for (const tag of ["a", "b"]) await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag } });
    expect((await store.claim({ workerId: "w1", limit: 10 })).length).toBe(1);
    expect((await store.claim({ workerId: "w2", limit: 10 })).length).toBe(0);
    await db.destroy();
  });

  it("limit <= 0 直接返回空（不查库、不回收）", async () => {
    const { db, store } = await setup();
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    expect(await store.claim({ workerId: "w1", limit: 0 })).toEqual([]);
    expect((await store.get(1))!.state).toBe("queued");
    await db.destroy();
  });

  it("★ 退避：fail 之后在 nextAttemptAt 之前不可被领取", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    await store.claim({ workerId: "w1", limit: 1 });
    expect(await store.fail(jobId, "w1", "x")).toBe("queued");
    clock.advance(JOB_POLICY.retryBaseMs - 1);
    expect((await store.claim({ workerId: "w1", limit: 1 })).length).toBe(0);
    clock.advance(2);
    expect((await store.claim({ workerId: "w1", limit: 1 })).length).toBe(1);
    await db.destroy();
  });
});

describe("C. 租约、回收、终态（spec §9.2 I3/I4）", () => {
  it("★ heartbeat 延长租约（前后 leaseUntil 比较：正好 +heartbeat 间隔）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    const [claimed] = await store.claim({ workerId: "w1", limit: 1 });
    const before = claimed.leaseUntil as number;
    expect(before).toBe(clock.now() + JOB_POLICY.leaseMs);
    clock.advance(5_000);
    expect(await store.heartbeat(jobId, "w1")).toBe(true);
    const after = (await store.get(jobId))!.leaseUntil as number;
    expect(after).toBe(before + 5_000); // 租约被原样推后了 5000ms
    expect(after).toBeGreaterThan(before);
    expect((await store.get(jobId))!.heartbeatAt).toBe(clock.now());
    await db.destroy();
  });

  it("★★ reclaim 只回收**租约已过期**的行：心跳仍新鲜的 running 绝不能被回收", async () => {
    const { db, store, clock } = await setup();
    const fresh = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "fresh" } });
    const stale = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "stale" } });
    // 手工把两条都置成 running，并让 fresh 的租约远离到期、stale 的租约已过期
    await store.claim({ workerId: "w1", limit: 5 });
    const base = clock.now();
    await db("o_job").where("id", fresh.jobId).update({ leaseUntil: base + JOB_POLICY.leaseMs, heartbeatAt: base });
    await db("o_job").where("id", stale.jobId).update({ leaseUntil: base - 1, heartbeatAt: base - JOB_POLICY.leaseMs });

    const r = await store.reclaimExpired();
    expect(r).toEqual({ requeued: 1, dead: 0 });
    const freshRow = (await store.get(fresh.jobId))!;
    expect(freshRow.state).toBe("running"); // 新鲜的**没被动**
    expect(freshRow.workerId).toBe("w1");
    expect(freshRow.leaseUntil).toBe(base + JOB_POLICY.leaseMs);
    expect(freshRow.lastError).toBeNull();
    const staleRow = (await store.get(stale.jobId))!;
    expect(staleRow.state).toBe("queued");
    expect(staleRow.workerId).toBeNull();
    expect(staleRow.lastError).toMatch(/租约到期/);

    // 反例自证：把 fresh 的租约也推过期 ⇒ 这次它必须被回收（证明上一个断言不是因为"什么都没扫到"）
    await db("o_job").where("id", fresh.jobId).update({ leaseUntil: base - 2 });
    expect(await store.reclaimExpired()).toEqual({ requeued: 1, dead: 0 });
    expect((await store.get(fresh.jobId))!.state).toBe("queued");
    await db.destroy();
  });

  it("★ 租约过期回收：queued 重排、attempts 保留、workerId 清空（用假时钟，不等待）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "lease" } });
    await store.claim({ workerId: "w1", limit: 1 });
    clock.advance(JOB_POLICY.leaseMs + 1);
    const r = await store.reclaimExpired();
    expect(r).toEqual({ requeued: 1, dead: 0 });
    const row = await store.get(jobId);
    expect(row && row.state).toBe("queued");
    expect(row && row.attempts).toBe(1); // 保留（"已经试过几次"的账）
    expect(row && row.workerId).toBeNull();
    expect(row && row.lastError).toMatch(/租约到期/);
    // 回收后**同一个时钟点**即可被再次领取（nextAttemptAt = 回收时刻，无退避）
    expect((await store.claim({ workerId: "w2", limit: 1 })).map((j) => j.id)).toEqual([jobId]);
    expect((await store.get(jobId))!.attempts).toBe(2);
    expect((await store.get(jobId))!.workerId).toBe("w2");
    await db.destroy();
  });

  it("★ 用尽重试 → dead（并把 dedupeActive 置 NULL，允许同键重投）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "dead" } });
    await store.claim({ workerId: "w1", limit: 1 }); // attempts = 1
    expect(await store.fail(jobId, "w1", "boom")).toBe("queued"); // maxAttempts=2 → 回队列
    clock.advance(JOB_POLICY.retryMaxMs + 1);
    await store.claim({ workerId: "w1", limit: 1 }); // attempts = 2
    expect(await store.fail(jobId, "w1", "boom again")).toBe("dead");
    const row = await store.get(jobId);
    expect(row && row.state).toBe("dead");
    expect(row && row.dedupeActive).toBeNull();
    expect(row && row.dedupeKey).toBe("1:test.sleep:dead"); // 原始键保留（审计）
    expect(row && row.lastError).toBe("boom again");
    expect(row && row.finishedAt).toBe(clock.now());
    // 死信可被运维重投
    expect(await store.requeueDead(jobId)).toBe(true);
    expect((await store.get(jobId))!.state).toBe("queued");
    expect((await store.get(jobId))!.dedupeActive).toBe("1:test.sleep:dead"); // 重新占住同一把锁
    expect((await store.get(jobId))!.attempts).toBe(0);
    await db.destroy();
  });

  it("租约过期且额度用尽 → dead（回收路径的死信分支）", async () => {
    const { db, store, clock } = await setup({ globalMaxRunning: 10, perUserMaxRunning: 10 });
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "exp-dead" } });
    await store.claim({ workerId: "w1", limit: 1 }); // attempts = 1
    clock.advance(JOB_POLICY.retryMaxMs + 1);
    await store.claim({ workerId: "w2", limit: 1 }); // attempts = 2 = maxAttempts
    clock.advance(JOB_POLICY.leaseMs + 1);
    expect(await store.reclaimExpired()).toEqual({ requeued: 0, dead: 1 });
    const row = (await store.get(jobId))!;
    expect(row.state).toBe("dead");
    expect(row.dedupeActive).toBeNull();
    expect(row.lastError).toMatch(/用尽重试/);
    await db.destroy();
  });

  it("★ 心跳在租约被夺走后返回 false（handler 据此 abort）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    await store.claim({ workerId: "w1", limit: 1 });
    expect(await store.heartbeat(jobId, "w1")).toBe(true);
    expect(await store.heartbeat(jobId, "w2")).toBe(false); // 别人不是持有者
    clock.advance(JOB_POLICY.leaseMs + 1);
    await store.reclaimExpired(); // 租约被回收
    expect(await store.heartbeat(jobId, "w1")).toBe(false);
    expect(await store.progress(jobId, "w1", 50)).toBe(false);
    await db.destroy();
  });

  it("★ 租约丢失后 succeed/fail 不得覆盖（affected=0 → false）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    await store.claim({ workerId: "w1", limit: 1 });
    clock.advance(JOB_POLICY.leaseMs + 1);
    await store.reclaimExpired();
    expect(await store.succeed(jobId, "w1", {})).toBe(false);
    expect((await store.get(jobId))!.state).toBe("queued");
    // fail 同样不许把"别人的/已回收的"行改写；返回值是它**现在**的真实状态
    expect(await store.fail(jobId, "w1", "late failure")).toBe("queued");
    expect((await store.get(jobId))!.lastError).toMatch(/租约到期/); // 没被 late failure 覆盖
    await db.destroy();
  });

  it("progress 写进度并续租（0..100 夹紧、stage 截断到 64 字符）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1 } });
    const [claimed] = await store.claim({ workerId: "w1", limit: 1 });
    clock.advance(1_000);
    expect(await store.progress(jobId, "w1", 42.4, "s".repeat(100))).toBe(true);
    const row = (await store.get(jobId))!;
    expect(row.progress).toBe(42);
    expect(row.stage).toHaveLength(64);
    expect(row.leaseUntil).toBe((claimed.leaseUntil as number) + 1_000); // 进度更新 = 续租
    expect(await store.progress(jobId, "w1", 999)).toBe(true);
    expect((await store.get(jobId))!.progress).toBe(100);
    expect(await store.progress(jobId, "w1", -5)).toBe(true);
    expect((await store.get(jobId))!.progress).toBe(0);
    await db.destroy();
  });

  it("取消：queued/running 可取消且幂等；终态不可再取消", async () => {
    const { db, store } = await setup();
    const a = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "c1" } });
    expect(await store.cancel(a.jobId, "用户点了停止")).toBe(true);
    expect(await store.cancel(a.jobId, "再来一次")).toBe(false);
    expect((await store.get(a.jobId))!.state).toBe("canceled");
    expect((await store.get(a.jobId))!.dedupeActive).toBeNull();
    // 取消后不许再被领取
    expect(await store.claim({ workerId: "w1", limit: 5 })).toEqual([]);
    // running 也可取消
    const b = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "c2" } });
    await store.claim({ workerId: "w1", limit: 1 });
    expect(await store.cancel(b.jobId)).toBe(true);
    expect((await store.get(b.jobId))!.workerId).toBeNull();
    await db.destroy();
  });

  it("requeueDead 只对 dead 生效（queued 行返回 false，不误改）", async () => {
    const { db, store } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "rq" } });
    expect(await store.requeueDead(jobId)).toBe(false);
    expect(await store.requeueDead(999_999)).toBe(false);
    expect((await store.get(jobId))!.state).toBe("queued");
    await db.destroy();
  });

  it("requeueDead：同类键已有活跃任务时拒绝重投（可诊断，而不是抛唯一键错误）", async () => {
    const { db, store, clock } = await setup();
    const { jobId } = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "dup" } });
    await store.claim({ workerId: "w1", limit: 1 });
    clock.advance(JOB_POLICY.retryMaxMs + 1);
    await store.claim({ workerId: "w1", limit: 1 });
    expect(await store.fail(jobId, "w1", "boom")).toBe("dead");
    // 死信之后同键又入队了一条（新锁）
    const again = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "dup" } });
    expect(again.deduped).toBe(false);
    expect(await store.requeueDead(jobId)).toBe(false); // 锁已被占用 ⇒ 拒绝，不抢
    expect((await store.get(jobId))!.state).toBe("dead");
    await db.destroy();
  });
});

describe("D. 统计、方言形态与错误识别", () => {
  it("activeCounts / stats 与库状态一致", async () => {
    const { db, store } = await setup({ globalMaxRunning: 10, perUserMaxRunning: 5 });
    await store.enqueue({ type: "test.sleep", userId: 3, payload: { ms: 1, tag: "a" } });
    await store.enqueue({ type: "test.sleep", userId: 3, payload: { ms: 1, tag: "b" } });
    await store.enqueue({ type: "test.sleep", userId: 4, payload: { ms: 1, tag: "c" } });
    await store.claim({ workerId: "w1", limit: 10 });
    const caps = await store.activeCounts();
    expect(caps.global).toBe(3);
    expect(caps.perUser["3"]).toBe(2);
    expect(caps.perUser["4"]).toBe(1);
    const stats = await store.stats();
    expect(stats.running).toBe(3);
    expect(stats.queued).toBeUndefined();
    await db.destroy();
  });

  it("activeCounts 不把'租约已过期的僵尸 running'算进额度（否则崩掉的 worker 会永久卡死队列）", async () => {
    const { db, store, clock } = await setup({ globalMaxRunning: 1, perUserMaxRunning: 5 });
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "z" } });
    await store.claim({ workerId: "w1", limit: 1 });
    expect((await store.activeCounts()).global).toBe(1);
    clock.advance(JOB_POLICY.leaseMs + 1);
    expect((await store.activeCounts()).global).toBe(0); // 僵尸不占额度
    // 所以下一个 claim 能立刻接手（内部会先回收它）
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "z2" } });
    expect((await store.claim({ workerId: "w2", limit: 1 })).length).toBe(1);
    await db.destroy();
  });

  it("list 过滤与上限（state / type / limit 夹到 1..500）；**作用域必填**（review-C F5）", async () => {
    const { db, store } = await setup();
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "l1" } });
    await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "l2" } });
    await store.claim({ workerId: "w1", limit: 1 });
    const ALL = { scope: { all: true } } as const;
    expect((await store.list({ ...ALL, state: "running" })).length).toBe(1);
    expect((await store.list({ ...ALL, state: "queued" })).length).toBe(1);
    expect((await store.list({ ...ALL, type: "test.sleep" })).length).toBe(2);
    expect((await store.list({ ...ALL, type: "nope" })).length).toBe(0);
    expect((await store.list(ALL)).length).toBe(2);
    expect((await store.list({ ...ALL, limit: 1 })).length).toBe(1);
    expect((await store.list({ ...ALL, limit: 0 })).length).toBe(1); // 夹到 >=1
    await db.destroy();
  });

  /**
   * ★ review-C F5 的判别力用例：**作用域必须显式**。
   *  - 类型层：`list({ state: "queued" })`（缺 scope）应编译不过（tsc 是判据；见 `JobListFilter`）；
   *  - 运行层：绕过类型的 JS 调用（`as never`）必须**抛错**而不是"默认全量"；
   *  - 语义层：`{scope:{userId}}` 只回该用户的行 —— 另一个用户的行**绝不可见**
   *    （platform 表守卫不注入 userId，所以这一条完全靠调用方显式过滤）。
   */
  it("★ list 的作用域：缺 scope ⇒ 抛错；带他人 userId ⇒ 一条都读不到（1d-3）", async () => {
    const { db, store } = await setup();
    await store.enqueue({ type: "test.sleep", userId: 1001, payload: { ms: 1, tag: "s1" } });
    await store.enqueue({ type: "test.sleep", userId: 1002, payload: { ms: 1, tag: "s2" } });

    // ① 缺 scope（模拟 JS 调用方绕过类型）⇒ 必须抛，不许"默认全量"
    await expect(store.list({ state: "queued" } as never)).rejects.toThrow(/必须显式选择作用域/);

    // ② 显式系统/全量 ⇒ 两条都看得到（这是允许的，但必须**显式**声明）
    expect((await store.list({ scope: { all: true } })).length).toBe(2);

    // ③ 用户可见读取：A 只看到 A 的，B 只看到 B 的（跨租户泄漏的判别力就在这一条）
    const a = await store.list({ scope: { userId: 1001 } });
    const b = await store.list({ scope: { userId: 1002 } });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(Number(a[0].userId)).toBe(1001);
    expect(Number(b[0].userId)).toBe(1002);
    expect(JSON.stringify(a)).not.toContain("s2"); // 不含另一用户的 payload
    await db.destroy();
  });

  it("isDuplicateKeyError 认 sqlite 与 mysql2 两种形状（不靠 message 猜测）", () => {
    expect(isDuplicateKeyError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isDuplicateKeyError({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(true);
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(isDuplicateKeyError(new Error("UNIQUE constraint failed: o_job.dedupeActive"))).toBe(true);
    expect(isDuplicateKeyError(new Error("Duplicate entry 'k' for key 'o_job_dedupe_active_unique'"))).toBe(true);
    expect(isDuplicateKeyError(new Error("connection lost"))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it("★ 方言分支：mysql 编译出 `for update skip locked`，sqlite 不许调用（调用即抛）", async () => {
    const mysql = createKnex({
      ...cfg("unused.sqlite"),
      db: { driver: "mysql", host: "127.0.0.1", port: 3306, user: "u", password: "", name: "n", poolMin: 1, poolMax: 1 },
    } as MiwoConfig);
    const mysqlSql = buildClaimQuery(mysql, { now: 1, limit: 3, lock: true }).toSQL().sql;
    expect(mysqlSql).toContain("for update skip locked");
    // 离线形态证据（**未连真机**）：候选查询的三条过滤条件都在 SQL 里
    // ⚠ 值都是**占位符**（`?`）—— `toSQL()` 不内联绑定值（第一版断言写死了 `= 'queued'`，实测红）
    expect(mysqlSql).toContain("`state` = ?");
    expect(mysqlSql).toContain("`nextAttemptAt` is null");
    expect(mysqlSql).toContain("`nextAttemptAt` <= ?");
    expect(mysqlSql).toContain("`leaseUntil` is null");
    expect(mysqlSql).toContain("`leaseUntil` < ?");
    expect(mysqlSql).toContain("order by `priority` asc, `id` asc");
    // limit 走绑定参数（knex 的 mysql2 方言把它渲染成 `?`）—— 用 bindings 断言，不猜 SQL 文本
    expect(buildClaimQuery(mysql, { now: 1, limit: 3, lock: true }).toSQL().bindings).toContain(3);
    void mysql.destroy();

    const { db } = await setup();
    // sqlite 上调 .skipLocked() 会抛 —— 但**抛点在 `toSQL()`/执行时**，不是链式构建时
    // （实测：`k("o_job").select("id").forUpdate().skipLocked()` 构建成功，`toSQL()` 才抛
    //  ".skipLocked() is currently only supported on MySQL 8.0+ and PostgreSQL 9.5+"）。
    // 这正是"必须分方言"的原因：只在 try/catch 里包**构建**是抓不住的。
    expect(() => buildClaimQuery(db, { now: 1, limit: 3, lock: true }).toSQL()).toThrow(/only supported on MySQL/);
    const plain = buildClaimQuery(db, { now: 1, limit: 3, lock: false }).toSQL().sql;
    expect(plain).not.toContain("for update");
    expect(plain).toContain("`state` = ?");
    await db.destroy();
  });
});

describe("E. 生产接线：受守卫的 u.db + 特权系统身份（o_job/o_gate 必须是 platform）", () => {
  it("policyOf 认这两张表，且都是 platform（换登记就不是放宽判据，是要改理由）", () => {
    expect(policyOf("o_job")).toBe("platform");
    expect(policyOf("o_gate")).toBe("platform");
    expect(TABLE_POLICIES["o_job"]).toBe("platform");
  });

  it("★ facade（@/jobs 的 getJobStore/enqueueJob）接的是受守卫的 u.db：真跑通 enqueue+claim", async () => {
    const { db, registry } = await setup(); // 只借它把库建好
    seq += 1;
    const file = path.join(TMP, `facade${seq}.sqlite`);
    const db2 = createKnex(cfg(file));
    await runMigrations(db2);
    // ⚠ getCtx 必须是**生产的那一个**（`currentTenant`）：store 的特权身份（runAsAuth）正是靠
    //    同一个 AsyncLocalStorage 让守卫看见 admin ctx —— 传 `() => undefined` 会让这条链断掉。
    const guarded = makeTenantAware(db2, { getCtx: currentTenant });
    // 用守卫包住的 handle 冒充 `u.db`：facade 的接线（`u.db` + store 内部的特权身份）就是被验证的对象
    vi.doMock("@/utils", () => ({ default: { db: guarded } }));
    try {
      const facade = await import("@/jobs/index");
      const store = facade.getJobStore(registry as JobRegistry);
      // 自定义 registry ⇒ **不缓存**（不污染单例）；默认 registry ⇒ 单例
      expect(facade.getJobStore(registry as JobRegistry)).not.toBe(store);
      expect(facade.getJobStore()).toBe(facade.getJobStore());
      // 真跑通 enqueue → claim → succeed（全程经守卫 + 特权系统身份）
      const { jobId } = await store.enqueue({ type: "test.sleep", userId: 7, payload: { ms: 1, tag: "facade" } });
      const [claimed] = await store.claim({ workerId: "w1", limit: 1 });
      expect(claimed.id).toBe(jobId);
      expect(await store.succeed(jobId, "w1", { ok: true })).toBe(true);
      expect((await store.get(jobId))!.state).toBe("succeeded");
      // ⚠ `enqueueJob()` 走的是**默认注册表**（现在是空的：Task 7/9 才登记类型）⇒ 现在必须抛"未注册"。
      //   这是**显式**断言，不是"没测到"：Task 7/9 登记 selftest.sleep 之后，这一行要改成真入队。
      await expect(facade.enqueueJob({ type: "test.sleep", userId: 7, payload: { ms: 1 } })).rejects.toThrow(/未注册/);
    } finally {
      vi.doUnmock("@/utils");
      await db2.destroy();
      await db.destroy();
    }
  });

  it("★ 守卫是**真的在生效**：不套系统身份直接写 o_job 会被拒（platform 写要求 admin ctx）", async () => {
    const { db } = await setup();
    const guarded = makeTenantAware(db, { getCtx: currentTenant });
    const row = { userId: 1, type: "test.sleep", payload: "{}", state: "queued", attempts: 0, maxAttempts: 1, priority: 1, progress: 0, createdAt: 1, updatedAt: 1 };
    // 无 ctx：platform 的**写**在构建期就抛（`PlatformWriteDeniedError` 需要 ctx；没有 ctx 抛 TenantContextError）
    expect(() => guarded("o_job").insert(row)).toThrow(/没有租户上下文/);
    // role=user 的 ctx：被 PlatformWriteDeniedError 拒（"平台表只允许管理员写、或由特权原语代行"）
    await expect(
      runWithTenant({ userId: 7, role: "user", requestId: "r", source: "http" }, async () => {
        await guarded("o_job").insert(row);
      }),
    ).rejects.toThrow(/平台表/);
    // 未声明的表在守卫下 fail-closed（这就是"登记不是放宽判据"的另一面）
    expect(() => guarded("o_unknown_table")).toThrow(/未在 policies.ts 声明策略/);
    await db.destroy();
  });

  it("★★ 若把 o_job 登记成 tenant，系统身份（userId=0）的 claim 一条都领不到 —— 这就是它必须是 platform 的理由", async () => {
    const { db, registry } = await setup();
    // 直接往库里塞一条"别人的"排队任务（绕过守卫，模拟另一个租户入队的行）
    const ts = 1_700_000_000_000;
    await db("o_job").insert({ userId: 7, type: "test.sleep", payload: "{}", state: "queued", attempts: 0, maxAttempts: 1, priority: 1, progress: 0, createdAt: ts, updatedAt: ts });
    // 只改登记（策略表），别的都不动 —— 守卫仍然接生产的那套 getCtx（currentTenant）
    const asTenant = makeTenantAware(db, { getCtx: currentTenant, policies: { ...TABLE_POLICIES, o_job: "tenant" } });
    const store = createJobStore({ db: asTenant as unknown as Knex, registry, policy: { ...JOB_POLICY, globalMaxRunning: 10, perUserMaxRunning: 10 } });
    expect(await store.claim({ workerId: "w1", limit: 5 })).toEqual([]); // 注入的 userId=0 ⇒ 查不到别人的任务
    expect(await store.activeCounts()).toEqual({ global: 0, perUser: {} });
    // 同一份数据、同一套代码，只是把登记改回 platform ⇒ 立刻能领到
    const asPlatform = createJobStore({ db, registry, policy: { ...JOB_POLICY, globalMaxRunning: 10, perUserMaxRunning: 10 } });
    const claimed = await asPlatform.claim({ workerId: "w1", limit: 5 });
    expect(claimed.map((j) => j.id)).toEqual([1]);
    expect(claimed[0].userId).toBe(7); // 归属仍如实带回来（跨租户领取是**合法**的：worker 代表系统调度）
    await db.destroy();
  });

  it("★ 业务 handler 的 ctx 是 role=user（拿不到 platform 写）：withJobTenant 与 store 的特权身份是两件事", async () => {
    const { db } = await setup();
    const guarded = makeTenantAware(db, { getCtx: currentTenant });
    await expect(
      withJobTenant(7, async () => {
        await guarded("o_job").update({ progress: 1 }).where("id", 1);
      }),
    ).rejects.toThrow(/平台表/);
    // 对比：同一个 handle 在**系统身份**里写就成功（这就是 store 内部的 asSystem 做的事）
    const { runAsAuth } = await import("@/db/noContext");
    await runAsAuth(async () => {
      await guarded("o_job").update({ progress: 2 }).where("id", 1);
    });
    await db.destroy();
  });
});

describe("F. 队列状态机的收尾不变式", () => {
  it("终态行一定满足 dedupeActive is null（succeeded/dead/canceled 三条路径都验证）", async () => {
    const { db, store, clock } = await setup();
    const a = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "s" } });
    await store.claim({ workerId: "w1", limit: 1 });
    await store.succeed(a.jobId, "w1", null);
    const b = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "d" } });
    await store.claim({ workerId: "w1", limit: 1 });
    clock.advance(JOB_POLICY.retryMaxMs + 1);
    await store.claim({ workerId: "w1", limit: 1 });
    await store.fail(b.jobId, "w1", "boom");
    const c = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag: "c" } });
    await store.cancel(c.jobId);
    const states: Array<[number, JobState]> = [
      [a.jobId, "succeeded"],
      [b.jobId, "dead"],
      [c.jobId, "canceled"],
    ];
    for (const [id, want] of states) {
      const row = (await store.get(id))!;
      expect(row.state).toBe(want);
      expect(row.dedupeActive).toBeNull();
      expect(row.leaseUntil).toBeNull();
      expect(row.workerId).toBeNull();
    }
    // 三条都进了终态 ⇒ 同键可以再投（一把锁都不剩）
    for (const tag of ["s", "d", "c"]) {
      const again = await store.enqueue({ type: "test.sleep", userId: 1, payload: { ms: 1, tag } });
      expect(again.deduped).toBe(false);
    }
    await db.destroy();
  });
});
