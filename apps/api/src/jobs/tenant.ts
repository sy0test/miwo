/**
 * `job → 租户上下文`的**唯一**适配点（spec §6.4：队列任务必须携带 `userId`，worker 在任务上下文中
 * 建立同样的 ctx，worker 也受隔离约束）。
 *
 * ⚠ **与 Phase 1b 的耦合只有这一个文件**（核验命令：`git grep -ln "tenant-context" -- apps/api/src/jobs`
 *   只应命中本文件）。brief 里写的是 `@/db/policies` 的 `runWithTenantContext({userId, role:"worker"})`
 *   —— **两处都与实现不符**：Phase 1b 实际导出的是
 *   `src/db/tenant-context.ts` 的 `runWithTenant(ctx, fn)`，而 `TenantCtx.role` 只有 `"user" | "admin"`
 *   （没有 `"worker"`）。所以这里按**实际导出**写，并在组报告里登记这处偏离。
 *
 * 三个刻意的选择：
 *  1. `userId === null`（平台/运维任务）**直接跑，不建 ctx**。`o_job` / `o_gate` 是 platform 内部表
 *     （spec §6.2），平台任务没有租户身份；硬造一个"空 ctx"会让 fail-closed 包装层把内部表访问
 *     也当成租户访问，反而更糟。此时若 handler 误碰**租户表**，守卫会抛 `TenantContextError`
 *     —— 这正是我们要的失败方向（fail-closed，不是"看到全部"）。
 *  2. `role: "user"`（**最小权限**）：任务代表某个用户跑业务，绝不该获得 platform 写权限
 *     （`src/db/tenant-guard.ts` 的 `isPlatformWriteCtx()` 要求 `role === "admin"`，
 *     因此即便 `source` 是 `"system"` 也拿不到 platform 写 —— 队列自身的写走
 *     `store.ts` 里**另一个**特权入口，见该文件头）。
 *  3. `source: "system"`：这个 ctx 不是某个 HTTP 请求建的（`TenantSource` 只有 `http|socket|system`），
 *     标记成 `system` 才能让日志/审计分得清"这是后台任务"。它**不**提权：
 *     `isPlatformWriteCtx()` 对 `source === "system"` 额外要求 `userId === 0`，
 *     而我们这里的 `userId` 是真用户 id。
 *  4. `requestId` 每次生成新 uuid：把同一次任务尝试里的多条 SQL 串起来（与认证路径同一手法）。
 */
import { randomUUID } from "node:crypto";
import { runWithTenant, type TenantCtx } from "@/db/tenant-context";
import { withAiBillingContext } from "@/billing/context";

/** 任务尝试的 ctx（导出只为测试断言形状；生产路径请用 `withJobTenant()`）。 */
export function jobTenantCtx(userId: number): TenantCtx {
  return {
    userId,
    role: "user",
    requestId: `job:${randomUUID()}`,
    source: "system",
  };
}

/**
 * 在任务所属租户的 ctx 里执行 `fn`；`userId` 为 `null` 时不建 ctx（平台任务）。
 *
 * ⚠ 纪律（Ruling 234 的同族）：回调**必须 async 且在里面 await**，
 *   不要把 thenable 返回出来再在外面 await（那样守卫的执行期复核看不到 ctx）。
 */
export function withJobTenant<T>(userId: number | null, fn: () => Promise<T>, jobId?: string | number): Promise<T> {
  if (userId === null || userId === undefined) return fn();
  const tenant = jobTenantCtx(userId);
  return runWithTenant(tenant, async () =>
    await withAiBillingContext(
      { userId, requestId: tenant.requestId, ...(jobId === undefined ? {} : { jobId: String(jobId) }) },
      fn,
    ),
  );
}
