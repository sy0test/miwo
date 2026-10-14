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
import { AUDIT_ACTIONS, audit, auditPlatformWrite } from "@/utils/audit";
import { registrationMode as readRegistrationMode, type RegistrationMode } from "@/utils/opsSwitch";

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

/**
 * 注册方式（spec §15 O1）：`invite`（默认）/ `open` / `closed`。
 *
 * ⚠ **单一实现**在 `src/utils/opsSwitch.ts`（Phase 1c Task 4 把两个"默认关闭/最严解析"的
 *   平台开关收在一处）；这里只做转出，避免第二份口径。
 */
export async function registrationMode(): Promise<RegistrationMode> {
  return await readRegistrationMode();
}

/** 口令强度下限：≥8 字符、且不得与用户名相同（spec §7.2 的最小要求，写进用例）。 */
function assertPasswordStrength(username: string, password: string): void {
  if (String(password).length < 8) throw new AuthHttpError(400, "WEAK_PASSWORD", "口令至少 8 位");
  if (String(password).toLowerCase() === String(username).toLowerCase()) {
    throw new AuthHttpError(400, "WEAK_PASSWORD", "口令不得与用户名相同");
  }
}

/**
 * 邀请码相关的对外文案 —— **统一一条**（Phase 1c Task 4 的 L2 修复）。
 *
 * 旧实现把内部差异（`INVITE_INVALID` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED`）直接写进 message，
 * 于是**任何人都能枚举出"哪些码存在"**：无效码说"邀请码无效"，过期/用尽码说别的措辞 ⇒
 * 拿字典扫一遍就能把"存在的码"筛出来。现在：**内部 code 保留差异**（日志/审计/排障要用），
 * **对外文案只有这一条**。
 */
export const INVITE_FAILURE_MESSAGE = "邀请码不可用";

/**
 * 消费一次邀请码（`disabled=0` / 未过期 / `usedCount < maxUses`）。返回被消费的邀请码行 id。
 *
 * ⚠ 并发超发防护：**带条件的 CAS 更新**（`where usedCount = 我刚读到的值`），
 *   影响 0 行 = 有人抢先了 ⇒ 拒绝。不用 `raw("usedCount + 1")`：
 *   一是跨方言的写法差异，二是 `raw` 会新增一条需要人工标注的隔离特例（`check-tenant-exceptions`）。
 * ⚠ 三种拒绝的 `code` 不同、`message` **相同**（见 `INVITE_FAILURE_MESSAGE`）。
 */
