/**
 * HTTP 租户上下文（spec §6.4）+ 隔离错误的 403/500 映射 —— Task 4 的判别力用例。
 *
 * 为什么用"假 req/res"单测中间件、用"真 HTTP"单测错误中间件：
 *   · 中间件的行为是**同步决策 + 一次 next()**（401/444/白名单/建 ctx），假件能逐分支钉住；
 *   · 错误映射的行为依赖 **Express 5 会不会把 async handler 的 reject 交给错误中间件**，
 *     这一环只有真起 HTTP 才能验（造假件等于把被测机制假设掉了）。
 *
 * ⚠ 用的库是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（仓库外一次性目录），**不碰**
 *   `apps/api/data/db2.sqlite`。tokenKey 那一行在 `beforeAll` 里种、在 `afterAll` 里**还原**
 *   （共享的测试库不能被我这个文件改脏）。
 *
 * ⚠ 密钥语义是 **Phase 1a Task 5 的现状**，不是 brief 初稿的"只认库值"：
 *   库里优先（`o_setting.tokenKey`），**库里没有时回退 `config.jwtSecret`**。
 *   这条兜底是 `verify-phase0.cjs`（全新空库 + `MIWO_JWT_SECRET` 已设必须能起）与
 *   `tests/auth-token-key.test.ts`（R1）的现成判据，删掉它们必红。
 *   库值缺失时那个 `444` 分支在 `config.ts` 的模块级 fail-fast（`MIWO_JWT_SECRET` 必需、≥32 字节）
 *   下**不可达**，但保留它 + 文案（"密钥缺失时该怎么办"的意图）。
 */
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { currentTenant, runWithTenant } from "@/db/tenant-context";
import { systemDb } from "@/utils/db";
import { tenantContextMiddleware, requireAdmin, tenantErrorHandler } from "@/middleware/tenant";
import { TenantIsolationError } from "@/db/tenant-guard";

const TOKEN_KEY = "test-token-key-for-tenant-middleware";

/** 极简 req/res 假件：既能单测中间件，也不需要真起 HTTP（真起 HTTP 在 Task 9 的 verify-phase1b 里）。 */
function fakeReq(over: Record<string, any> = {}) {
  return { path: "/api/project/getProject", headers: {}, query: {}, ...over } as any;
}
function fakeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (payload: any) => { res.body = payload; return res; };
  res.json = res.send;
  return res;
}

/** 库里原本有没有 tokenKey（`undefined` = 原本就没有）。用例结束必须还原成这个样子。 */
let originalTokenKey: string | undefined;

