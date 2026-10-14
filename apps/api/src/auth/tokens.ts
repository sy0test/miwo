/**
 * 双令牌（spec §7.2）。Phase 1c Task 2。
 *
 *   access  —— JWT 15 分钟，载荷 `{uid, role, tv, typ:"access", jti}`；前端**存内存**
 *   refresh —— JWT 7 天，载荷同上但 `typ:"refresh"`；只放 HttpOnly Cookie，路径限定 `/api/auth`
 *
 * 吊销：验签后必须比对**当前** DB 里的 `o_user.tokenVersion`；`tv` 不等即视为已吊销（spec §7.2）。
 * 授权：token 里的 `role` **只是提示**，ctx 的 role 一律以 DB 为准（`middleware/auth.ts`）。
 *
 * ⚠ 已知限制（显式登记，别当成安全保证）：
 *   1. 只做 `tv` 版本吊销 + 轮转，**不做 refresh 重用检测**（那需要 jti 黑名单表）。
 *      spec §7.2 未要求重用检测；Phase 2 若要，加 `o_sessionJti` 表即可。
 *   2. ~~兼容旧 token 形状~~ —— **Phase 1c Task 11 已整体退役**：`verifyLegacyToken` 与两侧
 *      （HTTP `middleware/auth.ts` / socket `socket/tenant.ts`）的 legacy 分支都已删除。
 *      原因（安全，不是洁癖）：旧形状**不读 DB** ⇒ 005 把旧账号迁成 `status="disabled"` 的封禁
 *      对它不生效，且 `roleOfUserId(1)==="admin"` 让任何旧 `{id:1}` 令牌恒为管理员。
 *      旧令牌寿命 180 天 ⇒ 只删签发端不够，必须让验签端也不再认它。
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "@/config";

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 7 * 24 * 3600;

export class AuthError extends Error {
  code: "invalid" | "expired" | "revoked" | "type";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "AuthError";
  }
}

export type TokenType = "access" | "refresh";
export interface TokenClaims {
  uid: number;
  role: "user" | "admin";
  tv: number;
  typ: TokenType;
  jti: string;
}

/**
 * ⚠ `secret` 参数默认 `config.jwtSecret`，但 HTTP/socket 链路**必须**传
 *   `await resolveJwtSecret()` 的结果（`@/auth/secret`：库值优先、配置兜底）。
 *   不传 = 只认配置密钥 = 会与"验签用库值"的既有语义错开（表现为"登录成功但立刻 401"）。
 */
export function signToken(c: Omit<TokenClaims, "jti">, secret: string = config.jwtSecret): string {
  const ttl = c.typ === "access" ? ACCESS_TTL_SEC : REFRESH_TTL_SEC;
  const payload: TokenClaims = { ...c, jti: crypto.randomUUID() };
  return jwt.sign(payload, secret, { expiresIn: ttl, algorithm: "HS256" });
}

export function verifyToken(token: string, typ: TokenType, secret: string = config.jwtSecret): TokenClaims {
  let decoded: any;
  try {
    // `algorithms` 白名单：防 `alg=none` / RS256-HS256 混淆（验签必须锁算法）
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (e: any) {
    if (e?.name === "TokenExpiredError") throw new AuthError("expired", "登录已过期");
    throw new AuthError("invalid", "令牌无效");
  }
  if (decoded?.typ !== typ) throw new AuthError("type", `令牌类型不匹配（期望 ${typ}）`);
  if (
    typeof decoded?.uid !== "number" ||
    typeof decoded?.tv !== "number" ||
    (decoded.role !== "user" && decoded.role !== "admin")
  ) {
    throw new AuthError("invalid", "令牌载荷不完整");
  }
  return decoded as TokenClaims;
}

/**
 * ⚠【Phase 1c Task 11】**旧形状 token 的验签函数已删除**（原 `verifyLegacyToken`）。
 *
 * 删掉比"留着但没人调用"更安全：留着一个"能把 `{id:N}` 变成 userId"的原语，下一个人只要在
 * 中间件里加一行就能把整条漏洞恢复，而**没有任何机械判据会红**。现在这条路上什么都不剩：
 * 载荷形状不对 ⇒ `verifyToken` 抛 `AuthError("invalid")` ⇒ HTTP 401 / socket 拒连。
 *
 * 判别力用例：`tests/auth-legacy-retired.test.ts`（真应用 + 真 HTTP：旧形状令牌必须 401，
 * 新形状令牌必须 200）。
 */
