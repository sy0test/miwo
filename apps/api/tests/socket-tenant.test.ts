/**
 * socket 租户上下文（spec §6.4 / §10.2 Tier 0 #9）—— Phase 1b Task 5 的判别力用例。
 *
 * 三层证据：
 *   A. **单元**：`decodeSocketToken` / `bindSocketTenant` / `resolveOwnedProject` / `resolveOwnedScript`
 *      / `buildIsolationKey`。
 *   B. **handler 层端到端**：跑**真实**的 `src/socket/routes/scriptAgent.ts` 与
 *      `productionAgent.ts` 的连接逻辑（真 route 函数 + 假 socket + 手工 emit 已注册的 handler）。
 *      ⚠ **不覆盖 engine.io 传输层**：仓库没有 `socket.io-client`，本任务不新增依赖
 *      （会动 `package.json`/lockfile）。所以"handler 层通过"**不等于**"端到端通过"。
 *   C. **合同另一半**：socket 侧推导出的 `isolationKey` 与 HTTP `getMemory`/`clearMemory`
 *      拼出的键**逐字符相同** —— 用"socket 侧写的行，HTTP 真路由读得到 / 清得掉"做**行为断言**
 *      （比字符串比对更强：下次谁只改一边，这条用例立刻红）。
 *
 * ⚠ 用的库是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（仓库外一次性目录），**不碰**
 *   `apps/api/data/db2.sqlite`。种下的行在 `afterAll` 逐条删除、`tokenKey` 原值还原。
 */
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";
import { systemDb } from "@/utils/db";
import u from "@/utils";
import { bindSocketTenant, buildIsolationKey, decodeSocketToken, resolveOwnedProject, resolveOwnedScript } from "@/socket/tenant";
import { tenantContextMiddleware, tenantErrorHandler } from "@/middleware/tenant";
import scriptAgentRoute from "@/socket/routes/scriptAgent";
import productionAgentRoute from "@/socket/routes/productionAgent";
import getMemoryRoute from "@/routes/agents/getMemory";
import clearMemoryRoute from "@/routes/agents/clearMemory";
import socketInit from "@/socket/index";

const TOKEN_KEY = "test-token-key-for-socket-tenant";

/** 固定的测试 fixture id（9 万段，避开真实数据；afterAll 逐条删）。 */
const OWN_PROJECT = 97001;      // userId = 7
const FOREIGN_PROJECT = 97002;  // userId = 8
const OWN_PROJECT2 = 97003;     // userId = 7（写测试专用，免得踩上面两条的断言）
const OWN_SCRIPT = 97101;       // userId = 7, projectId = OWN_PROJECT
const FOREIGN_SCRIPT = 97102;   // userId = 8, projectId = FOREIGN_PROJECT
const MEM_ID = "sock-mem-contract-1";

const ctx7: TenantCtx = { userId: 7, role: "user", requestId: "r", source: "socket" };
const ctx8: TenantCtx = { userId: 8, role: "user", requestId: "r", source: "socket" };
const token7 = () => `Bearer ${jwt.sign({ id: 7, name: "u7" }, TOKEN_KEY, { expiresIn: "1h" })}`;

/** 假 socket：记录 on() 注册的 handler，之后手工 emit（不需要真起 socket.io 服务）。 */
function fakeSocket(auth: Record<string, any> = {}, id = "s-1") {
  const handlers = new Map<string, (...args: any[]) => any>();
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket: any = {
    id,
    handshake: { auth },
    disconnected: false,
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); return socket; },
    emit(event: string, payload: any) { emitted.push({ event, payload }); return true; },
    disconnect() { socket.disconnected = true; },
  };
  return { socket, handlers, emitted, fire: (event: string, ...args: any[]) => handlers.get(event)?.(...args) };
}

/** 把真实 route 函数挂到假 Namespace 上，取回它注册的 connection handler。 */
function captureConnection(route: (nsp: any) => void): (socket: any) => Promise<any> {
  let connection: any = null;
  const nsp: any = { on(event: string, handler: any) { if (event === "connection") connection = handler; return nsp; } };
  route(nsp);
  if (!connection) throw new Error("route 没有注册 connection handler");
  return connection;
}

