import express from "express";
import { success } from "@/lib/responseFormat";
import { rotateRefresh } from "@/auth/service";
import { REFRESH_COOKIE, readCookie, refreshCookieOptions } from "@/auth/cookies";
const router = express.Router();

/**
 * 刷新（spec §7.2）：读 HttpOnly Cookie → 轮转 → 重新下发 Cookie + 新 access。
 *
 * ⚠ 本路由**在白名单里**（refresh 自己没有 access token）；凭证**只有** Cookie。
 * ⚠ 已知行为：不做 refresh 重用检测（见 `@/auth/tokens` 文件头限制 1），
 *   轮转前的旧 refresh 在到期前仍可用 —— **不是**安全保证。
 */
export default router.post("/", async (req, res) => {
  const token = readCookie(req.headers.cookie, REFRESH_COOKIE);
  if (!token) return res.status(401).send({ code: 401, data: null, message: "缺少刷新凭证，请重新登录" });
  const { access, refresh } = await rotateRefresh(token);
  res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
  return res.status(200).send(success({ token: `Bearer ${access}` }, "已刷新"));
});
