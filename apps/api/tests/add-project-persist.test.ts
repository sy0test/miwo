/**
 * `addProject` 落库的 `o_project.id` 判据（Phase 1b / Task 4 修复轮 1 的 P0）。
 *
 * ── 为什么必须有这个文件 ──
 * `e3d5886` 曾从 `routes/project/addProject.ts` 删掉 `id: Date.now()`，理由是"`o_project.id` 是自增主键"。
 * **事实相反**：`001_schema.ts` 用 `T.bigInteger("id").unsigned().primary()`，sqlite 落到
 * `id bigint … primary key (id)` —— 它**不是** rowid 别名 ⇒ **允许 NULL**。后果是：
 *     POST /api/project/addProject → **200**（插入成功），但库里 `id = NULL`，`getProject` 原样返回 `"id":null`。
 * MySQL 侧同列没有 `auto_increment`，严格模式下 INSERT 缺列更是 `ERROR 1364` ⇒ 500。
 *
 * ── 判据的要点：**不能只断言"插入成功"** ──
 * `id = NULL` 时插入同样返回 200，所以"200"对这个缺陷**没有判别力**。本文件的判别力落在这里：
 *     ① 真 HTTP 打真实路由（`app.use("/api/project/addProject", addProject)` + `runWithTenant` ctx）；
 *     ② 再从库里**直读**那一行（`systemDb`，绕过租户条件，读的就是落盘的值）；
 *     ③ 断言 `id` **非 NULL 且是 number**。
 * 把 `id: Date.now()` 删掉 → ①仍 200、②仍有行，但 ③必红（`id === null`）。
 *
 * ⚠ 用 `vitest.config.ts` 的 `MIWO_DATA_DIR`（仓库外一次性目录，`D:\tmp\miwo-test-data`）；
 *   **不碰** `apps/api/data/db2.sqlite`。用例自建的那一行在 `afterAll` 按唯一 `name` 删除。
 * ⚠ 这里**不**新起进程/端口池：与 `tests/tenant-http-ctx-gap.test.ts` 同一手法（真 handler + `listen(0)`）。
 */
import express from "express";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithTenant } from "@/db/tenant-context";
import { systemDb } from "@/utils/db";
import addProject from "@/routes/project/addProject";

/** 唯一项目名（ASCII）：用来在共享测试库里精确定位并清理本用例建的那一行。 */
const PROJECT_NAME = `T4-FIX-ADDPROJECT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let server: http.Server;
let port = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // "Task 4 形状"的 ctx 中间件：HTTP 侧建 ctx 的唯一入口与生产中同一个 helper
  app.use((_req, _res, next) => runWithTenant({ userId: 7, role: "user", requestId: "t4-fix", source: "http" }, () => next()));
  app.use("/api/project/addProject", addProject);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.httpStatus ?? 500).send({ code: err?.code, name: err?.name, message: String(err?.message ?? "") }),
  );

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 只删本用例建的那一行（唯一 name），别影响共享测试库里的其它行
  await systemDb("o_project").where("name", PROJECT_NAME).del();
});

function post(body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/project/addProject",
        timeout: 15000,
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
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

describe("addProject 落库：o_project.id 必须由代码给（非 NULL 的 number）", () => {
  it("真 HTTP 200 且落库行的 id 非 NULL、是 number（删掉 `id: Date.now()` 时这里必红）", async () => {
    const res = await post({
      projectType: "normal",
      name: PROJECT_NAME,
      intro: "t4-fix",
      type: "short",
      artStyle: "anime",
      videoRatio: "9:16",
      imageModel: "m1",
      videoModel: "v1",
      imageQuality: "high",
      mode: "auto",
    });
    // ① 请求本身成功 —— 注意：**这一条对 id=NULL 的缺陷没有判别力**（那种情况下也是 200），
    //    它的作用是证明"插入真的发生了"，好让下面 ③ 的红端归因到 id 而不是"路由没跑到"。
    expect(res.status, `POST /api/project/addProject 必须 200，实际 ${res.status} body=${res.body}`).toBe(200);
    expect(res.body).toContain('"code":200');

    // ② 直读落盘的行（systemDb 无租户条件，读到的是真实值）
    const row: any = await systemDb("o_project").where("name", PROJECT_NAME).first();
    expect(row, "落库行必须存在（证明 insert 真的执行了）").toBeTruthy();
    expect(Number(row.userId)).toBe(7); // 守卫按 ctx 注入的租户列（顺带钉住 ctx 生效）

    // ③ ★判别力：id 非 NULL 且是 number
    expect(row.id, `o_project.id 不能是 NULL（DDL 是 bigint + 非 rowid 别名主键 ⇒ 不给值就落 NULL）：${JSON.stringify(row)}`).not.toBeNull();
    expect(row.id).toBeDefined();
    expect(typeof row.id, `o_project.id 必须是 number，实际 ${typeof row.id}（${String(row.id)}）`).toBe("number");
    expect(Number.isInteger(row.id)).toBe(true);
    expect(row.id).toBeGreaterThan(0);
  });
});
