/**
 * vendor 分池闸门的回归网（Phase 1d Task 9 / spec §9.3）。
 *
 * 核心不变式：**同一池的并发持有者数永不超过 limit** —— 这靠"插入后校验"（没进前 limit 名就
 * 立刻删掉自己那行）实现，正确性不依赖行锁，所以 sqlite / MySQL 同一套语义
 * （MySQL 下的 `for update skip locked` 属**未实测**优化，本阶段不用）。
 *
 * 另四条：过期回收 / 等待超时返回 null / releaseAll 兜底 / 未列出的池取 default。
 *
 * ⚠ 用 `%TEMP%` 下的一次性库；`createGate` 显式注入（不走生产单例，也不经过受守卫的 `u.db`）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { createGate, withVendorSlot, type Gate } from "@/jobs/gate";
import batchGenerateImageAssets from "@/routes/assetsGenerate/batchGenerateImageAssets";
import batchPolishAssetsPrompt from "@/routes/assetsGenerate/batchPolishAssetsPrompt";
import batchBindAudio from "@/routes/cornerScape/batchBindAudio";
import generateEvents from "@/routes/novel/event/generateEvents";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-gate-"));
/** `apps/api`（静态守卫读路由源码用；其余用例只用一次性 `%TEMP%` 库）。 */
const API_DIR = path.resolve(__dirname, "..");
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 真 HTTP POST（不引新依赖；只用于"参数校验阶段被拒"这一条）。 */
function post(port: number, pathname: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", timeout: 10_000, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
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

let seq = 0;
async function setup(): Promise<{ db: Knex; gate: Gate }> {
  seq += 1;
  const db = createKnex(cfg(path.join(TMP, `g${seq}.sqlite`)));
  await runMigrations(db);
  // asSystem 显式给成"直通"：本用例的 db 是不带租户守卫的裸 knex，不需要系统身份代行
  // （生产侧 `createGate` 缺省走 `runAsAuth`，见 gate.ts 文件头）。
  return { db, gate: createGate({ db, limits: { "vendor:image": 3, default: 1 }, pollMs: 10, leaseMs: 500, waitMs: 3_000, asSystem: (fn) => fn() }) };
}

describe("vendor 分池闸门（spec §9.3）", () => {
  it("★ 并发持有者数**永不超过** limit（20 个并发抢 3 个槽位）", async () => {
    const { db, gate } = await setup();
    let holders = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const id = await gate.acquire("vendor:image", `h${i}`);
        if (id === null) return false;
        holders += 1;
        peak = Math.max(peak, holders);
        await sleep(30);
        holders -= 1;
        await gate.release(id);
        return true;
      }),
    );
    expect(results.filter(Boolean).length).toBeGreaterThan(0); // 反恒真：真的有拿到槽位的
    expect(peak).toBeGreaterThan(0); // 反恒真：峰值不是"从没并发过"
    expect(peak).toBeLessThanOrEqual(3);
    // 全部释放后池子应是空的（槽位没有泄漏）
    expect(await gate.counts()).toEqual({});
    await db.destroy();
  });

  it("槽位过期会被回收（持有者崩溃不永久占位）", async () => {
    const { db, gate } = await setup();
    const id = await gate.acquire("vendor:image", "h1");
    expect(id).not.toBeNull();
    await db("o_gate").update({ leaseUntil: Date.now() - 1 });
    expect(await gate.reclaimExpired()).toBe(1);
    expect(await gate.counts()).toEqual({});
    await db.destroy();
  });

  it("等待超时返回 null（不无限等）", async () => {
    const { db, gate } = await setup();
    const a = await gate.acquire("default", "h1");
    const b = await gate.acquire("default", "h2", 100); // limit=1，只等 100ms
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    // 没拿到的人不留行（关键：否则会永久堆积僵尸槽位）
    expect(await gate.counts()).toEqual({ default: 1 });
    await db.destroy();
  });

  it("releaseAll 清掉某持有者的全部槽位（进程退出兜底）", async () => {
    const { db, gate } = await setup();
    await gate.acquire("vendor:image", "h1");
    await gate.acquire("default", "h1");
    expect(await gate.releaseAll("h1")).toBe(2);
    expect(await gate.counts()).toEqual({});
    await db.destroy();
  });

  it("未列出的池取 default 上限", async () => {
    const { db, gate } = await setup();
    expect(await gate.acquire("unknown:pool", "h1")).not.toBeNull();
    expect(await gate.acquire("unknown:pool", "h2", 50)).toBeNull();
    await db.destroy();
  });

  it("★ 不同池互不影响（image 满不挡 text）", async () => {
    const { db, gate } = await setup();
    const a = await gate.acquire("vendor:image", "h1");
    const b = await gate.acquire("vendor:image", "h2");
    const c = await gate.acquire("vendor:image", "h3");
    expect([a, b, c].every((x) => x !== null)).toBe(true);
    // image 池已满（limit=3）：第 4 个要等
    expect(await gate.acquire("vendor:image", "h4", 50)).toBeNull();
    // ⚠ 但 `default` 池 limit=1 且此时它是空的 ⇒ 不受 image 池影响
    expect(await gate.acquire("default", "h5")).not.toBeNull();
    await db.destroy();
  });
});

