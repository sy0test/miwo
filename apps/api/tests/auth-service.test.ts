/**
 * 认证链路的**服务级 + HTTP 级**判别力用例（Phase 1c Task 3）。
 *
 * 为什么在同一个文件里既测 service 又真跑 HTTP：
 *   · service（`@/auth/service`）是业务规则的家（注册三模式、锁定、改密、轮转）；
 *   · 但"令牌到底能不能过中间件、`tokenVersion++` 之后旧 access 是不是**立刻** 401"
 *     只有把**真路由 + 真中间件**挂在 HTTP 上才成立（造假 req/res 会把被测机制假设掉）。
 *   所以这里挂的是 `src/routes/auth/**` 与 `src/routes/login/login.ts` 的**真模块**，
 *   中间件链与 `src/app.ts` 同形状（`authenticate` → 路由 → 错误处理器）。
 *   打**真应用进程**（`tsx src/app.ts`）的端到端证据在 `tests/auth-http-e2e.test.ts`。
 *
 * ⚠ 每个用例用**独立的客户端 IP**（`X-Forwarded-For` + `app.set("trust proxy", true)`）：
 *   `registerLimiter` 是"10 次/小时/IP"，一个文件里十几个注册请求会**自己把自己限流掉**
 *   （第一版就是这么红的：注册被 429、随后登录 401"账号或口令错误"，症状完全指向别处）。
 *   独立 IP 同时也让 `o_loginAttempt`（按 username+IP 计数）在用例之间互不干扰。
 *   限流器本身另有一条正向用例（见文件末尾）——不然它就成了"没人验过的装饰品"。
 *
 * ⚠ 用的库是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（`D:\tmp\miwo-test-data`，仓库外），
 *   **不碰** `apps/api/data/db2.sqlite`（Ruling 170：dev 库永远只读）。
 *   `systemDb` 只用于**夹具**（建邀请码 / 改注册开关 / 收尾清理）：它是唯一合法的绕过口，
 *   用来避免"用被测代码给自己造数据"的循环论证。
 */
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbReady, systemDb } from "@/utils/db";
import { authenticate, AUTH_WHITELIST, authErrorHandler } from "@/middleware/auth";
import { tenantErrorHandler } from "@/middleware/tenant";
import { currentTenant } from "@/db/tenant-context";
import { policyOf } from "@/db/policies";
import { AUTH_TABLES } from "@/db/noContext";
import { LOCK_MS, MAX_FAILED } from "@/auth/attempts";
import { loadUserCtx, logout } from "@/auth/service";
import registerRoute from "@/routes/auth/register";
import authLoginRoute from "@/routes/auth/login";
import refreshRoute from "@/routes/auth/refresh";
import logoutRoute from "@/routes/auth/logout";
import meRoute from "@/routes/auth/me";
import changePasswordRoute from "@/routes/auth/changePassword";
import legacyLoginRoute from "@/routes/login/login";

const TAG = `svc${crypto.randomBytes(4).toString("hex")}`;
const PW = "pw-initial-123456";
const NEW_PW = "pw-changed-1234567";
const createdUsers: string[] = [];
const createdInvites: string[] = [];
let originalMode: string | undefined;

