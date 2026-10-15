/**
 * `job-chaos.cjs` 的**纯函数断言逻辑**的判别力用例（Phase 1d review-D.md F-1 / F-2）。
 *
 * ── 为什么必须有这个文件 ──
 * chaos 本体**只有连上 MySQL 才会跑到**（本机 EXIT 2、CI 的 mysql job 才真跑），所以它的断言逻辑
 * 在开发机上**一次都没被执行过** —— F-1 就是因此漏到复核轮的：C 断言的区间配对算法在它自己制造的
 * SIGKILL 场景下必然误判"重叠"，而 B 断言又强制那个场景必须发生（B 与 C 互斥）。
 * 于是这里用**合成事件流**（逐行照抄 review-D.md 的复现数据）把断言逻辑单测起来：
 * 开发机上也能证明"这条判据真的能红/能绿"，不必等 MySQL。
 *
 * ⚠ 这里**不重写**算法：直接从 `scripts/job-chaos.cjs` require 同一份实现（`require.main !== module`
 *   ⇒ 不会进 main()、不会连库、不会 exit）。"测的不是被测对象"是这一族的常见退化。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chaos = require(path.resolve(__dirname, "..", "scripts", "job-chaos.cjs")) as {
  buildSpans: (events: unknown[]) => Map<number, Array<{ attempt: number; s: number; e: number | null; userId?: number }>> & { orphanEnds: number };
  findOverlaps: (spans: Map<number, Array<{ attempt: number; s: number; e: number | null }>>, fallbackMs: number) => Array<{ jobId: number; prev: { attempt: number }; cur: { attempt: number } }>;
  resolveLimits: (policy: { globalMaxRunning: number; perUserMaxRunning: number }, env?: Record<string, string | undefined>) => {
    global: number;
    perUser: number;
    problems: string[];
    source: string;
  };
};

/** 合成事件：`selftest.sleep` handler 写 JSONL 的形状（事件流只有 start/end + jobId/attempt/ts/userId）。 */
const ev = (jobId: number, attempt: number, event: "start" | "end", ts: number, userId?: number) => ({ jobId, attempt, event, ts, userId });
/** chaos 用 selftest 的 `ms`（默认 400）作为"无 end 的 attempt 至少跑了多久"的下界。 */
const MS = 400;

