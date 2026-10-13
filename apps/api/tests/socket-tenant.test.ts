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
 *   C. **合同另一半**：socket 侧推导出的 `isolationKey` 与 HTTP `getMemory`/`clearMemory`/`delProject`
 *      拼出的键**逐字符相同** —— 用"socket 侧写的行，HTTP 真路由读得到 / 清得掉 / 删项目删得掉"
 *      做**行为断言**（比字符串比对更强：下次谁只改一边，这条用例立刻红）。
 *   D. **回调面门禁**：`src/socket/**` + `src/agents/**` 不得出现 `.once(` / `onAny(`
 *      （它们注册的回调**不会**被 `bindSocketTenant` 包住 ⇒ 静默逃逸）。
 *
 * ⚠ 用的库是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（仓库外一次性目录），**不碰**
 *   `apps/api/data/db2.sqlite`。种下的行在 `afterAll` 逐条删除、`tokenKey` 原值还原。
 */
import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "@/config";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";
import { systemDb } from "@/utils/db";
import u from "@/utils";
import { bindSocketTenant, buildIsolationKey, decodeSocketToken, resolveOwnedProject, resolveOwnedScript } from "@/socket/tenant";
import { tenantContextMiddleware, tenantErrorHandler } from "@/middleware/tenant";
import scriptAgentRoute from "@/socket/routes/scriptAgent";
import productionAgentRoute from "@/socket/routes/productionAgent";
import getMemoryRoute from "@/routes/agents/getMemory";
import clearMemoryRoute from "@/routes/agents/clearMemory";
import delProjectRoute from "@/routes/project/delProject";
import socketInit from "@/socket/index";

const API_ROOT = path.resolve(__dirname, "..");
const TOKEN_KEY = "test-token-key-for-socket-tenant";

/** 固定的测试 fixture id（9 万段，避开真实数据；afterAll 逐条删）。 */
const OWN_PROJECT = 97001;      // userId = 7
const FOREIGN_PROJECT = 97002;  // userId = 8
const OWN_PROJECT2 = 97003;     // userId = 7（写测试专用，免得踩上面两条的断言）
const DEL_PROJECT = 97005;      // userId = 7（delProject 用例专用，会被路由真的删掉）
const OWN_SCRIPT = 97101;       // userId = 7, projectId = OWN_PROJECT
const FOREIGN_SCRIPT = 97102;   // userId = 8, projectId = FOREIGN_PROJECT
const MEM_ID = "sock-mem-contract-1";
const MEM_SCRIPT_ID = "sock-mem-script-key-1";

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

