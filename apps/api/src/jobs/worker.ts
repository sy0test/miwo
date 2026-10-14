/**
 * worker 循环（spec §9.2/§9.3）。
 *
 * 一个循环做四件事：
 *   1. **回收**：交给 store.claim 内部先跑 reclaimExpired（租约过期的 running → queued/dead）。
 *   2. **领取**：只在有空槽时才领（`globalMaxRunning - inFlight.size`），并把槽位数当 limit 传下去。
 *   3. **执行**：每条任务一个 AbortController；心跳定时器负责续租，续租失败（affected=0）
 *      立刻 abort —— 这是"租约被回收/被取消"时唯一能阻止 handler 继续写产物的机制。
 *   4. **收尾**：stop() 先等在跑任务自然结束（最多 shutdownGraceMs），再强 abort。
 *
 * ⚠ 为什么不用 `Promise.all` 一次领一批再等：那会让"空槽"与"领取数"脱钩（领回来的任务排队等槽），
 *    而队列的意义正是**在领之前**就限流。这里一次只领 `free` 条，领完立刻派发。
 * ⚠ worker 不 import 任何 socket/express：它是独立进程（Task 5 的 data/serve/worker.js）。
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * 【组 B 偏离登记】brief 的参考实现**跑不过它自己给出的 5 条用例**（实测 2 红）。下面三处是
 * 为了让「租约丢失 → abort」与「超时 → 判死」真的成立而做的**加强**（判据没有放宽，反而更严）。
 * 每一处都附本会话实测到的反例现象；报告 `groupB-report.md` 里有逐字命令与原文。
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * 偏离 ① **心跳先验租约、再续租**（`verifyLease()`）。
 *   brief 的心跳直接 `store.heartbeat(id, workerId)` —— 那是一条**无条件**续租（store 侧条件只有
 *   `id + workerId + state='running'`）。于是"租约已经被推到过期"这件事**永远看不见**：
 *   下一个心跳（默认 15s，测试里 100ms）会把它**原地复活**。
 *   实测（诊断脚本 `%TEMP%\miwo-diag-lease.ts`，强夺租约后逐 tick 打印）：
 *     `253ms 强夺租约 → 312ms heartbeat(1) -> true → … → 2383ms FINAL aborted=false wrote=false`
 *   —— 强夺被心跳抹平，abort 一次都没发生（brief 用例 3 因此必红）。
 *   为什么"续租一条已过期的租约"本身就是错的（不只是测试要红）：租约一过期，**回收方就已经
 *   有权**把它改回 `queued`（`store.reclaimExpired`）甚至判死；此时旧持有者再续租 = 把一条
 *   别人已经在跑的任务拉回自己名下 → **同一 job 双执行**（诊断日志里 `attempts` 从 1 变 2、
 *   两条心跳并发即是铁证）。所以正确顺序是：**先确认租约仍属于我且未过期，再续租**；
 *   一旦过期就认输 abort（fail-closed，宁可不做也不做两遍）。
 *
 * 偏离 ② **abort 立刻解除 worker 的等待**（`Promise.race`，`abortedDeferred`）。
 *   brief 写的是 `await def.handle(...)` —— handler 不尊重 `ctx.signal` 时（brief 用例 4 的
 *   handler 就是 `sleep(5s).then(...)`，**完全不看 signal**），worker 会把槽位占满 handler 的
 *   全部时长：超时 100ms 触发了，但 `store.fail` 要等 5s 后才执行 ⇒ 用例 4 在 vitest 的 5s
 *   上限上直接 `Test timed out in 5000ms`（实测）。abort 的语义是"这条任务我已经放弃了"，
 *   所以 worker **不该**再为它阻塞自己的槽位。竞速之后：abort 分支立刻写失败（含"已中止：…"），
 *   handler 的 promise 只挂 `.catch` 兜住未处理拒绝（它若还在跑，其产物写入由租约/终态条件
 *   拦下 —— store 的 I4 保证 `succeed/fail` 的 `state='running'` 条件命中不了）。
 *
 * 偏离 ③ **同一 job 被重新领取时的代际记账**（`superseded`）。
 *   偏离①生效后，"旧执行 abort + 该 job 被回收重领"会在**同一进程、同一 workerId** 下同时
 *   存在两次执行。`inFlight` 若只按 job id 存一个 controller，旧执行收尾时的 `delete` 会把
 *   **新执行**的槽位记录删掉（槽位数虚低 → 可超发），旧执行还会拿同一个 workerId 去 `fail`
 *   **新执行**正在跑的那一行。所以：新执行接管时先 abort 旧执行并给它打 `superseded` 标记；
 *   被取代的执行**不再写任何终态**（succeed/fail 都跳过）；`finally` 只在"映射里还是我自己"时删除。
 */
