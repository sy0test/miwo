import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { AuthHttpError } from "@/auth/errors";
import { hashPassword } from "@/auth/password";
import { currentTenant } from "@/db/tenant-context";
import { runAsAuth } from "@/db/noContext";
import u from "@/utils";
const router = express.Router();

/**
 * "设置 → 登录配置"保存（改用户名 / 改口令）。
 *
 * ⚠ Phase 1c Task 3 修的三处（`005_accounts` 之后旧实现直接 500）：
 *   1. 旧实现写 `{name, password}` —— `o_user` 已无这两列（`username` + `passwordHash`），
 *      sqlite 会抛 `no such column` ⇒ 这个页面在 HEAD 上是坏的。
 *   2. 旧实现按请求体里的 `id` **任意**改一行 ⇒ 普通用户能改别人的账号（IDOR）。
 *      现在要求 `id === ctx.userId`（前端本来就传自己的 id，行为不变）。
 *   3. 口令必须以 **argon2id** 落库，并 `tokenVersion++`（改密后旧令牌立即失效，spec §7.2）。
 *      `password` 为空 = "不改口令"（前端表单在用户没填时会传空串）。
 */
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string().min(3).max(64),
    password: z.string().max(200).optional(),
  }),
  async (req, res) => {
    const ctx = currentTenant();
    if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
    const { id, name, password } = req.body;
    if (Number(id) !== Number(ctx.userId)) {
      return res.status(403).send({ code: 403, data: null, message: "只能修改自己的账号" });
    }
    const row: any = await u.db("o_user").where("id", ctx.userId).first();
    if (!row) return res.status(404).send({ code: 404, data: null, message: "账号不存在" });

    const patch: Record<string, unknown> = { username: String(name) };
    const newPwd = String(password ?? "");
    if (newPwd) {
      if (newPwd.length < 8) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令至少 8 位");
      if (newPwd.toLowerCase() === String(name).toLowerCase()) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令不得与用户名相同");
      patch.passwordHash = await hashPassword(newPwd);
      patch.tokenVersion = Number(row.tokenVersion ?? 0) + 1; // 旧令牌立即失效
    }
    // ⚠ 写 `o_user`（**platform** 策略）必须带"系统身份"：守卫对 platform 表的写要求
    //    `ctx.role === "admin"`（spec §6.2），而这里的 ctx 可能是普通用户（role=user）。
    //    "改自己的账号"是**服务端代劳**的动作，所以走 `runAsAuth`（与 `@/auth/service` 同一套）。
    await runAsAuth(async () => {
      await u.db("o_user").where("id", ctx.userId).update(patch);
    });
    return res.status(200).send(success("保存设置成功"));
  },
);
