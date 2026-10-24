/**
 * 转绘状态机（M2-T5）：
 *   ① migration 016 的两列 + 回填（extractState=3 → redrawState=1）+ down；
 *   ② 状态转移白名单（越级/回退都要拦）；
 *   ③ `getEpisodeState` 一次拿齐前端要的字段；
 *   ④ `writeRedrawStage` 的阶段/进度只前不后。
 *
 * 全部用**真 SQLite**（`createKnex` 指向临时文件），不连 MySQL、不起服务。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { MIGRATIONS, makeMigrationSource, rollbackMigrations } from "@/db/migrations";
import migration016 from "@/db/migrations/016_redraw_pipeline";
import {
  REDRAW_STATE,
  RedrawStateError,
  assertRedrawTransition,
  canRedrawTransition,
  getEpisodeState,
  readRedrawState,
  readRedrawStage,
  transitionRedrawState,
  writeRedrawStage,
} from "@/redraw/state";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-redraw-state-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const opened: Knex[] = [];
afterAll(async () => {
  for (const db of opened) await db.destroy().catch(() => {});
});

function freshDb(): Knex {
  const cfg = {
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir: TMP,
    mediaDir: path.join(TMP, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: "x".repeat(48),
    db: { driver: "sqlite", file: path.join(TMP, `s${++seq}.sqlite`) },
  } as MiwoConfig;
  const db = createKnex(cfg);
  opened.push(db);
  return db;
}

/** 迁到 015（016 之前的基线）—— 用来在"升级前"造旧数据，再单独跑 016。 */
async function migrateTo015(db: Knex): Promise<void> {
  const before = MIGRATIONS.filter((m) => m.name !== "016_redraw_pipeline");
  await db.migrate.latest({ migrationSource: makeMigrationSource(before) });
}

async function fullMigrate(db: Knex): Promise<void> {
  await db.migrate.latest({ migrationSource: makeMigrationSource(MIGRATIONS) });
}