/** 每个用例一个独立客户端 IP（见文件头）。 */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.9.${Math.floor(ipSeq / 200)}.${(ipSeq % 200) + 1}`;
}

/** 与 `src/app.ts` 同形状的中间件链（真路由 + 真中间件，只监听回环随机端口）。 */
async function serve() {
  const app = express();
  app.set("trust proxy", true); // 让 X-Forwarded-For 成为 req.ip（测试用它隔离限流/锁定计数）
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/auth/register", registerRoute);
  app.use("/api/auth/login", authLoginRoute);
  app.use("/api/auth/refresh", refreshRoute);
  app.use("/api/auth/logout", logoutRoute);
  app.use("/api/auth/me", meRoute);
  app.use("/api/auth/changePassword", changePasswordRoute);
  app.use("/api/login/login", legacyLoginRoute);
  // "受保护接口"替身：**只有**带 ctx 才答 200，并把 ctx.userId 回显出来
  //（防"路由根本没挂上/中间件被绕过"的假绿）
  app.get("/api/project/ping", (req, res) => {
    const ctx = currentTenant();
    if (!ctx) return res.status(500).send({ code: 500, data: null, message: "TENANT_NO_CONTEXT" });
    res.status(200).send({ code: 200, data: { userId: ctx.userId, role: ctx.role }, message: "pong" });
  });
  app.use(tenantErrorHandler);
  app.use(authErrorHandler);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).send({ message: err?.message }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Reply {
  status: number;
  body: any;
  raw: string;
  setCookie: string[];
  retryAfter: string | undefined;
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string; cookie?: string; ip?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        timeout: 20000,
        headers: {
          ...(opts.token ? { Authorization: opts.token } : {}),
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.ip ? { "X-Forwarded-For": opts.ip } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* 保留原文，断言失败时能看到 */
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
            raw,
            setCookie: res.headers["set-cookie"] ?? [],
            retryAfter: res.headers["retry-after"] as string | undefined,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 取 `Set-Cookie` 里 refresh Cookie 的 `name=value` 段。 */
function refreshCookieOf(reply: Reply): string {
  const found = reply.setCookie.find((c) => c.startsWith("miwo_rt="));
  expect(found, `响应里必须有 refresh Cookie：${JSON.stringify(reply.setCookie)}`).toBeTruthy();
  return String(found).split(";")[0];
}

/** HTTP 注册一个用户（**断言成功**：注册被限流/校验拦住时，后面的登录断言会指向完全错误的方向）。 */
async function registerViaHttp(port: number, username: string, ip: string, inviteCode?: string): Promise<void> {
  const res = await request(port, "POST", "/api/auth/register", { username, password: PW, ...(inviteCode ? { inviteCode } : {}) }, { ip });
  expect(res.status, `注册 ${username} 必须成功：${res.raw.slice(0, 200)}`).toBe(200);
  createdUsers.push(username);
}

/** HTTP 登录取 access（顺带断言 200）。 */
async function loginViaHttp(port: number, username: string, ip: string, password = PW): Promise<string> {
  const res = await request(port, "POST", "/api/auth/login", { username, password }, { ip });
  expect(res.status, `登录 ${username} 必须成功：${res.raw.slice(0, 200)}`).toBe(200);
  return String(res.body?.data?.token ?? "");
}

async function addInvite(code: string, maxUses = 1, expiresAt: number | null = null): Promise<void> {
  await systemDb("o_invite").insert({ code, createdBy: 1, maxUses, usedCount: 0, expiresAt, disabled: 0, createdAt: Date.now() });
  createdInvites.push(code);
}

async function setMode(mode: string): Promise<void> {
  await systemDb("o_setting").insert({ key: "registrationMode", value: mode }).onConflict("key").merge();
}

beforeAll(async () => {
  await dbReady;
  const row: any = await systemDb("o_setting").where("key", "registrationMode").first();
  originalMode = row?.value;
});

afterAll(async () => {
  if (originalMode === undefined) await systemDb("o_setting").where("key", "registrationMode").del();
  else await setMode(originalMode);
  if (createdInvites.length) await systemDb("o_invite").whereIn("code", createdInvites).del();
  if (createdUsers.length) await systemDb("o_user").whereIn("username", createdUsers).del();
  await systemDb("o_loginAttempt").whereLike("username", `${TAG}%`).del();
});

describe("认证路径的表策略（spec §6.2：登录发生在建 ctx 之前）", () => {
  it("AUTH_TABLES 全部是 platform 策略（少一个都说明有人改错了归属）", () => {
    for (const t of AUTH_TABLES) expect(policyOf(t), `${t} 必须是 platform`).toBe("platform");
  });

  it("白名单恰好是 4 个匿名路径（不靠前缀猜）", () => {
    expect([...AUTH_WHITELIST].sort()).toEqual([
      "/api/auth/login",
      "/api/auth/refresh",
      "/api/auth/register",
      "/api/login/login",
    ]);
  });
});

describe("注册（spec §15 O1：closed / invite / open 三模式）", () => {
  it("closed ⇒ 403，且**没有**建出用户", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("closed");
      const username = `${TAG}_closed`;
      const res = await request(srv.port, "POST", "/api/auth/register", { username, password: PW }, { ip });
      expect(res.status).toBe(403);
      expect(res.body?.message).toContain("注册已关闭");
      expect(await systemDb("o_user").where("username", username).first()).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("invite：无码 / 错码 / 过期码都 403；正确码 200 且 usedCount 消费 1 次", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("invite");
      const noCode = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_n1`, password: PW }, { ip });
      expect(noCode.status, JSON.stringify(noCode.body)).toBe(403);
      const badCode = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_n2`, password: PW, inviteCode: "nope" }, { ip });
      expect(badCode.status).toBe(403);

      const expiredCode = `${TAG}-expired`;
      await addInvite(expiredCode, 1, Date.now() - 60_000);
      const expired = await request(
        srv.port,
        "POST",
        "/api/auth/register",
        { username: `${TAG}_n3`, password: PW, inviteCode: expiredCode },
        { ip },
      );
      expect(expired.status).toBe(403);
      expect(expired.body?.message).toContain("过期");

      const good = `${TAG}-good`;
      await addInvite(good, 1);
      const username = `${TAG}_ok`;
      await registerViaHttp(srv.port, username, ip, good);
      const invite = await systemDb("o_invite").where("code", good).first();
      expect(Number(invite.usedCount)).toBe(1);

      // 用完 1 次（maxUses=1）⇒ 第二个用户必须被拒
      const second = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_ok2`, password: PW, inviteCode: good }, { ip });
      expect(second.status).toBe(403);
      expect(second.body?.message).toContain("用尽");
      expect(await systemDb("o_user").where("username", `${TAG}_ok2`).first()).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("重复用户名 ⇒ 409；弱口令 / 口令==用户名 ⇒ 400（服务级兜底，不依赖 zod）", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_dup`;
      await registerViaHttp(srv.port, username, ip);
      const dup = await request(srv.port, "POST", "/api/auth/register", { username, password: PW }, { ip });
      expect(dup.status).toBe(409);
      const weak = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_weak`, password: "short" }, { ip });
      expect(weak.status).toBe(400);
      const same = await request(
        srv.port,
        "POST",
        "/api/auth/register",
        { username: "aaaa-lowercase-name", password: "AAAA-LOWERCASE-NAME" },
        { ip },
      );
      expect(same.status).toBe(400);
      expect(await systemDb("o_user").where("username", "aaaa-lowercase-name").first()).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});

