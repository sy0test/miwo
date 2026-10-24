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
 *   POST /api/auth/login         —— 新路径
 *   POST /api/auth/register
 *   POST /api/auth/refresh       —— refresh 本身没有 access（只有 Cookie），必须在验签之前
 *   GET  /api/other/configHealth?summary=1
 * 白名单命中 ⇒ **既不验签也不建 ctx**（天然匿名，不许塞假 ctx），且**不读密钥**（性能）。
 *
 * ⚠【Phase 1c Task 11】**旧登录路径 `/api/login/login` 已整体退役**（路由文件删除、白名单条目同步删除）：
 *   它曾是一个"调同一个 service 的薄壳"，让旧前端在切换期还能登录 —— 代价是**两条匿名入口**与
 *   一份必须长期维护的兼容面。现在只留 `/api/auth/*` 三条款。
 *
 * ── 一种 token 形状（Phase 1c Task 11 起）──
 *   · 新形状（`typ` + `uid` + `tv`）：验签 → 每请求从 DB 读 `status`/`tokenVersion`/`role`
 *     → 比对 `tv`（登出/改密后立即失效）→ ctx.role 取 **DB 的 role**。
 *   · **旧形状（`{id, name}`，无 `typ`）已整体退役 ⇒ 一律 401**（见下）。
 *
 * ⚠ 为什么必须删掉旧形状分支（**安全**，不是洁癖）：legacy 分支**不读 DB** ⇒
 *   ① 005 把旧账号迁成 `status="disabled"` 的封禁对它**完全不生效**（停用的人照样进得来）；
 *   ② 它用 `roleOfUserId(userId)` 桥接角色，而 `roleOfUserId(1) === "admin"` ⇒
 *      **用当前密钥签的 `{id:1}` 旧令牌至今仍然是管理员**。
 *   旧令牌的寿命是 180 天，所以"删掉签发端"并不够 —— 必须让**验签端**也不再认它。
 *
 * ── 失败一律 401 + `{code:401,data:null,message}` ──
 * 不返回 444、不带 err 对象、不区分"用户不存在/口令错/被停用"（避免账号枚举）。
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AuthError, verifyToken } from "@/auth/tokens";
import { resolveJwtSecret } from "@/auth/secret";
import { AuthHttpError } from "@/auth/errors";
import { loadUserCtx } from "@/auth/service";
import { withAiBillingContext } from "@/billing/context";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";

/** 匿名可访问的路径（**精确匹配**，不用前缀）。 */
export const AUTH_WHITELIST: readonly string[] = [
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
 *
 * ── `mountPath` 参数（Phase 1c Task 7 新增，**默认空 ⇒ 行为与本参数不存在时逐字相同**）──
 * Task 7 把静态资源 `/oss`、`/assets` 移到鉴权之后，于是 `src/app.ts` 不能再用
 * `app.use(authenticate)`（挂在整个进程的根上）—— 那会让匿名访问 SPA 壳 `/` 得到 **401**，
 * 用户**连登录页都打不开**。改成 `app.use("/api", …)` 之后，Express 会把 `req.path` 切成
 * **挂载点之后**的部分（`/api/login/login` → `/login/login`），而 `AUTH_WHITELIST` 里的路径是
 * **全路径**形态 ⇒ 不拼回前缀，登录/注册/refresh 会全部落到"未提供token ⇒ 401"。
 * 所以这里显式接一个前缀并拼回去比白名单。
 *
 * ⚠ 为什么不改 `AUTH_WHITELIST` 的字面值：那份集合是**公共契约**（`tests/auth-service.test.ts`
 *   逐项断言它的内容，1c 的验收脚本也按全路径打接口），改它等于让"白名单是什么"取决于挂载位置。
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
  mountPath: string = "",
): Promise<unknown> {
  const fullPath = mountPath && !req.path.startsWith(mountPath) ? mountPath + req.path : req.path;
  if (isAuthWhitelisted(fullPath, req.query as Record<string, unknown>)) return next();

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
    // ⚠【Phase 1c Task 11】这里**不再**回退旧形状：`verifyToken` 失败就是失败。
    //   过期与其它失败分开只为给前端**一条**可操作的提示（"去续期/重登"），不泄露更多信息。
    if (err instanceof AuthError && err.code === "expired") return unauthorized(res, "登录已过期，请重新登录");
    return unauthorized(res, "无效的token");
  }

  (req as any).user = reqUser; // spec §6.4：保留 `req.user`（形状由上面的 db 行投影而来，不直接透传令牌载荷）
  (req as any).tenant = ctx;
  // ⚠ Phase 1c Task 6：`req.ctx` 是**错误处理器读 requestId** 的位置（`src/app.ts` 的 errorHandler）。
  //   同一个对象挂两个名字是**故意**的：`req.tenant` 是 Phase 1b 起的既有消费面（socket/测试都在读），
  //   改名会让"日志能串起一次请求"这件事依赖一次全仓改名；两个名字指向**同一个 ctx**，不会漂移。
  (req as any).ctx = ctx;
  return runWithTenant(ctx, () =>
    withAiBillingContext({ userId: ctx.userId, requestId: ctx.requestId }, () => next()),
  );
}

