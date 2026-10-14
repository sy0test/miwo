import express from "express";
import { success } from "@/lib/responseFormat";
import { logout } from "@/auth/service";
import { REFRESH_COOKIE, clearRefreshCookieOptions } from "@/auth/cookies";
import { currentTenant } from "@/db/tenant-context";
const router = express.Router();

/**
 * 登出（spec §7.2）：`tokenVersion++` ⇒ 该账号**所有**已签发的令牌立即失效（含其他设备），
 * 并清掉 refresh Cookie（用**同一组 path/属性**，否则浏览器里那份不会被覆盖）。
 *
 * ⚠ 本路由**不在白名单**里（需要 access）—— 否则谁都能拿别人的 userId 去踢人下线。
 */
export default router.post("/", async (_req, res) => {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
  await logout(ctx.userId);
  res.clearCookie(REFRESH_COOKIE, clearRefreshCookieOptions());
  return res.status(200).send(success(null, "已登出"));
});
