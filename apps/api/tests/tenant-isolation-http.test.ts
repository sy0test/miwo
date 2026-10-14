/**
 * Task 9：**HTTP 层跨租户**（真中间件 + 真路由 + 真 `u.db`），把"最直接的越权读"逐条钉住。
 *
 * 为什么要端到端：`socket`/守卫的单元用例证明不了"路由接线正确"；这里挂**真** `tenantContextMiddleware`
 * （验签 → 建 ctx）→ 真路由 handler，用 A 的 token 去打 B 的数据，并**同时**断言 A 看得到自己的数据
 * （正向对照：否则"全空"会让所有跨租户断言恒真）。
 *
 * ⚠ `dbInfo` 是 **GET**（Task 7 收权时保留原方法）⇒ 用 GET 打；brief 里按 POST 写的部分是笔误。
 */
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { systemDb } from "@/utils/db";
import { tenantContextMiddleware } from "@/middleware/tenant";

import getTaskApi from "@/routes/task/getTaskApi";
import getProject from "@/routes/project/getProject";
import pollingImageAssets from "@/routes/assets/pollingImageAssets";
import getEvent from "@/routes/novel/event/getEvent";
import getMemory from "@/routes/agents/getMemory";
import getFileUrl from "@/routes/production/workbench/getFileUrl";
import dbInfo from "@/routes/setting/dbConfig/dbInfo";

const TOKEN_KEY = "http-isolation-token-key-0123456789";
let server: http.Server;
let base = "";
let tokenA = "";
let tokenB = "";
let tokenAdmin = "";

const P_A = 7001;
const P_B = 8001;

async function secret(): Promise<string> {
  const row: any = await systemDb("o_setting").where("key", "tokenKey").first();
  return (row && row.value) || config.jwtSecret;
}

function req(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        path,
        method,
        timeout: 15000,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const post = (p: string, body: unknown, token?: string) => req("POST", p, body, token);
const get = (p: string, token?: string) => req("GET", p, undefined, token);

beforeAll(async () => {
  const key = await secret();
  tokenA = jwt.sign({ id: 7, name: "A" }, key, { expiresIn: "1h" });
  tokenB = jwt.sign({ id: 8, name: "B" }, key, { expiresIn: "1h" });
  tokenAdmin = jwt.sign({ id: 1, name: "admin" }, key, { expiresIn: "1h" });

  // 夹具（幂等：onConflict.merge）—— A=7 → project 7001；B=8 → project 8001
  await systemDb("o_project").insert([
    { id: P_A, userId: 7, name: "iso-A", createTime: 1 },
    { id: P_B, userId: 8, name: "iso-B", createTime: 1 },
  ]).onConflict("id").merge();
  await systemDb("o_tasks").insert([
    { id: 7002, userId: 7, projectId: P_A, state: "进行中" },
    { id: 8002, userId: 8, projectId: P_B, state: "进行中" },
  ]).onConflict("id").merge();
  await systemDb("o_assets").insert([
    { id: 7003, userId: 7, projectId: P_A, type: "role" },
    { id: 8003, userId: 8, projectId: P_B, type: "role" },
  ]).onConflict("id").merge();
  await systemDb("o_image").insert([
    { id: 7004, userId: 7, assetsId: 7003, state: "已完成", filePath: "iso/a.png" },
    { id: 8004, userId: 8, assetsId: 8003, state: "已完成", filePath: "iso/b.png" },
  ]).onConflict("id").merge();
  await systemDb("o_assets").where("id", 7003).update({ imageId: 7004 });
  await systemDb("o_assets").where("id", 8003).update({ imageId: 8004 });
  await systemDb("o_novel").insert([
    { id: 7005, userId: 7, projectId: P_A, chapterIndex: 1 },
    { id: 8005, userId: 8, projectId: P_B, chapterIndex: 1 },
  ]).onConflict("id").merge();
  await systemDb("o_event").insert([
    { id: 7006, userId: 7, name: "A 的事件" },
    { id: 8006, userId: 8, name: "B 的事件" },
  ]).onConflict("id").merge();
  await systemDb("o_eventChapter").insert([
    { id: 7007, userId: 7, eventId: 7006, novelId: 7005 },
    { id: 8007, userId: 8, eventId: 8006, novelId: 8005 },
  ]).onConflict("id").merge();
  await systemDb("memories").insert([
    { id: "iso-ha", userId: 7, isolationKey: `7:${P_A}:scriptAgent`, type: "message", content: "A 的记忆", createTime: 1 },
    { id: "iso-hb", userId: 8, isolationKey: `8:${P_B}:scriptAgent`, type: "message", content: "B 的记忆", createTime: 1 },
  ]).onConflict("id").merge();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(tenantContextMiddleware);
  app.use("/api/task/getTaskApi", getTaskApi);
  app.use("/api/project/getProject", getProject);
  app.use("/api/assets/pollingImageAssets", pollingImageAssets);
  app.use("/api/novel/event/getEvent", getEvent);
  app.use("/api/agents/getMemory", getMemory);
  app.use("/api/production/workbench/getFileUrl", getFileUrl);
  app.use("/api/setting/dbConfig/dbInfo", dbInfo);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.httpStatus ?? 500).send({ code: err?.code ?? 500, message: String(err?.message ?? err) }),
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  void base;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await systemDb("o_eventChapter").whereIn("id", [7007, 8007]).del();
  await systemDb("o_event").whereIn("id", [7006, 8006]).del();
  await systemDb("o_novel").whereIn("id", [7005, 8005]).del();
  await systemDb("o_image").whereIn("id", [7004, 8004]).del();
  await systemDb("o_assets").whereIn("id", [7003, 8003]).del();
  await systemDb("o_tasks").whereIn("id", [7002, 8002]).del();
  await systemDb("o_project").whereIn("id", [P_A, P_B]).del();
  await systemDb("memories").whereIn("id", ["iso-ha", "iso-hb"]).del();
});

