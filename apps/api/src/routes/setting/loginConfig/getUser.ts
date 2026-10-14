import express from "express";
import { success } from "@/lib/responseFormat";
import { loadUserCtx } from "@/auth/service";
import { currentTenant } from "@/db/tenant-context";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";
const router = express.Router();

/**
 * 「设置 → 登录配置」读账号（Phase 1c Task 4 起是"**本人 + 管理员**"）。
 *
 * ⚠ Phase 1c Task 3 修的两处（都是 `005_accounts` 之后才坏的）：
 *   1. 原来 `select("*").first()` 取的是**全表第一行** —— 多用户下会显示/修改别人的账号
 *      （旧系统只有一个用户，所以这个 bug 一直看不出来）。现在按 **ctx.userId** 取**自己**。
 *   2. `select("*")` 会把 `o_user` 的**所有列**回传，其中含 `passwordHash`
 *      （Task 1 之前那列叫 `password`，是明文 —— 现在换成 argon2 哈希，泄露同样不可接受）。
 *      这里只回传前端要用的字段（`pages/.../loginConfig.vue` 读 `id` / `name`）。
 *
 * ⚠ Phase 1c Task 4 补的一条：**查询串里带 `?id=` 时只有管理员能查别人**（spec §7.3 的
 *   "`getUser`：无 id → 本人；带 id → 仅 admin"）。缺了这一条就是一条 IDOR 读路径：
 *   普通用户 `?id=1` 就能看到管理员的 `role`/`status`/`mustChangePassword`。
 *   ⚠ 仍**不**回 `passwordHash`（无论谁查）。
 */
export default router.get("/", async (req, res) => {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });

  const rawId = (req.query as Record<string, unknown>)?.id;
  const wantsOther = rawId !== undefined && rawId !== null && String(rawId) !== "" && Number(rawId) !== Number(ctx.userId);
  if (wantsOther) {
    if (ctx.role !== "admin") {
      await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${String(rawId)}`, {
        ok: false,
        reason: "getUser-forbidden-not-admin",
      });
      return res.status(403).send({ code: 403, data: null, message: "只有管理员能查看其他账号" });
    }
    const other = await loadUserCtx(Number(rawId));
    if (!other) return res.status(404).send({ code: 404, data: null, message: "账号不存在" });
    return res.status(200).send(
      success({ id: other.id, name: other.username, role: other.role, status: other.status, mustChangePassword: other.mustChangePassword }),
    );
  }

  const user = await loadUserCtx(ctx.userId);
  if (!user) return res.status(404).send({ code: 404, data: null, message: "账号不存在" });
  return res.status(200).send(
    success({ id: user.id, name: user.username, role: user.role, status: user.status, mustChangePassword: user.mustChangePassword }),
  );
});
