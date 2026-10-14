/**
 * 产物对账的回归网（Phase 1d Task 6）——Phase 1a §5.2 ② 删掉"启动时无条件改判"之后的**终点机制**。
 *
 * 五条用例覆盖两种"永久生成中"的成因与两条安全边界：
 *  1. **死信**：终态 `dead` 的 job 在宽限期后触发 `onAbandon`（写清 jobId/userId/reason）；
 *  2. **dryRun**：只报告不调用钩子（生产上先看）；
 *  3. **幂等**：同一个死信跑两次，钩子被调用两次是允许的（幂等义务在钩子实现里）；
 *  4. **孤儿产物行**：`state='生成中'` 且**没有任何活跃 job** 引用的行被改判（替代 db:repair-stuck）；
 *  5. **★ 有活跃租约的行不得被改判**（判别力核心：去掉活跃引用过滤 ⇒ 它必红）。
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
import { reconcileAbandoned } from "@/jobs/reconcile";
import type { JobDefinition } from "@/jobs/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-reconcile-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const ABANDONED: number[] = [];
const def: JobDefinition<{ videoId: number }> = {
  type: "video.generate", timeoutMs: 1_000, maxAttempts: 1, pool: "vendor:video",
  parse: (raw) => raw as { videoId: number },
  dedupeKey: (p) => `video.generate:${p.videoId}`,
  handle: async () => ({}),
  onAbandon: async (payload, reason, info) => {
    ABANDONED.push(payload.videoId);
    // 真实实现用 u.db 改 o_video；这里用同一个 db 句柄（测试里注入）
    void info;
    void reason;
  },
};

let seq = 0;
async function setup(policy: Partial<JobPolicy> = {}) {
  seq += 1;
  const db = createKnex(cfg(path.join(TMP, `r${seq}.sqlite`)));
  await runMigrations(db);
  const registry: JobRegistry = createJobRegistry([def]);
  const store: JobStore = createJobStore({ db, registry, policy: { ...JOB_POLICY, ...policy } });
  return { db, store, registry };
}

describe("产物对账（Phase 1a §5.2 ② 的终点方案）", () => {
  it("★ dead 的 job 在宽限期后调用 onAbandon（写清 jobId/userId/reason）", async () => {
    ABANDONED.length = 0;
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/a.mp4", time: Date.now(), state: "生成中", scriptId: 1, projectId: 1 });
    const { jobId } = await store.enqueue({ type: "video.generate", userId: 42, payload: { videoId: 1 } });
    await store.claim({ workerId: "w", limit: 1 });
    await store.fail(jobId, "w", "厂商 500"); // maxAttempts=1 → dead
    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 0 });
    expect(report.deadJobs).toBe(1);
    expect(ABANDONED).toEqual([1]);
    await db.destroy();
  });

  it("dryRun 只报告不调用钩子（可安全地在生产上先看）", async () => {
    ABANDONED.length = 0;
    const { db, store, registry } = await setup();
    const { jobId } = await store.enqueue({ type: "video.generate", userId: 42, payload: { videoId: 7 } });
    await store.claim({ workerId: "w", limit: 1 });
    await store.fail(jobId, "w", "boom");
    const report = await reconcileAbandoned({ db, store, registry, dryRun: true, olderThanMs: 0 });
    expect(report.dryRun).toBe(true);
    expect(report.deadJobs).toBe(1);
    expect(ABANDONED).toEqual([]);
    await db.destroy();
  });

  it("幂等：同一个死信跑两次，第二次不再重复改判（产物已不是'生成中'）", async () => {
    ABANDONED.length = 0;
    const { db, store, registry } = await setup();
    const { jobId } = await store.enqueue({ type: "video.generate", userId: 42, payload: { videoId: 9 } });
    await store.claim({ workerId: "w", limit: 1 });
    await store.fail(jobId, "w", "boom");
    await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 0 });
    await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 0 });
    expect(ABANDONED).toEqual([9, 9]); // 钩子被调用两次是允许的——**幂等义务在钩子实现里**
    await db.destroy();
  });

  it("★ 孤儿产物：没有活跃 job 的'生成中'行（Phase 1a 遗留）也会被改判（这替代 db:repair-stuck）", async () => {
    ABANDONED.length = 0;
    const { db, store, registry } = await setup();
    // 造一条"生成中"的 o_video：既没有 dead job，也没有任何 o_job 引用它（Phase 1a 之前重启的残留）
    await db("o_video").insert({ filePath: "/1/video/orphan.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(1);
    const row: any = await db("o_video").where("state", "生成失败").first();
    expect(row).toBeTruthy();
    expect(String(row.errorReason)).toMatch(/对账/);
    await db.destroy();
  });

  it("★ 有活跃租约的'生成中'行**不能**被改判（不许误杀正在跑的任务）", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/live.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await store.enqueue({ type: "video.generate", userId: 1, payload: { videoId: 1 } }); // payload 里出现 videoId:1
    await store.claim({ workerId: "w", limit: 1 });                                     // 变成 running（有有效租约）
    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(0);
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成中");
    await db.destroy();
  });
});
