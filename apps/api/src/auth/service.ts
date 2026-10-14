/**
 * 认证业务层（spec §7.1 / §7.2 / §7.3）。Phase 1c Task 3。
 *
 * 分层：**路由是薄壳**（校验 + 调这里 + 发响应），业务规则全部在本文件；
 * 原语（argon2id / 双令牌 / Cookie / 锁定判定）在 `src/auth/{password,tokens,cookies,attempts}.ts`。
 *
 * ── 本文件要修的那件事（Task 1 留下的洞）──
 * `005_accounts` 把 `o_user` 重建为 §7.1 的十列（`username`/`passwordHash`/`role`/`status`/
 * `tokenVersion`/`mustChangePassword`…），而旧的 `routes/login/login.ts` 仍读
 * `o_user.name` / `o_user.password` ⇒ **登录必坏**。本文件是修好它的那一半（另一半是路由接线）。
 *
 * ── 三条容易写错的纪律 ──
 * 1. **登录发生在建立租户 ctx 之前**：本文件的读走 guarded `u.db`（platform 表无 ctx 放行读），
 *    写走 `runAsAuth()`（系统身份，见 `@/db/noContext`）。**绝不**在无 ctx 时读租户表
 *    （那会抛 `TENANT_NO_CONTEXT`）。
 * 2. **授权只信 DB**：token 里的 `role` 只是提示；`loadUserCtx()` 每请求读一次真实
 *    `role/status/tokenVersion`（spec §7.3）。
 * 3. **不泄露账号是否存在**：用户不存在时也跑一次真实的 argon2 校验（哑验证，抹平时序差），
 *    失败文案统一为"账号或口令错误"。
 */
import u from "@/utils";
import { AuthHttpError } from "@/auth/errors";
import { lockState, nextAttempt, MAX_FAILED, type AttemptRec } from "@/auth/attempts";
import { hashPassword, needsRehash, verifyPassword } from "@/auth/password";
import { resolveJwtSecret } from "@/auth/secret";
import { signToken, verifyToken } from "@/auth/tokens";
import { runAsAuth } from "@/db/noContext";

export type AuthRole = "user" | "admin";
export type AuthStatus = "active" | "disabled";

export interface AuthUser {
  id: number;
  username: string;
  role: AuthRole;
  status: AuthStatus;
  tokenVersion: number;
  mustChangePassword: boolean;
}

/** `o_user` 在 005 之后的形状（`src/types/database.d.ts` 仍是 005 之前的快照，故显式声明）。 */
interface UserRow {
  id: number | string;
  username: string | null;
  email?: string | null;
  passwordHash?: string | null;
  role?: string | null;
  status?: string | null;
  tokenVersion?: number | null;
  mustChangePassword?: number | null;
  lastLoginAt?: number | null;
}

/** `o_user` 里可安全读出的列（**永不**读/回传 `passwordHash`，除非本文件内部校验口令）。 */
const SAFE_USER_COLUMNS = ["id", "username", "role", "status", "tokenVersion", "mustChangePassword"] as const;

/**
 * 表格句柄的统一取法。
 *
 * ⚠ 为什么要这层：`u.db` 的类型来自 `src/types/database.d.ts`，而那份文件是**自动生成**的
 *   （`db:types` 从真实库生成），当前仍是 005 之前的快照（`o_user` 只有 id/name/password、
 *   四张新表完全不在 `DB` 里）。重新生成需要连一个已迁移的库，而本机唯一那个库是用户的
 *   **只读真实快照**（Ruling 170）⇒ 不在本任务里动它。这里用显式行接口 + 局部放宽的句柄，
 *   让类型既不撒谎、也不因为"生成的快照过期"而挡路（表名仍由守卫按策略表校验，fail-closed）。
 */
function tbl(name: string): any {
  return (u.db as any)(name);
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: Number(row.id),
    username: String(row.username ?? ""),
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "active" ? "active" : "disabled",
    tokenVersion: Number(row.tokenVersion ?? 0),
    mustChangePassword: Number(row.mustChangePassword ?? 0) === 1,
  };
}