describe("migration 016_redraw_pipeline", () => {
  it("up 加两列；down 删两列；往返可逆", async () => {
    const db = freshDb();
    await migrateTo015(db);
    expect(await db.schema.hasColumn("o_script", "redrawState")).toBe(false);
    expect(await db.schema.hasColumn("o_project", "redrawMaxSegmentSec")).toBe(false);

    await migration016.up(db);
    expect(await db.schema.hasColumn("o_script", "redrawState")).toBe(true);
    expect(await db.schema.hasColumn("o_project", "redrawMaxSegmentSec")).toBe(true);

    await migration016.down(db);
    expect(await db.schema.hasColumn("o_script", "redrawState")).toBe(false);
    expect(await db.schema.hasColumn("o_project", "redrawMaxSegmentSec")).toBe(false);
  });

  it("新建的项目/脚本拿到缺省值：redrawMaxSegmentSec=15、redrawState=0", async () => {
    const db = freshDb();
    await fullMigrate(db);
    await db("o_project").insert({ id: 1001, name: "新项目", projectType: "redraw" });
    await db("o_script").insert({ id: 11, projectId: 1001, name: "第1集" });
    const p = await db("o_project").where("id", 1001).first();
    const s = await db("o_script").where("id", 11).first();
    expect(Number(p.redrawMaxSegmentSec)).toBe(15);
    expect(Number(s.redrawState)).toBe(0);
  });

  it("★ 回填：extractState=3（旧「待对账」）→ redrawState=1；其它 extractState 不动", async () => {
    const db = freshDb();
    await migrateTo015(db);
    // 016 之前插的行（列还不存在）：先插再升级，才是"旧数据"
    await db("o_project").insert({ id: 2002, name: "老项目", projectType: "redraw" });
    await db("o_script").insert([
      { id: 21, projectId: 2002, name: "待对账", extractState: 3 },
      { id: 22, projectId: 2002, name: "解析中", extractState: 0 },
      { id: 23, projectId: 2002, name: "已成功", extractState: 1 },
      { id: 24, projectId: 2002, name: "失败", extractState: -1 },
    ]);

    await migration016.up(db);

    const rows = await db("o_script").where("projectId", 2002).orderBy("id");
    const byId = new Map(rows.map((r: any) => [Number(r.id), Number(r.redrawState)]));
    expect(byId.get(21)).toBe(1); // 旧的「待对账」= 已解析待认账
    // ⚠ 同时把 extractState 3 → 1（spec §4.2：extractState 只保留 0/1/2/-1，转绘不再写 3）
    expect(Number((await db("o_script").where("id", 21).first()).extractState)).toBe(1);
    expect(Number((await db("o_script").where("id", 23).first()).extractState)).toBe(1); // 本来就是 1 的保持不变
    expect(byId.get(22)).toBe(0);
    expect(byId.get(23)).toBe(0);
    expect(byId.get(24)).toBe(0);
    // 老项目也拿到缺省 15（ALTER 的 default 对既有行走 SQLite/MySQL 都成立）
    const p = await db("o_project").where("id", 2002).first();
    expect(Number(p.redrawMaxSegmentSec)).toBe(15);
  });

  it("回填幂等：重复 up 不会把已推进的状态退回 1", async () => {
    const db = freshDb();
    await migrateTo015(db);
    await db("o_project").insert({ id: 3003, name: "p" });
    await db("o_script").insert({ id: 31, projectId: 3003, name: "x", extractState: 3 });
    await migration016.up(db);
    await db("o_script").where("id", 31).update({ redrawState: 4 }); // 用户已确认覆盖
    await migration016.up(db); // 手工重跑（加列有 hasColumn 守卫、回填只动 0）
    expect(Number((await db("o_script").where("id", 31).first()).redrawState)).toBe(4);
    // 清单末尾也必须是 016（migrations.test.ts 另有全清单断言）
    expect(MIGRATIONS[MIGRATIONS.length - 1].name).toBe("016_redraw_pipeline");
  });

  it("★ G3 部署行：按 key insert-if-absent，老库已有同 key 行时不动它", async () => {
    const db = freshDb();
    await migrateTo015(db);
    // ⚠ seed ndjson 在 M2 已补了这两个 key（002 新库会直接种下）⇒ 先删掉那一行，才能模拟
    //   "老库（没有这一行）由 016 补" 与 "老库里运营已手工配过同 key 行"（不被覆盖）。
    await db("o_agentDeploy").where("key", "redrawAgent:reconcileAgent").del();
    await db("o_agentDeploy").where("key", "redrawAgent:storyboardAgent").del();
    await db("o_agentDeploy").insert({
      key: "redrawAgent:reconcileAgent",
      modelName: "ops:custom-model",
      model: "custom-model",
      vendorId: "ops",
      name: "运营自己配的",
      desc: "keep me",
      temperature: 1,
      maxOutputTokens: 0,
      disabled: 0,
    });
    await migration016.up(db);

    const rows = await db("o_agentDeploy").whereIn("key", ["redrawAgent:reconcileAgent", "redrawAgent:storyboardAgent"]);
    expect(rows.length).toBe(2); // 各一行（没有因重复执行插出第二行）
    const reconcile = rows.find((r: any) => r.key === "redrawAgent:reconcileAgent");
    expect(reconcile.modelName).toBe("ops:custom-model"); // 已有行不被覆盖
    const storyboard = rows.find((r: any) => r.key === "redrawAgent:storyboardAgent");
    expect(storyboard.modelName).toBe("newapi:gpt-6.1-sol");
    expect(storyboard.name).toBe("转绘Agent:分镜");

    // down：本迁移补的部署行一起删掉
    await migration016.down(db);
    expect(await db("o_agentDeploy").where("key", "redrawAgent:storyboardAgent").first()).toBeUndefined();
    expect(await db("o_agentDeploy").where("key", "redrawAgent:reconcileAgent").first()).toBeUndefined();
  });

  it("迁移清单跑完后 knex_migrations 含 016（确保真的被登记执行）", async () => {
    const db = freshDb();
    await fullMigrate(db);
    const names = (await db("knex_migrations").select("name")).map((r: any) => r.name);
    expect(names).toContain("016_redraw_pipeline");
    // 全量回滚也不报错（down 与 up 对称）
    const [, rolled] = await rollbackMigrations(db, true);
    expect(rolled).toContain("016_redraw_pipeline");
  });
});

