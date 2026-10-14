/**
 * 旧登录路径 `/api/login/login` —— **保留可用**（Phase 1c Task 3）。
 *
 * ── 为什么不是"删掉它、让前端改用 /api/auth/login"（brief Task 3 的原话）──
 * 控制器的验收（本任务书 §5 判别力 1）明确要求"**真 HTTP 打 `/api/login/login` 能拿到令牌**，
 * 并用该令牌访问一个受保护接口成功"，且 §5.4 要求 `verify:phase1b` 17/17 不回归
 *   —— 那条脚本的 token 与白名单判据都建立在"`/api/login/login` 是匿名入口"之上
 *   （`tests/tenant-http-context.test.ts` 也钉着它"放行且不建 ctx"）。
 * 前端切换（存内存 + 401 续期 + 注册页）是 **Task 11**，在那之前砍掉旧路径 = 用户点不动登录。
 * ⇒ 本任务把它**改成薄壳**（与 `/api/auth/login` 调**同一个** service），
 *   响应体保留旧前端要用的 `token`/`id`/`name`（`pages/login/index.vue:99-100` 只读这两个）。
 *
 * ⚠ 与 `/api/auth/login` 的唯一差别是**不发 refresh Cookie**（旧前端不做续期；
 *   refresh Cookie 的 path 是 `/api/auth`，给旧路径发它也只会变成浏览器里的死数据）。
 * ⚠ 口令校验、锁定、令牌签发全部走 `@/auth/service`（唯一实现），本文件没有第二份业务逻辑。
 */
import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { loginLimiter } from "@/middleware/rateLimit";
import { login } from "@/auth/service";
const router = express.Router();

export default router.post(
  "/",
  loginLimiter,
  validateFields({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(200),
  }),
  async (req, res) => {
    const { username, password } = req.body;
    const { user, access } = await login({ username, password, ip: req.ip ?? "" });
    return res.status(200).send(
      success(
        { token: `Bearer ${access}`, id: user.id, name: user.username, role: user.role },
        "登录成功",
      ),
    );
  },
);
