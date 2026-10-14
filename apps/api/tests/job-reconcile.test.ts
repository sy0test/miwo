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
import { mentionsId, reconcileAbandoned } from "@/jobs/reconcile";
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

/**
 * Task 7 的**真实** payload 形状（`task-7-brief.md:43`）：`storyboardIds` 是**复数数组**，
 * 不是标量 `storyboardId`。High-2 就是按这个形状复现"活跃任务被误杀"的。
 */
const SB_ABANDONED: number[][] = [];
const sbDef: JobDefinition<{ projectId: number; scriptId: number; storyboardIds: number[]; compulsory: boolean }> = {
  type: "image.storyboard.batch", timeoutMs: 1_000, maxAttempts: 1, pool: "vendor:image",
  parse: (raw) => raw as { projectId: number; scriptId: number; storyboardIds: number[]; compulsory: boolean },
  dedupeKey: (p) => `image.storyboard.batch:${p.scriptId}:${p.storyboardIds.join(",")}`,
  handle: async () => ({}),
  onAbandon: async (payload) => {
    SB_ABANDONED.push(payload.storyboardIds);
  },
};

let seq = 0;
async function setup(policy: Partial<JobPolicy> = {}, extraDefs: Array<JobDefinition<any>> = []) {
  seq += 1;
  const db = createKnex(cfg(path.join(TMP, `r${seq}.sqlite`)));
  await runMigrations(db);
  const registry: JobRegistry = createJobRegistry([def, ...extraDefs]);
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

/**
 * ── 修复轮（review-B F1/F2/F3/F4）的用例 ──
 * 每条都是**先红后绿**：对 6f86f1c 的实现跑这些用例，F1/F2/F3/F4 对应条目会红（证据见 groupB-report.md）。
 */
describe("产物对账·修复轮（review-B F1–F4）", () => {
  it("★ F1：`o_storyboard` 的失败原因写**真列** `reason`（不是 `errorReason`），且对账整体不 rejects", async () => {
    const { db, store, registry } = await setup();
    // 两张表各留一条孤儿：旧实现会在 o_storyboard 上抛 `no such column: errorReason`
    await db("o_video").insert({ filePath: "/1/video/f1.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await db("o_storyboard").insert({ scriptId: 1, projectId: 1, state: "生成中", createTime: Date.now() - 3_600_000 });

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(1);
    expect(report.abandonedRows.storyboards).toBe(1);

    // o_storyboard 必须真的被改判，且原因写在**存在的**列 `reason` 上
    const sb: any = await db("o_storyboard").where("state", "生成失败").first();
    expect(sb).toBeTruthy();
    expect(String(sb.reason)).toMatch(/对账/);
    // o_video 同时被改判（两张表都成功，不存在"前一张提交、后一张抛错"的半应用）
    expect((await db("o_video").where("state", "生成失败").first())).toBeTruthy();
    await db.destroy();
  });

  it("★ F1b：B 段一张表失败**不得**让整次对账 rejects，也不得留下半提交（逐表隔离）", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/f1b.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await db("o_storyboard").insert({ scriptId: 1, projectId: 1, state: "生成中", createTime: Date.now() - 3_600_000 });

    // 注入式故障：只让对 `o_storyboard` 的 update 抛错，模拟"某张表列名/约束不对"
    const realDb = db;
    const broken = new Proxy(realDb as unknown as (...a: any[]) => any, {
      apply(target, thisArg, args: any[]) {
        const qb = Reflect.apply(target, thisArg, args);
        if (args[0] !== "o_storyboard") return qb;
        return new Proxy(qb as object, {
          get(t, prop, recv) {
            if (prop !== "update") return Reflect.get(t, prop, recv);
            return async () => {
              throw new Error("injected failure: o_storyboard update");
            };
          },
        });
      },
    }) as unknown as Knex;

    const report = await reconcileAbandoned({ db: broken, store, registry, dryRun: false, olderThanMs: 60_000 });
    // 不 rejects，且报告如实反映两张表的判定
    expect(report.abandonedRows.videos).toBe(1);
    expect(report.abandonedRows.storyboards).toBe(1);
    // o_video 已被改判（隔离生效：坏表不影响好表）
    expect((await realDb("o_video").where("state", "生成失败").first())).toBeTruthy();
    // o_storyboard 仍是"生成中"（它那张表确实失败了）——但**没有**半提交的静默假绿
    expect((await realDb("o_storyboard").where("id", 1).first<any>()).state).toBe("生成中");
    await realDb.destroy();
  });

  it("★ F2：Task 7 真实 payload `storyboardIds:[N]` 的活跃任务**不得**被误杀", async () => {
    SB_ABANDONED.length = 0;
    const { db, store, registry } = await setup({}, [sbDef]);
    await db("o_storyboard").insert({ scriptId: 1, projectId: 1, state: "生成中", createTime: Date.now() - 3_600_000 });
    // 真实形状（task-7-brief.md:43）：复数数组
    await store.enqueue({ type: "image.storyboard.batch", userId: 1, payload: { projectId: 1, scriptId: 1, storyboardIds: [1], compulsory: false } });
    await store.claim({ workerId: "w", limit: 1 }); // running（有效租约）

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.storyboards).toBe(0); // 旧实现这里是 1（误杀）
    expect((await db("o_storyboard").where("id", 1).first<any>()).state).toBe("生成中");
    await db.destroy();
  });

  it("★ F3：**僵尸租约**（running 但租约已过期）不得保护产物行", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/zombie.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await store.enqueue({ type: "video.generate", userId: 1, payload: { videoId: 1 } });
    await store.claim({ workerId: "w", limit: 1 }); // running
    // 持有者崩了、没人回收：租约推到过期
    await db("o_job").where("state", "running").update({ leaseUntil: Date.now() - 1 });

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(1); // 旧实现这里是 0（永久钉住"生成中"）
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成失败");
    await db.destroy();
  });

  it("★ F3b：租约**未过期**的 running 仍然受保护（反例自证：上一条不是因为\"什么都不扫\"）", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/live2.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await store.enqueue({ type: "video.generate", userId: 1, payload: { videoId: 1 } });
    await store.claim({ workerId: "w", limit: 1 });
    await db("o_job").where("state", "running").update({ leaseUntil: Date.now() + 600_000 });

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(0);
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成中");
    await db.destroy();
  });

  it("★ F4：`mentionsId` 按 JSON 键值边界匹配（1 不得被 12 保护；标量/数组/嵌套/空格都要对）", () => {
    // 前缀盲点：旧实现用裸子串 `"videoId":1` ⇒ 命中 `"videoId":12`
    expect(mentionsId(['{"videoId":12}'], "videoId", 1)).toBe(false);
    expect(mentionsId(['{"videoId":12}'], "videoId", 12)).toBe(true);
    // 边界：后面跟 `}` / `,` / 空白
    expect(mentionsId(['{"videoId":1}'], "videoId", 1)).toBe(true);
    expect(mentionsId(['{"videoId":1, "x":2}'], "videoId", 1)).toBe(true);
    expect(mentionsId(['{"videoId": 1 }'], "videoId", 1)).toBe(true);
    expect(mentionsId(['{"videoId": 12 }'], "videoId", 1)).toBe(false);
    // 数组形状（Task 7 的 `storyboardIds`）
    expect(mentionsId(['{"storyboardIds":[1,2,3]}'], "storyboardIds", 2)).toBe(true);
    expect(mentionsId(['{"storyboardIds":[11,12]}'], "storyboardIds", 1)).toBe(false);
    // 嵌套（Task 7 的 `items:[{videoId}]`）
    expect(mentionsId(['{"items":[{"videoId":7}]}'], "videoId", 7)).toBe(true);
    expect(mentionsId(['{"items":[{"videoId":70}]}'], "videoId", 7)).toBe(false);
    // 字符串里的数字不算（类型敏感）：`"videoId":"1"` 不是 number
    expect(mentionsId(['{"videoId":"1"}'], "videoId", 1)).toBe(false);
    // 坏 JSON 不得抛（脏数据只应"不保护"，不能崩对账）
    expect(mentionsId(["not json"], "videoId", 1)).toBe(false);
  });

  it("★ F4b：13 行里只有 id=12 有活跃任务 ⇒ 改判 12 条（不是旧实现的 11 条）", async () => {
    const { db, store, registry } = await setup();
    const base = Date.now() - 3_600_000;
    for (let i = 1; i <= 13; i += 1) {
      await db("o_video").insert({ id: i, filePath: `/1/video/m${i}.mp4`, time: base, state: "生成中", scriptId: 1, projectId: 1 });
    }
    await store.enqueue({ type: "video.generate", userId: 1, payload: { videoId: 12 } });
    await store.claim({ workerId: "w", limit: 1 }); // 只有 12 受保护

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(12); // 旧实现是 11（id=1 被 "videoId":12 前缀误保护）
    expect((await db("o_video").where("id", 12).first<any>()).state).toBe("生成中");
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成失败");
    await db.destroy();
  });
});
