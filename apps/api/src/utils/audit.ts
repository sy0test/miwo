/**
 * 审计日志（Phase 1c Task 4；spec Tier 1 #17 / §7.3「导出/清库/改 key 都要审计」）。
 *
 * ── 它解决的那件事（`routes/auth/register.ts` 在 Task 3 留给本任务的原话）──
 * 「未认证路径怎么写 platform 表」：登录/注册/登出/改密都发生在**建租户 ctx 之前**，
 * 而 `o_auditLog` 是 **platform** 策略的表（写要求 admin）。统一处置 = 审计**一律**经
 * `runAsAuth()` 的系统身份落库（`src/db/noContext.ts`），不新增绕过口、不塞假 ctx。
 *
 * ── 两条铁律 ──
 *  1. **审计失败绝不让业务失败**：整段 `try/catch`，失败只 `console.error`。
 *     代价必须说清：审计是**旁路证据**，不是事务性保证 —— 库写不进去时业务照常成功。
 *     这就是为什么有一条用例专门断言「审计失败会打印」（否则"审计静默失败"就是一个
 *     假装存在的门禁）。
 *  2. **只追加**：`o_auditLog` 没有 update/delete 路径（本模块不导出任何修改函数）。
 *
 * ── detail 的形状 ──
 *  `JSON.stringify`（对象）/ 原样（字符串）；**绝不把凭据写进 detail**（调用方负责：
 *  口令、token、供应商 key 都不许进来）。超长就截断（列是 `text`，但审计不该成为
 *  又一条写放大路径）。
 */
import u from "@/utils";
import { runAsAuth } from "@/db/noContext";
import { currentTenant } from "@/db/tenant-context";

/** 审计的"谁"：已认证请求用 ctx；未认证路径显式给 userId=null（**不是** 0，0 是系统身份）。 */
export interface AuditActor {
  userId?: number | null;
  role?: string | null;
  requestId?: string | null;
  ip?: string | null;
}

/** `o_auditLog.action` 的取值目录（单一口径，避免各处手写字符串漂移）。 */
export const AUDIT_ACTIONS = Object.freeze({
  LOGIN_SUCCESS: "auth.login.success",
  LOGIN_FAIL: "auth.login.fail",
  LOGIN_LOCKED: "auth.login.locked",
  LOGOUT: "auth.logout",
  PASSWORD_CHANGE: "auth.password.change",
  INVITE_CONSUMED: "auth.invite.consume",
  USER_PROFILE_UPDATE: "user.profile.update",
  DB_EXPORT: "db.export",
  DB_IMPORT: "db.import",
  DB_CLEAR: "db.clear",
  DB_CLEAR_TABLE: "db.clearTable",
  DB_INFO: "db.info",
  SKILL_WRITE: "setting.skill.write",
  /** 所有经特权原语（`src/db/noContext.ts`）代行的 platform 写。 */
  PLATFORM_WRITE: "platform.write",
});

/** `detail` 落库前的保护上限（字符）。 */
const DETAIL_MAX = 4000;

function serializeDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  let out: string;
  if (typeof detail === "string") out = detail;
  else {
    try {
      out = JSON.stringify(detail);
    } catch {
      out = String(detail);
    }
  }
  return out.length > DETAIL_MAX ? out.slice(0, DETAIL_MAX) + "…(truncated)" : out;
}

/**
 * 写一条审计。**永不抛**（见文件头铁律 1）。
 *
 * `target` 是"被操作的对象"（账号名 / 表名 / 路由），最长 191（列宽），超长截断。
 */
export async function audit(actor: AuditActor, action: string, target?: string | null, detail?: unknown): Promise<void> {
  try {
    await runAsAuth(async () => {
      await (u.db as any)("o_auditLog").insert({
        userId: actor?.userId === undefined || actor?.userId === null ? null : Number(actor.userId),
        role: actor?.role ? String(actor.role).slice(0, 16) : null,
        action: String(action).slice(0, 64),
        target: target === undefined || target === null || target === "" ? null : String(target).slice(0, 191),
        detail: serializeDetail(detail),
        requestId: actor?.requestId ? String(actor.requestId).slice(0, 64) : null,
        ip: actor?.ip ? String(actor.ip).slice(0, 64) : null,
        createdAt: Date.now(),
      });
    });
  } catch (err: any) {
    // 刻意只打印：审计失败不能让登录/导出等业务失败（详见文件头铁律 1）。
    console.error(`[audit] 写审计失败（业务不受影响）action=${action} target=${String(target ?? "")}：${err?.message ?? err}`);
  }
}

/** 从当次请求的 ctx 造 actor（HTTP 请求路径的默认口径；`ip` 由调用方给）。 */
export function actorFromCtx(ip?: string | null): AuditActor {
  const ctx = currentTenant();
  if (!ctx) return { userId: null, role: null, requestId: null, ip: ip ?? null };
  return { userId: ctx.userId, role: ctx.role, requestId: ctx.requestId, ip: ip ?? null };
}

/**
 * 「经特权原语代行的 platform 写」的统一审计（`AUDIT_ACTIONS.PLATFORM_WRITE`）。
 *
 * 认证服务（`src/auth/service.ts`）的每一次 `runAsAuth` 写都调它 —— 于是
 * 「未认证路径怎么落审计」在**同一处**实现，而不是散在 6 个调用点里各写一遍。
 */
export async function auditPlatformWrite(
  what: string,
  target?: string | null,
  detail?: unknown,
  actor?: AuditActor,
): Promise<void> {
  await audit(actor ?? { userId: null, role: null }, AUDIT_ACTIONS.PLATFORM_WRITE, target ?? what, {
    what,
    ...(detail && typeof detail === "object" ? (detail as Record<string, unknown>) : detail === undefined ? {} : { detail }),
  });
}
