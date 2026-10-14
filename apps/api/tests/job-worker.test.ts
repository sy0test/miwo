/**
 * worker 循环的回归网（Phase 1d Task 4 / spec §9.2 §9.3）。
 *
 * 五条用例覆盖 worker 的四个职责：
 *  1. **限流**：并发峰值不超过 `globalMaxRunning`，且**真的并发跑过**（`peak > 0` —— 反恒真断言：
 *     若把 `peak` 恒为 0，第 2 条断言会红，所以"峰值 ≤ 上限"这条不可能靠"从没跑过"混过去）；
 *  2. **脏数据**：未注册的任务类型判死，但**不许让循环崩**（后续任务照样跑）；
 *  3. **★ 租约丢失 → abort**：这是"租约被回收/被取消"时唯一能阻止 handler 继续写产物的机制；
 *  4. **超时**：按失败处理，不把 worker 挂住；
 *  5. **优雅停机**：等在跑任务收尾，之后 `inFlight()` 归零且 `done` 兑现。
 *
 * 测试策略：真的短租约（不用假时钟 —— worker 里有真实的 setInterval/超时）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { JOB_POLICY, type JobPolicy } from "@/jobs/policy";
import { createJobRegistry, type JobRegistry } from "@/jobs/registry";
import { createJobStore, type JobStore } from "@/jobs/store";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { startWorkerLoop } from "@/jobs/worker";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-worker-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 测试策略：真的短租约（不用假时钟——worker 里有真实的 setInterval/超时）。 */
const FAST: JobPolicy = { ...JOB_POLICY, leaseMs: 400, heartbeatMs: 100, idlePollMs: 50, busyPollMs: 20, shutdownGraceMs: 500, retryBaseMs: 10, retryMaxMs: 20 };

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

let seq = 0;
async function setup(defs: Array<JobDefinition<any>>, policy: Partial<JobPolicy> = {}) {
  seq += 1;
  const db = createKnex(cfg(path.join(TMP, `w${seq}.sqlite`)));
  await runMigrations(db);
  const registry: JobRegistry = createJobRegistry(defs);
  const store: JobStore = createJobStore({ db, registry, policy: { ...FAST, ...policy } });
  return { db, store, registry, policy: { ...FAST, ...policy } };
}