describe("登录 / 令牌 / 吊销（spec §7.2）", () => {
  it("★ 登录成功 → access 能访问受保护接口；logout（tokenVersion++）后**同一个** access 立刻 401", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_basic`;
      await registerViaHttp(srv.port, username, ip);

      const wrong = await request(srv.port, "POST", "/api/auth/login", { username, password: "definitely-wrong" }, { ip });
      expect(wrong.status, "错口令必须 401（红端）").toBe(401);
      expect(wrong.raw).not.toContain(username); // 不泄露账号存在性

      const ok = await request(srv.port, "POST", "/api/auth/login", { username, password: PW }, { ip });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const access = String(ok.body?.data?.token ?? "");
      expect(access.startsWith("Bearer ")).toBe(true);
      expect(ok.body?.data?.role).toBe("user");
      expect(ok.body?.data?.mustChangePassword).toBe(false);
      // refresh 只走 HttpOnly Cookie，**绝不**出现在响应体里
      const cookie = refreshCookieOf(ok);
      expect(ok.setCookie.join(";")).toContain("HttpOnly");
      expect(ok.setCookie.join(";")).toContain("Path=/api/auth");
      expect(ok.raw).not.toContain(cookie.split("=")[1]);

      const ping = await request(srv.port, "GET", "/api/project/ping", undefined, { token: access, ip });
      expect(ping.status, JSON.stringify(ping.body)).toBe(200);
      expect(ping.body?.data?.userId).toBeGreaterThan(0);
      expect(ping.body?.data?.role).toBe("user");

      const me = await request(srv.port, "GET", "/api/auth/me", undefined, { token: access, ip });
      expect(me.status).toBe(200);
      expect(me.body?.data?.name).toBe(username);

      // 无 token / 坏 token → 401（不是 200/500）
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { ip })).status).toBe(401);
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { token: "Bearer garbage", ip })).status).toBe(401);

      // 登出：tokenVersion++ ⇒ 旧 access 立刻失效（**不需要**等 15 分钟）
      const out = await request(srv.port, "POST", "/api/auth/logout", {}, { token: access, ip });
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const denied = await request(srv.port, "GET", "/api/project/ping", undefined, { token: access, ip });
      expect(denied.status, "吊销后同一个 access 必须 401").toBe(401);
      expect(denied.body?.message).toContain("失效");
      // 正对照：登出后重新登录拿到的**新** access 必须能用（证明 401 是"这一个 token 被吊销"）
      const access2 = await loginViaHttp(srv.port, username, ip);
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { token: access2, ip })).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("旧登录路径 /api/login/login 仍能用（Phase 1c §5 的验收入口），返回 Bearer token", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_legacy`;
      await registerViaHttp(srv.port, username, ip);
      const res = await request(srv.port, "POST", "/api/login/login", { username, password: PW }, { ip });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(String(res.body?.data?.token).startsWith("Bearer ")).toBe(true);
      expect(res.body?.data?.name).toBe(username);
      expect(res.body?.data?.id).toBeGreaterThan(0);
      const bad = await request(srv.port, "POST", "/api/login/login", { username, password: "nope" }, { ip });
      expect(bad.status).toBe(401);
      const token = String(res.body?.data?.token);
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { token, ip })).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("★ 连错 5 次 ⇒ 第 6 次**即使口令正确**也被锁定，且 lockedUntil 在未来", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_lock`;
      await registerViaHttp(srv.port, username, ip);

      const before = Date.now();
      for (let i = 1; i <= MAX_FAILED; i += 1) {
        const r = await request(srv.port, "POST", "/api/auth/login", { username, password: `wrong-${i}` }, { ip });
        expect(r.status, `第 ${i} 次错口令应 401`).toBe(401);
      }
      const rec = await systemDb("o_loginAttempt").whereLike("username", username).first();
      expect(Number(rec.failedCount)).toBe(MAX_FAILED);
      expect(Number(rec.lockedUntil)).toBeGreaterThan(before);
      expect(Number(rec.lockedUntil)).toBeLessThanOrEqual(before + LOCK_MS + 5000);

      const lockedRightPwd = await request(srv.port, "POST", "/api/auth/login", { username, password: PW }, { ip });
      expect(lockedRightPwd.status, "锁定期内**正确口令**也必须被拒").toBe(401);
      expect(lockedRightPwd.body?.message).toContain("锁定");
      expect(Number(lockedRightPwd.body?.data?.lockedUntil)).toBeGreaterThan(Date.now());

      // 判别力对照 ①：**另一个**用户名的正确口令仍能登录（锁定是按 username+ip 的，不是全局关门）
      const other = `${TAG}_notlocked`;
      await registerViaHttp(srv.port, other, ip);
      expect((await request(srv.port, "POST", "/api/auth/login", { username: other, password: PW }, { ip })).status).toBe(200);
      // 判别力对照 ②：换一个 IP 打同一个用户名 —— **口令仍然正确**，所以必须放行（证明锁定键含 IP）
      expect(
        (await request(srv.port, "POST", "/api/auth/login", { username, password: PW }, { ip: nextIp() })).status,
      ).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("用户不存在时也走哑验证：响应与「口令错」同类（不泄露账号是否存在）", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_dummy`;
      await registerViaHttp(srv.port, username, ip);
      const wrongPwd = await request(srv.port, "POST", "/api/auth/login", { username, password: "wrong-password" }, { ip });
      const noSuchUser = await request(srv.port, "POST", "/api/auth/login", { username: `${TAG}_ghost`, password: "wrong-password" }, { ip });
      expect(noSuchUser.status).toBe(wrongPwd.status);
      // message 只有"剩余次数"的差别（各自计数），文案前缀必须一致
      expect(String(noSuchUser.body?.message).split("（")[0]).toBe(String(wrongPwd.body?.message).split("（")[0]);
    } finally {
      await srv.close();
    }
  });
});