/**
 * Step 5 的验收：`concurrentCount` 必须有 `.max(8)`（spec §3.4/§9.3 点名"单请求可传 1000"）。
 *
 * ⚠ 这里只打**请求内入口**（路由级 grep 见 groupC-report.md 的 4 处对照）。走真 `validateFields`：
 *   超限在**参数校验阶段**就被拒（400），因此**不会碰到数据库**（也不该碰到 —— 这正是"上限在入口收掉"的意思）。
 *   不带鉴权中间件也成立：校验比任何 handler 逻辑都早。
 *
 * ── Phase 1d F8 收口（本组）──
 * C 组只把 4 个入口上了 `.max(8)`，另 **3 个入口漏了**（`batchPolishAssetsPrompt` / `batchBindAudio` /
 * `generateEvents`）—— 症状与 spec §9.3 点名的"单请求可传 1000"完全一样：请求方能自己放大进程内并发。
 * 现在 7 个入口全部收口，且**两个方向**都被覆盖：
 *   ① 真 HTTP：7 个入口各自传 9 ⇒ 400、传 8 ⇒ 不因上限被拒；
 *   ② 源码静态：7 个路由文件的 `concurrentCount` schema 必须都带 `.max(8)`
 *      （机械守卫：删掉任何一处 `.max(8)` ⇒ 这条用例红，不必等到有人打 9）。
 */
