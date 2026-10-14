import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { changePassword } from "@/auth/service";
import { REFRESH_COOKIE, clearRefreshCookieOptions } from "@/auth/cookies";
import { currentTenant } from "@/db/tenant-context";
const router = express.Router();

/**
 * 改密（spec §7.2）：校验旧口令 → argon2id 新哈希 → `tokenVersion++`（旧令牌全失效）
 * → 清 `mustChangePassword` → 顺手清掉 refresh Cookie（本设备也要重新登录）。
 *
 * ⚠ 强度下限（≥8、不得与用户名相同、不得与原口令相同）在 **service** 里判，
 *   本路由只做**形状**校验 —— 两条判据不能只留一条（zod 的 min(8) 也会挡，
 *   但 service 是"任何调用方"的兜底，路由被绕过时仍然成立）。
 */
export default router.post(
  "/",
  validateFields({ oldPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }),
  async (req, res) => {
    const ctx = currentTenant();
    if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
    const { oldPassword, newPassword } = req.body;
    await changePassword(ctx.userId, oldPassword, newPassword);
    res.clearCookie(REFRESH_COOKIE, clearRefreshCookieOptions());
    return res.status(200).send(success(null, "口令已更新，请重新登录"));
  },
);
