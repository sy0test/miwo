/**
 * HTTP 侧的租户上下文 + 隔离错误的响应映射（spec §6.4）。
 *
 * ⚠ **Phase 1c Task 3 起本文件只做两件事**：
 *   1. `tenantErrorHandler`（隔离/策略错误 → 403/500，响应体只有 `{code, message}`）**仍住在这里**
 *      —— 它是 Phase 1b 的产物、与认证无关，1b 的用例（`tests/tenant-http-context.test.ts`）按名字钉着它；
 *   2. 把 Task 3 的新实现在 `@/middleware/auth` **原样再导出**，并保留 1b 的旧名字
 *      （`tenantContextMiddleware` / `TENANT_WHITELIST` / `isTenantWhitelisted`）——
 *      这样 `src/routes/setting/**` 的 6 处 `requireAdmin`、4 个测试文件、以及 socket 侧
 *      都不必同一个提交里改名（改名会让"鉴权改写"这一个语义变更淹没在机械 diff 里）。
 *
 * 行为差异（Task 3 有意改掉的，见 `@/middleware/auth` 文件头）：
 *   · 444 分支**删除**（缺密钥不再是"服务起不来"，密钥三档优先级里配置恒有值）；
 *   · 失败响应统一 `{code:401,data:null,message}`；
 *   · ctx 的 role 从 **DB** 读（`o_user.role`），不再由 `roleOfUserId` 桥接 ——
 *     **旧形状 token 例外**（它没有 `tv`/`role` claim，只能按 1b 的桥接语义走）。
 */
import type { NextFunction, Request, Response } from "express";

export {
  AUTH_WHITELIST,
  TENANT_WHITELIST,
  authenticate,
  authenticate as tenantContextMiddleware,
  isAuthWhitelisted,
  isAuthWhitelisted as isTenantWhitelisted,
  requireAdmin,
  requireSelf,
  authErrorHandler,
} from "@/middleware/auth";

const ISOLATION_CODES = new Set(["TENANT_NO_CONTEXT", "TENANT_ISOLATION", "PLATFORM_WRITE_DENIED", "POLICY_NOT_FOUND"]);

/**
 * 只处理隔离/策略类错误；其它错误一律 `next(err)` 交给既有错误中间件。
 * 响应体刻意只有 `{code, message}`：不带堆栈、不带绝对路径（spec §10.2 Tier 1 #15 对**这两类**错误先落地）。
 *
 * ⚠ 必须在既有错误中间件**之前**注册：既有的那个不调 `next(err)`，注册在后面就永远轮不到。
 * ⚠ 两个 socket 路由（`src/socket/index.ts` 家族）各自 verify jwt，**不经这里**：它们的每个 handler
 *   必须显式包 `runWithTenant`（`tenant-context.ts` 文件头第 2 条纪律）。
 * ⚠ TODO（Phase 1c）：500 类错误的 `message` 会把**内部文案**（表名、`policies.ts` 的措辞）原样回给客户端。
 *   这符合"不带堆栈、不带绝对路径"的既有口径，但会泄露结构性信息。Phase 1c 统一错误体时收口为
 *   对外通用文案 + 服务端日志保留原文（**本阶段不改行为**，只留指向）。
 */
export function tenantErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): unknown {
  const code = String(err?.code ?? "");
  if (!ISOLATION_CODES.has(code)) return next(err);
  const status = Number(err?.httpStatus) || 500;
  console.error(`[tenant] ${code}: ${err?.message ?? ""}`);
  return res.status(status).send({ code: status, message: String(err?.message ?? "租户隔离拒绝") });
}