describe("concurrentCount 上限 8（spec §9.3）", () => {
  /** 7 个"请求内并发"入口：路由文件 + 挂载路径 + 最小合法 payload（`concurrentCount` 由用例填）。 */
  const ENTRIES: Array<{ name: string; route: string; mount: string; payload: (n: number) => unknown; handler: any }> = [
    {
      name: "batchGenerateImageAssets",
      route: "src/routes/assetsGenerate/batchGenerateImageAssets.ts",
      mount: "/api/assetsGenerate/batchGenerateImageAssets",
      handler: batchGenerateImageAssets,
      payload: (n) => ({ projectId: 1, model: "miwo:test", resolution: "1K", concurrentCount: n, items: [{ id: 1, type: "role", name: "n", prompt: "p" }] }),
    },
    {
      name: "batchPolishAssetsPrompt（F8 新收口）",
      route: "src/routes/assetsGenerate/batchPolishAssetsPrompt.ts",
      mount: "/api/assetsGenerate/batchPolishAssetsPrompt",
      handler: batchPolishAssetsPrompt,
      payload: (n) => ({ projectId: 1, items: [{ assetsId: 1, type: "role", name: "n", describe: "d" }], concurrentCount: n, otherTextPrompt: "x" }),
    },
    {
      name: "batchBindAudio（F8 新收口）",
      route: "src/routes/cornerScape/batchBindAudio.ts",
      mount: "/api/cornerScape/batchBindAudio",
      handler: batchBindAudio,
      payload: (n) => ({ projectId: 1, assetsIds: [1], concurrentCount: n }),
    },
    {
      name: "generateEvents（F8 新收口）",
      route: "src/routes/novel/event/generateEvents.ts",
      mount: "/api/novel/event/generateEvents",
      handler: generateEvents,
      payload: (n) => ({ projectId: 1, novelIds: [1], concurrentCount: n }),
    },
  ];

  function mountOne(handler: any, mount: string): Promise<http.Server> {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(mount, handler);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.httpStatus ?? 500).send({ code: err?.code ?? 500, message: String(err?.message ?? err) }));
    return new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  }

  for (const e of ENTRIES) {
    it(`★ ${e.name}：传 9 ⇒ 400（validateFields 阶段被拒）；传 8 ⇒ 不因上限被拒`, async () => {
      const srv = await mountOne(e.handler, e.mount);
      try {
        const port = (srv.address() as AddressInfo).port;
        const over = await post(port, e.mount, e.payload(9));
        expect(over.status, `传 9 必须被拒（实际 ${over.status}）`).toBe(400);
        const ok = await post(port, e.mount, e.payload(8));
        expect(ok.status, `传 8 不该因"上限"被拒（实际 ${ok.status}）`).not.toBe(400);
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });
  }

  it("★★ 机械守卫：7 个入队/并发入口的 concurrentCount 都必须带 .max(8)（少一处即红）", () => {
    const files = [
      "src/routes/assetsGenerate/batchGenerateImageAssets.ts",
      "src/routes/assetsGenerate/batchPolishAssetsPrompt.ts",
      "src/routes/cornerScape/batchBindAudio.ts",
      "src/routes/novel/event/generateEvents.ts",
      "src/routes/production/assets/batchGenerateAssetsImage.ts",
      "src/routes/production/workbench/batchGeneratePrompt.ts",
      "src/routes/production/storyboard/batchGenerateImage.ts",
    ];
    const missing = files.filter((rel) => {
      const text = fs.readFileSync(path.join(API_DIR, rel), "utf8");
      // 只认 schema 里那一处（`concurrentCount: … .max(8)`），注释里的说明不算
      return !/concurrentCount:\s*[^,\n]*\.max\(8\)/.test(text);
    });
    expect(missing, `这些入口的 concurrentCount 没有 .max(8)：${missing.join(", ")}`).toEqual([]);
  });
});

describe("withVendorSlot（包住一次厂商调用）", () => {
  it("★ 正常路径：拿到槽位 → 跑回调 → 归还（池子清空）", async () => {
    const { db, gate } = await setup();
    let ran = 0;
    const out = await withVendorSlot("vendor:image", "w1", async () => {
      ran += 1;
      expect(await gate.counts()).toEqual({ "vendor:image": 1 }); // 回调执行期间**确实持有**槽位
      return "ok";
    }, { gate });
    expect(out).toBe("ok");
    expect(ran).toBe(1);
    expect(await gate.counts()).toEqual({}); // 归还了
    await db.destroy();
  });

  it("★ 回调抛错也必须归还槽位（finally 释放）", async () => {
    const { db, gate } = await setup();
    await expect(
      withVendorSlot("vendor:image", "w1", async () => {
        throw new Error("厂商 500");
      }, { gate }),
    ).rejects.toThrow("厂商 500");
    expect(await gate.counts()).toEqual({}); // 抛错后槽位不泄漏
    await db.destroy();
  });

  it("★ 池满且等待超时 → 抛错（不是无限等）", async () => {
    const { db, gate } = await setup();
    const held = await gate.acquire("default", "other");
    expect(held).not.toBeNull();
    await expect(withVendorSlot("default", "w1", async () => "never", { gate, waitMs: 80 })).rejects.toThrow(/池等待超时/);
    expect(await gate.counts()).toEqual({ default: 1 }); // 只留下既有的那个持有者
    await db.destroy();
  });
});