describe("HTTP 跨租户（spec §12.2 T1 的端到端部分）", () => {
  it("无 token → 401（鉴权仍在）", async () => {
    expect((await post("/api/task/getTaskApi", { page: 1, limit: 10 })).status).toBe(401);
  });

  it("★ getTaskApi 不传 projectId：只回自己的（改造前返回全租户）", async () => {
    const r = await post("/api/task/getTaskApi", { page: 1, limit: 50 }, tokenA);
    expect(r.status).toBe(200);
    // ⚠ 该路由 `success({ data, total })` ⇒ 列表在 `json.data.data`（brief 里写成 `json.data` 是笔误）。
    // ⚠ 它 join 了 o_project 并 `select *` ⇒ 同名 `id` 被 join 侧覆盖（**预存在**的路由怪癖，本任务不改路由）
    //   ⇒ 不许按"任务 id"断言；用 `total`（A 只有 1 条任务，两租户共 2 条）与"不含 B 的任何 id"作判据。
    const rows = r.json.data.data as any[];
    expect(Number(r.json.data.total), "A 的任务数必须是 1（漏守卫会是 2）").toBe(1);
    expect(rows.length).toBe(1);
    const asText = JSON.stringify(rows);
    expect(asText).not.toContain("8001");
    expect(asText).not.toContain("8002");
  });

  it("★ getTaskApi 传 B 的 projectId：空集（不是数据）", async () => {
    const r = await post("/api/task/getTaskApi", { page: 1, limit: 50, projectId: P_B }, tokenA);
    expect(r.status).toBe(200);
    expect(r.json.data.data).toEqual([]);
    expect(Number(r.json.data.total ?? 0)).toBe(0);
  });

  it("★ getProject：A 只看到自己的项目（双向互不可见）", async () => {
    const a = await post("/api/project/getProject", {}, tokenA);
    const idsA = (a.json.data as any[]).map((p) => Number(p.id));
    expect(idsA).toContain(P_A);
    expect(idsA).not.toContain(P_B);
    const b = await post("/api/project/getProject", {}, tokenB);
    const idsB = (b.json.data as any[]).map((p) => Number(p.id));
    expect(idsB).toContain(P_B);
    expect(idsB).not.toContain(P_A);
  });

  it("★ pollingImageAssets 传 B 的资产 id：空集（自己的 id 拿得到）", async () => {
    const cross = await post("/api/assets/pollingImageAssets", { ids: [8003] }, tokenA);
    expect(cross.status).toBe(200);
    expect(cross.json.data).toEqual([]);
    const own = await post("/api/assets/pollingImageAssets", { ids: [7003] }, tokenA);
    expect(own.status).toBe(200);
    expect((own.json.data as any[]).length).toBeGreaterThan(0); // 正向对照
  });

  it("★ getEvent 传 B 的 projectId：空列表（含 join 与 GROUP_CONCAT 的路径）；自己的拿得到", async () => {
    const cross = await post("/api/novel/event/getEvent", { projectId: P_B, page: 1, limit: 10 }, tokenA);
    expect(cross.status).toBe(200);
    expect(cross.json.data.list).toEqual([]);
    expect(cross.json.data.total).toBe(0);
    const own = await post("/api/novel/event/getEvent", { projectId: P_A, page: 1, limit: 10 }, tokenA);
    expect(own.json.data.total).toBe(1);
    expect(own.json.data.list[0].eventName).toBe("A 的事件");
  });

  it("★ getMemory 传 B 的 projectId：空历史；自己的 projectId 拿得到自己的记忆", async () => {
    const cross = await post("/api/agents/getMemory", { projectId: P_B, agentType: "scriptAgent" }, tokenA);
    expect(cross.status).toBe(200);
    expect(cross.json.data).toEqual([]);
    const own = await post("/api/agents/getMemory", { projectId: P_A, agentType: "scriptAgent" }, tokenA);
    expect(own.status).toBe(200);
    // 该路由把 content 包成 markdown 块：`content: [{type:"markdown", status:"complete", data: row.content}]`
    expect((own.json.data as any[]).map((m) => m.content[0].data)).toEqual(["A 的记忆"]);
  });

  it("★ getFileUrl 传 B 的资产 id：拿不到 B 的路径；自己的拿得到", async () => {
    const cross = await post("/api/production/workbench/getFileUrl", { items: [{ sources: "assets", id: 8003 }] }, tokenA);
    expect(cross.status).toBe(200);
    expect(JSON.stringify(cross.json)).not.toContain("iso/b.png");
    const own = await post("/api/production/workbench/getFileUrl", { items: [{ sources: "assets", id: 7003 }] }, tokenA);
    expect(own.status).toBe(200);
  });

  it("运维接口（GET dbInfo）：普通用户 403；管理员 200", async () => {
    expect((await get("/api/setting/dbConfig/dbInfo", tokenA)).status).toBe(403);
    expect((await get("/api/setting/dbConfig/dbInfo", tokenAdmin)).status).toBe(200);
  });
});
