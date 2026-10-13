/**
 * Task 3 的**端到端**补充证据：把真实路由挂在 HTTP 上跑一遍，证明"接线本身是通的"，
 * 并把"还差什么"精确地钉在 **Task 4 的 HTTP ctx** 上。
 *
 * 为什么要有这个文件（而不是只留 smoke 的 `500`）：
 *   接线后 `POST /api/project/getProject` 在真应用里是 **500 `TENANT_NO_CONTEXT`**
 *   （那是**预期红**，建 ctx 是计划 Task 4 的产物，1b Task 3 的范围里没有它）。
 *   但"500"本身证明不了**接线是对的** —— 也可能是我把守卫接坏了（注入出非法 SQL、路由炸在别处）。
 *   所以这里用**同一个真实 handler**跑两次：
 *     ① 包在 `runWithTenant(...)` 里（= Task 4 落地后 HTTP 路径的形状）→ 必须 **200**；
 *     ② 不包（= 今天的真应用）→ 必须 **500 + `TENANT_NO_CONTEXT`**。
 *   两条合起来才是完整结论：**缺的只是 ctx，隔离开关本身工作正常**。
 *
 * ⚠ 用的库是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（仓库外的一次性目录）；
 *   **不碰** `apps/api/data/db2.sqlite`。真起 HTTP（`listen(0)`）而不是造假 req/res，
 *   因为"express 5 会不会把 async 抛错转成 500"正是本文件要证的一环。
 */
import express from "express";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { runWithTenant } from "@/db/tenant-context";
import getProject from "@/routes/project/getProject";

/** 真实 handler + 一个"Task 4 形状"的 ctx 中间件（`runWithTenant(ctx, () => next())`）。 */
async function serve(getProjectWithCtx: boolean) {
  const app = express();
  app.use(express.json());
  if (getProjectWithCtx) {
    app.use((_req, _res, next) =>
      runWithTenant({ userId: 1, role: "admin", requestId: "t", source: "http" }, () => next()),
    );
  }
  app.use("/api/project/getProject", getProject);
  // 与 `src/app.ts` 的错误中间件同形状：隔离错误有 `httpStatus`，用它回状态码
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.httpStatus ?? 500).send({ code: err?.code, name: err?.name }),
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, close };
}

function post(port: number, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/project/getProject",
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

describe("主链路的租户 ctx 缺口（Task 3 接线证据 / Task 4 收口）", () => {
  it("同一个真实 handler：有 ctx → 200；没有 ctx → 500 TENANT_NO_CONTEXT", async () => {
    const withCtx = await serve(true);
    const ok = await post(withCtx.port, {});
    await withCtx.close();
    expect(ok.status, `有 ctx 时必须是 200，实际 ${ok.status} body=${ok.body}`).toBe(200);
    expect(ok.body).toContain('"code":200');

    const noCtx = await serve(false);
    const red = await post(noCtx.port, {});
    await noCtx.close();
    expect(red.status, `无 ctx 时必须 fail-closed 成 500，实际 ${red.status} body=${red.body}`).toBe(500);
    expect(red.body).toContain("TENANT_NO_CONTEXT");
  });
});
