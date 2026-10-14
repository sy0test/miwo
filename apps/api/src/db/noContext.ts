/**
 * 认证阶段需要的"**服务端系统身份**"上下文（Phase 1c Task 3）。
 *
 * ── 为什么需要它（不是"图省事塞个假 ctx"）──
 * 1b 的守卫（`src/db/tenant-guard.ts`）对表策略的语义是：
 *   · **platform 读**：放行（含无 ctx）—— 所以"登录前查 `o_user`"本来就能读（这正是 Task 1 把
 *     `o_user`/`o_invite`/`o_loginAttempt`/`o_userSetting` 判成 platform 的理由）；
 *   · **platform 写**：要求 `ctx.role === "admin"`（spec §6.2 的原话）。
 * 而注册要 `insert o_user`、登录要 `update o_user.lastLoginAt` + 写 `o_loginAttempt`、
 * 登出/改密要 `tokenVersion++` —— 这些**全是 platform 表的写**，且都发生在"用户还没被认证"的时刻。
 * 于是只有两条路：给守卫开一个"无 ctx 也能写 platform"的口子，或**显式给一个系统身份**。
 * 这里选后者：
 *   · 走的是**同一个守卫**（不新增 `systemDb` 绕过口 —— 那会当场撞
 *     `tools/check-tenant-exceptions.cjs` 的 `systemDbUsers` 清单与
 *     `tests/tenant-db-bypass.test.ts` 的"使用者集合 == 登记清单"断言，且绕过口**不应该**变多）；
 *   · `source: "system"`（`TenantCtx` 的三种来源之一，1b 早就留好了）；
 *   · `userId = 0`：**没有真实用户**，即便哪段代码误碰租户表，注入的条件也是 `userId = 0`
 *     ⇒ **查不到任何人的行**（fail-closed，而不是"看到全部"）。
 *
 * ⚠ 它是**代码常量**、不可由环境变量配置：唯一的调用方是 `src/auth/service.ts`
 *   （`tests/auth-service.test.ts` 有一条用例把"白名单里的表都必须是 platform 策略"钉住）。
 * ⚠ 纪律（Ruling 234）：包在里面的回调**必须 async 且在里面 await**，
 *   不要把 thenable 返回出来再在外面 await（那样守卫的执行期复核看不到 ctx）。
 */
import { randomUUID } from "node:crypto";
import { runWithTenant, type TenantCtx } from "@/db/tenant-context";

/** 系统身份的 userId：0 = "不属于任何用户"（租户条件注入后什么都查不到）。 */
export const AUTH_SYSTEM_USER_ID = 0;

/**
 * 认证路径允许触碰的表（**点名式**，不是通配）。
 * 它们必须全部是 `platform` 策略 —— 由 `tests/auth-service.test.ts` 断言。
 */
export const AUTH_TABLES = ["o_user", "o_invite", "o_loginAttempt", "o_userSetting"] as const;

/** 构造系统 ctx（每次调用一个新 requestId，便于把一次注册/登录的多条 SQL 串起来）。 */
export function authSystemCtx(): TenantCtx {
  return {
    userId: AUTH_SYSTEM_USER_ID,
    role: "admin",
    requestId: randomUUID(),
    source: "system",
  };
}

/** 在系统身份里执行 `fn`（回调必须 async 且内部 await；见文件头纪律）。 */
export function runAsAuth<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenant(authSystemCtx(), fn);
}
