/**
 * 认证接口的限流器（spec §7.2 / §10.2 Tier 1）。Phase 1c Task 3；Task 6 加全局档。
 *
 * ── 为什么自己写而不引依赖 ──
 * 只需要几个固定窗口计数器（登录/注册/全局兜底）。引 `express-rate-limit` 会新增一个运行期
 * 依赖与其升级面；而"按 IP 计数"这点逻辑用 `Map` 就够了。
 *
 * ── ⚠ **进程内计数**（如实登记，Task 6 裁定：允许保持）──
 *   桶是**本进程的 `Map`**：多副本（多容器/多进程）之间**不共享**，进程重启即清零。
 *   后果：横向扩容到 N 个副本时，真实生效阈值是 `N × max`；重启窗口内计数归零。
 *   Phase 1c Task 6 控制器裁定：**允许保持进程内**（多副本部署不在本阶段范围），但必须登记；
 *   **不要把已落库的锁定计数也改成内存态** —— `@/auth/attempts` + `o_loginAttempt` 的
 *   账号级锁定是**持久、跨重启**的（见下方分工）。要跨副本共享需 Redis（Phase 2）。
 *
 * ── 与"失败锁定"的分工（两者都要有，别互相替代）──
 *   · `@/auth/attempts` + `o_loginAttempt`：按 **username + IP** 的**账号级**锁定（持久、跨重启）；
 *   · 本文件：按 **IP** 的**请求速率**限制（防"同一个 IP 拿不同用户名刷"）。
 *
 * ⚠ `apiLimiter` 在 **dev 放宽**（3000/分钟 vs prod 300/分钟），**不是关闭**：
 *   旧版（Task 3）是 `skip: () => config.env !== "prod"` ⇒ dev 下这条防线**完全不生效**，
 *   于是"限流分支可达"这件事在 dev/CI 上永远测不到（假绿）。Task 6 改成放宽后，超阈值在 dev
 *   也会 429 —— 而 dev 与回归脚本（几十到几百个请求）离 3000 还很远。
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
 * 全局兜底（Phase 1c Task 6 的"全局限流"档）：按 IP + 路径，60s 窗口。
 *
 * 上限：prod 300 次/分钟/IP（防"脚本扫接口"），dev 3000 次（放宽，见文件头：
 * 旧版在 dev 直接 `skip`，那会让"429 分支"在本机与 CI 上都不可达 = 假绿）。
 *
 * ⚠ **如实登记**：spec Tier 0 #7 要求"登录/生成/上传**分别**限流"。本阶段做到的是
 *   **登录 + 注册 + 全局**三档；**生成**限流归 Phase 1d（要有队列才谈得上），**上传**限流归 Phase 1e。
 * ⚠ 进程内计数（多副本不共享）—— 见文件头。
 */
export const API_LIMIT_PROD = 300;
export const API_LIMIT_DEV = 3000;

export const apiLimiter = createLimiter({
  max: config.env === "prod" ? API_LIMIT_PROD : API_LIMIT_DEV,
  windowMs: 60 * 1000,
  message: "请求过于频繁，请稍后再试",
});
