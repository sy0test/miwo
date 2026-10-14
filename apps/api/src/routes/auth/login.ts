import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { loginLimiter } from "@/middleware/rateLimit";
import { login } from "@/auth/service";
import { REFRESH_COOKIE, refreshCookieOptions } from "@/auth/cookies";
const router = express.Router();

/**
 * 登录（spec §7.2）。**薄壳**：校验 → service → 发双令牌。
 *
 * 令牌载体（刻意如此，别"顺手改干净"）：
 *   · access → 响应体 `data.token`（**带 `Bearer ` 前缀**，与旧前端 `login/index.vue` 的用法一致）；
 *   · refresh → **只**走 HttpOnly Cookie（`miwo_rt`，path=/api/auth），绝不回传到响应体。
 *
 * ⚠ `mustChangePassword` 为真时**不在后端拦其他接口**（那会把管理员锁在门外），
 *   只在响应体与 `/api/auth/me` 里回这个标志，由前端强制跳改密页（拍板项 #5 / Task 11）。
 */
export default router.post(
  "/",
  loginLimiter,
  validateFields({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }),
  async (req, res) => {
    const { username, password } = req.body;
    const { user, access, refresh } = await login({ username, password, ip: req.ip ?? "" });
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    return res.status(200).send(
      success(
        {
          token: `Bearer ${access}`,
          id: user.id,
          name: user.username,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
        "登录成功",
      ),
    );
  },
);