/**
 * 每请求读一次真实身份（spec §7.3：授权判定只信 DB，不信 token 里的 role）。
 * 读的是 platform 表 ⇒ 不需要 ctx，也就不会在"认证尚未完成"时踩 `TENANT_NO_CONTEXT`。
 */
export async function loadUserCtx(uid: number): Promise<AuthUser | null> {
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const row: UserRow | undefined = await tbl("o_user").where("id", uid).select(...SAFE_USER_COLUMNS).first();
  return row ? toAuthUser(row) : null;
}

async function findByUsername(username: string): Promise<UserRow | undefined> {
  return await tbl("o_user").where("username", username).first();
}

/** 注册方式（spec §15 O1）：`invite`（默认）/ `open` / `closed`；非法/缺失值一律按最严的 `invite`。 */
export async function registrationMode(): Promise<"invite" | "open" | "closed"> {
  const row: { value?: string | null } | undefined = await tbl("o_setting").where("key", "registrationMode").select("value").first();
  const v = String(row?.value ?? "invite");
  if (v === "open" || v === "closed") return v;
  return "invite";
}

/** 口令强度下限：≥8 字符、且不得与用户名相同（spec §7.2 的最小要求，写进用例）。 */
function assertPasswordStrength(username: string, password: string): void {
  if (String(password).length < 8) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令至少 8 位");
  if (String(password).toLowerCase() === String(username).toLowerCase()) {
    throw new AuthHttpError(400, "WEAK_PASSWORD", "口令不得与用户名相同");
  }
}

/**
 * 消费一次邀请码（`disabled=0` / 未过期 / `usedCount < maxUses`）。
 *
 * ⚠ 并发超发防护：**带条件的 CAS 更新**（`where usedCount = 我刚读到的值`），
 *   影响 0 行 = 有人抢先了 ⇒ 拒绝。不用 `raw("usedCount + 1")`：
 *   一是跨方言的写法差异，二是 `raw` 会新增一条需要人工标注的隔离特例（`check-tenant-exceptions`）。
 */
async function consumeInvite(trx: any, code: string): Promise<void> {
  const invite = await trx("o_invite").where("code", code).first();
  if (!invite) throw new AuthHttpError(403, "INVITE_INVALID", "邀请码无效");
  if (Number(invite.disabled) === 1) throw new AuthHttpError(403, "INVITE_INVALID", "邀请码无效");
  const exp = invite.expiresAt === null || invite.expiresAt === undefined ? null : Number(invite.expiresAt);
  if (exp !== null && exp <= Date.now()) throw new AuthHttpError(403, "INVITE_EXPIRED", "邀请码已过期");
  const used = Number(invite.usedCount ?? 0);
  if (used >= Number(invite.maxUses ?? 1)) throw new AuthHttpError(403, "INVITE_EXHAUSTED", "邀请码已用尽");
  const updated = await trx("o_invite")
    .where({ id: invite.id, usedCount: used })
    .update({ usedCount: used + 1 });
  if (!updated) throw new AuthHttpError(409, "INVITE_RACE", "邀请码正被使用，请重试");
}

export interface RegisterInput {
  username: string;
  password: string;
  inviteCode?: string;
  ip: string;
}

/** 邀请码注册（spec §15 O1）。返回新用户；口令只以 argon2id 形态落库。 */
export async function registerWithInvite(input: RegisterInput): Promise<AuthUser> {
  const username = String(input?.username ?? "").trim();
  if (username.length < 3) throw new AuthHttpError(400, "USERNAME_TOO_SHORT", "用户名至少 3 个字符");
  if (username.length > 64) throw new AuthHttpError(400, "USERNAME_TOO_LONG", "用户名过长");
  assertPasswordStrength(username, input?.password);
  const inviteCode = input?.inviteCode ? String(input.inviteCode).trim() : "";

  const mode = await registrationMode();
  if (mode === "closed") throw new AuthHttpError(403, "REGISTER_CLOSED", "注册已关闭");
  if (mode === "invite" && !inviteCode) throw new AuthHttpError(403, "INVITE_REQUIRED", "需要邀请码");

  const passwordHash = await hashPassword(String(input.password));

  const id: number = await runAsAuth(async () => {
    return await (u.db as any).transaction(async (trx: any) => {
      if (mode !== "open") await consumeInvite(trx, inviteCode);
      const existing = await trx("o_user").where("username", username).first();
      if (existing) throw new AuthHttpError(409, "USERNAME_TAKEN", "用户名已存在");
      const inserted = await trx("o_user").insert({
        username,
        email: null,
        passwordHash,
        role: "user",
        status: "active",
        tokenVersion: 0,
        mustChangePassword: 0,
        createdAt: Date.now(),
        lastLoginAt: null,
      });
      return Number(Array.isArray(inserted) ? inserted[0] : inserted);
    });
  });

  const created = await loadUserCtx(id);
  if (!created) throw new AuthHttpError(500, "REGISTER_FAILED", "注册失败，请稍后再试");
  return created;
}

