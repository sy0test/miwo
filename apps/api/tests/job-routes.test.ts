/**
 * 路由级验收（Phase 1d Task 7 Step 5）：**真 HTTP + 真入队**，把"六个生成入口改入队"这件事
 * 从"代码看起来对"提升到"行为可观测"。
 *
 * 本文件钉住 4 条（评审判断判别力就用这 4 条）：
 *  ① 响应在 1s 内返回 ⇒ 接口**不再同步等模型**（否则"入队"与"进程内直跑"无从区分）；
 *  ② `data` 形状**一个字都没变**（单个入口 = 数字 `videoId`；批量入口 = `[{videoId, trackId}]` 数组）
 *     + `jobIds` 是**新顶层字段**；
 *  ③ `o_job` 真的多了一行，`type`/`payload`/`userId` 正确，且 **payload 里没有 base64**；
 *  ④ 未认证 ⇒ 被拒且**零写入**。
 *
 * ⚠ 用共享测试库（`vitest.config.ts` 的 `MIWO_DATA_DIR`，即 `D:\tmp\miwo-test-data`），
 *   **不碰** `apps/api/data/db2.sqlite`（真机只读快照）。夹具按显式 id 逐个清理。
 * ⚠ 走**真** `tenantContextMiddleware`（验签 → 建 ctx）而不是伪造 `req.user`：
 *   否则 `currentUserId()` 的 ctx 分支根本没被覆盖，而生产上走的正是它。
 */
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/utils/db";
import { tenantContextMiddleware } from "@/middleware/tenant";
import { mintAccess, removeAuthUsers, seedAuthUsers, type AuthFixtureUser } from "./helpers/auth-fixture";

import generateVideo from "@/routes/production/workbench/generateVideo";
import batchGenerateVideo from "@/routes/production/workbench/batchGenerateVideo";

const USER: AuthFixtureUser = { id: 5151, username: "job-routes-1", role: "user" };
const PROJECT = 900001;
const TRACK_A = 5150;
const TRACK_B = 5152;
const TRACK_C = 5160;
const SCRIPT = 9001;
const ASSET = 900010;
const ASSET_IMAGE = 900011;
const ASSET_NEW = 900012;

let server: http.Server;
let token = "";

