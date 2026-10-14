/**
 * JWT 密钥的**唯一解析点**（Phase 1c Task 3；裁定 §3.3）。
 *
 * ── 为什么要有这个文件 ──
 * Phase 1a/1b 的验签语义是"**库值优先 + 配置兜底**"（`o_setting.tokenKey` → `config.jwtSecret`），
 * 它被两条现成判据钉着（删掉必红）：
 *   · `apps/api/scripts/verify-phase0.cjs`：**全新空库** + `MIWO_JWT_SECRET` 已设 ⇒
 *     `configHealth?summary=1` 必须 200（只认库值的话服务永远起不来）；
 *   · `tests/auth-token-key.test.ts` R1/R2、`tests/socket-tenant.test.ts`、`tests/tenant-http-context.test.ts`。
 * Phase 1c Task 1 把 `tokenKey` **行**从 `o_setting` 删掉了（Tier 0 #6：JWT 密钥改由
 * `MIWO_JWT_SECRET` 提供）⇒ 这条链要**搬到新位置且保持同一语义**：
 *
 *   ① `o_setting.jwtSecret`（**新位置**，运维显式轮换密钥用；新库**不种**它）
 *   ② `o_setting.tokenKey`（**旧位置**，老库/既有夹具仍在用：`scripts/seed-tenant-fixture.ts`、
 *      `tests/auth-token-key.test.ts` R2、`tests/tenant-http-context.test.ts`）
 *   ③ `config.jwtSecret`（配置兜底；`config.ts` 模块级 fail-fast ⇒ ≥32 字节、恒有值）
 *
 * ⚠ **每次请求现读**，不做进程内缓存：这是既有语义（`tests/auth-token-key.test.ts` R2 在服务
 *   启动**之后**才插入密钥行，然后断言"无需重启即生效"）。代价是每请求一次 platform 表读；
 *   `o_setting` 是 platform 策略 ⇒ **无 ctx 也放行读**（登录发生在建租户 ctx 之前，这是必要条件）。
 */
import u from "@/utils";
import { config } from "@/config";

/** 新的库内密钥键（显式轮换用）。新库**不种**它（`verify-phase0.cjs` 断言 `o_setting` 的键集合）。 */
export const JWT_SECRET_SETTING_KEY = "jwtSecret";
/** 旧的库内密钥键：Task 1 已从库里删除，但仍读它 —— 老库/夹具里可能还有这一行。 */
export const LEGACY_JWT_SECRET_SETTING_KEY = "tokenKey";

/** 库里显式配置的密钥（新键优先于旧键）；没有就返回 `null`。 */
export async function dbJwtSecret(): Promise<string | null> {
  const rows: Array<{ key: string; value: string | null }> = await (u.db as any)("o_setting")
    .whereIn("key", [JWT_SECRET_SETTING_KEY, LEGACY_JWT_SECRET_SETTING_KEY])
    .select("key", "value");
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const preferred = byKey.get(JWT_SECRET_SETTING_KEY) || byKey.get(LEGACY_JWT_SECRET_SETTING_KEY);
  return preferred ? String(preferred) : null;
}

/** 验签/签发**共用**的密钥：库值优先，配置兜底。 */
export async function resolveJwtSecret(): Promise<string> {
  return (await dbJwtSecret()) ?? config.jwtSecret;
}
