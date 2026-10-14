import express from "express";
import { success } from "@/lib/responseFormat";
import { loadUserCtx } from "@/auth/service";
import { currentTenant } from "@/db/tenant-context";
const router = express.Router();

/**
 * "设置 → 登录配置"读当前账号。
 *
 * ⚠ Phase 1c Task 3 修的两处（都是 `005_accounts` 之后才坏的）：
 *   1. 原来 `select("*").first()` 取的是**全表第一行** —— 多用户下会显示/修改别人的账号
 *      （旧系统只有一个用户，所以这个 bug 一直看不出来）。现在按 **ctx.userId** 取**自己**。
 *   2. `select("*")` 会把 `o_user` 的**所有列**回传，其中含 `passwordHash`
 *      （Task 1 之前那列叫 `password`，是明文 —— 现在换成 argon2 哈希，泄露同样不可接受）。
 *      这里只回传前端要用的字段（`pages/.../loginConfig.vue` 读 `id` / `name`）。
 */
export default router.get("/", async (_req, res) => {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
  const user = await loadUserCtx(ctx.userId);
  if (!user) return res.status(404).send({ code: 404, data: null, message: "账号不存在" });
  return res.status(200).send(
    success({ id: user.id, name: user.username, role: user.role, status: user.status, mustChangePassword: user.mustChangePassword }),
  );
});