describe("状态转移白名单", () => {
  it("正向链 0→1→2→3→4 每一步都允许", () => {
    expect(canRedrawTransition(0, 1)).toBe(true);
    expect(canRedrawTransition(1, 2)).toBe(true);
    expect(canRedrawTransition(2, 3)).toBe(true);
    expect(canRedrawTransition(3, 4)).toBe(true);
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 4]]) assertRedrawTransition(a, b);
  });

  it("越级一律拒绝（0→4 / 1→3 / 2→4）—— 每个确认点都是用户拍板的记录", () => {
    for (const [a, b] of [[0, 4], [1, 3], [2, 4], [0, 2], [1, 4]]) {
      expect(canRedrawTransition(a, b), `${a}→${b} 不应允许`).toBe(false);
      expect(() => assertRedrawTransition(a, b)).toThrow(RedrawStateError);
    }
  });

  it("任意状态可失败；失败后可回 0/1 重试；重复写同态幂等", () => {
    for (const from of [0, 1, 2, 3, 4, -1]) {
      expect(canRedrawTransition(from, REDRAW_STATE.FAILED)).toBe(true);
      expect(canRedrawTransition(from, from)).toBe(true);
    }
    expect(canRedrawTransition(-1, 0)).toBe(true);
    expect(canRedrawTransition(-1, 1)).toBe(true);
    expect(canRedrawTransition(-1, 2)).toBe(false);
  });

  it("重跑/回退：2/3/4 可回 1；3/4 可回 3；3/4 可回 2（回退到源片版）；其它回退拒绝", () => {
    for (const from of [2, 3, 4]) expect(canRedrawTransition(from, 1)).toBe(true);
    expect(canRedrawTransition(3, 3)).toBe(true);
    expect(canRedrawTransition(4, 3)).toBe(true);
    expect(canRedrawTransition(4, 1)).toBe(true);
    // spec §4.2 的新转移表：3/4 → 2 = 用户「回退到源片版」（转绘分镜作废、资产仍算确认）
    expect(canRedrawTransition(4, 2)).toBe(true);
    expect(canRedrawTransition(3, 2)).toBe(true);
    expect(canRedrawTransition(2, 2)).toBe(true);
    expect(canRedrawTransition(2, 0)).toBe(false);
  });

  it("非法值（字符串 / 5 / null）不猜，一律拒绝", () => {
    expect(canRedrawTransition("1", 2)).toBe(false);
    expect(canRedrawTransition(1, 5)).toBe(false);
    expect(() => assertRedrawTransition(9, 1)).toThrow(RedrawStateError);
    expect(() => assertRedrawTransition(1, "2")).toThrow(RedrawStateError);
  });
});

describe("transitionRedrawState（唯一写入口）", () => {
  it("写状态 + 失败写 errorReason；非法转移抛错且不改库", async () => {
    const db = freshDb();
    await fullMigrate(db);
    await db("o_project").insert({ id: 4004, name: "p", projectType: "redraw" });
    await db("o_script").insert([
      { id: 41, projectId: 4004, name: "x", extractState: 1, redrawState: 0 },
      { id: 42, projectId: 4004, name: "y", extractState: 1, redrawState: 0 },
    ]);

    await transitionRedrawState(db, { projectId: 4004, scriptId: 41, to: REDRAW_STATE.PARSED });
    expect(await readRedrawState(db, { projectId: 4004, scriptId: 41 })).toBe(1);

    await transitionRedrawState(db, { projectId: 4004, scriptId: 41, to: REDRAW_STATE.FAILED, errorReason: "ASR 没有词级时间戳" });
    const failed = await db("o_script").where("id", 41).first();
    expect(Number(failed.redrawState)).toBe(-1);
    expect(failed.errorReason).toBe("ASR 没有词级时间戳");

    // 非法转移（0 → 4）：抛错，库里仍是 0
    await expect(transitionRedrawState(db, { projectId: 4004, scriptId: 42, to: REDRAW_STATE.CONFIRMED })).rejects.toThrow(RedrawStateError);
    expect(Number((await db("o_script").where("id", 42).first()).redrawState)).toBe(0);

    // 跨项目：别的项目下的同一 scriptId 查不到 → 抛错（不静默成功）
    await expect(transitionRedrawState(db, { projectId: 9999, scriptId: 42, to: REDRAW_STATE.PARSED })).rejects.toThrow(/没有这一集/);
  });

  it("成功写入时保留旧 errorReason（除非显式清空）", async () => {
    const db = freshDb();
    await fullMigrate(db);
    await db("o_project").insert({ id: 5005, name: "p" });
    await db("o_script").insert({ id: 51, projectId: 5005, name: "x", extractState: 1, redrawState: 0, errorReason: "上一次的失败" });
    await transitionRedrawState(db, { projectId: 5005, scriptId: 51, to: REDRAW_STATE.PARSED });
    expect((await db("o_script").where("id", 51).first()).errorReason).toBe("上一次的失败");
    await transitionRedrawState(db, { projectId: 5005, scriptId: 51, to: REDRAW_STATE.PARSED, errorReason: null });
    expect((await db("o_script").where("id", 51).first()).errorReason).toBeNull();
  });
});

