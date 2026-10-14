/**
 * 队列门面：给路由 / handler / CLI / worker 一个"拿到唯一 store 实例"的入口，避免到处 `new`。
 *
 * ⚠ **这里接的是受守卫的 `u.db`**（`@/utils` 的默认导出里的 `db`），不是裸 knex：
 *   `o_job` / `o_gate` 是 platform 表，未声明的表在守卫下会 `PolicyNotFoundError`（fail-closed）。
 *   而 platform 表的**写**要求 `ctx.role === "admin"` —— 队列的写由 `src/jobs/store.ts` 内部的
 *   特权原语（`runAsAuth`，登记在 `tools/auth-writer-registry.json`）统一代行：
 *   于是**普通用户**点"生成"也能入队，而业务 handler 仍然只有 `role: "user"` 的租户 ctx。
 *
 * ⚠ `import u from "@/utils"` 会触发 `@/utils/db` 的启动序列（建连接 → 跑迁移），
 *   所以本模块**只能在进程启动路径上** import（路由 / worker / CLI 都满足；
 *   测试里要注入假 db 就**别** import 本模块，直接 `createJobStore({ db })`）。
 */
import type { Knex } from "knex";
import u from "@/utils";
import { jobRegistry, type JobRegistry } from "@/jobs/registry";
import { createJobStore, type JobStore } from "@/jobs/store";
import { __setGateFactory, createGate } from "@/jobs/gate";
import type { EnqueueInput, EnqueueResult } from "@/jobs/types";

/** 默认注册表（= `JOB_DEFINITIONS`）对应的单例。 */
let singleton: JobStore | null = null;

/**
 * 取队列 store。
 * · 不传 `registry`（或缺省那个）⇒ 进程内**单例**（api 侧只需要一个）；
 * · 显式传**别的** registry ⇒ 返回一个**不缓存**的新实例（worker / 测试各自一套定义，
 *   绝不把自定义定义写进全局单例 —— 否则两边的 handler 会互相串）。
 */
export function getJobStore(registry: JobRegistry = jobRegistry): JobStore {
  if (registry !== jobRegistry) return createJobStore({ db: u.db as unknown as Knex, registry });
  if (!singleton) singleton = createJobStore({ db: u.db as unknown as Knex, registry: jobRegistry });
  return singleton;
}

/** 入队的唯一出口（路由用这个；`getJobStore().enqueue` 等价）。 */
export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  return getJobStore().enqueue(input);
}

/**
 * Phase 1d Task 9：把 `o_gate` 闸门的**单例建库入口**接到启动链**唯一**的受守卫 `u.db` 上。
 *
 * 为什么放在本模块（而不是 `gate.ts` 自己 import）：`gate.ts` 会被路由/handler 直接 import，
 * 它自己去拉 `u.db` 会让"谁在启动路径上用哪个 db"出现第二个答案（`docs`/门禁口径都要单一入口）；
 * 而且 `require("@/utils/db")` 的 `@/` 别名在**编译产物**里不会被改写（生产会 MODULE_NOT_FOUND）。
 * 所以与 `getJobStore()` 逐字同理：**在本文件**注入 `u.db`。
 * ⚠ 只是注册工厂（不连库、不建实例）：真正的闸门实例在第一次 `withVendorSlot()` 时才建。
 */
__setGateFactory(() => createGate({ db: u.db as unknown as Knex }));
