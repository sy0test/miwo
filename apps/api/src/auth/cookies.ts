/**
 * refresh Cookie 的读写（spec §7.2：httpOnly + Secure + SameSite=Lax）。Phase 1c Task 2。
 *
 * 为什么不引 cookie-parser：只要读一个固定名字的 Cookie，十来行解析就够；少一个运行期依赖
 * 就少一个升级面（`res.cookie()` / `res.clearCookie()` 是 Express 自带的）。
 *
 * ⚠ `Secure` 只在 prod 打开：dev 走 `http://127.0.0.1`，浏览器会**拒收**带 Secure 的 Cookie
 *   （症状是"登录成功但一刷新就掉线"，很隐蔽）—— 这是 spec "prod 必须 HTTPS" 的直接推论。
 * ⚠ 令牌**绝不**回传到非 HttpOnly 存储（spec §7.2）：access 走响应体的 `token` 字段（前端存内存），
 *   refresh 只走这个 Cookie；`readCookie` 只给服务端路由用，不参与任何"回传令牌"的响应体。
 */
import type { CookieOptions } from "express";
import { config } from "@/config";
import { REFRESH_TTL_SEC } from "@/auth/tokens";

export const REFRESH_COOKIE = "miwo_rt";

/** refresh / 登出都在这个前缀下；其他接口收不到这个 Cookie（最小暴露面）。 */
export const REFRESH_COOKIE_PATH = "/api/auth";

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.env === "prod",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TTL_SEC * 1000,
  };
}

/** 登出时清除要用**同一组 path/属性**，否则浏览器里的旧 Cookie 不会被覆盖掉。 */
export function clearRefreshCookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: config.env === "prod", path: REFRESH_COOKIE_PATH };
}
