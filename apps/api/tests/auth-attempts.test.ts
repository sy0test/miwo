/**
 * 失败锁定判定 + Cookie 解析（spec §7.2；Phase 1c Task 2）。
 *
 * ⚠ 这两块都是**纯函数**，所以在这里穷举边界 —— 尤其"第 5 次失败即锁"与"锁到期自动放行"：
 *   它们是最容易被写成"看起来锁了、其实没锁"（或反过来"永久锁死"）的两处。
 *   真正的落库（`o_loginAttempt`）与 HTTP 行为在 `tests/auth-service.test.ts` / `tests/auth-http-e2e.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { DECAY_MS, LOCK_MS, MAX_FAILED, lockRemainingMs, lockState, nextAttempt, type AttemptRec } from "@/auth/attempts";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, readCookie, refreshCookieOptions } from "@/auth/cookies";

const T0 = 1_700_000_000_000;

describe("登录失败锁定（spec §7.2：连续失败 5 次锁 15 分钟）", () => {
  it("没有记录 → ok；锁定未到期 → locked；到期 → ok", () => {
    expect(lockState(undefined, T0)).toBe("ok");
    const locked: AttemptRec = { failedCount: 5, lockedUntil: T0 + LOCK_MS, firstFailedAt: T0, updatedAt: T0 };
    expect(lockState(locked, T0)).toBe("locked");
    expect(lockState(locked, T0 + LOCK_MS - 1)).toBe("locked");
    expect(lockState(locked, T0 + LOCK_MS)).toBe("ok"); // 边界：到期当刻即放行（不做"多锁一秒"）
    expect(lockRemainingMs(locked, T0)).toBe(LOCK_MS);
    expect(lockRemainingMs(undefined, T0)).toBe(0);
  });

  it("第 1..4 次失败不锁；**第 5 次**失败即锁（阈值精确到 MAX_FAILED）", () => {
    let rec: AttemptRec | undefined;
    for (let i = 1; i <= MAX_FAILED; i += 1) {
      rec = nextAttempt(rec, T0 + i);
      expect(rec.failedCount).toBe(i);
      if (i < MAX_FAILED) {
        expect(rec.lockedUntil, `第 ${i} 次失败不该锁`).toBeNull();
        expect(lockState(rec, T0 + i)).toBe("ok");
      } else {
        expect(rec.lockedUntil).toBe(T0 + i + LOCK_MS);
        expect(lockState(rec, T0 + i)).toBe("locked");
      }
    }
  });

  it("距上次失败超过 30 分钟 → 计数从头开始（不会攒几天把正常用户锁死）", () => {
    const stale: AttemptRec = { failedCount: 4, lockedUntil: null, firstFailedAt: T0, updatedAt: T0 };
    const fresh = nextAttempt(stale, T0 + DECAY_MS + 1);
    expect(fresh.failedCount).toBe(1);
    expect(fresh.lockedUntil).toBeNull();
  });

  it("锁定期内继续失败不会把锁定**缩短**（lockedUntil 只可能被推到更晚或被清零）", () => {
    const locked: AttemptRec = { failedCount: 5, lockedUntil: T0 + LOCK_MS, firstFailedAt: T0, updatedAt: T0 };
    const again = nextAttempt(locked, T0 + 1000);
    expect(again.failedCount).toBe(6);
    expect(again.lockedUntil).toBe(T0 + 1000 + LOCK_MS);
    expect(lockState(again, T0 + LOCK_MS + 1)).toBe("locked");
  });
});

describe("refresh Cookie（spec §7.2：httpOnly + SameSite=Lax + 路径限定）", () => {
  it("readCookie：取得到、忽略其它 Cookie、缺头/空值/未编码坏值都返回 null", () => {
    expect(readCookie("a=1; miwo_rt=abc.def.ghi; b=2", REFRESH_COOKIE)).toBe("abc.def.ghi");
    expect(readCookie("miwo_rt=", REFRESH_COOKIE)).toBe("");
    expect(readCookie(undefined, REFRESH_COOKIE)).toBeNull();
    expect(readCookie("other=1", REFRESH_COOKIE)).toBeNull();
    // %zz 不是合法百分号编码 → decodeURIComponent 抛 → null（不把异常抛给调用方）
    expect(readCookie("miwo_rt=%zz", REFRESH_COOKIE)).toBeNull();
    // 名字必须精确匹配（前缀相同不算）
    expect(readCookie("miwo_rt_x=1", REFRESH_COOKIE)).toBeNull();
  });

  it("选项：httpOnly + sameSite=lax + path=/api/auth + maxAge 7 天；dev 下 secure=false", () => {
    const o = refreshCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe(REFRESH_COOKIE_PATH);
    expect(o.path).toBe("/api/auth");
    expect(o.maxAge).toBe(7 * 24 * 3600 * 1000);
    // vitest 的 MIWO_ENV=dev ⇒ 不允许 Secure（否则浏览器直接拒收 Cookie，登录"成功却掉线"）
    expect(o.secure).toBe(false);
  });
});