/**
 * **可选鉴权**（Phase 1c Task 10；控制器裁定）：给 `/oss`、`/assets` 用。
 *
 * ── 它修的是什么（Task 7 留下的"文档与实现不符"）──
 * Task 7 把静态资源移到鉴权之后，同时把 `app.use(authenticate)` 改成 `app.use("/api", …)`
 * （理由见 `authenticate` 的 `mountPath` 注释：挂根会让 SPA 壳得到 401，登录页打不开）。
 * 副作用是 `req.ctx` **只在 `/api` 分支上**被建出来 ⇒ `mediaAuthGuard` 里"已有 ctx 就放行"
 * 那条分支对 `/oss`、`/assets` **永远走不到** ⇒ **带 Bearer 取媒体一律 403**，
 * 而 `app.ts` 的挂载表、`utils/mediaSign.ts` 的注释、报告与 e2e **四处都宣称 Bearer 可用**。
 *
 * ── 语义（刻意与 `authenticate` 分开，不是它的"软版本"）──
 *   · **有 `Authorization` 头** ⇒ 完全走 `authenticate` 那条路：合法 ⇒ 建 ctx（下游守卫据此放行、
 *     并让 `runWithTenant` 生效）；非法/过期 ⇒ `authenticate` 自己的 **401**（不静默降级成匿名 ——
 *     "令牌坏了"必须区别于"没带令牌"，否则前端永远不知道该去刷新还是该重新登录）。
 *   · **没有 `Authorization` 头** ⇒ 直接 `next()`（**匿名**）。媒体守卫随后按 query 里的短时签名判，
 *     都不满足 ⇒ 403。这就是浏览器 `<img src>` 的路径：它本来就不带 `Authorization`。
 *
 * ⚠ 为什么不做成"JSON 响应体里带 token"之类：`<img>` 无法带自定义头，媒体只有两条路 ——
 *   签名（浏览器）或 Bearer（服务端/脚本）。本中间件让**第二条**真的可用，签名那条不变。
 * ⚠ 它**不读 DB 也不解析 token**（没有头时）：每个没有凭据的 `<img>` 请求只多一次 `req.headers` 查找，
 *   没有额外查询 —— 这是热路径，不能加成本。
 */
export function optionalMediaAuth(req: Request, res: Response, next: NextFunction): unknown {
  const raw = (req.headers?.authorization as string) || "";
  if (!String(raw).trim()) return next();
  // 有头就交给 authenticate（它自己会 401 或建 ctx；不会"未提供token"以外的新行为）
  return authenticate(req, res, next, "");
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