async function consumeInvite(trx: any, code: string): Promise<number> {
  const invite = await trx("o_invite").where("code", code).first();
  if (!invite) throw new AuthHttpError(403, "INVITE_INVALID", INVITE_FAILURE_MESSAGE);
  if (Number(invite.disabled) === 1) throw new AuthHttpError(403, "INVITE_INVALID", INVITE_FAILURE_MESSAGE);
  const exp = invite.expiresAt === null || invite.expiresAt === undefined ? null : Number(invite.expiresAt);
  if (exp !== null && exp <= Date.now()) throw new AuthHttpError(403, "INVITE_EXPIRED", INVITE_FAILURE_MESSAGE);
  const used = Number(invite.usedCount ?? 0);
  if (used >= Number(invite.maxUses ?? 1)) throw new AuthHttpError(403, "INVITE_EXHAUSTED", INVITE_FAILURE_MESSAGE);
  const updated = await trx("o_invite")
    .where({ id: invite.id, usedCount: used })
    .update({ usedCount: used + 1 });
  if (!updated) throw new AuthHttpError(409, "INVITE_RACE", "邀请码正被使用，请重试");
  return Number(invite.id);
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

  let consumedInviteId: number | null = null;
  const id: number = await runAsAuth(async () => {
    return await (u.db as any).transaction(async (trx: any) => {
      if (mode !== "open") consumedInviteId = await consumeInvite(trx, inviteCode);
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
  // 审计（spec Tier 1 #17）：注册建号 + 邀请码消费各一条。**邀请码只记 id，不记码本身**
  //（码 == 开通权限，落进审计表等于把权限抄一份到另一张表）。
  await auditPlatformWrite("register.createUser", `o_user:${created.id}`, { username: created.username }, { userId: created.id, role: created.role, ip: input.ip });
  if (consumedInviteId !== null) {
    await audit(
      { userId: created.id, role: created.role, ip: input.ip },
      AUDIT_ACTIONS.INVITE_CONSUMED,
      `o_invite:${consumedInviteId}`,
      { username: created.username, mode },
    );
  }
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
  // 审计：登录**失败计数**的每一次变更（含触发锁定的那一次）。
  await auditPlatformWrite(
    "loginAttempt.save",
    `o_loginAttempt:${username}@${ip}`,
    { failedCount: rec.failedCount, locked: Boolean(rec.lockedUntil) },
    { userId: null, role: null, ip },
  );
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
    // 审计：**锁定期内还来尝试**（"锁定生效"与"有人仍在打"是两件事，都要有痕迹）。
    await audit({ userId: null, role: null, ip }, AUDIT_ACTIONS.LOGIN_LOCKED, username, {
      lockedUntil: (attempt as AttemptRec).lockedUntil,
      failedCount: (attempt as AttemptRec).failedCount,
    });
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
    // 审计：失败（含"刚刚触发锁定"那次）。
    await audit(
      { userId: row ? Number(row.id) : null, role: row ? (row.role === "admin" ? "admin" : "user") : null, ip },
      next.lockedUntil ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAIL,
      username,
      { failedCount: next.failedCount, locked: Boolean(next.lockedUntil), reason: row ? "bad-credentials" : "no-such-user" },
    );
    throw new AuthHttpError(401, "BAD_CREDENTIALS", failureMessage(next), next.lockedUntil ? { lockedUntil: next.lockedUntil } : null);
  }

  const user = toAuthUser(row);
  // ③ 状态（disabled 与口令错误**同码**：不泄露"账号存在但被停用"）
  if (user.status !== "active") {
    const next = nextAttempt(attempt, now);
    await saveAttempt(username, ip, next);
    await audit({ userId: user.id, role: user.role, ip }, AUDIT_ACTIONS.LOGIN_FAIL, username, {
      failedCount: next.failedCount,
      locked: Boolean(next.lockedUntil),
      reason: "disabled",
    });
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
  // 审计：成功登录 + 这次 system 身份代行的写（lastLoginAt / 口令哈希升级 / 清失败计数）。
  await audit({ userId: user.id, role: user.role, ip }, AUDIT_ACTIONS.LOGIN_SUCCESS, user.username, {
    rehashed: Boolean(upgradeHash),
  });
  await auditPlatformWrite(
    "login.clearAttemptAndTouchLastLogin",
    `o_user:${user.id}`,
    { rehashed: Boolean(upgradeHash), username: user.username },
    { userId: user.id, role: user.role, ip },
  );

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
  const row: UserRow | undefined = await tbl("o_user").where("id", userId).first();
  if (!row) throw new AuthHttpError(401, "NO_SUCH_USER", "账号不存在");
  await runAsAuth(async () => {
    await tbl("o_user").where("id", userId).update({ tokenVersion: Number(row.tokenVersion ?? 0) + 1 });
  });
  // 审计：**令牌吊销**（登出 = 该账号全部令牌立即失效，spec §7.2）。
  await audit(
    { userId, role: row.role === "admin" ? "admin" : "user" },
    AUDIT_ACTIONS.LOGOUT,
    String(row.username ?? userId),
    { tokenVersion: Number(row.tokenVersion ?? 0) + 1 },
  );
  await auditPlatformWrite("logout.tokenVersion++", `o_user:${userId}`, { username: row.username ?? null }, { userId, role: row.role === "admin" ? "admin" : "user" });
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
  // 审计：改密 = 口令变更 + **令牌吊销**（两件事都记，排障时"为什么他突然要重新登录"有答案）。
  const role = row.role === "admin" ? "admin" : "user";
  await audit({ userId, role }, AUDIT_ACTIONS.PASSWORD_CHANGE, username, {
    tokenVersion: Number(row.tokenVersion ?? 0) + 1,
    clearedMustChangePassword: true,
  });
  await auditPlatformWrite("changePassword.tokenVersion++", `o_user:${userId}`, { username }, { userId, role });
}
