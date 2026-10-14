/**
 * `selftest.sleep` —— 队列自身的冒烟/混沌任务。
 *
 * 它是**正式的运维入口**（Task 10 的 `job:admin --enqueue-selftest`），不是"只在测试里注册"的东西：
 *   - 冒烟：部署后入队一条，确认 worker 真的能领走并跑完（比"进程活着"强得多）；
 *   - chaos：Task 10 的多进程 harness 用它来验证租约回收、并发上限、零丢失。
 * 它不碰任何业务表，因此对生产库是安全的。
 */
import type { JobDefinition } from "@/jobs/types";

export interface SelftestPayload {
  ms: number;
  tag?: string;
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
    const step = 200;
    let done = 0;
    while (done < p.ms) {
      if (ctx.signal.aborted) throw new Error("被中止");
      await new Promise((r) => setTimeout(r, Math.min(step, p.ms - done)));
      done += step;
      const ok = await ctx.progress(Math.min(99, Math.round((done / Math.max(1, p.ms)) * 100)), "selftest");
      if (!ok) throw new Error("租约丢失");
    }
    return { sleptMs: done };
  },
};
