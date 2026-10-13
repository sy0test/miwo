/**
 * Task 7（Phase 1b）判别力：`getEvent` 的**跨租户可读性**两端。
 *
 * 背景：`routes/novel/event/getEvent.ts` 在 Task 3 之前是 spec 附录 B.1 的绕过口之一
 * （命名导入裸 `db` + `db.raw`），一个查询同时踩三种形态：**主表、两处 join、一处 raw**。
 * Task 3 已把它改成 `u.db`（守卫）+ `u.db.raw`（不含表名的表达式）。本文件把这**三处**
 * 一起钉住，并在报告里给出"改前能跨租户读到 / 改后只能读到本租户"的两端原文
 * （改前那一端用 VCS 篡改实验复现，见 task-7-report.md）。
 *
 * 为什么挂**真中间件**（`tenantContextMiddleware`）而不是塞一个假 ctx：
 *   "谁的身份"是世界状态的一部分；塞假 ctx 就测不到"token → ctx → 守卫注入"这条链。
 *   真起 HTTP（`listen(0)`）+ 真 sqlite（vitest 的一次性 data 目录）。
 *
 * 判别力（每一条都有"没人别的行"作为对照）：
 *   ① 本租户的项目 ⇒ 看得到自己的事件，且**看不到**别人的；
 *   ② **别人的项目 id** ⇒ 一行都看不到（这是"改前"会泄露的那一端）；
 *   ③ `GROUP_CONCAT`（raw 表达式）在守卫下仍然工作 ⇒ `chapters: [1,2]`。
 */
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { config } from "@/config";
import { createKnex } from "@/db/connect";
import { tenantContextMiddleware } from "@/middleware/tenant";
import getEvent from "@/routes/novel/event/getEvent";

const OWNER = 7;
const STRANGER = 8;
const P_OWN = 900001;
const P_OTHER = 900002;
const N_OWN_A = 910001;
const N_OWN_B = 910002;
const N_OTHER = 910003;
const E_OWN = 920001;
const E_OTHER = 920002;
const EC = [930001, 930002, 930003];

let db: Knex;
let server: http.Server;
let port = 0;

function sign(userId: number, secret: string): string {
  return (jwt.sign as any)({ id: userId, name: `get-event-${userId}` }, secret, { expiresIn: "180Days" });
}

function post(token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/novel/event/getEvent",
        timeout: 15000,
        headers: { "Content-Type": "application/json", "Content-Length": data.length, Authorization: `Bearer ${token}` },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode as number, body: buf }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** 解析 `success({...})` 的响应体（`{code, data, ...}` 形状见 lib/responseFormat）。 */
function payload(body: string): any {
  const parsed = JSON.parse(body);
  return parsed?.data ?? parsed;
}

describe("getEvent 的租户可读范围（真中间件 + 真守卫 + 真 HTTP）", () => {
  beforeAll(async () => {
    db = createKnex(config);
    // 两个租户各一套：项目 → 小说(两章) → 事件 → 事件-章节关联
    await db("o_project").insert([
      { id: P_OWN, userId: OWNER, name: "own", createTime: 1 },
      { id: P_OTHER, userId: STRANGER, name: "other", createTime: 1 },
    ]);
    await db("o_novel").insert([
      { id: N_OWN_A, chapterIndex: 1, projectId: P_OWN, userId: OWNER },
      { id: N_OWN_B, chapterIndex: 2, projectId: P_OWN, userId: OWNER },
      { id: N_OTHER, chapterIndex: 1, projectId: P_OTHER, userId: STRANGER },
    ]);
    await db("o_event").insert([
      { id: E_OWN, name: "OWN-EVENT", detail: "own", createTime: 1, userId: OWNER },
      { id: E_OTHER, name: "OTHER-EVENT", detail: "other", createTime: 1, userId: STRANGER },
    ]);
    await db("o_eventChapter").insert([
      { id: EC[0], eventId: E_OWN, novelId: N_OWN_A, userId: OWNER },
      { id: EC[1], eventId: E_OWN, novelId: N_OWN_B, userId: OWNER },
      { id: EC[2], eventId: E_OTHER, novelId: N_OTHER, userId: STRANGER },
    ]);

    const app = express();
    app.use(express.json());
    // ★ 真中间件：token → ctx（ALS）→ 下游 handler 的 await 全带 ctx
    app.use(tenantContextMiddleware);
    app.use("/api/novel/event/getEvent", getEvent);
    app.use((err: any, _req: any, res: any, _next: any) =>
      res.status(err?.httpStatus ?? 500).send({ code: err?.code, name: err?.name, message: String(err?.message ?? "") }),
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db("o_eventChapter").whereIn("id", EC).del();
    await db("o_event").whereIn("id", [E_OWN, E_OTHER]).del();
    await db("o_novel").whereIn("id", [N_OWN_A, N_OWN_B, N_OTHER]).del();
    await db("o_project").whereIn("id", [P_OWN, P_OTHER]).del();
    await db.destroy();
  });

  /** 中间件优先用库里的 tokenKey（没有才回退配置密钥）——测试与它保持一致，否则全是 401。 */
  async function secretOf(): Promise<string> {
    const row: any = await db("o_setting").where("key", "tokenKey").first();
    return (row && row.value) || config.jwtSecret;
  }

  it("① 本租户项目：看得到自己的事件、看不到别人的（含 GROUP_CONCAT 聚合）", async () => {
    const token = sign(OWNER, await secretOf());
    const res = await post(token, { projectId: P_OWN, page: 1, limit: 10 });
    expect(res.status, `本租户查询应 200：${res.body.slice(0, 300)}`).toBe(200);
    const data = payload(res.body);
    expect(data.total).toBe(1);
    expect(data.list.map((x: any) => x.eventName)).toEqual(["OWN-EVENT"]);
    // ③ raw 表达式（GROUP_CONCAT）在守卫下仍工作：两章的 chapterIndex 聚合成 [1,2]
    expect(data.list[0].chapters).toEqual([1, 2]);
    expect(res.body, "别人的事件名不得出现在本租户的响应里").not.toContain("OTHER-EVENT");
  }, 60000);

  it("② 别人的项目 id：一行都看不到（改前这里会返回 OTHER-EVENT）", async () => {
    const token = sign(OWNER, await secretOf());
    const res = await post(token, { projectId: P_OTHER, page: 1, limit: 10 });
    expect(res.status, `跨租户查询不该 500（守卫应把它过滤成空集）：${res.body.slice(0, 300)}`).toBe(200);
    const data = payload(res.body);
    expect(data.total, "别人的项目 id 必须查不到任何行").toBe(0);
    expect(data.list).toEqual([]);
    expect(res.body).not.toContain("OTHER-EVENT");
  }, 60000);

  it("②b 反向对照：陌生人拿**我的**项目 id 也看不到（证明不是'只有 7 号被特殊对待'）", async () => {
    const token = sign(STRANGER, await secretOf());
    const res = await post(token, { projectId: P_OWN, page: 1, limit: 10 });
    expect(res.status).toBe(200);
    const data = payload(res.body);
    expect(data.total).toBe(0);
    expect(res.body).not.toContain("OWN-EVENT");
  }, 60000);
});
