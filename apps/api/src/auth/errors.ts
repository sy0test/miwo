/**
 * 认证链路的**对外错误**（Phase 1c Task 3）。
 *
 * 为什么单独一个类型（而不是复用 1b 的 `TenantIsolationError` 家族）：
 *   `tenantErrorHandler` 只认 4 个隔离类 code，认证失败是另一条语义链（401/403/409/400），
 *   混进那 4 个 code 会让"租户隔离门禁"的判据被稀释（`tools/check-tenant-exceptions.cjs`
 *   与 `tests/tenant-guard.test.ts` 都按那些 code 断言）。
 *
 * 响应体形状（与 spec §7.2 / brief 一致）：`{ code: <httpStatus>, data: <通常 null>, message }`
 *   —— 不带堆栈、不带内部文案（service 抛出的 message 都是**面向用户**的；
 *   唯一的例外是锁定态的 `data.lockedUntil`，它是前端倒计时要用的、且不泄露账号是否存在）。
 */
export class AuthHttpError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly data: unknown;
  constructor(httpStatus: number, code: string, message: string, data: unknown = null) {
    super(message);
    this.name = "AuthHttpError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.data = data;
  }
}
