import express from "express";
import { success } from "@/lib/responseFormat";
import { loadUserCtx } from "@/auth/service";
import { currentTenant } from "@/db/tenant-context";
const router = express.Router();

/**
 * 当前登录用户（spec §7.3）。前端用它判断"要不要强制改密"与"token 是否还有效"。
 *
 * ⚠ 每请求从 DB 现读（不复用 token 里的 role/status）：停用/改密之后**不需要**等 token 过期
 *   就会在这里反映出来（`middleware/auth.ts` 的 `tv` 比对是同一族判据）。
 * ⚠ **绝不**回传 `passwordHash`（`loadUserCtx` 的投影里就没有它）。
 */
export default router.get("/", async (_req, res) => {
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
  const user = await loadUserCtx(ctx.userId);
  if (!user || user.status !== "active") return res.status(401).send({ code: 401, data: null, message: "登录状态无效" });
  return res.status(200).send(
    success({
      id: user.id,
      name: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    }),
  );
});
