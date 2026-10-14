/**
 * 登录态（Phase 1c Task 11）。
 *
 * ── 为什么 `token` 是**内存** ref ──
 * spec §7.2 / brief Step 2：access token **不落 localStorage，也不落 sessionStorage**。
 * 落盘之后，一次 XSS（或一次"用户把开发工具打开"）就能拿到一条长期可用的凭据；存内存则最坏
 * 损失被限制在"这个标签页活着的这段时间"，而且续期凭证（refresh）在 **HttpOnly Cookie** 里，
 * JS 根本读不到。刷新页面的代价是"重新静默续期一次"，不是"重新登录"（见 `utils/session.ts`）。
 *
 * ⚠ `persist` 只 pick `role`：它不是凭据（不构成鉴权），只是让首屏少一次闪烁。
 *   **绝不要**把 `token` / `id` / `name` 加进 `persist.pick` —— 那等于把会话写回磁盘。
 */
export default defineStore(
  "user",
  () => {
    /** 形如 `Bearer <jwt>`（与后端 `data.token` 同形：axios 请求头里直接用，不再二次拼接）。 */
    const token = ref("");
    const id = ref(0);
    const name = ref("");
    const role = ref<"user" | "admin">("user");
    const mustChangePassword = ref(false);

    /** 登录 / 续期 / `/auth/me` 的响应体 → store（**只在这里**写这几个字段）。 */
    function setSession(payload: {
      token?: string;
      id?: number;
      name?: string;
      role?: "user" | "admin";
      mustChangePassword?: boolean;
    }): void {
      if (payload?.token) token.value = String(payload.token);
      if (payload?.id !== undefined) id.value = Number(payload.id);
      if (payload?.name !== undefined) name.value = String(payload.name);
      if (payload?.role === "admin" || payload?.role === "user") role.value = payload.role;
      if (payload?.mustChangePassword !== undefined) mustChangePassword.value = Boolean(payload.mustChangePassword);
    }

    return { token, id, name, role, mustChangePassword, setSession };
  },
  { persist: { pick: ["role"] } },
);
