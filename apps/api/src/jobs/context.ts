/**
 * 从"请求/连接"里取当前用户的**单点适配**（spec §6.4 / §7.2）。
 *
 * ⚠ 为什么单独一个文件：Phase 1b 用 AsyncLocalStorage 建 ctx、Phase 1c 保留 `req.user`
 *    —— 两者都可能有名字/形状变化。把耦合收在这里，名字变了只改这一处。
 *
 * ── 核验（本会话实读，brief 里写的导出名与实际不符）──
 *   brief 写 `import { getCurrentTenantContext } from "@/db/policies"` —— **该导出不存在**
 *   （`src/db/policies.ts` 只有 `TABLE_POLICIES/policyOf/isTenantTable/...`）。
 *   实际可读出口是 `src/db/tenant-context.ts` 的 `currentTenant()` / `currentUserId()`
 *   （后者返回 `number | undefined`）。所以这里按**实际导出**接。
 *
 * 优先顺序：**Phase 1b 的 ctx**（`currentTenant()`，由 `runWithTenant` 在 HTTP 中间件里建）
 *   → 退路 `req.user`（Phase 1c 在 `app.ts` 认证中间件里挂的载荷）。
 *   ctx 是权威（它经过守卫的 fail-closed 包装），`req.user` 只作为兼容退路。
 */
import type { Request } from "express";
import { currentTenant } from "@/db/tenant-context";

/** 从请求里取当前用户 id；取不到返回 `null`（调用方负责 401，见 6 个路由）。 */
export function currentUserId(req: Request): number | null {
  // ① Phase 1b 的租户 ctx（权威）
  const ctxUser = currentTenant()?.userId;
  if (typeof ctxUser === "number") return ctxUser;
  // ② Phase 1c 的 `req.user` 退路（字段名可能是 uid/userId/id 三者之一）
  const raw = (req as unknown as { user?: { uid?: number; userId?: number; id?: number } }).user;
  const v = raw?.uid ?? raw?.userId ?? raw?.id;
  return typeof v === "number" ? v : null;
}