describe("worker 循环（spec §9.2/§9.3）", () => {
  it("跑完所有已入队任务；并发峰值不超过 globalMaxRunning", async () => {
    let running = 0;
    let peak = 0;
    const def: JobDefinition<{ ms: number }> = {
      type: "t.peak", timeoutMs: 5_000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (_ctx: JobContext, p: { ms: number }) => {
        running += 1; peak = Math.max(peak, running);
        await sleep(p.ms);
        running -= 1;
        return { ok: true };
      },
    };
    const { db, store, registry, policy } = await setup([def], { globalMaxRunning: 2 });
    for (let i = 0; i < 6; i += 1) await store.enqueue({ type: "t.peak", userId: 1, payload: { ms: 60 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    for (let i = 0; i < 100; i += 1) {
      const s = await store.stats();
      if ((s.succeeded ?? 0) === 6) break;
      await sleep(50);
    }
    await runner.stop();
    const s = await store.stats();
    expect(s.succeeded).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0); // 反恒真：证明真的并发跑过
    await db.destroy();
  });

  it("未知任务类型：判失败（不崩循环），后续任务照样跑", async () => {
    const def: JobDefinition<{ ms: number }> = {
      type: "t.ok", timeoutMs: 5_000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async () => ({ ok: true }),
    };
    const { db, store, registry, policy } = await setup([def]);
    const now = Date.now();
    // 直接插一条未注册类型的任务（模拟"部署了旧 handler"或脏数据）
    await db("o_job").insert({ userId: 1, type: "t.unknown", payload: "{}", state: "queued", attempts: 0, maxAttempts: 1, priority: 1, progress: 0, createdAt: now, updatedAt: now });
    await store.enqueue({ type: "t.ok", userId: 1, payload: { ms: 1 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    for (let i = 0; i < 60; i += 1) {
      const rows = await store.list({ limit: 10 });
      if (rows.every((r) => r.state === "dead" || r.state === "succeeded")) break;
      await sleep(50);
    }
    await runner.stop();
    const unknown = (await store.list({ limit: 10 })).find((r) => r.type === "t.unknown");
    expect(unknown?.state).toBe("dead");
    expect(unknown?.lastError).toMatch(/未知任务类型/);
    expect((await store.stats()).succeeded).toBe(1);
    await db.destroy();
  });

  it("★ 租约丢失 → 正在跑的 handler 被 abort，且不得写成功", async () => {
    let aborted = false;
    let wrote = false;
    const def: JobDefinition<{ ms: number }> = {
      type: "t.lease", timeoutMs: 10_000, maxAttempts: 2, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (ctx: JobContext, p: { ms: number }) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, p.ms);
          ctx.signal.addEventListener("abort", () => { aborted = true; clearTimeout(t); resolve(); });
        });
        if (!ctx.signal.aborted) wrote = true; // abort 之后不能再"完成"
        return { ok: true };
      },
    };
    const { db, store, registry, policy } = await setup([def]);
    await store.enqueue({ type: "t.lease", userId: 1, payload: { ms: 3_000 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    await sleep(150);                              // 让它领到并进入 handler
    await sleep(policy.leaseMs + 150);             // 心跳会先续租；这里直接强夺（模拟时钟跳变/长 GC）
    await db("o_job").update({ leaseUntil: Date.now() - 1 }).where("state", "running");
    for (let i = 0; i < 60 && !aborted; i += 1) await sleep(50);
    await runner.stop();
    expect(aborted).toBe(true);
    expect(wrote).toBe(false);
    await db.destroy();
  });

  /**
   * ★ 修复轮 Med-3（review-B F5）：**心跳路径的隔离用例**。
   *
   * 为什么原用例对"心跳路径"没有判别力：原用例的 `maxAttempts:2` 在强夺租约后会走
   * **回收 → 重领 → supersede** 那条路，于是三条 abort 路径（`verifyLease` / `heartbeat` /
   * supersede）任一条存活都能让它绿。reviewer 四档篡改实测：单拆任一条**仍绿**，全拆才红。
   *
   * 隔离手法（reviewer 已验证可行）：`maxAttempts: 1` ⇒ 租约一到期回收方就把它判成 `dead`
   * （终态），**永远不会被重领** ⇒ supersede 路径不可达 ⇒ 只剩心跳的两条分支能 abort。
   * 这样"拆掉心跳的任一条分支"就必须红（实测：只拆一条仍绿 —— 两条分支互为兜底，属设计内的
   * 冗余；**两条一起拆必红**，见 groupB-report.md 修复轮证据）。
   */
  it("★ 心跳路径隔离（maxAttempts=1，supersede 不可达）：租约丢失必须由心跳 abort", async () => {
    let aborted = false;
    let wrote = false;
    const def: JobDefinition<{ ms: number }> = {
      type: "t.lease-hb", timeoutMs: 10_000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (ctx: JobContext, p: { ms: number }) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, p.ms);
          ctx.signal.addEventListener("abort", () => { aborted = true; clearTimeout(t); resolve(); });
        });
        if (!ctx.signal.aborted) wrote = true;
        return { ok: true };
      },
    };
    const { db, store, registry, policy } = await setup([def]);
    await store.enqueue({ type: "t.lease-hb", userId: 1, payload: { ms: 5_000 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    await sleep(150);
    // 强夺租约（模拟时钟跳变/长 GC）。maxAttempts=1 ⇒ 回收即 dead ⇒ 不会被重领 ⇒ 无 supersede。
    await db("o_job").update({ leaseUntil: Date.now() - 1 }).where("state", "running");
    for (let i = 0; i < 80 && !aborted; i += 1) await sleep(50);
    await runner.stop();
    expect(aborted).toBe(true);   // 只有心跳两条分支能达成这一条
    expect(wrote).toBe(false);
    expect((await store.list({ limit: 5 }))[0]?.state).toBe("dead"); // 证明真的走了"回收即死"这条路
    await db.destroy();
  });

  it("超时 → 按失败处理（maxAttempts=1 时进 dead），不会把 worker 挂住", async () => {    const def: JobDefinition<{ ms: number }> = {
      type: "t.timeout", timeoutMs: 100, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (_ctx: JobContext, p: { ms: number }) => sleep(p.ms).then(() => ({ ok: true })),
    };
    const { db, store, registry, policy } = await setup([def]);
    await store.enqueue({ type: "t.timeout", userId: 1, payload: { ms: 5_000 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    for (let i = 0; i < 60; i += 1) {
      if (((await store.stats()).dead ?? 0) === 1) break;
      await sleep(50);
    }
    await runner.stop();
    const row = (await store.list({ limit: 5 }))[0];
    expect(row.state).toBe("dead");
    expect(row.lastError).toMatch(/超时|中止/);
    await db.destroy();
  });

  it("stop() 优雅退出：等待在跑任务收尾，之后 inFlight 归零且 done 兑现", async () => {
    let finished = false;
    const def: JobDefinition<{ ms: number }> = {
      type: "t.stop", timeoutMs: 5_000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (_ctx: JobContext, p: { ms: number }) => { await sleep(p.ms); finished = true; return {}; },
    };
    const { db, store, registry, policy } = await setup([def]);
    await store.enqueue({ type: "t.stop", userId: 1, payload: { ms: 200 } });
    const runner = startWorkerLoop({ store, registry, workerId: "w-test", policy, log: () => {} });
    await sleep(100);
    await runner.stop();
    await runner.done;
    expect(runner.inFlight()).toBe(0);
    expect(finished).toBe(true);
    expect((await store.stats()).succeeded).toBe(1);
    await db.destroy();
  });
});