describe("chaos C 断言：按 (jobId, attempt) 分组配对（review-D.md F-1 / F-1R）", () => {
  /**
   * review-D.md 逐行复制的两条事件流（+ 复核轮 F-1R 的两条）：
   *  · NORMAL：同一 job 两次 attempt **都正常收尾**（有 end）。
   *  · KILLED_ATTEMPT / LEGIT_RECLAIM：attempt 1 被 SIGKILL（**没有 end**）+ 60s 后租约过期**合法重领** ⇒
   *    必须判 0（旧"第 i 个 start 配第 i 个 end"算法会误判成重叠，而 B 断言强制这个场景必须发生）。
   *  · DUP_KILLED：**同一 job 被两个 worker 同时执行**（start 1000 / 1005）且 chaos 杀掉其中一个 ⇒
   *    左端永远没有 end；若"无 end 就整段跳过"就会**漏判重复执行**（F-1R）。
   */
  const STREAMS = {
    // 两次 attempt 正常收尾（start 1000/end 9000、start 10000/end 19000）
    NORMAL: [ev(7, 1, "start", 1000, 1), ev(7, 1, "end", 9000, 1), ev(7, 2, "start", 10000, 1), ev(7, 2, "end", 19000, 1)],
    // review-D.md 的原始数据：start(1000, attempt=1) 无 end + start(61000, attempt=2) + end(61400, attempt=2)
    KILLED_ATTEMPT: [ev(7, 1, "start", 1000, 1), ev(7, 2, "start", 61000, 1), ev(7, 2, "end", 61400, 1)],
    // 与 KILLED_ATTEMPT 同形（合法重领：间隔 60s ≫ leaseMs），单独命名以表达"不许误伤"
    LEGIT_RECLAIM: [ev(7, 1, "start", 1000, 1), ev(7, 2, "start", 61000, 1), ev(7, 2, "end", 61400, 1)],
    // 【F-1R】重复执行 + 其中一个被杀：start(1000,a1) 无 end、start(1005,a2) 有 end
    DUP_KILLED: [ev(7, 1, "start", 1000, 1), ev(7, 2, "start", 1005, 1), ev(7, 2, "end", 61400, 1)],
  };

  /** **旧算法**（行内复制，只用于"改前红"的见证；生产代码里已删除）。 */
  function legacyOverlapCount(events: Array<{ jobId: number; attempt: number; event: string; ts: number }>): number {
    const spans = new Map<number, Array<{ event: string; ts: number }>>();
    for (const e of events) {
      if (!spans.has(e.jobId)) spans.set(e.jobId, []);
      spans.get(e.jobId)!.push({ event: e.event, ts: e.ts });
    }
    let overlaps = 0;
    for (const [, evs] of spans) {
      const starts = evs.filter((x) => x.event === "start").sort((a, b) => a.ts - b.ts);
      const ends = evs.filter((x) => x.event === "end").sort((a, b) => a.ts - b.ts);
      const intervals = starts.map((s, i) => ({ s: s.ts, e: ends[i] ? ends[i].ts : Number.POSITIVE_INFINITY })).sort((a, b) => a.s - b.s);
      for (let i = 1; i < intervals.length; i += 1) if (intervals[i].s < intervals[i - 1].e) overlaps += 1;
    }
    return overlaps;
  }

  it("★ NORMAL 事件流：新旧算法都判 0 重叠（改前改后都绿 —— 证明改的不是恒真条件）", () => {
    expect(legacyOverlapCount(STREAMS.NORMAL)).toBe(0);
    expect(chaos.findOverlaps(chaos.buildSpans(STREAMS.NORMAL), MS)).toEqual([]);
  });

  it("★★ KILLED_ATTEMPT（被 SIGKILL 的 attempt 没有 end）：旧算法误判 1 处重叠（改前红），新算法 0（改后绿）", () => {
    // 改前红：这正是 review-D.md 实测的 `C_KILLED_ATTEMPT overlaps=1`
    expect(legacyOverlapCount(STREAMS.KILLED_ATTEMPT), "旧配对算法在被 SIGKILL 的场景下会误判重叠").toBe(1);
    // 改后绿：按 attempt 分组 + 无 end 的左端按 "start + ms" 下界估计（下界 < 60000 的重领间隔 ⇒ 不误伤）
    const spans = chaos.buildSpans(STREAMS.KILLED_ATTEMPT);
    expect(chaos.findOverlaps(spans, MS)).toEqual([]);
    // 而且"无 end"这件事是可观测的（chaos 会打印它，不是被静默吞掉）
    const flat = [...spans.values()].flat();
    expect(flat.length).toBe(2);
    expect(flat.filter((s) => s.e === null).length).toBe(1);
    expect(spans.orphanEnds).toBe(0);
  });

  it("★★ LEGIT_RECLAIM（租约过期后**合法重领**，间隔 ~60s）：必须判 0 ⇒ 修复没有误伤正常回收", () => {
    // ⚠ 这条用例**只**表达"不误伤"：60s 的重领间隔远大于下界 MS=400 ⇒ 任何一版实现都必须判 0
    expect(chaos.findOverlaps(chaos.buildSpans(STREAMS.LEGIT_RECLAIM), MS)).toEqual([]);
  });

  it("★★ F-1R DUP_KILLED（同一 job 被两个 worker 同时执行、其中一个被 SIGKILL）：必须判 1 处重叠", () => {
    // 这是复核轮的原始数据：start(1000,a1) 无 end + start(1005,a2) + end(61400,a2)
    // ⚠ 漏判形态：对"左端无 end"整段 continue ⇒ overlaps=0 ⇒ C 会 PASS（B 只看 attempts、D 只看采样峰值）
    const overlaps = chaos.findOverlaps(chaos.buildSpans(STREAMS.DUP_KILLED), MS);
    expect(overlaps.length, "重复执行 + 其中一个被杀必须被判重叠（否则对重复执行的检测退化成概率性）").toBe(1);
    expect(overlaps[0].prev.attempt).toBe(1);
    expect(overlaps[0].cur.attempt).toBe(2);
    // 下界口径的**边界**：重领起点落在 `start + MS` 之内（1399 < 1000+400）时同样必须判重叠
    const tight = [ev(7, 1, "start", 1000, 1), ev(7, 2, "start", 1399, 1), ev(7, 2, "end", 2000, 1)];
    expect(chaos.findOverlaps(chaos.buildSpans(tight), MS).length, "落在下界之内 ⇒ 判重叠").toBe(1);
  });

  it("★★ 漏判的**机械守卫**：findOverlaps 缺 fallbackMs（或非正值）必须**抛错**，不许静默退化成'整段跳过'", () => {
    const spans = chaos.buildSpans(STREAMS.DUP_KILLED);
    expect(() => chaos.findOverlaps(spans as never, undefined as never)).toThrow(/fallbackMs/);
    expect(() => chaos.findOverlaps(spans as never, 0 as never)).toThrow(/fallbackMs/);
  });

  it("★★ REAL_OVERLAP（两次 attempt 真的同时在跑，都有 end）：必须判 1 处重叠 ⇒ 修复没有放宽判据", () => {
    const stream = [ev(7, 1, "start", 1000, 1), ev(7, 1, "end", 9000, 1), ev(7, 2, "start", 5000, 1), ev(7, 2, "end", 12000, 1)];
    const overlaps = chaos.findOverlaps(chaos.buildSpans(stream), MS);
    expect(overlaps.length).toBe(1);
    expect(overlaps[0].prev.attempt).toBe(1);
    expect(overlaps[0].cur.attempt).toBe(2);
  });

  it("★ 多 job 互不干扰：A 的 attempt 与 B 的 attempt 时间重叠不算重叠（重叠只在**同一 job** 内判定）", () => {
    const stream = [ev(7, 1, "start", 1000, 1), ev(7, 1, "end", 9000, 1), ev(8, 1, "start", 2000, 2), ev(8, 1, "end", 8000, 2)];
    expect(chaos.findOverlaps(chaos.buildSpans(stream), MS)).toEqual([]);
  });

  it("★ 只有 end 没有 start 的事件（事件流不完整）被计数为 orphanEnds ⇒ C 判 FAIL（观测不到 ≠ 通过）", () => {
    const spans = chaos.buildSpans([ev(7, 1, "end", 9000, 1)]);
    expect(spans.orphanEnds).toBe(1);
    expect([...spans.values()].flat()).toEqual([]); // 没有 start 就不构成区间
  });
});

