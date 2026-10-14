/**
 * Task 9 / T1–T3：**对抗性隔离套件**（20 张租户表 × 读/改/删 × 用户 A/B）。
 *
 * T2 fail-closed：无 ctx 访问租户表 → 抛；未声明策略的表 → 抛（不是"查不到"）。
 * T1 跨租户：A 的凭证去读/改/删 B 的行 → 读空、改删 0 行、B 的行不变；**同时**自己的行读得到
 *            （后半条是**防假绿**的正向对照：守卫如果把所有行都挡了，前半条也会"通过"）。
 * T3 策略自动填写：insert 自动填 `userId`；显式写别人的 `userId` → 抛；不带 where 的 update/del 只影响自己。
 *
 * ⚠ 全程在 `%TEMP%` 一次性库上（`runMigrations` 建表），**不碰** `apps/api/data/db2.sqlite`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { PolicyNotFoundError } from "@/db/policies";
import { makeTenantAware } from "@/db/tenant-guard";
import { TenantContextError, type TenantCtx } from "@/db/tenant-context";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-isolation-"));
const A: TenantCtx = { userId: 7, role: "user", requestId: "a", source: "http" };
const B: TenantCtx = { userId: 8, role: "user", requestId: "b", source: "http" };

let knex: any;
let dbA: any;
let ctx: TenantCtx | undefined = { ...A };

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

/** 20 张租户表的最小夹具：A 一行（userId=7）、B 一行（userId=8）。`key` 用于定位行。 */
const FIXTURES: Array<{ table: string; a: Record<string, any>; b: Record<string, any>; key: string[] }> = [
  { table: "o_project", a: { id: 1001, userId: 7, name: "A" }, b: { id: 2001, userId: 8, name: "B" }, key: ["id"] },
  { table: "o_tasks", a: { id: 1002, userId: 7, projectId: 1001, state: "进行中" }, b: { id: 2002, userId: 8, projectId: 2001, state: "进行中" }, key: ["id"] },
  { table: "o_novel", a: { id: 1003, userId: 7, projectId: 1001 }, b: { id: 2003, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_event", a: { id: 1004, userId: 7, name: "A" }, b: { id: 2004, userId: 8, name: "B" }, key: ["id"] },
  { table: "o_eventChapter", a: { id: 1005, userId: 7, eventId: 1004, novelId: 1003 }, b: { id: 2005, userId: 8, eventId: 2004, novelId: 2003 }, key: ["id"] },
  { table: "o_script", a: { id: 1006, userId: 7, projectId: 1001 }, b: { id: 2006, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_assets", a: { id: 1007, userId: 7, projectId: 1001 }, b: { id: 2007, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_image", a: { id: 1008, userId: 7, assetsId: 1007 }, b: { id: 2008, userId: 8, assetsId: 2007 }, key: ["id"] },
  { table: "o_storyboard", a: { id: 1009, userId: 7, projectId: 1001 }, b: { id: 2009, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_agentWorkData", a: { id: 1010, userId: 7, projectId: 1001, episodesId: 1, key: "k" }, b: { id: 2010, userId: 8, projectId: 2001, episodesId: 1, key: "k" }, key: ["id"] },
  { table: "o_video", a: { id: 1011, userId: 7, projectId: 1001 }, b: { id: 2011, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_videoTrack", a: { id: 1012, userId: 7, projectId: 1001 }, b: { id: 2012, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_imageFlow", a: { id: 1013, userId: 7, flowData: "{}" }, b: { id: 2013, userId: 8, flowData: "{}" }, key: ["id"] },
  { table: "o_shot", a: { id: 1014, userId: 7, projectId: 1001 }, b: { id: 2014, userId: 8, projectId: 2001 }, key: ["id"] },
  { table: "o_shotAssets", a: { shotId: 1014, assetId: 1007, userId: 7 }, b: { shotId: 2014, assetId: 2007, userId: 8 }, key: ["shotId", "assetId"] },
  { table: "o_segment", a: { id: 1016, userId: 7, projectId: 1001, scriptId: 1006, segmentIndex: 1 }, b: { id: 2016, userId: 8, projectId: 2001, scriptId: 2006, segmentIndex: 1 }, key: ["id"] },
  { table: "o_assets2Storyboard", a: { storyboardId: 1009, assetId: 1007, userId: 7 }, b: { storyboardId: 2009, assetId: 2007, userId: 8 }, key: ["storyboardId", "assetId"] },
  { table: "o_scriptAssets", a: { scriptId: 1006, assetId: 1007, userId: 7 }, b: { scriptId: 2006, assetId: 2007, userId: 8 }, key: ["scriptId", "assetId"] },
  { table: "o_assetsRole2Audio", a: { assetsAudioId: 1007, assetsRoleId: 1015, userId: 7 }, b: { assetsAudioId: 2007, assetsRoleId: 2015, userId: 8 }, key: ["assetsAudioId", "assetsRoleId"] },
  { table: "memories", a: { id: "ma", userId: 7, isolationKey: "7:1001:scriptAgent", type: "message", content: "a", createTime: 1 }, b: { id: "mb", userId: 8, isolationKey: "8:2001:scriptAgent", type: "message", content: "b", createTime: 1 }, key: ["id"] },
];

const whereOf = (row: Record<string, any>, key: string[]) => Object.fromEntries(key.map((k) => [k, row[k]]));

beforeAll(async () => {
  knex = createKnex(cfg(path.join(TMP, "isolation.sqlite")));
  await runMigrations(knex);
  for (const f of FIXTURES) await knex(f.table).insert([f.a, f.b]);
  dbA = makeTenantAware(knex, { getCtx: () => ctx });
  // 前置（防假绿）：夹具真的进去了 —— 20 张表每张都恰好 2 行
  for (const f of FIXTURES) {
    const n = Number(((await knex(f.table).count({ n: "*" }).first()) as any)?.n ?? 0);
    if (n !== 2) throw new Error(`夹具写入不完整：${f.table} 应有 2 行，实际 ${n}`);
  }
});

afterAll(async () => {
  if (knex) await knex.destroy();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("T2 fail-closed（spec §12.2 T2）", () => {
  it("没有 ctx → 访问任何租户表都抛 TenantContextError；平台表读放行", async () => {
    ctx = undefined;
    for (const f of FIXTURES) expect(() => dbA(f.table), `${f.table} 无 ctx 必须抛`).toThrow(TenantContextError);
    expect(await dbA("o_setting").select("key")).toBeInstanceOf(Array);
    ctx = { ...A };
  });

  it("未声明策略的表 → PolicyNotFoundError（不是「查不到」，是「直接报错」）", () => {
    ctx = { ...A };
    expect(() => dbA("o_table_that_does_not_exist")).toThrow(PolicyNotFoundError);
  });
});

describe("T1 每张租户表 × 读/改/删：A 的凭证动 B 的对象（spec §12.2 T1）", () => {
  for (const f of FIXTURES) {
    it(`${f.table}：读 B 的行 → 空；改/删 B 的行 → 0 行且 B 的数据不变；自己的行读得到`, async () => {
      ctx = { ...A };
      expect(await dbA(f.table).where(whereOf(f.b, f.key)).first(), "跨租户读必须查不到").toBeUndefined();
      expect(await dbA(f.table).where(whereOf(f.b, f.key)).update({ ...f.b, userId: 7 }), "跨租户 update 必须 0 行").toBe(0);
      expect(await dbA(f.table).where(whereOf(f.b, f.key)).delete(), "跨租户 delete 必须 0 行").toBe(0);
      const still: any = await knex(f.table).where(whereOf(f.b, f.key)).first();
      expect(still, "B 的行必须还在").toBeTruthy();
      expect(Number(still.userId), "B 的行 userId 不得被改").toBe(8);
      // ★ 正向对照：把自己的行也挡住 = 假绿
      expect(await dbA(f.table).where(whereOf(f.a, f.key)).first(), "自己的行必须读得到").toBeTruthy();
    });
  }
});

describe("T3 策略自动填写（spec §12.2 T3）", () => {
  it("非管理员写任意租户表 → userId 被填成 ctx；显式写他人 → 抛错（执行期 fail-closed）", async () => {
    ctx = { ...A };
    await dbA("o_tasks").insert({ id: 9990, projectId: 1001, state: "新" });
    expect(Number((await knex("o_tasks").where("id", 9990).first()).userId)).toBe(7);
    // ⚠ 越权 insert 的抛错发生在**执行期**（守卫在 thenable 上做执行前复核，与"同一段 SQL 先审后跑"的设计一致）
    //   ⇒ 必须 `await expect(...).rejects`，用 `expect(() => builder).toThrow` 会变成**未处理的 rejection**（实测）。
    await expect(dbA("o_tasks").insert({ id: 9991, projectId: 2001, userId: 8, state: "新" })).rejects.toThrow(/显式写了别人/);
    expect(await knex("o_tasks").where("id", 9991).first(), "越权行不得落库").toBeUndefined();
  });

  it("不带 where 的 update/delete 也只影响自己的行", async () => {
    ctx = { ...A };
    expect(await dbA("o_tasks").update({ state: "全部" })).toBeGreaterThan(0);
    expect((await knex("o_tasks").where("id", 2002).first()).state, "B 的行不得被动").toBe("进行中");
    expect(await dbA("o_tasks").where("id", 2002).delete()).toBe(0);
    expect(await knex("o_tasks").where("id", 2002).first()).toBeTruthy();
    expect((await knex("o_tasks").where("id", 1002).first()).userId).toBe(7);
    void B;
  });
});