describe("改密 / refresh 轮转", () => {
  it("★ 改密：旧口令错 ⇒ 400；成功 ⇒ 旧 access 立刻 401 + 新口令能登录 + 旧口令不能", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_chpw`;
      await registerViaHttp(srv.port, username, ip);
      const access = await loginViaHttp(srv.port, username, ip);

      const wrongOld = await request(srv.port, "POST", "/api/auth/changePassword", { oldPassword: "nope", newPassword: NEW_PW }, { token: access, ip });
      expect(wrongOld.status).toBe(400);
      const tooShort = await request(srv.port, "POST", "/api/auth/changePassword", { oldPassword: PW, newPassword: "short" }, { token: access, ip });
      expect(tooShort.status).toBe(400);

      const okChange = await request(srv.port, "POST", "/api/auth/changePassword", { oldPassword: PW, newPassword: NEW_PW }, { token: access, ip });
      expect(okChange.status, JSON.stringify(okChange.body)).toBe(200);
      expect(okChange.setCookie.join(";")).toContain("miwo_rt=;");
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { token: access, ip })).status).toBe(401);
      expect((await request(srv.port, "POST", "/api/auth/login", { username, password: PW }, { ip })).status).toBe(401);
      expect((await request(srv.port, "POST", "/api/auth/login", { username, password: NEW_PW }, { ip })).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("refresh 轮转：Cookie 续期得到新 access；**已知行为**——旧 refresh 在到期前仍可用（无重用检测）", async () => {
    const ip = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      const username = `${TAG}_refresh`;
      await registerViaHttp(srv.port, username, ip);
      const login1 = await request(srv.port, "POST", "/api/auth/login", { username, password: PW }, { ip });
      const cookie1 = refreshCookieOf(login1);

      const first = await request(srv.port, "POST", "/api/auth/refresh", {}, { cookie: cookie1, ip });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const access2 = String(first.body?.data?.token);
      expect((await request(srv.port, "GET", "/api/project/ping", undefined, { token: access2, ip })).status).toBe(200);
      const cookie2 = refreshCookieOf(first);
      expect(cookie2).not.toBe(cookie1);
      expect((await request(srv.port, "POST", "/api/auth/refresh", {}, { cookie: cookie2, ip })).status).toBe(200);

      // ⚠ 这是**已登记的限制**（不是安全保证）：不做 refresh 重用检测
      const second = await request(srv.port, "POST", "/api/auth/refresh", {}, { cookie: cookie1, ip });
      expect(second.status, "已知行为：旧 refresh 轮转后仍可用（Phase 2 若加重用检测，这条要改成 401）").toBe(200);

      // 没有 Cookie ⇒ 401；伪造的 Cookie ⇒ 401
      expect((await request(srv.port, "POST", "/api/auth/refresh", {}, { ip })).status).toBe(401);
      expect((await request(srv.port, "POST", "/api/auth/refresh", {}, { cookie: "miwo_rt=not.a.token", ip })).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("service 层：loadUserCtx 只回安全字段、logout 让 tv 前进、被停用的账号登不上", async () => {
    const ip = nextIp();
    const srv = await serve();
    const username = `${TAG}_svc`;
    try {
      await setMode("open");
      await registerViaHttp(srv.port, username, ip);
    } finally {
      await srv.close();
    }
    const row: any = await systemDb("o_user").where("username", username).first();
    const user = await loadUserCtx(Number(row.id));
    expect(user).toMatchObject({ id: Number(row.id), username, role: "user", status: "active", tokenVersion: 0 });
    expect(JSON.stringify(user)).not.toContain("passwordHash");
    expect(await loadUserCtx(0)).toBeNull();
    expect(await loadUserCtx(999_999_999)).toBeNull();

    await logout(user!.id);
    expect((await loadUserCtx(user!.id))!.tokenVersion).toBe(1);

    // 停用后：口令正确也必须 401（与"口令错"同码，不泄露状态）
    await systemDb("o_user").where("id", user!.id).update({ status: "disabled" });
    const srv2 = await serve();
    try {
      const res = await request(srv2.port, "POST", "/api/auth/login", { username, password: PW }, { ip });
      expect(res.status).toBe(401);
      // 判别力：停用不影响"不存在的用户"的同类响应（两者同码同文案前缀）
      const ghost = await request(srv2.port, "POST", "/api/auth/login", { username: `${TAG}_ghost2`, password: PW }, { ip });
      expect(ghost.status).toBe(res.status);
    } finally {
      await srv2.close();
    }
  });
});

describe("限流器（spec §7.2：按 IP 限流；这条用例防它变成装饰品）", () => {
  it("同一 IP 注册超过阈值 ⇒ 429（且带 Retry-After），换 IP 立刻放行", async () => {
    const ip = nextIp();
    const otherIp = nextIp();
    const srv = await serve();
    try {
      await setMode("open");
      let saw429 = 0;
      for (let i = 0; i < 12; i += 1) {
        const res = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_rl${i}`, password: PW }, { ip });
        if (res.status === 429) {
          saw429 += 1;
          expect(res.retryAfter, "429 必须带 Retry-After，前端/运维才有依据退避").toBeTruthy();
        } else if (res.status === 200) {
          createdUsers.push(`${TAG}_rl${i}`);
        }
      }
      expect(saw429, "同一 IP 连打 12 次注册必须出现 429").toBeGreaterThan(0);
      const fresh = await request(srv.port, "POST", "/api/auth/register", { username: `${TAG}_rlfresh`, password: PW }, { ip: otherIp });
      expect(fresh.status, "换 IP 必须立刻放行（限流是按 IP 计数）").toBe(200);
      createdUsers.push(`${TAG}_rlfresh`);
    } finally {
      await srv.close();
    }
  });
});
