/**
 * 鉴权中间件（spec §6.4 / §7.3）。Phase 1c Task 3。
 *
 * ── 它取代的是什么（Phase 0 的旧版，1b 期间搬进 `middleware/tenant.ts`）──
 * 旧版有三个问题：
 *   1. **每个请求**都去 `o_setting` 读一次密钥（白名单外的 177 条路由全都付这个成本）；
 *   2. 缺 key 时返回 **444**（非标准码，前端 axios 的分支处理不了）；
 *   3. `req.user = decoded` 之后**全仓零消费**（spec §3.2 的"授权 0% 覆盖"）。
 * 现在：密钥走 `@/auth/secret`（**库值优先 + 配置兜底**，见该文件头的三档优先级）、
 * 建 ctx、并在 ctx 里带上**从 DB 读出来的真实 role**（spec §7.3：授权判定只信 DB，不信 token 的 role）。
 *
 * ── 白名单（必须显式列出，不靠"路径前缀"猜）──
 *   POST /api/login/login        —— 旧路径，**保留**（Phase 1c §5 的验收就是打它；前端切换归 Task 11）
 *   POST /api/auth/login         —— 新路径
 *   POST /api/auth/register
 *   POST /api/auth/refresh       —— refresh 本身没有 access（只有 Cookie），必须在验签之前
 *   GET  /api/other/configHealth?summary=1
 * 白名单命中 ⇒ **既不验签也不建 ctx**（天然匿名，不许塞假 ctx），且**不读密钥**（性能）。
 *
 * ── 两种 token 形状（都要接受，理由见 `tokens.ts` 文件头限制 2）──
 *   · 新形状（`typ` + `uid` + `tv`）：验签 → 每请求从 DB 读 `status`/`tokenVersion`/`role`
 *     → 比对 `tv`（登出/改密后立即失效）→ ctx.role 取 **DB 的 role**；
 *   · 旧形状（`{id, name}`，无 `typ`）：验签 → ctx 由 `roleOfUserId` 桥接（Phase 1b 的语义原样，
 *     否则 `verify-phase1b` / `ops-endpoints-auth` / `socket-tenant` / `auth-token-key` 会整片红）。
 *
 * ── 失败一律 401 + `{code:401,data:null,message}` ──
 * 不返回 444、不带 err 对象、不区分"用户不存在/口令错/被停用"（避免账号枚举）。
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AuthError, verifyLegacyToken, verifyToken } from "@/auth/tokens";
import { resolveJwtSecret } from "@/auth/secret";
import { AuthHttpError } from "@/auth/errors";
import { loadUserCtx } from "@/auth/service";
import { roleOfUserId } from "@/db/policies";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";

/** 匿名可访问的路径（**精确匹配**，不用前缀）。 */
export const AUTH_WHITELIST: readonly string[] = [
  "/api/login/login",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/refresh",
];

/** 兼容旧名（1b 的 `TENANT_WHITELIST` 语义 = "不需要 ctx 的路径"）。 */
export const TENANT_WHITELIST = AUTH_WHITELIST;

export function isAuthWhitelisted(path: string, query: Record<string, unknown>): boolean {
  if (AUTH_WHITELIST.includes(path)) return true;
  return path === "/api/other/configHealth" && String(query?.summary ?? "") === "1";
}

/** 兼容旧名（1b 的 `isTenantWhitelisted`）。 */
export const isTenantWhitelisted = isAuthWhitelisted;

function unauthorized(res: Response, message: string): void {
  res.status(401).send({ code: 401, data: null, message });
}

/**
 * 取令牌：**只认 `Authorization` 头**（Phase 1c Task 4 取消 `?token=` 查询串）。
 *
 * ⚠ 为什么必须取消查询串形态（Phase 0 遗留）：
 *   · URL 会被**访问日志 / 反代日志 / 浏览器历史**记录下来 ⇒ 令牌等于明文落盘；
 *   · 页面里的 `<img src="…?token=…">` 之类会把令牌经 `Referer` 带给第三方站点；
 *   · 它还让"令牌可以出现在分享链接里"变成事实上的功能，而这条路没有吊销面（只在 tokenVersion 上）。
 *   现在查询串里带 token **一律 401**（`tests/authorization.test.ts` 有红绿两端用例）。
 */
function extractToken(req: Request): string {
  const raw = (req.headers?.authorization as string) || "";
  return String(raw).replace("Bearer ", "").trim();
}