describe("redrawStage（阶段/进度只前不后）", () => {
  it("阶段前进；同阶段进度只增；阶段后退被忽略；未知阶段名直接写", async () => {
    const db = freshDb();
    await fullMigrate(db);
    await db("o_project").insert({ id: 6006, name: "p" });
    await db("o_script").insert({ id: 61, projectId: 6006, name: "x" });

    expect(await readRedrawStage(db, { projectId: 6006, scriptId: 61 })).toBeNull();

    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "cut", progress: 40 });
    expect(await readRedrawStage(db, { projectId: 6006, scriptId: 61 })).toMatchObject({ stage: "cut", progress: 40 });

    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "cut", progress: 10 }); // 进度回退 → 保留 40
    expect((await readRedrawStage(db, { projectId: 6006, scriptId: 61 }))!.progress).toBe(40);

    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "transcribe" });
    expect((await readRedrawStage(db, { projectId: 6006, scriptId: 61 }))!.stage).toBe("transcribe");

    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "cut", progress: 90 }); // 阶段后退 → 忽略
    expect((await readRedrawStage(db, { projectId: 6006, scriptId: 61 }))!.stage).toBe("transcribe");

    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "analysis", progress: 100 });
    expect(await readRedrawStage(db, { projectId: 6006, scriptId: 61 })).toMatchObject({ stage: "analysis", progress: 100 });

    // 未知阶段名（技能/前端改了措辞）：不拿旧值挡住新的
    await writeRedrawStage(db, { projectId: 6006, scriptId: 61, stage: "whatever", progress: 5 });
    expect((await readRedrawStage(db, { projectId: 6006, scriptId: 61 }))!.stage).toBe("whatever");
  });
});

describe("getEpisodeState", () => {
  it("一次拿齐：状态/阶段/段数/clip/资产/上限；跨项目返回 null", async () => {
    const db = freshDb();
    await fullMigrate(db);
    await db("o_project").insert([
      { id: 7007, name: "转绘项目", projectType: "redraw", targetCountry: "美国", redrawMaxSegmentSec: 30 },
      { id: 7008, name: "普通项目", projectType: "normal" },
    ]);
    await db("o_script").insert([
      { id: 71, projectId: 7007, name: "第1集", extractState: 1, redrawState: 1, sourceVideo: "/7007/source/a.mp4" },
      { id: 72, projectId: 7007, name: "第2集", extractState: 0 },
    ]);
    await db("o_segment").insert([
      { id: 701, projectId: 7007, scriptId: 71, segmentIndex: 1, manual: 0, clipPath: "/x/seg-1.mp4" },
      { id: 702, projectId: 7007, scriptId: 71, segmentIndex: 2, manual: 0, clipPath: null },
      { id: 703, projectId: 7007, scriptId: 71, segmentIndex: 3, manual: 0 },
    ]);
    await db("o_shot").insert([
      { id: 801, projectId: 7007, scriptId: 71, segmentId: 701, segmentIndex: 1, shotIndex: 1 },
      { id: 802, projectId: 7007, scriptId: 71, segmentId: 701, segmentIndex: 1, shotIndex: 2 },
    ]);
    await db("o_scriptAssets").insert([{ scriptId: 71, assetId: 11 }, { scriptId: 71, assetId: 12 }]);
    await db("o_agentWorkData").insert([
      { id: 901, projectId: 7007, episodesId: 71, key: "redrawAssetDraft", data: JSON.stringify({ assets: [{ name: "A" }, { name: "B" }, { name: "C" }] }) },
      { id: 902, projectId: 7007, episodesId: 71, key: "redrawAssetBindings", data: JSON.stringify({ A: 11 }) },
    ]);
    await writeRedrawStage(db, { projectId: 7007, scriptId: 72, stage: "cut", progress: 20 });

    const s1 = await getEpisodeState(db, { projectId: 7007, scriptId: 71 });
    // 字段名是**前端契约**（联调定稿）：assetTotal / segmentCap / capConfirmed，不要改
    expect(s1).toEqual({
      extractState: 1,
      redrawState: 1,
      stage: null,
      progress: null,
      segmentCount: 3,
      assetTotal: 3,
      assetsConfirmed: 2,
      clipsReady: 1,
      segmentCap: 30,
      capConfirmed: false,
      job: null,
    });

    // 同一项目的另一集：上限跟项目走（7007 显式设了 30）
    const s2 = await getEpisodeState(db, { projectId: 7007, scriptId: 72 });
    expect(s2).toMatchObject({ extractState: 0, redrawState: 0, stage: "cut", progress: 20, segmentCount: 0, segmentCap: 30 });

    // 没显式设置上限的项目：读迁移的缺省 15
    await db("o_script").insert({ id: 73, projectId: 7008, name: "普通集" });
    expect((await getEpisodeState(db, { projectId: 7008, scriptId: 73 }))!.segmentCap).toBe(15);

    // 跨项目 / 不存在的集：null（路由翻 400，绝不返回别人的）
    expect(await getEpisodeState(db, { projectId: 7008, scriptId: 71 })).toBeNull();
    expect(await getEpisodeState(db, { projectId: 7007, scriptId: 9999 })).toBeNull();
    expect(await getEpisodeState(db, { projectId: 9999, scriptId: 71 })).toBeNull();
  });
});