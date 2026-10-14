import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { AuthHttpError } from "@/auth/errors";
import { hashPassword, verifyPassword } from "@/auth/password";
import { currentTenant } from "@/db/tenant-context";
import { runAsAuth } from "@/db/noContext";
import { AUDIT_ACTIONS, actorFromCtx, audit, auditPlatformWrite } from "@/utils/audit";
import u from "@/utils";
const router = express.Router();

/**
 * 「设置 → 登录配置」保存（改用户名 / 改口令）。
 *
 * ── Phase 1c Task 3 修的三处（`005_accounts` 之后旧实现直接 500）──
 *   1. 旧实现写 `{name, password}` —— `o_user` 已无这两列（`username` + `passwordHash`）；
 *   2. 旧实现按请求体里的 `id` **任意**改一行（IDOR）⇒ 现在 `id === ctx.userId` 或调用者是 admin；
 *   3. 口令必须以 **argon2id** 落库，并 `tokenVersion++`（改密后旧令牌立即失效，spec §7.2）。
 *
 * ── Phase 1c Task 4 的三处（本任务）──
 *   · **L3 用户名唯一性预检**：改名前先查重 ⇒ 撞 `o_user.username` 的 UNIQUE 时回 **409**
 *     而不是通用 500（`sqlite`/MySQL 的 ci collation 都更容易撞，且 500 还会回显约束名）；
 *     写入路径同时 catch 约束错误（并发抢名）⇒ 仍然 409。
 *   · **旧口令可选**：`oldPassword` 给了就必须对（更安全的路径）；没给就沿用"已登录即可改自己"的
 *     现状语义 —— 前端表单（`apps/web/.../loginConfig.vue`）当前只发 `{id,name,password}`，
 *     把 `oldPassword` 改成必填会让**用户改不了口令**（Task 11 前端加字段后再收紧）。
 *   · **管理员改他人**：允许（仅 admin），**不要求旧口令**，只重置 + `tokenVersion++` + 审计。
 *
 * ── 审计（spec Tier 1 #17）──
 *   成功与拒绝都落 `o_auditLog`；**口令内容绝不进 detail**。
 */
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string().min(3).max(64),
    password: z.string().max(200).optional(),
    oldPassword: z.string().max(200).optional(),
  }),
  async (req, res) => {
    const ctx = currentTenant();
    if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
    const { id, name, password, oldPassword } = req.body;
    const targetId = Number(id);
    const isSelf = targetId === Number(ctx.userId);
    if (!isSelf && ctx.role !== "admin") {
      await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${targetId}`, {
        ok: false,
        reason: "forbidden-not-self-not-admin",
        requestedUsername: String(name),
      });
      return res.status(403).send({ code: 403, data: null, message: "只能修改自己的账号" });
    }

    // ⚠ 读走**受守卫的** `u.db`（`o_user` 是 platform 策略 ⇒ **读**放行，含非 admin 的请求 ctx），
    //   只有**写**才需要系统身份（platform 写要求 `ctx.role === "admin"`，见文件末尾）。
    //   这样本文件的 `runAsAuth` 调用点**只有一处**（写），授权面更窄、也更好审。
    const row: any = await u.db("o_user").where("id", targetId).first();
    if (!row) return res.status(404).send({ code: 404, data: null, message: "账号不存在" });

    const newName = String(name);
    const newPwd = String(password ?? "");

    // ---- L3：唯一性**写前预检**（撞 UNIQUE ⇒ 409，而不是 500 + 约束名回显）----
    if (newName !== String(row.username ?? "")) {
      const taken: any = await u.db("o_user").where("username", newName).first();
      if (taken && Number(taken.id) !== targetId) {
        await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${targetId}`, {
          ok: false,
          reason: "username-taken",
          requestedUsername: newName,
        });
        return res.status(409).send({ code: 409, data: null, message: "用户名已被占用" });
      }
    }

    // ---- 口令 ----
    let pwdChanged = false;
    if (newPwd) {
      if (newPwd.length < 8) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令至少 8 位");
      if (newPwd.toLowerCase() === newName.toLowerCase()) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令不得与用户名相同");
      // "给了旧口令就必须对"（管理员改他人时跳过：他不知道也不需要对方的口令）
      if (isSelf && oldPassword !== undefined && String(oldPassword).length > 0) {
        if (!(await verifyPassword(String(row.passwordHash ?? ""), String(oldPassword)))) {
          await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${targetId}`, {
            ok: false,
            reason: "old-password-wrong",
          });
          throw new AuthHttpError(400, "OLD_PASSWORD_WRONG", "原口令不正确");
        }
      }
      pwdChanged = true;
    }

    const patch: Record<string, unknown> = { username: newName };
    if (pwdChanged) {
      patch.passwordHash = await hashPassword(newPwd);
      patch.tokenVersion = Number(row.tokenVersion ?? 0) + 1; // 旧令牌立即失效
    }

    // ⚠ 写 `o_user`（**platform** 策略）必须带"系统身份"：守卫对 platform 表的写要求
    //    `ctx.role === "admin"`（spec §6.2），而这里的 ctx 可能是普通用户（role=user）。
    //    "改自己的账号"是**服务端代劳**的动作，所以走 `runAsAuth`（与 `@/auth/service` 同一套）。
    try {
      await runAsAuth(async () => {
        await u.db("o_user").where("id", targetId).update(patch);
      });
    } catch (err: any) {
      // 并发抢名：预检之后、写入之前被别人占了同一个用户名 ⇒ 仍然是 409（不是 500）
      if (/unique|UNIQUE constraint failed|duplicate/i.test(String(err?.message ?? ""))) {
        await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${targetId}`, {
          ok: false,
          reason: "username-unique-constraint",
          requestedUsername: newName,
        });
        return res.status(409).send({ code: 409, data: null, message: "用户名已被占用" });
      }
      throw err;
    }

    // ---- 审计：成功（口令变更 + 令牌吊销都在 detail 里，但**不含任何口令内容**）----
    const actor = actorFromCtx(req.ip);
    await audit(actor, AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${targetId}`, {
      ok: true,
      byAdmin: !isSelf,
      usernameChanged: newName !== String(row.username ?? ""),
      passwordChanged: pwdChanged,
    });
    if (pwdChanged) {
      await audit(actor, AUDIT_ACTIONS.PASSWORD_CHANGE, String(row.username ?? targetId), {
        viaLoginConfig: true,
        byAdmin: !isSelf,
        tokenVersion: Number(row.tokenVersion ?? 0) + 1,
      });
    }
    await auditPlatformWrite(
      "loginConfig.updateUserPwd",
      `o_user:${targetId}`,
      { usernameChanged: newName !== String(row.username ?? ""), passwordChanged: pwdChanged },
      actor,
    );
    return res.status(200).send(success("保存设置成功"));
  },
);
