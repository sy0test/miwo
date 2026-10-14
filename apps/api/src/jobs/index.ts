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