function post(port: number, path: string, body: unknown, tok?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: 15_000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
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
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/**
 * 单个视频生成请求体。
 * ⚠ `uploadData` 必须是**存在**的资产：路由对 `item.sources === "assets"` 会读 `filePath.type`，
 * 老代码在这一支**没有空值保护**（`generateVideo.ts:78`，预存在缺陷，本任务不动路由）
 * ⇒ 用不存在的 id 会让路由 500，那样测到的就不是"入队"了。
 */
const body = (trackId: number, projectId = PROJECT) => ({
  projectId,
  scriptId: SCRIPT,
  uploadData: [{ id: ASSET, sources: "assets" }],
  prompt: "p",
  model: "miwo:test-model",
  mode: "text",
  resolution: "720p",
  duration: 5,
  trackId,
});

const count = async (q: any): Promise<number> => Number(((await q.first()) as any)?.n ?? -1);

beforeAll(async () => {
  await seedAuthUsers(systemDb, [USER]);
  token = await mintAccess(USER);
  // 路由要读 o_project.videoRatio（生产上项目一定存在；这里显式种一条）
  await systemDb("o_project").insert({ id: PROJECT, userId: USER.id, name: "job-routes", videoRatio: "16:9", createTime: 1 }).onConflict("id").merge();
  await systemDb("o_image").insert({ id: ASSET_IMAGE, userId: USER.id, assetsId: 0, state: "已完成", filePath: "job-routes/a.png", type: "role" }).onConflict("id").merge();
  await systemDb("o_assets").insert({ id: ASSET, userId: USER.id, projectId: PROJECT, imageId: ASSET_IMAGE, type: "role", name: "job-routes-asset" }).onConflict("id").merge();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(tenantContextMiddleware);
  app.use("/api/production/workbench/generateVideo", generateVideo);
  app.use("/api/production/workbench/batchGenerateVideo", batchGenerateVideo);
  // 显式错误中间件：路由自己 catch 的分支会回 400，这里只承接**没被 catch** 的异常（把 message 带出来便于诊断）
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.httpStatus ?? 500).send({ code: err?.code ?? 500, message: String(err?.message ?? err) }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  // 逐条清理（显式 id）：本文件造的 o_job 只可能属于 USER
  await systemDb("o_job").where("userId", USER.id).del();
  await systemDb("o_video").where("projectId", PROJECT).del();
  await systemDb("o_assets").whereIn("id", [ASSET, ASSET_NEW]).del();
  await systemDb("o_image").where("id", ASSET_IMAGE).del();
  await systemDb("o_project").where("id", PROJECT).del();
  await removeAuthUsers(systemDb, [USER.id]);
});

describe("generateVideo 路由 → 入队（Phase 1d）", () => {
  it("★ 1s 内返回；data 是数字 videoId；jobIds 是新顶层字段；只产生一条 o_job 且 payload 无 base64", async () => {
    const port = (server.address() as AddressInfo).port;
    const before = await count(systemDb("o_job").where("type", "video.generate").count({ n: "*" }));

    const t0 = Date.now();
    const res = await post(port, "/api/production/workbench/generateVideo", body(TRACK_A), token);
    const ms = Date.now() - t0;

    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.code).toBe(200);
    expect(typeof res.json.data).toBe("number"); // ← 形状铁律：前端 index.vue:473 把 data 当数字
    expect(Array.isArray(res.json.jobIds)).toBe(true);
    expect(res.json.jobIds.length).toBe(1);
    expect(ms, "接口不再等模型：必须 1s 内返回").toBeLessThan(1_000);

    const after = await count(systemDb("o_job").where("type", "video.generate").count({ n: "*" }));
    expect(after, "入队必须真的多一行 o_job").toBe(before + 1);

    const job = await systemDb("o_job").where("id", res.json.jobIds[0]).first();
    expect(job.type).toBe("video.generate");
    expect(job.state).toBe("queued");
    expect(Number(job.userId), "归属必须显式写进去（platform 表守卫不回填）").toBe(USER.id);
    const payload = JSON.parse(job.payload);
    /**
     * ⚠ **实现与 task-7 契约表的偏离（已登记；测试断言的是实际形状）**：
     * brief 的契约表把 `video.generate` 的 payload 写成**扁平**（`payload.videoId`），
     * 但落地实现（`e964caf` 的 handler + 本路由）复用了 `VideoBatchPayload`：单个任务也包一层
     * `items[]`。本用例断言**实际**形状，偏离登记在 `groupC-report.md`。
     */
    expect(payload.items[0].videoId).toBe(res.json.data);
    expect(payload.projectId).toBe(PROJECT);
    expect(payload.items[0].trackId).toBe(TRACK_A);
    expect(payload.items[0].refs, "refs 只带路径（base64 由 handler 现取）").toEqual([{ path: "job-routes/a.png", sources: "role" }]);
    expect(job.payload).not.toContain("base64"); // ← payload 只存引用

    const video = await systemDb("o_video").where("id", res.json.data).first();
    expect(video.state).toBe("生成中"); // 产物占位行仍由路由建
  });

  it("同一 trackId 重复提交 → 命中幂等（jobIds 相同，且 o_job 行数只 +1）", async () => {
    const port = (server.address() as AddressInfo).port;
    const before = await count(systemDb("o_job").where("type", "video.generate").count({ n: "*" }));
    const r1 = await post(port, "/api/production/workbench/generateVideo", body(TRACK_B), token);
    const r2 = await post(port, "/api/production/workbench/generateVideo", body(TRACK_B), token);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // 明确的行数断言（brief 原稿在这里是模糊断言，按要求改成确定性判据）
    expect(r2.json.jobIds[0]).toBe(r1.json.jobIds[0]);
    const after = await count(systemDb("o_job").where("type", "video.generate").count({ n: "*" }));
    expect(after, "幂等命中 ⇒ 只多一行（不是两行）").toBe(before + 1);
  });

  /**
   * 未认证路径（brief Step 5 第 3 条："未登录 → 401 且不写库"）。
   *
   * ⚠ **[1d-14 规范] 门槛写清，不许暗示比实测更强的主张**：
   *   本路由在鉴权判断**之前**就要读库（`o_project` / `o_assets`），而租户守卫对"无 ctx"是
   *   **fail-closed** ⇒ 未认证请求在真实装配下**走不到** handler 的 401 分支，是在守卫处被拒。
   *   所以本用例钉的是**安全属性本身**（未认证 ⇒ 被拒 + 零写入），而不是"响应码一定是 401"：
   *   断言 ① 不是 200（没有"未认证却成功生成"）；② `o_video` / `o_job` 零新增。
   *   handler 的 `if (userId === null) → 401` 分支作为防御性冗余保留（路由直挂、不带守卫时生效）。
   */
  it("★ 未认证：被拒且零写入（不新增 o_video 占位行、不新增 o_job）", async () => {
    const app2 = express();
    app2.use(express.json({ limit: "10mb" }));
    app2.use("/generateVideo", generateVideo); // **不挂** tenantContextMiddleware ⇒ 无 ctx、无 req.user
    app2.use((err: any, _req: any, res: any, _next: any) => res.status(err?.httpStatus ?? 500).send({ code: err?.code ?? 500, message: String(err?.message ?? err) }));
    const s2 = await new Promise<http.Server>((resolve) => {
      const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port2 = (s2.address() as AddressInfo).port;
      const videoBefore = await count(systemDb("o_video").where("projectId", PROJECT).count({ n: "*" }));
      const jobBefore = await count(systemDb("o_job").where("userId", USER.id).count({ n: "*" }));

      const res = await post(port2, "/generateVideo", body(5153), undefined);

      const videoAfter = await count(systemDb("o_video").where("projectId", PROJECT).count({ n: "*" }));
      const jobAfter = await count(systemDb("o_job").where("userId", USER.id).count({ n: "*" }));
      expect(res.status, `未认证请求不得成功（实际 ${res.status}）`).not.toBe(200);
      expect(videoAfter, "未认证请求绝不留下产物占位行").toBe(videoBefore);
      expect(jobAfter, "未认证请求绝不留下 o_job").toBe(jobBefore);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });
});

describe("batchGenerateVideo 路由 → 入队（data 是数组，形状不许变）", () => {
  it("★ data 是 [{videoId, trackId}] 数组；jobIds 顶层；一条 video.batchGenerate", async () => {
    const port = (server.address() as AddressInfo).port;
    const before = await count(systemDb("o_job").where("type", "video.batchGenerate").count({ n: "*" }));
    const t0 = Date.now();
    const res = await post(
      port,
      "/api/production/workbench/batchGenerateVideo",
      {
        projectId: PROJECT,
        scriptId: SCRIPT,
        model: "miwo:test-model",
        mode: "text",
        resolution: "720p",
        duration: 5,
        // ⚠ zod 要求每项都带 uploadData / duration（`batchGenerateVideo.ts:29-41`）
        trackData: [{ trackId: TRACK_C, prompt: "p1", duration: 5, uploadData: [{ id: ASSET, sources: "assets" }] }],
      },
      token,
    );
    const ms = Date.now() - t0;
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(Array.isArray(res.json.data)).toBe(true); // ← 形状铁律：track.vue:336 把 data 当数组
    expect(res.json.data[0]).toHaveProperty("videoId");
    expect(res.json.data[0]).toHaveProperty("trackId");
    expect(Array.isArray(res.json.jobIds)).toBe(true);
    expect(res.json.jobIds.length).toBe(1);
    expect(ms, "接口不再等模型").toBeLessThan(1_000);

    const after = await count(systemDb("o_job").where("type", "video.batchGenerate").count({ n: "*" }));
    expect(after, "批量入队只多一行（带全部 items）").toBe(before + 1);

    const job = await systemDb("o_job").where("id", res.json.jobIds[0]).first();
    expect(job.state).toBe("queued");
    expect(Number(job.userId)).toBe(USER.id);
    const payload = JSON.parse(job.payload);
    expect(payload.items.length).toBe(1); // 一个任务带全部 items
    expect(payload.items[0].videoId).toBe(res.json.data[0].videoId);
    expect(payload.items[0].trackId).toBe(TRACK_C);
    expect(job.payload).not.toContain("base64");
  });
});
