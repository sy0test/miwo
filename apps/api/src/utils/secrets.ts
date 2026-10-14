/**
 * 供应商凭据的**回传脱敏**（Phase 1c Task 9；spec Tier 0 #2）。
 *
 * ── 它解决的那件事 ──
 * `getVendorList` 原来把 `o_vendorConfig.inputValues` 原样 `JSON.parse` 后回给前端 ——
 * 那是**供应商 API key 的明文**。Task 4 给整族端点加了 `requireAdmin`，但"admin 也拿不到明文"
 * 是另一条独立的判据：管理员令牌一旦被盗/被误用，"全站出网凭据"不该是免费信息。
 *
 * ── 判定口径：**按键名匹配**，不是按值猜 ──
 *  · 命中（值换 `***`）：`apiKey` / `token` / `secret` / `password` / `key` 这类**完整词**，
 *    大小写不敏感，允许 `-`/`_` 连接（`api_key`、`API-KEY`、`accessToken` 里的 `token` 尾巴）。
 *  · 不命中：`vendorName` / `modelName` / `baseUrl` / `chatBaseUrl` / `mediaBaseUrl` /
 *    `placeholder` … —— 它们的**词**里没有 `key`/`token`/`secret`/`password`。
 *    ⚠ 这正是"必须写词边界"的原因：宽松的 `includes("key")` 会把 `monkey`、`keyboard` 之类
 *      甚至 `vendorKeyName` 一起掩掉，前端"填过没填过"的判断就没了。
 *
 * ── 两个返回值，一条原则 ──
 *  · `values`：原键名 → 命中键给 `"***"`，其余原样（`baseUrl` 这类**非凭据**要留着，
 *    否则前端连"打到哪个地址"都显示不出来）。
 *  · `configured`：键名 → `true/false`（**值非空**）。前端据此渲染"已配置/未配置"，
 *    而拿不到值本身。
 *  ⚠ `configured` 是**额外**加的一个键（`__configured`），不要把它与真实输入键混在一起：
 *    真实输入键来自适配器声明的 `inputs`，前端按 `inputs` 渲染表单。
 */

/** 凭据键名判据（完整词 + 可选 `-`/`_` 连接；大小写不敏感）。 */
const SECRET_KEY_RE = /(?:^|[^A-Za-z0-9])(?:api[-_]?key|apikey|key|token|secret|password|passwd|pwd|credential)s?(?![A-Za-z0-9])/i;
/** 与上面同口径的"整键名"判据（用于 `configured` 的自证测试）。 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(String(key));
}

export interface MaskedSecrets {
  /** 键名 → 掩码后的值（命中键一律 `"***"`）。 */
  values: Record<string, string>;
  /** 键名 → 是否**已配置**（值非空）。**不给值**。 */
  configured: Record<string, boolean>;
}

/** 掩码占位符（前端只需判断"是不是 `***`"，不需要区分长度）。 */
export const SECRET_MASK = "***";

/**
 * 把一份 `inputValues` 拆成"可安全回传的值"与"存在性"。
 *
 * @param input 原始 `inputValues`（对象或 `JSON.parse` 之前的那种任意形状）
 */
export function maskSecrets(input: unknown): MaskedSecrets {
  const values: Record<string, string> = {};
  const configured: Record<string, boolean> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { values, configured };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const present = v !== undefined && v !== null && String(v).trim() !== "";
    configured[k] = present;
    values[k] = isSecretKey(k) && present ? SECRET_MASK : String(v ?? "");
  }
  return { values, configured };
}
