/**
 * 队列基础设施的**启动期注册**（worker 与 api 共用）—— 目前只有一件事：把 `o_gate`
 * 闸门的单例工厂接到**唯一的受守卫 `u.db`** 上。
 *
 * ── 为什么必须单独一个文件（review-C F2，Critical）──
 *   原来这一行写在 `jobs/index.ts`（`@/jobs` 桶文件）里，而 `@/jobs` **只被 API 侧路由 import**
 *   （为了 `enqueueJob()`）；`src/worker.ts` 的启动链从不 import 它 ⇒ **worker 进程里的闸门单例
 *   永远不会建**，六个 handler 的第一次 `withVendorSlot()` 直接抛 `[gate] 闸门未初始化`。
 *   实测旁证：构建产物 `worker.js` 里连 `__setGateFactory(` 这个符号都没有（`app.js` 有 3 处）。
 *   ⇒ 注册动作搬到本文件，**两条启动链各自显式 import 一次**；`check-build.cjs` 另加产物级守卫
 *   （`app.js` 与 `worker.js` 都必须观测到该符号，观测不到 ⇒ exit 3）。
 *
 * ⚠ 本文件刻意**只做注册**（不建实例、不连库）：真正的闸门实例在第一次 `withVendorSlot()` 时才建。
 * ⚠ 不要在 `src/worker.ts` 的顶层 import 本文件：那会让 `@/utils`（连接 → 迁移）在建租户 ctx 之前
 *   被求值。放在 `main()` 里 `await dbReady` **之后** import（CJS 下 `await import()` 是安全的）。
 */
import type { Knex } from "knex";
import u from "@/utils";
import { __setGateFactory, createGate } from "@/jobs/gate";

/** 幂等：重复调用只是重新注册同一个工厂。 */
export function bootstrapJobInfra(): void {
  __setGateFactory(() => createGate({ db: u.db as unknown as Knex }));
}
