/**
 * `selftest.sleep` —— 队列自身的冒烟/混沌任务。
 *
 * 它是**正式的运维入口**（Task 10 的 `job:admin --enqueue-selftest`），不是"只在测试里注册"的东西：
 *   - 冒烟：部署后入队一条，确认 worker 真的能领走并跑完（比"进程活着"强得多）；
 *   - chaos：Task 10 的多进程 harness 用它来验证租约回收、并发上限、零丢失。
 * 它不碰任何业务表，因此对生产库是安全的。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "@/config";
import type { JobDefinition } from "@/jobs/types";

export interface SelftestPayload {
  ms: number;
  tag?: string;
}

/**
 * 事件流（JSONL）：`${MIWO_DATA_DIR}/job-selftest.jsonl`。
 *
 * 为什么需要它：Task 10 的 `job-chaos.cjs` 要断言 **① 无重叠执行**（同一 jobId 的区间不重叠）
 * 与 **② 并发上限不被突破**（按 50ms 采样）。队列表本身只存最终状态，看不到"谁在什么时间跑"，
 * 所以由 handler 自己写事件流（**机器可读**，一个事件一行）。
 * ⚠ 只写"队列自身的冒烟/混沌任务"的路径，**不碰任何业务表**；写失败绝不影响任务本身。
 */
async function appendEvent(line: Record<string, unknown>): Promise<void> {
  try {
    await fs.appendFile(path.join(config.dataDir, "job-selftest.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* 事件流只是观测手段：写不进去不该让任务失败（任务本身的语义与它无关） */
  }
}

export const selftestSleep: JobDefinition<SelftestPayload> = {
  type: "selftest.sleep",
  timeoutMs: 60_000,
  maxAttempts: 1,
  pool: "selftest",
  parse(raw) {
    const o = (raw ?? {}) as Partial<SelftestPayload>;
    const ms = Number(o.ms ?? 1_000);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw new Error(`[job] selftest.sleep 的 ms 非法：${String(o.ms)}`);
    return { ms, tag: typeof o.tag === "string" ? o.tag : undefined };
  },
  dedupeKey: (p, userId) => (p.tag ? `${userId ?? "anon"}:selftest.sleep:${p.tag}` : null),
  async handle(ctx, p) {
    await appendEvent({ jobId: ctx.jobId, userId: ctx.userId, worker: ctx.workerId, attempt: ctx.attempt, event: "start", ts: Date.now() });
    const step = 200;
    let done = 0;
    while (done < p.ms) {
      if (ctx.signal.aborted) throw new Error("被中止");
      await new Promise((r) => setTimeout(r, Math.min(step, p.ms - done)));
      done += step;
      const ok = await ctx.progress(Math.min(99, Math.round((done / Math.max(1, p.ms)) * 100)), "selftest");
      if (!ok) throw new Error("租约丢失");
    }
    await appendEvent({ jobId: ctx.jobId, userId: ctx.userId, worker: ctx.workerId, attempt: ctx.attempt, event: "end", ts: Date.now() });
    return { sleptMs: done };
  },
};
