/**
 * 认证夹具（Phase 1c Task 11）。
 *
 * ── 为什么需要它 ──
 * Task 11 把**旧形状**令牌（`{id, name}`，无 `typ`/`tv`）整体退役：`middleware/auth.ts` 与
 * `socket/tenant.ts` 不再有 legacy 分支。于是"用当前密钥签一个 `{id:7}` 就能装成 7 号用户"
 * 这条路被封死 —— 夹具必须改成**生产路径的形状**，两件事缺一不可：
 *   ① 库里有一行 `status="active"` 的 `o_user`（`loadUserCtx()` 每请求读它，读不到 ⇒ 401）；
 *   ② 令牌是新形状 `{uid, role, tv, typ:"access"}`，`tv` 必须与库里那行的 `tokenVersion` **相等**
 *      （不等 ⇒ `"登录状态已失效"` 401）。
 *
 * ── 口径（与 `tests/authorization.test.ts` 的 `freshToken()` 逐字一致）──
 * 密钥走 `resolveJwtSecret()`（库值优先 + 配置兜底）—— 与中间件同一条链。
 * 用 `config.jwtSecret` 硬签会在"库里种了 tokenKey"的用例里整片 401（假红，且看不出原因）。
 *
 * ⚠ 只给"用**共享测试库**（`vitest.config.ts` 的 `MIWO_DATA_DIR`）的用例"用。
 *   用 `createKnex(dbConfigOf(自己的临时目录))` 起**独立**数据目录的用例（`auth-token-key` /
 *   `ops-endpoints-auth` / `vendor-secrets`）必须用它们自己的 knex 句柄 —— 这个句柄读的是
 *   共享库，对它们来说是另一个库，种了也读不到。
 *   `mintAccess()` 是纯函数（不碰库），那三个文件可以直接用它并显式传 `secret`。
 */
import type { Knex } from "knex";
import { resolveJwtSecret } from "@/auth/secret";
import { signToken } from "@/auth/tokens";

export interface AuthFixtureUser {
  id: number;
  username: string;
  role: "user" | "admin";
}

/**
 * 幂等种下"已开通"的账号夹具。
 *
 * ⚠ `passwordHash` 刻意留空串：夹具账号**登不进来**（argon2 验不过），它只用于 JWT 鉴权。
 *   这样"夹具账号"永远不会变成一条可用的登录凭据。
 */
export async function seedAuthUsers(db: Knex, users: readonly AuthFixtureUser[]): Promise<void> {
  for (const u of users) {
    await db("o_user")
      .insert({
        id: u.id,
        username: u.username,
        email: null,
        passwordHash: "",
        role: u.role,
        status: "active",
        tokenVersion: 0,
        mustChangePassword: 0,
        createdAt: 1,
        lastLoginAt: null,
      })
      .onConflict("id")
      .merge();
  }
}

/** 按 id **逐条**清理（不用通配符；`whereIn` 也是显式清单）。 */
export async function removeAuthUsers(db: Knex, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await db("o_user").whereIn("id", [...ids]).del();
}

/**
 * 新形状 access 令牌（**不带 `Bearer ` 前缀** —— 调用方自己决定放请求头还是拼串）。
 *
 * @param secret 缺省 = `resolveJwtSecret()`（库值优先 + 配置兜底）。
 * @param tv     必须与库里那一行的 `tokenVersion` 相等。
 */
export async function mintAccess(user: AuthFixtureUser, secret?: string, tv = 0): Promise<string> {
  const key = secret ?? (await resolveJwtSecret());
  return signToken({ uid: user.id, role: user.role, tv, typ: "access" }, key);
}
