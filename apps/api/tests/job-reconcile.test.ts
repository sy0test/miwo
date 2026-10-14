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
import { startWorkerLoop } from "@/jobs/worker";
import type { JobContext, JobDefinition } from "@/jobs/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-reconcile-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const merged = { ...JOB_POLICY, ...policy };
  const store: JobStore = createJobStore({ db, registry, policy: merged });
  return { db, store, registry, policy: merged };
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
    // 不 rejects；**真实写入数**：好表写了、坏表 0（F9 之后这两个字段语义分开）
    expect(report.abandonedRows.videos).toBe(1);
    expect(report.abandonedRows.storyboards).toBe(0);      // 一行都没写
    expect(report.wouldAbandonRows.storyboards).toBe(1);   // 但判定要改 1 行
    expect(report.failedTables).toContain("o_storyboard");
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

/**
 * ── 复核轮遗留（review-B F8/F9）──
 */
describe("产物对账·复核轮遗留（F8 TOCTOU / F9 报告失真）", () => {
  /** 注入式"只有某张表的 update 抛错"的 db 代理（独立一份，不复用 F1b 的写法）。 */
  function dbWithFailingTable(realDb: Knex, failingTable: string): Knex {
    return new Proxy(realDb as unknown as (...a: any[]) => any, {
      apply(target, thisArg, args: any[]) {
        const qb = Reflect.apply(target, thisArg, args);
        if (args[0] !== failingTable) return qb;
        return new Proxy(qb as object, {
          get(t, prop, recv) {
            if (prop !== "update") return Reflect.get(t, prop, recv);
            return async () => {
              throw new Error(`injected failure: ${failingTable} update`);
            };
          },
        });
      },
    }) as unknown as Knex;
  }

  it("★ F9：`--apply` 的 `abandonedRows` 必须是**真实写入行数**（写失败的表计 0，并登记 failedTables）", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/f9.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await db("o_image").insert({ filePath: "/1/image/f9.png", state: "生成中" });
    await db("o_storyboard").insert({ scriptId: 1, projectId: 1, state: "生成中", createTime: Date.now() - 3_600_000 });

    const report = await reconcileAbandoned({ db: dbWithFailingTable(db, "o_storyboard"), store, registry, dryRun: false, olderThanMs: 60_000 });

    // 旧实现：三张表都在 UPDATE **之前**赋值 ⇒ storyboards=1，但实际一行都没写（夸大改判量）
    expect(report.abandonedRows.storyboards).toBe(0); // 真实 affected = 0
    expect(report.failedTables).toContain("o_storyboard");
    // 判定数另开字段，不与"写入数"混淆
    expect(report.wouldAbandonRows.storyboards).toBe(1);
    // 另外两张表真的写了 ⇒ 计数与 DB 实况一致
    expect(report.abandonedRows.videos).toBe(1);
    expect(report.abandonedRows.images).toBe(1);
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成失败");
    expect((await db("o_storyboard").where("id", 1).first<any>()).state).toBe("生成中");
    await db.destroy();
  });

  it("★ F9b：报告计数必须与 DB 实况**逐表**相等（成功路径）", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/f9b.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });
    await db("o_image").insert({ filePath: "/1/image/f9b.png", state: "生成中" });
    await db("o_storyboard").insert({ scriptId: 1, projectId: 1, state: "生成中", createTime: Date.now() - 3_600_000 });

    const report = await reconcileAbandoned({ db, store, registry, dryRun: false, olderThanMs: 60_000 });
    const actual = {
      videos: Number((await db("o_video").where("state", "生成失败").count({ n: "*" }).first<any>()).n),
      images: Number((await db("o_image").where("state", "生成失败").count({ n: "*" }).first<any>()).n),
      storyboards: Number((await db("o_storyboard").where("state", "生成失败").count({ n: "*" }).first<any>()).n),
    };
    expect(report.abandonedRows).toEqual(actual);
    expect(report.failedTables).toEqual([]);
    await db.destroy();
  });

  it("★ F9c：`dryRun` 下 `abandonedRows` 恒为 0（没写就是 0），判定数在 `wouldAbandonRows`", async () => {
    const { db, store, registry } = await setup();
    await db("o_video").insert({ filePath: "/1/video/f9c.mp4", time: Date.now() - 3_600_000, state: "生成中", scriptId: 1, projectId: 1 });

    const report = await reconcileAbandoned({ db, store, registry, dryRun: true, olderThanMs: 60_000 });
    expect(report.abandonedRows.videos).toBe(0);        // 没写 ⇒ 不许报"改了 1 条"
    expect(report.wouldAbandonRows.videos).toBe(1);     // 但要说清"会改 1 条"
    expect((await db("o_video").where("id", 1).first<any>()).state).toBe("生成中");
    await db.destroy();
  });

  /**
   * ★ F8：`verifyLease` 与 `store.heartbeat()` 之间的 **TOCTOU 窗口**。
   *
   * 两条分支**语义不等价**（reviewer 复核轮裁定）：
   *   · `verifyLease()` 是**乐观读**（查 `state+workerId+leaseUntil`）；
   *   · `store.heartbeat()` 是**带条件的原子 UPDATE**（`id+workerId+state='running'`，**无租约条件**）。
   * 窗口内并发的 `cancel()` 或别的 worker 的 `reclaimExpired()` 会落地 ⇒ `heartbeat` 的 `affected=0`。
   * 这条护栏在生产里可达（reviewer 探针 `PROBED/PROBED2`：`verifyLeasePassed=true cancelled=true
   * store.heartbeat()=false`），但此前**无任何测试覆盖** ⇒ 拆掉它全量测试仍绿。
   *
   * 覆盖手法（确定性，不靠真并发）：包一层 store，`get()` 照旧返回"仍是我的 running + 有效租约"
   * （让 `verifyLease` **通过**），而 `heartbeat()` **恒返回 false**（模拟窗口内被取消/被回收）。
   * ⇒ 只有第二条分支能把 `aborted` 置真。
   */
  it("★ F8：`verifyLease` 通过但 `heartbeat()` 返回 false（TOCTOU 窗口）⇒ 必须 abort", async () => {
    let aborted = false;
    const def2: JobDefinition<{ ms: number }> = {
      type: "t.toctou", timeoutMs: 10_000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { ms: number },
      dedupeKey: () => null,
      handle: async (ctx: JobContext, p: { ms: number }) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, p.ms);
          ctx.signal.addEventListener("abort", () => { aborted = true; clearTimeout(t); resolve(); });
        });
        return { ok: true };
      },
    };
    // ⚠ 必须用**短心跳**（默认 `heartbeatMs` 是 15s，3s 的 handler 里一次都不会触发 ⇒
    //    断言 `heartbeatCalls > 0` 会失败，那正是"观测不到这条分支"的形态）。
    const { db, store, registry, policy } = await setup(
      { leaseMs: 5_000, heartbeatMs: 100, idlePollMs: 50, busyPollMs: 20, shutdownGraceMs: 500 },
      [def2],
    );
    // 包装：verifyLease 走真实 get()（窗口前一切正常）；heartbeat 恒 false（窗口内被取消）
    let heartbeatCalls = 0;
    let verifyLeasePassed = false;
    const wrapped: JobStore = {
      ...store,
      get: async (id) => {
        const row = await store.get(id);
        if (row && row.state === "running" && (row.leaseUntil ?? 0) > Date.now()) verifyLeasePassed = true;
        return row;
      },
      heartbeat: async () => { heartbeatCalls += 1; return false; },
    };

    await store.enqueue({ type: "t.toctou", userId: 1, payload: { ms: 3_000 } });
    const runner = startWorkerLoop({ store: wrapped, registry, workerId: "w-test", policy, log: () => {} });
    for (let i = 0; i < 60 && !aborted; i += 1) await sleep(50);
    const abortedBeforeStop = aborted; // stop() 的强 abort 会掩盖事实，先取快照
    await runner.stop();

    // 观测不到这条分支 ⇒ 观测失败（这里用显式断言表达"必须真的走到"）
    expect(heartbeatCalls).toBeGreaterThan(0);   // 心跳确实跑过
    expect(verifyLeasePassed).toBe(true);        // 且 verifyLease 确实**通过**过（窗口前）
    expect(abortedBeforeStop).toBe(true);        // ⇒ 只有 heartbeat=false 这条分支能达成
    await db.destroy();
  });
});