/** 真 HTTP：真中间件（验签→建 ctx）+ 给定路由；返回端口与关闭函数。 */
async function serveRoutes(mounts: Array<[string, any]>): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(tenantContextMiddleware);
  for (const [prefix, route] of mounts) app.use(prefix, route);
  app.use(tenantErrorHandler);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).send({ legacy: String(err?.message) }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
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
  // 逐条清理（不用通配符；memories 的键可能因失败残留，按已知前缀删）
  await systemDb("o_project").whereIn("id", [OWN_PROJECT, FOREIGN_PROJECT, OWN_PROJECT2, DEL_PROJECT]).del();
  await systemDb("o_script").whereIn("id", [OWN_SCRIPT, FOREIGN_SCRIPT]).del();
  await systemDb("memories").whereIn("id", [MEM_ID, MEM_SCRIPT_ID, "del-own-1", "del-own-2", "del-foreign-1"]).del();
  await systemDb("memories").where("isolationKey", "like", "7:97001:productionAgent%").del();
  await systemDb("memories").where("isolationKey", "like", "8:97002:productionAgent%").del();
  await systemDb("memories").where("isolationKey", "like", "7:97001:scriptAgent%").del();
  await systemDb("memories").where("isolationKey", "like", "7:97005:%").del();
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

  it("★ 密钥优先级（D1 对齐，Ruling 220 #3）：库里没有 tokenKey → 回退 config.jwtSecret；原库值签的 token 被拒", async () => {
    await systemDb("o_setting").where("key", "tokenKey").del();
    try {
      const viaConfig = await decodeSocketToken(`Bearer ${jwt.sign({ id: 7, name: "u7" }, config.jwtSecret, { expiresIn: "1h" })}`);
      expect(viaConfig?.userId).toBe(7);
      expect(viaConfig?.source).toBe("socket");
      // 判别力：库里那行被删掉后，**原库值**签的 token 必须被拒 —— 证明"库值真的被读走了"，
      // 而不是"任意密钥都能过"。
      expect(await decodeSocketToken(`Bearer ${jwt.sign({ id: 7, name: "u7" }, TOKEN_KEY, { expiresIn: "1h" })}`)).toBeNull();
    } finally {
      await systemDb("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }).onConflict("key").merge();
    }
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

  it("★ scriptAgent **不采纳**客户端集号：传了别人的 scriptId，键仍是 `userId:projectId:scriptAgent`（无集号）", async () => {
    const connection = captureConnection(scriptAgentRoute as unknown as (nsp: any) => void);
    // 故意同时传 `episodesId` 与 `scriptId`，且都是**别人的** o_script.id（审查者 P2-1 的探针形态）
    const { socket } = fakeSocket({ token: token7(), projectId: OWN_PROJECT, episodesId: FOREIGN_SCRIPT, scriptId: FOREIGN_SCRIPT });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let derivedKey = "";
    try {
      await connection(socket);
      expect(socket.disconnected, "客户端集号不进键 ⇒ 不因此拒连（若采纳它，那行记忆会变成谁也读不到的孤儿）").toBe(false);
      const line = spy.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("[scriptAgent] 已连接:"));
      expect(line, "连接日志里应带服务端推导的键").toBeTruthy();
      derivedKey = String(line).trim().split(/\s+/).pop() as string;
    } finally {
      spy.mockRestore();
    }
    expect(derivedKey).toBe(`7:${OWN_PROJECT}:scriptAgent`);
    expect(derivedKey, "任何客户端指定的 id 都不许进键").not.toContain(String(FOREIGN_SCRIPT));
    // 与 HTTP 侧**同一把键**（前端 getMemory/clearMemory 都不带集号）——键相等是硬要求
    expect(derivedKey).toBe(buildIsolationKey(ctx7, OWN_PROJECT, "scriptAgent"));
  });

  it("★ 已包 ctx 的 handler **写**库：只改本租户的行；跨租户 update 影响 0 行（直读库核对）", async () => {
    const connection = captureConnection(scriptAgentRoute as unknown as (nsp: any) => void);
    const { socket, fire } = fakeSocket({ token: token7(), projectId: OWN_PROJECT });
    await connection(socket);

    let affectedOwn: any = null;
    let affectedForeign: any = null;
    socket.on("probe", async () => {
      affectedOwn = await u.db("o_project").where("id", OWN_PROJECT2).update({ name: "socket-updated" });
      affectedForeign = await u.db("o_project").where("id", FOREIGN_PROJECT).update({ name: "HACKED-BY-7" });
    });
    await fire("probe");

    // ⚠ 用 systemDb **直读库**核对真实状态（拿守卫自己的返回值为证会自证循环）
    const own = await systemDb("o_project").where("id", OWN_PROJECT2).first();
    const foreign = await systemDb("o_project").where("id", FOREIGN_PROJECT).first();
    expect(Number(affectedOwn)).toBe(1);
    expect(Number(affectedForeign)).toBe(0);
    expect(own.name).toBe("socket-updated");
    expect(foreign.name, "别人的行必须一字未动").toBe("socket-foreign");
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
  it("productionAgent 面：socket 侧写的记忆，HTTP getMemory 读得到、clearMemory 清得掉；别的租户读不到", async () => {
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

    const srv = await serveRoutes([
      ["/api/agents/getMemory", getMemoryRoute],
      ["/api/agents/clearMemory", clearMemoryRoute],
    ]);
    try {
      const got = await postJson(srv.port, "/api/agents/getMemory", { projectId: OWN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT }, token7());
      expect(got.status, `getMemory 应 200，实际 ${got.status} body=${got.body}`).toBe(200);
      expect(got.body, "HTTP 拼出的键必须与 socket 推导的键逐字符相同").toContain(MEM_ID);
      expect(got.body).toContain("socket-wrote-this-row");

      // 同一 token 用**别人**的 projectId 去读：键不同 + 守卫过滤 ⇒ 拿不到
      const cross = await postJson(srv.port, "/api/agents/getMemory", { projectId: FOREIGN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT }, token7());
      expect(cross.status).toBe(200);
      expect(JSON.parse(cross.body).data).toEqual([]);

      const cleared = await postJson(srv.port, "/api/agents/clearMemory", { projectId: OWN_PROJECT, agentType: "productionAgent", episodesId: OWN_SCRIPT, type: "message" }, token7());
      expect(cleared.status).toBe(200);
      // 直读库（绕过守卫，避免"守卫过滤"造成假绿）：那一行真的没了
      expect(await systemDb("memories").where("isolationKey", key7).select("id")).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("scriptAgent 面：**无集号**的键同样读得到/清得掉（HTTP 调用本来就不带 episodesId）", async () => {
    const key = buildIsolationKey(ctx7, OWN_PROJECT, "scriptAgent");
    expect(key).toBe(`7:${OWN_PROJECT}:scriptAgent`);
    await runWithTenant(ctx7, () =>
      u.db("memories").insert({
        id: MEM_SCRIPT_ID,
        isolationKey: key,
        type: "message",
        role: "assistant",
        content: "scriptagent-wrote-this-row",
        summarized: 0,
        createTime: Date.now(),
      } as any),
    );

    const srv = await serveRoutes([
      ["/api/agents/getMemory", getMemoryRoute],
      ["/api/agents/clearMemory", clearMemoryRoute],
    ]);
    try {
      const got = await postJson(srv.port, "/api/agents/getMemory", { projectId: OWN_PROJECT, agentType: "scriptAgent" }, token7());
      expect(got.status, `getMemory 应 200，实际 ${got.status} body=${got.body}`).toBe(200);
      expect(got.body).toContain(MEM_SCRIPT_ID);

      const cleared = await postJson(srv.port, "/api/agents/clearMemory", { projectId: OWN_PROJECT, agentType: "scriptAgent", type: "message" }, token7());
      expect(cleared.status).toBe(200);
      expect(await systemDb("memories").where("isolationKey", key).select("id")).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("★ delProject 面：删本项目 ⇒ **本项目**记忆全没、**别人项目**的还在（把 `delProject.ts` 的 LIKE 回退即红）", async () => {
    await systemDb("o_project").insert({ id: DEL_PROJECT, userId: 7, name: "del-me", createTime: 1 }).onConflict("id").merge();
    const ownKeyA = `7:${DEL_PROJECT}:productionAgent:${OWN_SCRIPT}`;
    const ownKeyB = `7:${DEL_PROJECT}:scriptAgent`;
    const foreignKey = `8:${FOREIGN_PROJECT}:productionAgent:${FOREIGN_SCRIPT}`;
    // ⚠ **必须显式写 `userId`**：`systemDb` 绕过守卫、不会自动填。若写成 NULL，会被守卫的
    //    `userId = ctx.userId` 条件滤掉 ⇒ 即使 LIKE 前缀写错（回退成 `${DEL_PROJECT}:%`）也"看起来删干净了"
    //    —— 用例就失去判别力（审查者 P2-2 的探针正是这么暴露的）。
    await systemDb("memories")
      .insert([
        { id: "del-own-1", isolationKey: ownKeyA, type: "message", content: "own-a", summarized: 0, createTime: 1, userId: 7 },
        { id: "del-own-2", isolationKey: ownKeyB, type: "message", content: "own-b", summarized: 0, createTime: 1, userId: 7 },
        { id: "del-foreign-1", isolationKey: foreignKey, type: "message", content: "foreign", summarized: 0, createTime: 1, userId: 8 },
      ])
      .onConflict("id")
      .merge();
    // 前置：本项目的两条键**都不带**旧前缀（回退版 `LIKE '97005:%'` 一条都匹配不到）
    expect(ownKeyA.startsWith(`${DEL_PROJECT}:`)).toBe(false);
    expect((await systemDb("memories").where("isolationKey", "like", `7:${DEL_PROJECT}:%`).select("id")).length).toBe(2);

    const srv = await serveRoutes([["/api/project/delProject", delProjectRoute]]);
    try {
      const res = await postJson(srv.port, "/api/project/delProject", { id: DEL_PROJECT }, token7());
      expect(res.status, `delProject 应 200，实际 ${res.status} body=${res.body}`).toBe(200);
      // 直读库：本项目记忆必须全没（守卫只保证"不碰别人的"，前缀形状只有 LIKE 管）
      expect(await systemDb("memories").where("isolationKey", "like", `7:${DEL_PROJECT}:%`).select("id"), "本项目记忆必须全被删掉").toEqual([]);
      expect(await systemDb("memories").where("id", "del-foreign-1").select("id"), "别人项目的记忆不许被删").toEqual([{ id: "del-foreign-1" }]);
    } finally {
      await srv.close();
    }
  });
});

describe("D. 回调面门禁（`bindSocketTenant` 只拦 `on`）", () => {
  it("`src/socket/**` + `src/agents/**` 不得出现 `.once(` / `onAny(`（注册的回调不会被包装 ⇒ 静默逃逸）", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
      }
    };
    walk(path.join(API_ROOT, "src", "socket"));
    walk(path.join(API_ROOT, "src", "agents"));
    expect(files.length).toBeGreaterThan(8);   // 防止 walk 写错导致空扫（恒真）
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const rel = path.relative(API_ROOT, f).split(path.sep).join("/");
      expect(src, `${rel} 不得用 \`.once(…)\`：它在注册时不会被 bindSocketTenant 包住（要用就显式 runWithTenant）`).not.toMatch(/\.once\s*\(/);
      expect(src, `${rel} 不得用 \`onAny(…)\`：同上`).not.toMatch(/onAny\s*\(/);
    }
  });
});