describe("chaos D 断言：上界只能来自 JOB_POLICY（review-D.md F-2）", () => {
  const POLICY = { globalMaxRunning: 8, perUserMaxRunning: 2 };

  it("★ 未设 MIWO_CHAOS_* ⇒ 上界就是 JOB_POLICY 的值（不是硬编码 8/2）", () => {
    const r = chaos.resolveLimits(POLICY, {});
    expect(r.global).toBe(8);
    expect(r.perUser).toBe(2);
    expect(r.problems).toEqual([]);
    expect(r.source).toBe("JOB_POLICY");
  });

  it("★★ 策略被改（O10 口径调整）而 env 没设 ⇒ 断言跟着策略走（旧实现会继续验 8/2）", () => {
    const r = chaos.resolveLimits({ globalMaxRunning: 4, perUserMaxRunning: 1 }, {});
    expect(r.global).toBe(4);
    expect(r.perUser).toBe(1);
    expect(r.problems).toEqual([]);
  });

  it("★★ MIWO_CHAOS_GLOBAL_MAX 与策略不一致 ⇒ 报问题（拒绝用旧上界跑验收）", () => {
    const r = chaos.resolveLimits(POLICY, { MIWO_CHAOS_GLOBAL_MAX: "3" });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("JOB_POLICY.globalMaxRunning=8");
  });

  it("★ MIWO_CHAOS_PER_USER_MAX 与策略一致 ⇒ 没有问题（允许用于交叉自检）", () => {
    const r = chaos.resolveLimits(POLICY, { MIWO_CHAOS_GLOBAL_MAX: "8", MIWO_CHAOS_PER_USER_MAX: "2" });
    expect(r.problems).toEqual([]);
  });

  it("★ 源码级机械守卫：job-chaos.cjs 不得再用 `MIWO_CHAOS_* || 8` 这类硬编码上界", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "job-chaos.cjs"), "utf8");
    // ⚠ 必须剥注释：文件头的"旧实现"说明**故意**引用了那条硬编码（它是这段历史的一部分），
    //    判据只针对**真实代码**（剥注释是本仓库门禁的既有手法，见 verify-phase1d 的 A6）。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(/MIWO_CHAOS_GLOBAL_MAX\s*\|\|/.test(code), "不得把 env 默认值当上界（F-2）").toBe(false);
    expect(/MIWO_CHAOS_PER_USER_MAX\s*\|\|/.test(code), "不得把 env 默认值当上界（F-2）").toBe(false);
    expect(code.includes("loadJobPolicy"), "D 的上界必须从 @/jobs/policy 读").toBe(true);
  });
});
