/**
 * HTTP 侧的租户上下文（spec §6.4）+ 隔离错误的响应映射。
 *
 * 这里做四件事，一件都不多：
 *  1. 验签（**沿用现状**：`o_setting.tokenKey` 优先、`config.jwtSecret` 兜底；搬去
 *     `MIWO_JWT_SECRET` 是 Phase 1c 的 spec §7.2）
 *  2. 把 `{userId, role, requestId, source}` 放进 AsyncLocalStorage，并在**同一个 run()** 里 `next()`
 *     —— 这样下游所有 handler（含它们内部的 await）都带 ctx。
 *  3. `requireAdmin`（平台表写权限与运维接口的 403 判别）
 *  4. 把隔离错误映射成 403/500，且**响应体只有 {code, message}**（其余错误原样交给既有错误中间件）
 *
 * ⚠ 两处**刻意保持现状**、别按"更干净"改掉：
 *  a. **bootstrap 读 tokenKey 走 `u.db("o_setting")`，不走 `systemDb`**：`o_setting` 是 platform 表，
 *     守卫对平台表**无 ctx 也放行读**（`policies.ts` 的语义表 / `tests/db-driver.test.ts:226` 已钉住），
 *     所以这次读**不需要**任何绕过口。反过来，若为了"policy 无关"改用 `systemDb`，就等于给
 *     "唯一显式绕过口"新增第 8 个使用者 —— 而 `tools/check-tenant-exceptions.cjs` 的 bypass 正则
 *     认不出 `import { systemDb }`（Ruling 202 登记的盲区，Task 8 才收口），这会**当场扩大**一个
 *     已知不可见的出口。**bootstrap 不需要特权就不要特权。**
 *  b. **"库里优先 + 配置兜底"**（Phase 1a Task 5）：`002_platform_seed` 有意**不种** tokenKey，
 *     新库的密钥来自配置 `MIWO_JWT_SECRET`（`config.ts` 强制 ≥ 32 字节 ⇒ 兜底永远有值）。
 *     这条被两条现成判据钉住，删掉必红：
 *       · `apps/api/scripts/verify-phase0.cjs`：全新空库 + `MIWO_JWT_SECRET` 已设 → 轮询
 *         `configHealth?summary=1` 必须 200（只认库值的话会是 444，服务器永远起不来）；
 *       · `tests/auth-token-key.test.ts` R1：空库无 tokenKey 时用 `MIWO_JWT_SECRET` 签的 token 必须被接受。
 *     下面 `!tokenKey` 的 444 分支在该 fail-fast 下**不可达**，但保留它 + 文案（"密钥缺失时该怎么办"
 *     的意图；`app.ts` 原注释已论证过，勿为让它可达去放宽 `config.ts`）。
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import u from "@/utils";
import { config } from "@/config";
import { roleOfUserId } from "@/db/policies";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";

/** 不需要 ctx 的路径（与改造前的白名单一字不差）。 */
export const TENANT_WHITELIST: readonly string[] = ["/api/login/login"];

export function isTenantWhitelisted(path: string, query: Record<string, unknown>): boolean {
  if (TENANT_WHITELIST.includes(path)) return true;
  return path === "/api/other/configHealth" && String(query?.summary ?? "") === "1";
}

const ISOLATION_CODES = new Set(["TENANT_NO_CONTEXT", "TENANT_ISOLATION", "PLATFORM_WRITE_DENIED", "POLICY_NOT_FOUND"]);

/**
 * 建立 HTTP 租户 ctx 的唯一入口（spec §6.4）。
 *
 * ⚠ 白名单两条路径在**验签之前** `next()`：它们**天然无 ctx**，且**不要**给它们塞假 ctx
 *   （那等于给"未认证请求"一个租户身份）。
 * ⚠ 这里也是**唯一**一处"还没有 ctx 就要读库"的地方（bootstrap，见文件头 a）。
 */
export async function tenantContextMiddleware(req: Request, res: Response, next: NextFunction): Promise<unknown> {
  // 密钥优先级：库里优先，配置兜底（见文件头 b；两条现成判据依赖它）
  const setting: any = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  const tokenKey = (setting && setting.value) || config.jwtSecret;
  if (!tokenKey) return res.status(444).send({ message: "服务器秘钥未配置，请联系管理员" });

  // 白名单（登录 / 只读体检）：放行且**不建立 ctx**
  if (isTenantWhitelisted(req.path, req.query as Record<string, unknown>)) return next();

  const rawToken = req.headers.authorization || (req.query.token as string) || "";
  const token = String(rawToken).replace("Bearer ", "");
  if (!token) return res.status(401).send({ message: "未提供token" });

  let decoded: any;
  try {
    decoded = jwt.verify(token, tokenKey as string);
  } catch {
    return res.status(401).send({ message: "无效的token" });
  }

  // ⚠ JWT payload 是 `{id, name}`（routes/login/login.ts:32-39）⇒ userId 取 `decoded.id`。
  //   role **必须过 `roleOfUserId`**（policies.ts 的临时桥接：本阶段只有 id=1 是 admin）——
  //   不许硬编码 role，否则"platform 表仅 admin 可写"会恒真。
  const userId = Number(decoded?.id);
  // 没有 id 的 token 无法建立租户上下文 → 直接 401（**不要**退回"全局可见"）
  if (!Number.isInteger(userId) || userId <= 0) return res.status(401).send({ message: "token 缺少用户标识" });

  const ctx: TenantCtx = { userId, role: roleOfUserId(userId), requestId: randomUUID(), source: "http" };
  (req as any).user = decoded;   // spec §6.4：保留，并由下面的 ctx 消费
  (req as any).tenant = ctx;
  return runWithTenant(ctx, () => next());
}

/**
 * 平台表写权限 / 运维接口的 403 判别。用法：`app.use(requireAdmin)` 或按路由挂。
 *
 * ⚠ 用 `currentTenant()` **同步**取（ALS 在 requireAdmin 被调用时仍在同一条 async 链上），
 *   不要写成 `await import(...)` —— 那就变成异步取值，反而拿不到。
 * ⚠ 接线后平台写只有两条合法路径：**admin ctx** 或 `systemDb`（6 文件豁免）。
 *   别为了"消除无 ctx 报错"给那 6 个豁免文件套 `runWithTenant`（它们本就该无租户条件）。
 */
export function requireAdmin(_req: Request, res: Response, next: NextFunction): unknown {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ message: "未提供token" });
  if (ctx.role !== "admin") return res.status(403).send({ message: "需要管理员权限" });
  return next();
}

/**
 * 只处理隔离/策略类错误；其它错误一律 `next(err)` 交给既有错误中间件（Phase 1c 才统一错误体）。
 * 响应体刻意只有 `{code, message}`：不带堆栈、不带绝对路径（spec §10.2 Tier 1 #15 对**这两类**错误先落地）。
 *
 * ⚠ 必须在既有错误中间件**之前**注册：既有的那个不调 `next(err)`，注册在后面就永远轮不到。
 * ⚠ 两个 socket 路由（`src/socket/index.ts` 家族）各自 verify jwt，**不经这里**：它们的每个 handler
 *   必须显式包 `runWithTenant`（`tenant-context.ts:6-10` 第 2 条纪律），归 **Task 5**。
 */
export function tenantErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): unknown {
  const code = String(err?.code ?? "");
  if (!ISOLATION_CODES.has(code)) return next(err);
  const status = Number(err?.httpStatus) || 500;
  console.error(`[tenant] ${code}: ${err?.message ?? ""}`);
  return res.status(status).send({ code: status, message: String(err?.message ?? "租户隔离拒绝") });
}