import { JOB_POLICY, type JobPolicy } from "@/jobs/policy";
import type { JobRegistry } from "@/jobs/registry";
import type { JobStore } from "@/jobs/store";
import { withJobTenant } from "@/jobs/tenant";
import type { JobContext, JobRow } from "@/jobs/types";

export interface RunnerDeps {
  store: JobStore;
  registry: JobRegistry;
  workerId: string;
  policy?: JobPolicy;
  log?: (msg: string) => void;
}

export interface Runner {
  /** 优雅停机：等自然收尾，超时才强 abort。可重复调用。 */
  stop(): Promise<void>;
  /** 循环真正结束（stop 后 await 它即可）。 */
  done: Promise<void>;
  /** 当前在跑的任务数（诊断/测试用）。 */
  inFlight(): number;
}

/** 一次执行的账：controller 用于 abort，`superseded` 用于"这一代已被新领取取代"。 */
interface Running {
  controller: AbortController;
  superseded: boolean;
  /** 谁把它 abort 的（写失败原因用；`null` = 还在跑）。 */
  reason: string | null;
}

/** 极简 deferred（本文件只需要"abort 时兑现"这一个信号，不引第三方库）。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function startWorkerLoop(deps: RunnerDeps): Runner {
  const { store, registry, workerId } = deps;
  const P: JobPolicy = deps.policy ?? JOB_POLICY;
  const log = deps.log ?? ((m: string) => console.log(m));

  /** 槽位表：key = job id（一个 job 占一个槽；见偏离③的代际记账）。 */
  const inFlight = new Map<number, Running>();
  let stopping = false;
  const sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * 【偏离①】续租前的租约校验：**过期就认输**。
   * 返回 `false` = 这条租约已经不属于本次执行（被别人回收/取消/抢走，或已过期）。
   */
  async function verifyLease(jobId: number): Promise<boolean> {
    const row = await store.get(jobId);
    if (!row) return false;
    if (row.state !== "running" || row.workerId !== workerId) return false;
    // ⚠ 已过期 ⇒ **不续租**（续租会把回收方已经/即将拿走的任务拉回来 → 双执行，见文件头偏离①）
    return (row.leaseUntil ?? 0) > Date.now();
  }

  async function execute(job: JobRow): Promise<void> {
    // 【偏离③】接管同一 job 的上一代执行：先 abort + 打标，避免"旧代写新代的终态"。
    const prev = inFlight.get(job.id);
    if (prev) {
      prev.superseded = true;
      prev.reason = prev.reason ?? "superseded";
      log(`[job ${job.id}] 已被重新领取，中止上一代执行`);
      prev.controller.abort(new Error("superseded"));
    }
    const rec: Running = { controller: new AbortController(), superseded: false, reason: null };
    inFlight.set(job.id, rec);
    const controller = rec.controller;
    const abortOnce = (reason: string): void => {
      if (controller.signal.aborted) return;
      rec.reason = rec.reason ?? reason;
      controller.abort(new Error(reason));
    };
    const aborted = deferred();
    controller.signal.addEventListener("abort", () => aborted.resolve());
    if (controller.signal.aborted) aborted.resolve();

    const def = registry.get(job.type);

    // 心跳：**先验租约，再续租**；失败 = 租约丢了（被回收/被取消/被别人抢走/已过期）→ 立刻 abort。
    const hb = setInterval(() => {
      void (async () => {
        try {
          const stillMine = await verifyLease(job.id);
          if (!stillMine) {
            log(`[job ${job.id}] 租约已丢失（过期或已易主），中止执行`);
            abortOnce("lease lost");
            return;
          }
          const ok = await store.heartbeat(job.id, workerId);
          if (!ok) {
            log(`[job ${job.id}] 续租失败（租约已丢失），中止执行`);
            abortOnce("lease lost");
          }
        } catch (e) {
          log(`[job ${job.id}] 心跳异常：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    }, P.heartbeatMs);

    const timeoutMs = def?.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      log(`[job ${job.id}] 超时（${timeoutMs}ms），中止执行`);
      abortOnce("timeout");
    }, timeoutMs);

    /** 终态写入的统一闸门：被取代 / 已 abort 的执行**不许**再写终态。 */
    const finish = async (state: "succeed" | "fail", message?: string, result?: unknown): Promise<void> => {
      if (rec.superseded) {
        log(`[job ${job.id}] 本次执行已被取代，跳过写 ${state}`);
        return;
      }
      try {
        if (state === "succeed") {
          const ok = await store.succeed(job.id, workerId, result);
          if (!ok) log(`[job ${job.id}] 写成功状态被拒（租约已丢失）`);
        } else {
          await store.fail(job.id, workerId, message ?? "未知错误");
        }
      } catch (e) {
        log(`[job ${job.id}] 写 ${state} 状态时出错：${e instanceof Error ? e.message : String(e)}`);
      }
    };

    try {
      if (!def) {
        await finish("fail", `未知任务类型 "${job.type}"`);
        return;
      }
      const payload = def.parse(JSON.parse(job.payload ?? "null"));
      const ctx: JobContext = {
        jobId: job.id,
        userId: job.userId,
        type: job.type,
        attempt: job.attempts,
        workerId,
        signal: controller.signal,
        progress: async (percent: number, stage?: string) => {
          const ok = await store.progress(job.id, workerId, percent, stage);
          if (!ok) abortOnce("lease lost");
          return ok;
        },
        log: (m: string) => log(`[job ${job.id}] ${m}`),
      };
      const run = withJobTenant(job.userId, () => def.handle(ctx, payload));
      // 【偏离②】abort 立刻解除等待：不合作的 handler 不得把 worker 的槽位/停机流程卡住。
      const outcome = await Promise.race([
        run.then(
          (result) => ({ kind: "done" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        aborted.promise.then(() => ({ kind: "aborted" as const })),
      ]);

      if (outcome.kind === "aborted") {
        // handler 可能还在跑（不尊重 signal 的那种）：挂个 catch 兜住它的未处理拒绝。
        run.catch(() => {});
        const why = rec.reason ?? "aborted";
        const text = why === "timeout" ? `已中止：任务超时（${timeoutMs}ms）` : `已中止：${why === "lease lost" ? "租约已丢失" : why}`;
        log(`[job ${job.id}] ${text}`);
        await finish("fail", text);
        return;
      }
      if (outcome.kind === "error") {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        await finish("fail", controller.signal.aborted ? `已中止：${msg}` : msg);
        return;
      }
      // 正常返回：但若这一瞬间已被 abort（超时/租约丢失恰好同时发生），不许写成功。
      if (controller.signal.aborted) {
        await finish("fail", `已中止：${rec.reason ?? "aborted"}`);
        return;
      }
      await finish("succeed", undefined, outcome.result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await finish("fail", controller.signal.aborted ? `已中止：${msg}` : msg);
    } finally {
      clearInterval(hb);
      clearTimeout(timer);
      // 【偏离③】只删自己的那一代：被取代时映射里已经是新代的记录。
      if (inFlight.get(job.id) === rec) inFlight.delete(job.id);
    }
  }

  const done = (async () => {
    while (!stopping) {
      const free = P.globalMaxRunning - inFlight.size;
      if (free <= 0) {
        await sleepFn(P.busyPollMs);
        continue;
      }
      let claimed: JobRow[] = [];
      try {
        claimed = await store.claim({ workerId, limit: free });
      } catch (e) {
        log(`[worker] 领取失败（稍后重试）：${e instanceof Error ? e.message : String(e)}`);
        await sleepFn(P.idlePollMs);
        continue;
      }
      if (claimed.length === 0) {
        await sleepFn(P.idlePollMs);
        continue;
      }
      for (const job of claimed) void execute(job);
      await sleepFn(P.busyPollMs);
    }
    // 优雅收尾：先等在跑任务自己结束
    const deadline = Date.now() + P.shutdownGraceMs;
    while (inFlight.size > 0 && Date.now() < deadline) await sleepFn(200);
    if (inFlight.size > 0) {
      for (const [id, r] of inFlight) {
        log(`[worker] 停机超时，强停 job ${id}`);
        r.reason = r.reason ?? "shutdown";
        r.controller.abort(new Error("shutdown"));
      }
    }
    while (inFlight.size > 0) await sleepFn(50);
  })();

  return {
    async stop() {
      stopping = true;
      await done;
    },
    done,
    inFlight: () => inFlight.size,
  };
}
