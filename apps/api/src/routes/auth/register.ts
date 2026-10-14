import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { registerLimiter } from "@/middleware/rateLimit";
import { registerWithInvite } from "@/auth/service";
const router = express.Router();

/**
 * 注册（spec §15 O1：默认"邀请码"）。**薄壳**：校验 → service → 响应。
 *
 * ⚠ 审计日志（`o_auditLog`）不在这里写：它属于 Phase 1c Task 4 的"审计日志"本体
 *   （含"未认证路径怎么写 platform 表"的统一处置）。此处**不留半截实现**，避免两个写入点。
 */
export default router.post(
  "/",
  registerLimiter,
  validateFields({
    username: z.string().min(3).max(64),
    password: z.string().min(8).max(200),
    inviteCode: z.string().max(64).optional(),
  }),
  async (req, res) => {
    const { username, password, inviteCode } = req.body;
    const user = await registerWithInvite({ username, password, inviteCode, ip: req.ip ?? "" });
    return res.status(200).send(success({ id: user.id, username: user.username }, "注册成功"));
  },
);
