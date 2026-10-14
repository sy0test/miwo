/**
 * 会话（Phase 1c Task 11）。
 *
 * ── 这个文件解决什么 ──
 * 后端（Task 2+3）把登录态拆成两半：
 *   · **access**（15 分钟，响应体里返回）—— 前端**只存内存**，不落 localStorage/sessionStorage；
 *   · **refresh**（7 天，`HttpOnly` Cookie，`Path=/api/auth`）—— JS **读不到**，只能"用"它。
 * 于是"页面刷新"这个动作会把内存里的 access 清空，而 Cookie 还在 ⇒ 前端必须能**静默续期**：
 * 调 `POST /api/auth/refresh` 换一条新的 access，全程不需要用户重新输口令。
 *
 * ── 三条纪律 ──
 * 1. **单飞**（`inflight`）：一次 401 风暴里可能有十几个并发请求同时失败，只允许发**一次** refresh；
 *    否则会打出一个 refresh 请求风暴，而且后到的响应会互相覆盖内存里的 token。
 * 2. **绝不把 token 写进任何 storage**：本文件只有一处写 token —— `userStore().token`（内存 ref）。
 * 3. **不 import router**：`router/index.ts` 要 import 本文件（守卫里做首屏静默续期），
 *    反向 import 会成环。跳转/提示由调用方（`utils/axios.ts`）负责。
 */
import axios from "axios";
import settingStore from "@/stores/setting";
import userStore from "@/stores/user";

/** 刷新请求的超时：**刻意短**（首屏守卫会等它），10 分钟那种业务超时会变成白屏。 */
const REFRESH_TIMEOUT_MS = 15000;

let inflight: Promise<string | null> | null = null;

/**
 * 用 `HttpOnly` refresh Cookie 换一条新的 access 并写回内存；失败返回 `null`（**不抛**）。
 *
 * ⚠ 刻意用**裸 axios**（不是 `@/utils/axios` 的实例）：走实例会再次经过 401 拦截器 ⇒ 递归刷新。
 * ⚠ `withCredentials: true` 必须显式写：dev 下前端 50188 打后端 10588 是**跨源**，不带凭据就不发 Cookie。
 */
export function refreshAccessToken(): Promise<string | null> {
  if (inflight) return inflight;
  const baseURL = settingStore().baseUrl;
  inflight = axios
    .post(`${baseURL}/auth/refresh`, null, { withCredentials: true, timeout: REFRESH_TIMEOUT_MS })
    .then((res) => {
      const token = String(res?.data?.data?.token ?? "");
      if (!token) return null;
      userStore().token = token;
      return token;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 清掉**内存**里的会话（登出 / 续期失败 / 令牌被吊销时调用）。
 *
 * ⚠ 不清 Cookie：真正的吊销是后端的 `tokenVersion++` + 清 Cookie（`POST /api/auth/logout`）。
 *   前端这层只是"别再把这条失效令牌发出去"。
 */
export function clearSession(): void {
  const store = userStore();
  store.token = "";
  store.id = 0;
  store.name = "";
  store.role = "user";
  store.mustChangePassword = false;
}