beforeAll(async () => {
  const row: any = await systemDb("o_setting").where("key", "tokenKey").select("value").first();
  originalTokenKey = row?.value;
  await systemDb("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }).onConflict("key").merge();
});

afterAll(async () => {
  if (originalTokenKey === undefined) await systemDb("o_setting").where("key", "tokenKey").del();
  else await systemDb("o_setting").where("key", "tokenKey").update({ value: originalTokenKey });
});

describe("HTTP 租户上下文中间件（spec §6.4）", () => {
  it("合法 token → ctx 在下游可见（含 await 之后），且带 userId / role / requestId / source", async () => {
    const token = jwt.sign({ id: 7, name: "u7" }, TOKEN_KEY, { expiresIn: "1h" });
    const req = fakeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = fakeRes();
    let seen: any = null;
    // ⚠ next 刻意是 async 且**在 await 之后**才读 ctx：这是"ALS 能穿 await"的判别力
    //   （Ruling 190 #7 / tenant-context.ts:6-10 的第 1 条纪律）。
    await tenantContextMiddleware(req, res, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen = currentTenant();
    });
    expect(seen?.userId).toBe(7);
    expect(seen?.role).toBe("user");
    expect(seen?.source).toBe("http");
    expect(typeof seen?.requestId).toBe("string");
    expect((req as any).user).toMatchObject({ id: 7 });   // spec §6.4：保留 req.user（**当前全仓 0 个消费者**；消费方归 Phase 1c）
  });

  it("admin 桥接：id=1 → role=admin（走 roleOfUserId，不是硬编码）", async () => {
    const token = jwt.sign({ id: 1, name: "admin" }, TOKEN_KEY, { expiresIn: "1h" });
    let seen: any = null;
    await tenantContextMiddleware(fakeReq({ headers: { authorization: `Bearer ${token}` } }), fakeRes(), () => { seen = currentTenant(); });
    expect(seen?.role).toBe("admin");
  });

  it("无 token / 坏 token / token 里没有 id → 401，且**不建立 ctx**", async () => {
    for (const headers of [{}, { authorization: "Bearer garbage" }, { authorization: `Bearer ${jwt.sign({ name: "no-id" }, TOKEN_KEY)}` }]) {
      let entered = false;
      const res = fakeRes();
      await tenantContextMiddleware(fakeReq({ headers }), res, () => { entered = true; });
      expect(entered).toBe(false);
      expect(res.statusCode).toBe(401);
    }
  });

  it("白名单（登录 / configHealth?summary=1）放行且**不建立 ctx**；库里没有 tokenKey → 回退 config.jwtSecret（Phase 1a Task 5 的现状语义）", async () => {
    let loginCtx: any = "NOT_CALLED";
    await tenantContextMiddleware(fakeReq({ path: "/api/login/login" }), fakeRes(), () => { loginCtx = currentTenant() ?? null; });
    expect(loginCtx).toBeNull();
    let healthCtx: any = "NOT_CALLED";
    await tenantContextMiddleware(fakeReq({ path: "/api/other/configHealth", query: { summary: "1" } }), fakeRes(), () => { healthCtx = currentTenant() ?? null; });
    expect(healthCtx).toBeNull();

    // 库里那行删掉 → 必须回退到 config.jwtSecret（不是 444）：这正是"全新空库也能起、也能读
    // configHealth"的那条路（verify-phase0 / auth-token-key R1 依赖它）。
    await systemDb("o_setting").where("key", "tokenKey").del();
    let fallbackCtx: any = null;
    await tenantContextMiddleware(
      fakeReq({ headers: { authorization: `Bearer ${jwt.sign({ id: 7, name: "u7" }, config.jwtSecret, { expiresIn: "1h" })}` } }),
      fakeRes(),
      () => { fallbackCtx = currentTenant(); },
    );
    expect(fallbackCtx?.userId).toBe(7);
    // 判别力：库里那行被删掉后，**原库值**签的 token 必须被拒 —— 证明"库值真的被读走了"，
    // 而不是"任意 token 都能过"。
    const res = fakeRes();
    await tenantContextMiddleware(
      fakeReq({ headers: { authorization: `Bearer ${jwt.sign({ id: 7, name: "u7" }, TOKEN_KEY, { expiresIn: "1h" })}` } }),
      res,
      () => {},
    );
    expect(res.statusCode).toBe(401);

    await systemDb("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }); // 还原，别污染其他用例
  });

  it("requireAdmin：非 admin → 403；admin → next()", async () => {
    const asUser = fakeRes();
    runWithTenant({ userId: 7, role: "user", requestId: "r", source: "http" }, () => requireAdmin(fakeReq(), asUser, () => { throw new Error("不该走到这里"); }));
    expect(asUser.statusCode).toBe(403);
    const asAdmin = fakeRes();
    let passed = false;
    runWithTenant({ userId: 1, role: "admin", requestId: "r", source: "http" }, () => requireAdmin(fakeReq(), asAdmin, () => { passed = true; }));
    expect(passed).toBe(true);
  });
});

describe("隔离错误的 HTTP 映射（Express 5 会把 async handler 的 reject 交给错误中间件）", () => {
  it("TenantIsolationError → 403 且响应体只有 {code,message}，**不含堆栈**", async () => {
    const app = express();
    app.get("/boom", async () => { throw new TenantIsolationError("跨租户访问被阻断"); });
    app.use(tenantErrorHandler);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).send({ legacy: String(err?.message) }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    const body: any = await res.json();
    expect(res.status).toBe(403);
    expect(body).toEqual({ code: 403, message: "跨租户访问被阻断" });
    expect(JSON.stringify(body)).not.toMatch(/at |\.ts:/);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("其它错误必须原样交给后面的错误中间件（不许吞掉）", async () => {
    const app = express();
    app.get("/other", async () => { throw new Error("普通错误"); });
    app.use(tenantErrorHandler);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).send({ legacy: String(err?.message) }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ legacy: "普通错误" });
    await new Promise<void>((r) => server.close(() => r()));
  });
});
