/**
 * 进度 relay 的回归网（Phase 1d Task 8 / spec §9.2 + §9.3）。
 *
 * worker 是**独立进程**、没有 socket.io 服务端 ⇒ 事件只能走"worker 写库 + api 侧游标轮询"。
 * 本文件把这条链路的 5 条不变式钉死：
 *  1. 首次 tick 推既有行到 `user:{id}`（room 名是契约）；**同一状态不重复推**（心跳只改 updatedAt，
 *     不该造成事件风暴）；
 *  2. ★ 载荷是**白名单**：不含 `payload`/`lastError` 原文（判别力：故意插一条含密文的 lastError）；
 *  3. ★ **复合游标 (updatedAt,id)**：同一毫秒的两行都不能漏（`batch=1` 逼出边界）；
 *  4. 进度/状态变化再次推送；**终态也推**（前端要知道失败）；
 *  5. `userId` 为 NULL 的平台任务**不推给任何 room**。
 *
 * ⚠ 用的是 `%TEMP%` 下的一次性库（`createKnex` + `runMigrations`），**不碰** dev 库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { startProgressRelay, type RelayEvent } from "@/jobs/progressRelay";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-relay-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

function recorder() {
  const seen: Array<{ room: string; event: string; payload: RelayEvent }> = [];
  return { seen, io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => seen.push({ room, event, payload: payload as RelayEvent }) }) } };
}

async function insertJob(db: Knex, over: Record<string, unknown> = {}) {
  const ts = (over.updatedAt as number) ?? Date.now();
  const [id] = await db("o_job").insert({
    userId: 4242, type: "video.generate", payload: '{"videoId":1}', state: "queued", attempts: 0, maxAttempts: 1,
    priority: 100, progress: 0, createdAt: ts, updatedAt: ts, ...over,
  });
  return Number(id);
}

describe("进度 relay（spec §9.2 + §9.3）", () => {
  it("首次 tick 把既有行推给 `user:{id}` room；再次 tick 不重复推同一状态", async () => {
    const db = createKnex(cfg(path.join(TMP, "r1.sqlite")));
    await runMigrations(db);
    await insertJob(db);
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    expect(await relay.tick()).toBe(1);
    expect(rec.seen.length).toBe(1);
    expect(rec.seen[0].room).toBe("user:4242");
    expect(rec.seen[0].event).toBe("job:update");
    expect(await relay.tick()).toBe(0); // 状态没变 → 不推（心跳只改 updatedAt 不该造成事件风暴）
    relay.stop();
    await db.destroy();
  });

  /**
   * ★ 载荷白名单（判别力：故意往 **payload 列**插一段"密文"，再断言它**绝不出现**在事件里）。
   *
   * ⚠ [1d-14 规范] 门槛写清：`lastError` **不是**密文 —— 它正是"前端要知道失败原因"要用的那段文案，
   *   所以 `error` 字段**必须**带上它（只截断到 200 字符）。brief 原稿把"含密文的 lastError"
   *   与"载荷白名单"混在一条用例里，自相矛盾（`error` 若带上 lastError，那一行必然为红）。
   *   这里按实际语义拆成两条：本篇 = payload 绝不外泄；下篇 = lastError 截断到 200。
   */
  it("★ 事件载荷是白名单：payload 原文（含密文）绝不外泄", async () => {
    const db = createKnex(cfg(path.join(TMP, "r2.sqlite")));
    await runMigrations(db);
    await insertJob(db, { payload: '{"videoId":1,"secret":"SECRET-PAYLOAD-TOKEN"}' });
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    expect(await relay.tick()).toBe(1);
    const keys = Object.keys(rec.seen[0].payload).sort();
    expect(keys).toEqual(["id", "progress", "stage", "state", "type"]);
    expect(JSON.stringify(rec.seen)).not.toContain("SECRET-PAYLOAD-TOKEN");
    // ⚠ 不写 `not.toContain('"payload"')`：记录器自身字段名就叫 `payload`（brief 原稿那句是笔误，
    //   把"内部记录结构"当成了"外发事件"）。真正要断言的是**外发对象**的键集合，上面一行已覆盖。
    relay.stop();
    await db.destroy();
  });

  it("★ lastError 只截断到 200 字符（不把内部长栈整段推给前端）", async () => {
    const db = createKnex(cfg(path.join(TMP, "r2b.sqlite")));
    await runMigrations(db);
    await insertJob(db, { lastError: "E".repeat(500) });
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    await relay.tick();
    expect(rec.seen[0].payload.error?.length).toBe(200);
    expect(Object.keys(rec.seen[0].payload).sort()).toEqual(["error", "id", "progress", "stage", "state", "type"]);
    relay.stop();
    await db.destroy();
  });

  it("★ 复合游标 (updatedAt,id)：同一毫秒的两行都不会漏（batch=1 逼出边界）", async () => {
    const db = createKnex(cfg(path.join(TMP, "r3.sqlite")));
    await runMigrations(db);
    const ts = 1_700_000_000_000;
    await insertJob(db, { updatedAt: ts, dedupeActive: "a" });
    await insertJob(db, { updatedAt: ts, dedupeActive: "b" });
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000, batch: 1 });
    await relay.tick();
    await relay.tick();
    const ids = rec.seen.map((s) => s.payload.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    relay.stop();
    await db.destroy();
  });

  it("进度/状态变化会再次推送；终态也推（前端要知道失败）", async () => {
    const db = createKnex(cfg(path.join(TMP, "r4.sqlite")));
    await runMigrations(db);
    const id = await insertJob(db);
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    await relay.tick();
    await db("o_job").where("id", id).update({ state: "running", progress: 40, stage: "生成视频", updatedAt: Date.now() });
    await relay.tick();
    await db("o_job").where("id", id).update({ state: "dead", lastError: "厂商 500", updatedAt: Date.now() + 5 });
    await relay.tick();
    const states = rec.seen.map((s) => s.payload.state);
    expect(states).toEqual(["queued", "running", "dead"]);
    expect(rec.seen[2].payload.error).toMatch(/厂商 500/);
    relay.stop();
    await db.destroy();
  });

  it("userId 为 NULL 的平台任务不推给任何 room", async () => {
    const db = createKnex(cfg(path.join(TMP, "r5.sqlite")));
    await runMigrations(db);
    await insertJob(db, { userId: null });
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    expect(await relay.tick()).toBe(0);
    expect(rec.seen.length).toBe(0);
    relay.stop();
    await db.destroy();
  });

  it("★ 多用户不串号：A 的事件只进 `user:A`，B 的只进 `user:B`", async () => {
    const db = createKnex(cfg(path.join(TMP, "r6.sqlite")));
    await runMigrations(db);
    await insertJob(db, { userId: 77, updatedAt: 1_700_000_000_100 });
    await insertJob(db, { userId: 88, updatedAt: 1_700_000_000_200 });
    const rec = recorder();
    const relay = startProgressRelay({ db, io: rec.io, pollMs: 10_000 });
    expect(await relay.tick()).toBe(2);
    const byRoom = new Map(rec.seen.map((s) => [s.room, s.payload.id]));
    expect(byRoom.size).toBe(2);
    // 两条事件分别落在两个不同 room，且都只出现一次（串号会让某个 room 拿到两条）
    expect(rec.seen.filter((s) => s.room === "user:77").length).toBe(1);
    expect(rec.seen.filter((s) => s.room === "user:88").length).toBe(1);
    relay.stop();
    await db.destroy();
  });
});