/**
 * 建立 HTTP ctx 的唯一入口（spec §6.4）。
 *
 * ⚠ 顺序是刻意的：白名单 → 取 token → 解析密钥 → 验签 → **读 DB 复核** → 建 ctx → `runWithTenant`。
 *   所有 DB 读都在 `runWithTenant` **之外**（此时还没有 ctx，平台表读是放行的）；
 *   `runWithTenant` 内部只做 `next()`（Ruling 234：不要在 ALS 里"返回 thenable 到外面 await"）。
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<unknown> {
  if (isAuthWhitelisted(req.path, req.query as Record<string, unknown>)) return next();

  const token = extractToken(req);
  if (!token) return unauthorized(res, "未提供token");

  const secret = await resolveJwtSecret();

  let ctx: TenantCtx;
  let reqUser: Record<string, unknown>;

  try {
    const claims = verifyToken(token, "access", secret);
    const user = await loadUserCtx(claims.uid);
    if (!user || user.status !== "active") return unauthorized(res, "登录状态无效，请重新登录");
    if (user.tokenVersion !== claims.tv) return unauthorized(res, "登录状态已失效，请重新登录");
    ctx = { userId: user.id, role: user.role, requestId: randomUUID(), source: "http" };
    reqUser = { id: user.id, name: user.username, role: user.role };
  } catch (err) {
    // 过期/类型不符是**确定**的失败（不去猜旧形状）；只有"载荷不是新形状"才回退 legacy
    if (err instanceof AuthError && err.code === "expired") return unauthorized(res, "登录已过期，请重新登录");
    const legacy = verifyLegacyToken(token, secret);
    if (!legacy) return unauthorized(res, "无效的token");
    ctx = { userId: legacy.userId, role: roleOfUserId(legacy.userId), requestId: randomUUID(), source: "http" };
    reqUser = { ...legacy.payload, id: legacy.userId };
  }

  (req as any).user = reqUser; // spec §6.4：保留 `req.user`（形状与新/旧 token 一致）
  (req as any).tenant = ctx;
  return runWithTenant(ctx, () => next());
}

/**
 * 平台表写权限 / 运维接口的 403 判别。用法：`router.get("/", requireAdmin, handler)`。
 *
 * ⚠ 用 `currentTenant()` **同步**取（ALS 在 requireAdmin 被调用时仍在同一条 async 链上），
 *   不要写成 `await import(...)` —— 那就变成异步取值，反而拿不到。
 */
export function requireAdmin(_req: Request, res: Response, next: NextFunction): unknown {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
  if (ctx.role !== "admin") return res.status(403).send({ code: 403, data: null, message: "需要管理员权限" });
  return next();
}

/**
 * "只能操作自己的资源"骨架（spec §7.3 的越权防线之一）。
 *
 * ⚠ 现状：**还没有调用方**（Phase 1c Task 4 的收权矩阵会按路由挂）。留着它是因为
 *   "把 id 从请求体里读出来再比 `ctx.userId`"这件事必须由**服务端**做，散落在各路由里迟早漏一处。
 */
export function requireSelf(resourceUserId: number) {
  return (_req: Request, res: Response, next: NextFunction): unknown => {
    const ctx = currentTenant();
    if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
    if (Number(ctx.userId) !== Number(resourceUserId)) {
      return res.status(403).send({ code: 403, data: null, message: "无权访问他人资源" });
    }
    return next();
  };
}

/**
 * 认证类错误 → HTTP（`{code:<status>, data, message}`；`data` 通常是 null，
 * 只有锁定态带 `lockedUntil`）。其它错误一律 `next(err)` 交给后面的既有错误中间件。
 *
 * ⚠ 必须注册在既有错误中间件**之前**（那个处理器不调 `next(err)`，注册在它之后就永远轮不到）。
 * ⚠ `AuthError`（`@/auth/tokens`）也要在这里映射：它是**令牌层**的错误，
 *   若漏出去会被通用处理器当成 500 并回显内部 message。
 */
export function authErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): unknown {
  if (err instanceof AuthHttpError) {
    return res.status(err.httpStatus).send({ code: err.httpStatus, data: err.data ?? null, message: err.message });
  }
  if (err instanceof AuthError) {
    return res.status(401).send({ code: 401, data: null, message: err.message });
  }
  return next(err);
}