/** 用户不存在时的**哑验证**哈希：真实 argon2id 参数，代价与真校验相当（抹平时序差）。 */
let dummyHash: string | null = null;
async function dummyVerify(plain: string): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword("dummy-password-for-timing-equalisation");
  await verifyPassword(dummyHash, String(plain ?? "x"));
}

async function loadAttempt(username: string, ip: string): Promise<AttemptRec | undefined> {
  const row = await tbl("o_loginAttempt").where({ username, ip }).first();
  if (!row) return undefined;
  return {
    failedCount: Number(row.failedCount ?? 0),
    lockedUntil: row.lockedUntil === null || row.lockedUntil === undefined ? null : Number(row.lockedUntil),
    firstFailedAt: row.firstFailedAt === null || row.firstFailedAt === undefined ? null : Number(row.firstFailedAt),
    updatedAt: Number(row.updatedAt ?? 0),
  };
}

async function saveAttempt(username: string, ip: string, rec: AttemptRec): Promise<void> {
  const payload = { ...rec, username, ip };
  await runAsAuth(async () => {
    const existing = await tbl("o_loginAttempt").where({ username, ip }).first();
    if (existing) await tbl("o_loginAttempt").where({ username, ip }).update(payload);
    else {
      try {
        await tbl("o_loginAttempt").insert(payload);
      } catch {
        // 并发首次失败：另一条请求先插进去了 —— 改成更新（PK 是 (username, ip)，不可能重复插）
        await tbl("o_loginAttempt").where({ username, ip }).update(payload);
      }
    }
  });
}

async function clearAttempt(username: string, ip: string): Promise<void> {
  await runAsAuth(async () => {
    await tbl("o_loginAttempt").where({ username, ip }).delete();
  });
}

/** 失败文案统一（不泄露账号是否存在）；锁定后附上剩余秒数，便于前端提示（不含账号信息）。 */
function failureMessage(rec: AttemptRec): string {
  if (rec.lockedUntil) {
    return `账号或口令错误；已锁定至 ${new Date(rec.lockedUntil).toISOString()}`;
  }
  const left = Math.max(0, MAX_FAILED - rec.failedCount);
  return `账号或口令错误（还可尝试 ${left} 次）`;
}

export interface LoginInput {
  username: string;
  password: string;
  ip: string;
}

export interface LoginResult {
  user: AuthUser;
  access: string;
  refresh: string;
}

