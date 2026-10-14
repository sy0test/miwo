/**
 * 接口错误的**统一用户可读文案**（Phase 1c Task 11；对应后端 Task 5+6 的错误脱敏）。
 *
 * ── 为什么前端也要做这一层（后端已经脱敏了）──
 * 后端保证的是"`>=500` 不回内部文案"（`src/app.ts` 的 errorHandler），而 `<500` 的 message 来自
 * 各条路由自己 —— 那里面**可能有**表名/约束名/路径这类结构性信息。前端把后端原文**直接渲染**
 * 就等于把"后端脱敏"的边界交给了几十个调用点的自觉。所以这里收成一条规则：
 *
 *   **渲染的文案一律由 `code` 决定（i18n 键），后端的原始 message 只作为 `rawMessage` 保留在
 *   对象上（供调试/上报），不参与渲染。**
 *
 * ⚠ 调用方若知道自己在做什么（例如登录页知道 401 = 口令错），**按 code 覆盖成更精确的文案**，
 *   仍然不是"把后端原文渲染出去"。见 `pages/login/index.vue`。
 * ⚠ 本层**不**做"看起来像内部信息就过滤"这种启发式 —— 启发式会漏、也会误伤，判据必须是确定的。
 */

/** `code` → i18n 键。未登记者一律落到 `unknown`。 */
const CODE_KEYS: Record<string, string> = {
  "400": "common.apiError.badRequest",
  "401": "common.apiError.unauthorized",
  "403": "common.apiError.forbidden",
  "404": "common.apiError.notFound",
  "409": "common.apiError.conflict",
  "429": "common.apiError.tooManyRequests",
};

/** 该 `code` 对应的用户文案（i18n 缺键时退回键名本身，绝不回落后端原文）。 */
export function apiErrorText(code: number): string {
  const n = Number(code);
  const key = !Number.isFinite(n) || n <= 0 || n >= 500 ? "common.apiError.server" : CODE_KEYS[String(n)] ?? "common.apiError.unknown";
  const t = (window as any)?.$t;
  return typeof t === "function" ? String(t(key)) : key;
}

/** 归一化后的错误对象：`message` 一定可以安全渲染，`rawMessage` 仅供调试。 */
export interface NormalizedApiError {
  code: number;
  data: unknown;
  message: string;
  /** 后端/axios 的原始文案 —— **不要**直接渲染它。 */
  rawMessage: string;
}

/**
 * 把 axios 的错误（或任意抛出物）归一化成 `NormalizedApiError`。
 *
 * ⚠ 形状刻意与后端响应体 `{code,data,message}` 对齐：现有调用点写着 `err.message`，
 *   它们不需要改，拿到的就已经是安全文案。
 */
export function normalizeApiError(error: any): NormalizedApiError {
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  const body = error?.response?.data;
  const code = Number(body?.code ?? status ?? 0);
  const rawMessage = String(body?.message ?? error?.message ?? "");
  return {
    code: Number.isFinite(code) ? code : 0,
    data: body?.data ?? null,
    message: apiErrorText(code),
    rawMessage,
  };
}