function postJson(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers: Record<string, any> = { "Content-Type": "application/json", "Content-Length": data.length };
    if (token) headers.Authorization = token;
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, timeout: 10000, headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: buf }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
    req.write(data);
    req.end();
  });
}

let originalTokenKey: string | undefined;

beforeAll(async () => {
  const row: any = await systemDb("o_setting").where("key", "tokenKey").select("value").first();
  originalTokenKey = row?.value;
  await systemDb("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }).onConflict("key").merge();
  await systemDb("o_project")
    .insert([
      { id: OWN_PROJECT, userId: 7, name: "socket-own", createTime: 1 },
      { id: FOREIGN_PROJECT, userId: 8, name: "socket-foreign", createTime: 1 },
      { id: OWN_PROJECT2, userId: 7, name: "socket-write", createTime: 1 },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_script")
    .insert([
      { id: OWN_SCRIPT, userId: 7, projectId: OWN_PROJECT, name: "s-own" },
      { id: FOREIGN_SCRIPT, userId: 8, projectId: FOREIGN_PROJECT, name: "s-foreign" },
    ])
    .onConflict("id")
    .merge();
});

afterAll(async () => {
  // 逐条清理（不用通配符；memories 的键可能因失败残留，按两个已知前缀删）
  await systemDb("o_project").whereIn("id", [OWN_PROJECT, FOREIGN_PROJECT, OWN_PROJECT2]).del();
  await systemDb("o_script").whereIn("id", [OWN_SCRIPT, FOREIGN_SCRIPT]).del();
  await systemDb("memories").where("id", MEM_ID).del();
  await systemDb("memories").where("isolationKey", "like", "7:97001:productionAgent%").del();
  await systemDb("memories").where("isolationKey", "like", "8:97002:productionAgent%").del();
  if (originalTokenKey === undefined) await systemDb("o_setting").where("key", "tokenKey").del();
  else await systemDb("o_setting").where("key", "tokenKey").update({ value: originalTokenKey });
});

describe("A. socket 租户上下文单元（spec §6.4 / Ruling 220）", () => {
  it("token 能解出 ctx（userId/role/source/requestId）；坏 token / 缺 id / 空值 → null", async () => {
    const ctx = await decodeSocketToken(token7());
    expect(ctx?.userId).toBe(7);
    expect(ctx?.role).toBe("user");
    expect(ctx?.source).toBe("socket");
    expect(typeof ctx?.requestId).toBe("string");
    expect((await decodeSocketToken(`Bearer ${jwt.sign({ id: 1 }, TOKEN_KEY)}`))?.role).toBe("admin");
    expect(await decodeSocketToken("Bearer garbage")).toBeNull();
    expect(await decodeSocketToken(`Bearer ${jwt.sign({ name: "x" }, TOKEN_KEY)}`)).toBeNull();
    expect(await decodeSocketToken(`Bearer ${jwt.sign({ id: -1 }, TOKEN_KEY)}`)).toBeNull();
    expect(await decodeSocketToken(undefined)).toBeNull();
  });

  it("★ bindSocketTenant：handler 被 emit 触发时**必须**看得到 ctx（含 await 之后）", async () => {
    const { socket, fire } = fakeSocket();
    bindSocketTenant(socket as any, ctx7);
    let seen: any = "NOT_CALLED";
    socket.on("chat", async () => {
      await new Promise((r) => setTimeout(r, 5));   // ALS 跟随 async 资源的**创建点**：run() 内创建的 await 仍带 ctx
      seen = currentTenant() ?? null;
    });
    await fire("chat");
    expect(seen).toMatchObject({ userId: 7, source: "socket" });
  });

  it("★ 反例对照：**不**包装的 handler 既看不到 ctx，读租户表也响亮拒绝（TENANT_NO_CONTEXT）", async () => {
    const { socket, fire } = fakeSocket({ token: token7() });
    let seen: any = "NOT_CALLED";
    let err: any = null;
    socket.on("probe", async () => {
      seen = currentTenant() ?? null;
      try {
        await u.db("o_project").select("id");
      } catch (e) {
        err = e;
      }
    });
    await fire("probe");
    expect(seen).toBeNull();
    expect(err?.code).toBe("TENANT_NO_CONTEXT");
    expect(err?.httpStatus).toBe(500);
  });

  it("归属校验：自己的 projectId/scriptId 通过；别人的、非法值 → null", async () => {
    await runWithTenant(ctx7, async () => {
      expect(await resolveOwnedProject(ctx7, OWN_PROJECT)).toBe(OWN_PROJECT);
      expect(await resolveOwnedProject(ctx7, FOREIGN_PROJECT)).toBeNull();
      expect(await resolveOwnedScript(ctx7, OWN_SCRIPT)).toBe(OWN_SCRIPT);
      expect(await resolveOwnedScript(ctx7, FOREIGN_SCRIPT)).toBeNull();
    });
    await runWithTenant(ctx7, async () => {
      expect(await resolveOwnedProject(ctx7, -1)).toBeNull();
      expect(await resolveOwnedProject(ctx7, "abc")).toBeNull();
      expect(await resolveOwnedProject(ctx7, undefined)).toBeNull();
    });
  });

  it("isolationKey 是服务端形态 `${userId}:${projectId}:${agentType}[:episodesId]`，且集号按**值**判定", () => {
    expect(buildIsolationKey(ctx7, OWN_PROJECT, "scriptAgent")).toBe("7:97001:scriptAgent");
    expect(buildIsolationKey(ctx7, OWN_PROJECT, "productionAgent", OWN_SCRIPT)).toBe("7:97001:productionAgent:97101");
    // ⚠ 前端没选集时会传 -1/0/undefined/NaN：**必须当作"没有集号"**（`??` 拦不住 -1）
    expect(buildIsolationKey(ctx7, OWN_PROJECT, "productionAgent", -1)).toBe("7:97001:productionAgent");
    expect(buildIsolationKey(ctx7, OWN_PROJECT, "productionAgent", 0)).toBe("7:97001:productionAgent");
    expect(buildIsolationKey(ctx7, OWN_PROJECT, "productionAgent", undefined)).toBe("7:97001:productionAgent");
    expect(buildIsolationKey(ctx8, FOREIGN_PROJECT, "productionAgent", FOREIGN_SCRIPT)).toBe("8:97002:productionAgent:97102");
  });
});

describe("B. 真实 socket route handler（handler 层端到端；**不含传输层**）", () => {
  it("scriptAgent：合法 token + 自己的 projectId → 建立连接，之后注册的 handler 带 ctx 且只读到本租户行", async () => {
    const connection = captureConnection(scriptAgentRoute as unknown as (nsp: any) => void);
    const { socket, fire } = fakeSocket({ token: token7(), projectId: OWN_PROJECT });
    await connection(socket);
    expect(socket.disconnected).toBe(false);

    let seen: any = "NOT_CALLED";
    let rows: any[] = [];
    socket.on("probe", async () => {
      seen = currentTenant() ?? null;
      rows = await u.db("o_project").select("id");
    });
    await fire("probe");
    expect(seen).toMatchObject({ userId: 7, source: "socket" });
    const ids = rows.map((r) => r.id);
    expect(ids, `只应看到本租户的行，实际 ${JSON.stringify(ids)}`).toContain(OWN_PROJECT);
    expect(ids).not.toContain(FOREIGN_PROJECT);
  });

  it("scriptAgent：用**别人**的 projectId → 连接被拒（且不绑定 ctx）", async () => {
    const connection = captureConnection(scriptAgentRoute as unknown as (nsp: any) => void);
    const { socket, fire } = fakeSocket({ token: token7(), projectId: FOREIGN_PROJECT });
    await connection(socket);
    expect(socket.disconnected).toBe(true);
    let seen: any = "NOT_CALLED";
    socket.on("probe", () => { seen = currentTenant() ?? null; });
    await fire("probe");
    expect(seen).toBeNull();   // 被拒的连接**没有**被 bindSocketTenant 包过
  });

  it("scriptAgent：没有 token → 连接被拒", async () => {
    const connection = captureConnection(scriptAgentRoute as unknown as (nsp: any) => void);
    const { socket } = fakeSocket({ projectId: OWN_PROJECT });
    await connection(socket);
    expect(socket.disconnected).toBe(true);
  });

  it("★ productionAgent：updateContext 用别人的 projectId/scriptId → 拒；用自己的 → 通过（服务端重建键）", async () => {
    const connection = captureConnection(productionAgentRoute as unknown as (nsp: any) => void);
    const { socket, fire } = fakeSocket({ token: token7(), projectId: OWN_PROJECT, scriptId: OWN_SCRIPT });
    await connection(socket);
    expect(socket.disconnected).toBe(false);

    let denied: any = null;
    await fire("updateContext", { projectId: FOREIGN_PROJECT, scriptId: FOREIGN_SCRIPT }, (r: any) => { denied = r; });
    expect(denied).toEqual({ success: false });

    let accepted: any = null;
    await fire("updateContext", { projectId: OWN_PROJECT, scriptId: OWN_SCRIPT }, (r: any) => { accepted = r; });
    expect(accepted).toEqual({ success: true });
  });

  it("库级注册烟测：socketInit 在真 Server 上给两个命名空间都挂了 connection 监听器", () => {
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    try {
      socketInit(io);
      // ⚠ 必须**先** socketInit 再 of()：否则 of() 会自己建一个空 namespace，断言就恒真了
      expect((io.of("/api/socket/scriptAgent") as any).listeners("connection").length).toBeGreaterThan(0);
      expect((io.of("/api/socket/productionAgent") as any).listeners("connection").length).toBeGreaterThan(0);
    } finally {
      io.close();
      httpServer.close();
    }
  });
});

describe("C. 合同另一半：socket 键 == HTTP 键（行为断言）", () => {
  it("socket 侧写的记忆，HTTP getMemory 读得到、clearMemory 清得掉；别的租户读不到", async () => {
    const key7 = buildIsolationKey(ctx7, OWN_PROJECT, "productionAgent", OWN_SCRIPT);
    await runWithTenant(ctx7, () =>
      u.db("memories").insert({
        id: MEM_ID,
        isolationKey: key7,
        type: "message",
        role: "assistant",
        name: "统筹",
        content: "socket-wrote-this-row",
        relatedMessageIds: null,
        summarized: 0,
        createTime: Date.now(),
      } as any),
    );

    // 真 HTTP：真中间件（验签→建 ctx）+ 真 getMemory/clearMemory 路由
    const app = express();
    app.use(express.json());
    app.use(tenantContextMiddleware);
    app.use("/api/agents/getMemory", getMemoryRoute);
    app.use("/api/agents/clearMemory", clearMemoryRoute);
    app.use(tenantErrorHandler);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).send({ legacy: String(err?.message) }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      const got = await postJson(port, "/api/agents/getMemory", { projectId: OWN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT }, token7());
      expect(got.status, `getMemory 应 200，实际 ${got.status} body=${got.body}`).toBe(200);
      expect(got.body, "HTTP 拼出的键必须与 socket 推导的键逐字符相同").toContain(MEM_ID);
      expect(got.body).toContain("socket-wrote-this-row");

      // 同一 token 用**别人**的 projectId 去读：键不同 + 守卫过滤 ⇒ 拿不到
      const cross = await postJson(port, "/api/agents/getMemory", { projectId: FOREIGN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT }, token7());
      expect(cross.status).toBe(200);
      expect(JSON.parse(cross.body).data).toEqual([]);

      const cleared = await postJson(port, "/api/agents/clearMemory", { projectId: OWN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT, type: "message" }, token7());
      expect(cleared.status).toBe(200);
      // 直读库（绕过守卫，避免"守卫过滤"造成假绿）：那一行真的没了
      expect(await systemDb("memories").where("isolationKey", key7).select("id")).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
