/**
 * 认证接口的限流器（spec §7.2 / §10.2 Tier 1）。Phase 1c Task 3。
 *
 * ── 为什么自己写而不引依赖 ──
 * 只需要三个固定窗口计数器（登录/注册/全局兜底）。引 `express-rate-limit` 会新增一个运行期
 * 依赖与其升级面；而"按 IP 计数"这点逻辑用 `Map` 就够了。⚠ **代价已登记**：进程内计数，
 * 多进程/重启会重置，且不共享（Phase 1c Task 6 的"限流"是否换 Redis 由部署形态决定）。
 *
 * ── 与"失败锁定"的分工（两者都要有，别互相替代）──
 *   · `@/auth/attempts` + `o_loginAttempt`：按 **username + IP** 的**账号级**锁定（持久、跨重启）；
 *   · 本文件：按 **IP** 的**请求速率**限制（防"同一个 IP 拿不同用户名刷"）。
 *
 * ⚠ `apiLimiter` 只在 **prod** 生效（dev 与回归脚本要跑几十上百个请求；把 dev 也限住会让
 *   `verify-phase1b` 这类端到端脚本变得不可靠）。这条"dev 放宽"是**显式**的，不是漏写。
 */
import type { NextFunction, Request, Response } from "express";
import { config } from "@/config";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LimiterOptions {
  /** 窗口内允许的最大请求数。 */
  max: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 取桶键（默认按 IP + 路由）。 */
  keyOf?: (req: Request) => string;
  /** 返回 true 时**整个限流器跳过**（用于 dev 放宽 / 白名单）。 */
  skip?: (req: Request) => boolean;
  /** 被限流时的响应文案。 */
  message: string;
}

/**
 * 固定窗口计数器。⚠ 桶上限（`MAX_BUCKETS`）是防"大量不同 IP 把内存撑爆"的兜底：
 * 超限时**清空最旧的桶**（宁可短暂放宽，也不要 OOM）。
 */
const MAX_BUCKETS = 20_000;

export function createLimiter(options: LimiterOptions) {
  const buckets = new Map<string, Bucket>();

  return function limiter(req: Request, res: Response, next: NextFunction): unknown {
    if (options.skip?.(req)) return next();
    const now = Date.now();
    const key = options.keyOf ? options.keyOf(req) : `${req.ip ?? "unknown"}|${req.baseUrl}${req.path}`;
    const found = buckets.get(key);
    if (!found || found.resetAt <= now) {
      if (buckets.size >= MAX_BUCKETS) {
        // 清空过期桶；一个都没过期就直接清空（极端情况下宁可放宽，也不让内存无界增长）
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
        if (buckets.size >= MAX_BUCKETS) buckets.clear();
      }
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    found.count += 1;
    if (found.count > options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((found.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).send({ code: 429, data: null, message: options.message });
    }
    return next();
  };
}

/** 登录：按 **IP + 用户名**（避免一个 NAT 后面的人互相拖累，也让"换用户名刷"仍受 IP 约束）。 */
export const loginLimiter = createLimiter({
  max: 30,
  windowMs: 15 * 60 * 1000,
  keyOf: (req) => `${req.ip ?? "unknown"}|${String((req.body as any)?.username ?? "")}`,
  message: "登录尝试过于频繁，请稍后再试",
});

/** 注册：按 IP（注册是低频动作，10 次/小时足够）。 */
export const registerLimiter = createLimiter({
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyOf: (req) => `${req.ip ?? "unknown"}|register`,
  message: "注册过于频繁，请稍后再试",
});

/**
 * 全局兜底：**只在 prod 生效**（见文件头）。
 * 上限刻意给得宽松（600 次/分钟/IP）：它是防"脚本扫接口"，不是防正常前端。
 */
export const apiLimiter = createLimiter({
  max: 600,
  windowMs: 60 * 1000,
  skip: () => config.env !== "prod",
  message: "请求过于频繁，请稍后再试",
});
