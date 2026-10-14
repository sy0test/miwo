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
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { createGate, withVendorSlot, type Gate } from "@/jobs/gate";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-gate-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