/** 登录：锁定判定 → 口令校验（哑验证抹时序）→ 清零失败计数 → 双令牌。 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const username = String(input?.username ?? "");
  const ip = String(input?.ip ?? "");
  const password = String(input?.password ?? "");
  const now = Date.now();

  // ① 锁定（先判，锁定期内**连口令都不查** —— 否则锁定就成了摆设）
  const attempt = await loadAttempt(username, ip);
  if (lockState(attempt, now) === "locked") {
    throw new AuthHttpError(401, "LOCKED", failureMessage(attempt as AttemptRec), {
      lockedUntil: (attempt as AttemptRec).lockedUntil,
    });
  }

  // ② 查用户 + 校验口令（用户不存在也做一次等价的 argon2 运算）
  const row = await findByUsername(username);
  let ok = false;
  if (row) ok = await verifyPassword(String(row.passwordHash ?? ""), password);
  else await dummyVerify(password); // 账号不存在也付同样的 CPU 代价（存在性枚举的时序差）
  if (!row || !ok) {
    const next = nextAttempt(attempt, now);
    await saveAttempt(username, ip, next);
    throw new AuthHttpError(401, "BAD_CREDENTIALS", failureMessage(next), next.lockedUntil ? { lockedUntil: next.lockedUntil } : null);
  }

  const user = toAuthUser(row);
  // ③ 状态（disabled 与口令错误**同码**：不泄露"账号存在但被停用"）
  if (user.status !== "active") {
    const next = nextAttempt(attempt, now);
    await saveAttempt(username, ip, next);
    throw new AuthHttpError(401, "BAD_CREDENTIALS", failureMessage(next));
  }

  // ④ 成功：清零失败计数、写 lastLoginAt、顺手把旧参数的口令哈希升级掉
  const upgradeHash = needsRehash(String(row.passwordHash ?? "")) ? await hashPassword(password) : null;
  await runAsAuth(async () => {
    await tbl("o_loginAttempt").where({ username, ip }).delete();
    const patch: Record<string, unknown> = { lastLoginAt: now };
    if (upgradeHash) patch.passwordHash = upgradeHash;
    await tbl("o_user").where("id", user.id).update(patch);
  });

  const secret = await resolveJwtSecret();
  return {
    user,
    access: signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, typ: "access" }, secret),
    refresh: signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, typ: "refresh" }, secret),
  };
}

/**
 * refresh 轮转：验 `typ="refresh"` → 用 DB 的 `status`/`tokenVersion` 复核 → 签一**对**新令牌。
 *
 * ⚠ 已知行为（**不是**安全保证，见 `tokens.ts` 文件头）：不做 refresh 重用检测，
 *   轮转出来的旧 refresh 在 7 天到期前**仍然可用**（要堵住需要 jti 黑名单表，Phase 2）。
 */
export async function rotateRefresh(refreshToken: string): Promise<LoginResult> {
  const secret = await resolveJwtSecret();
  let claims;
  try {
    claims = verifyToken(String(refreshToken ?? ""), "refresh", secret);
  } catch {
    throw new AuthHttpError(401, "INVALID_REFRESH", "登录状态无效，请重新登录");
  }
  const user = await loadUserCtx(claims.uid);
  if (!user || user.status !== "active") throw new AuthHttpError(401, "INVALID_REFRESH", "登录状态无效，请重新登录");
  if (user.tokenVersion !== claims.tv) throw new AuthHttpError(401, "TOKEN_REVOKED", "登录状态已失效，请重新登录");
  return {
    user,
    access: signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, typ: "access" }, secret),
    refresh: signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, typ: "refresh" }, secret),
  };
}

/** 登出：`tokenVersion++` ⇒ 该账号**所有**已签发的 access/refresh 立即失效（spec §7.2）。 */
export async function logout(userId: number): Promise<void> {
  const row = await tbl("o_user").where("id", userId).select("id", "tokenVersion").first();
  if (!row) throw new AuthHttpError(401, "NO_SUCH_USER", "账号不存在");
  await runAsAuth(async () => {
    await tbl("o_user").where("id", userId).update({ tokenVersion: Number(row.tokenVersion ?? 0) + 1 });
  });
}

/** 改密：校验旧口令 → 换哈希 → `tokenVersion++`（旧令牌全失效）→ 清 `mustChangePassword`。 */
export async function changePassword(userId: number, oldPwd: string, newPwd: string): Promise<void> {
  const row: UserRow | undefined = await tbl("o_user").where("id", userId).first();
  if (!row) throw new AuthHttpError(401, "NO_SUCH_USER", "账号不存在");
  if (!(await verifyPassword(String(row.passwordHash ?? ""), String(oldPwd ?? "")))) {
    throw new AuthHttpError(400, "OLD_PASSWORD_WRONG", "原口令不正确");
  }
  const username = String(row.username ?? "");
  assertPasswordStrength(username, newPwd);
  if (String(newPwd) === String(oldPwd)) throw new AuthHttpError(400, "SAME_PASSWORD", "新口令不得与原口令相同");
  const passwordHash = await hashPassword(String(newPwd));
  await runAsAuth(async () => {
    await tbl("o_user").where("id", userId).update({
      passwordHash,
      tokenVersion: Number(row.tokenVersion ?? 0) + 1,
      mustChangePassword: 0,
    });
  });
}
