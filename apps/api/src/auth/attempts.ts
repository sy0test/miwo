/**
 * 登录防爆破的判定逻辑（spec §7.2：按 username + IP 限流；连续失败 N 次锁定 M 分钟）。
 * Phase 1c Task 2。
 *
 * ⚠ 只做**纯函数**：把"什么时候锁、锁多久"与"谁来存"分开
 *   —— 判定逻辑能被单测穷举（含边界），落库（`o_loginAttempt`）在 `@/auth/service` 里。
 *   `now` 一律可注入（默认 `Date.now()`），所以"锁定到期"能被确定性地测出来，
 *   不靠 `sleep`。
 */
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60 * 1000;
/** 距上次失败超过 30 分钟，计数从头开始（否则"几天里偶尔打错 5 次"会被当成爆破）。 */
export const DECAY_MS = 30 * 60 * 1000;

export interface AttemptRec {
  failedCount: number;
  lockedUntil: number | null;
  firstFailedAt: number | null;
  updatedAt: number;
}

/** 锁定期内一律拒绝（`lockedUntil` 已过期 = 计数仍在，但**不锁**）。 */
export function lockState(rec: AttemptRec | undefined, now = Date.now()): "ok" | "locked" {
  if (!rec) return "ok";
  if (rec.lockedUntil && Number(rec.lockedUntil) > now) return "locked";
  return "ok";
}

/** 记一次失败后的新状态；`failedCount` 达到 `MAX_FAILED` 时给出 `lockedUntil`。 */
export function nextAttempt(prev: AttemptRec | undefined, now = Date.now()): AttemptRec {
  const decayed = !prev || !prev.updatedAt || now - Number(prev.updatedAt) > DECAY_MS;
  const base: AttemptRec = decayed
    ? { failedCount: 0, lockedUntil: null, firstFailedAt: null, updatedAt: now }
    : { ...prev, lockedUntil: prev.lockedUntil ?? null, firstFailedAt: prev.firstFailedAt ?? null };
  const failedCount = Number(base.failedCount || 0) + 1;
  return {
    failedCount,
    lockedUntil: failedCount >= MAX_FAILED ? now + LOCK_MS : null,
    firstFailedAt: base.firstFailedAt ?? now,
    updatedAt: now,
  };
}

/** 距离锁定解除还有多少毫秒（未锁定返回 0）。响应体里给前端提示用，不泄露账号是否存在。 */
export function lockRemainingMs(rec: AttemptRec | undefined, now = Date.now()): number {
  if (!rec || !rec.lockedUntil) return 0;
  return Math.max(0, Number(rec.lockedUntil) - now);
}
