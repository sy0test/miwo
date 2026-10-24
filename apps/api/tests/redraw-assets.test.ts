/**
 * 资产认账层（M2-T6）+ 单段上限（M2-T11 的后端部分）的测试。
 *
 * 真 SQLite（全量迁移）+ 裸 knex；不连 MySQL、不起服务。
 * 钉住的判据：
 *  · 草稿状态机 pending → bound/created → confirmed；
 *  · 复用已有资产**只补空、不覆盖**；新建资产写类型列 + scriptId；
 *  · 跨项目资产一律拒绝；没处理的草稿确认时**报错并点名**；重复确认幂等；
 *  · 确认成功后 redrawState=2（事务内），getEpisodeState 的 assetTotal/assetsConfirmed/clipsReady 正确；
 *  · 单段上限 4..30；改值不带 force ⇒ needRerun 且不写库；带 force ⇒ 写库 + 审计。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource, MIGRATIONS } from "@/db/migrations";
import {
  AssetReconcileError,
  bindDraft,
  confirmAssets,
  createAsset,
  getDrafts,
  readPlan,
  updateAsset,
} from "@/redraw/assets";
import { SegmentCapError, confirmSegmentCap, normalizeSegmentCap } from "@/redraw/cap";
import { getEpisodeState, readRedrawState, upsertWorkData, writeCapConfirm } from "@/redraw/state";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-redraw-assets-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let db: Knex;

const PROJECT = 9101;
const OTHER_PROJECT = 9102;
let sideSeq = 0;

beforeAll(async () => {
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, "assets.sqlite") },
  } as MiwoConfig;
  db = createKnex(cfg);
  await db.migrate.latest({ migrationSource: makeMigrationSource(MIGRATIONS) });
  await db("o_project").insert([
    { id: PROJECT, name: "转绘项目", projectType: "redraw", targetCountry: "美国" },
    { id: OTHER_PROJECT, name: "别的项目", projectType: "redraw", targetCountry: "日本" },
  ]);
});

beforeEach(async () => {
  // 每个用例从"项目上限 = 15"开始（cap 用例会改库；不隔离会互相污染）
  await db("o_project").where("id", PROJECT).update({ redrawMaxSegmentSec: 15 });
});

afterAll(async () => {
  await db.destroy().catch(() => {});
});

const DRAFTS = [
  { type: "role", name: "Lucia", sourceName: "沈公子", describe: "银发少女", prompt: "silver hair girl" },
  { type: "scene", name: "Saint Hall", sourceName: "旧礼堂", describe: "哥特礼堂", prompt: "gothic hall" },
  { type: "tool", name: "Ledger", sourceName: "账本", describe: "旧账本", prompt: "old ledger" },
];

/** 造一集：解析成功状态 + 资产草稿。 */
async function newEpisode(opts: { drafts?: any[]; redrawState?: number } = {}): Promise<number> {
  sideSeq += 1;
  const [id] = await db("o_script").insert({
    name: "第" + sideSeq + "集",
    projectId: PROJECT,
    sourceVideo: "/src.mp4",
    extractState: 1,
    redrawState: opts.redrawState ?? 1,
  });
  const scriptId = Number(id);
  await upsertWorkData(db, PROJECT, scriptId, "redrawAssetDraft", { assets: opts.drafts ?? DRAFTS });
  return scriptId;
}

describe("getDrafts", () => {
  it("草稿状态 pending；已有资产按项目过滤；segments 与 segmentCap 带出", async () => {
    const scriptId = await newEpisode();
    await db("o_segment").insert([
      { projectId: PROJECT, scriptId, segmentIndex: 1, manual: 0, duration: 11, sourceRange: "0.000-11.000" },
      { projectId: PROJECT, scriptId, segmentIndex: 2, manual: 0, duration: 13.5, sourceRange: "11.000-24.500" },
    ]);
    const existingAssetId = Number(
      (await db("o_assets").insert({ projectId: PROJECT, name: "旧角色", type: "role" })).toString(),
    );
    expect(existingAssetId).toBeGreaterThan(0);
    // 不支持的资产类型不进 existing（前端只认 role/scene/tool）
    await db("o_assets").insert({ projectId: PROJECT, name: "音频", type: "audio" });

    const r = await getDrafts(db, { projectId: PROJECT, scriptId });
    expect(r.drafts.map((d) => d.state)).toEqual(["pending", "pending", "pending"]);
    expect(r.drafts[0]).toMatchObject({ name: "沈公子", targetName: "Lucia", type: "role", desc: "银发少女", prompt: "silver hair girl", gender: "" });
    expect(r.bindings).toEqual({});
    expect(r.existing.map((e) => e.name)).toEqual(["旧角色"]);
    expect(r.segments).toEqual([
      { index: 1, duration: 11, sourceRange: "0.000-11.000" },
      { index: 2, duration: 13.5, sourceRange: "11.000-24.500" },
    ]);
    expect(r.segmentCap).toBe(15);
  });
});

describe("bindDraft：复用已有资产", () => {
  it("绑定后 state=bound / bindings 落库；跨项目资产拒绝；未知草稿拒绝", async () => {
    const scriptId = await newEpisode();
    const [assetId] = await db("o_assets").insert({ projectId: PROJECT, name: "旧角色", type: "role" });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "Lucia", assetId: Number(assetId) });
    const r = await getDrafts(db, { projectId: PROJECT, scriptId });
    expect(r.bindings).toEqual({ Lucia: Number(assetId) });
    expect(r.drafts.find((d) => d.targetName === "Lucia")).toMatchObject({ state: "bound", assetId: Number(assetId) });

    // 用源片原名也能绑（前端可能传显示名）
    const [asset2] = await db("o_assets").insert({ projectId: PROJECT, name: "旧礼堂", type: "scene" });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "旧礼堂", assetId: Number(asset2) });
    expect((await readPlanAfter(scriptId)).entryCount).toBe(2);

    const [foreign] = await db("o_assets").insert({ projectId: OTHER_PROJECT, name: "别人的角色", type: "role" });
    await expect(
      bindDraft(db, { projectId: PROJECT, scriptId, draftName: "Ledger", assetId: Number(foreign) }),
    ).rejects.toThrow(/不属于该项目/);
    await expect(
      bindDraft(db, { projectId: PROJECT, scriptId, draftName: "不存在的草稿", assetId: Number(assetId) }),
    ).rejects.toThrow(/没有这条资产草稿/);
  });

  async function readPlanAfter(scriptId: number): Promise<{ entryCount: number }> {
    const plan = await readPlan(db, PROJECT, scriptId);
    return { entryCount: Object.keys(plan).length };
  }
});

describe("createAsset / updateAsset", () => {
  it("新建写 o_assets（类型列 + scriptId），state=created", async () => {
    const scriptId = await newEpisode();
    const { id } = await createAsset(db, {
      projectId: PROJECT,
      scriptId,
      draftName: "Lucia",
      name: "Lucia",
      type: "role",
      describe: "银发少女 · 修订版",
      prompt: "silver hair girl, revised",
      gender: "女",
    });
    const asset = await db("o_assets").where("id", id).first();
    expect(asset).toMatchObject({
      name: "Lucia",
      type: "role",
      describe: "银发少女 · 修订版",
      prompt: "silver hair girl, revised",
      projectId: PROJECT,
      scriptId,
    });
    const r = await getDrafts(db, { projectId: PROJECT, scriptId });
    expect(r.drafts.find((d) => d.targetName === "Lucia")).toMatchObject({ state: "created", assetId: id, gender: "女" });

    // ★ 幂等：同一 draftName 再建一次 → 409（否则双击就多一条 o_assets）
    const before = await db("o_assets").where({ projectId: PROJECT, scriptId }).count({ n: "*" }).first();
    await expect(
      createAsset(db, { projectId: PROJECT, scriptId, draftName: "Lucia", name: "Lucia2", type: "role" }),
    ).rejects.toThrow(/已经处理过/);
    const after = await db("o_assets").where({ projectId: PROJECT, scriptId }).count({ n: "*" }).first();
    expect(Number((after as any).n)).toBe(Number((before as any).n));
  });

  it("新资产允许覆盖；复用资产只补空、不覆盖用户已写的 prompt；清单外资产拒绝", async () => {
    const scriptId = await newEpisode();
    const { id: newId } = await createAsset(db, { projectId: PROJECT, scriptId, draftName: "Lucia", name: "Lucia", type: "role", describe: "x", prompt: "p1" });
    await updateAsset(db, { projectId: PROJECT, scriptId, assetId: newId, patch: { name: "Lucia V2", prompt: "p2", gender: "女" } });
    expect(await db("o_assets").where("id", newId).first()).toMatchObject({ name: "Lucia V2", prompt: "p2" });

    // 复用资产：prompt 非空 → 不覆盖；describe 为空 → 补上
    const [reuseId] = await db("o_assets").insert({ projectId: PROJECT, name: "已有场景", type: "scene", prompt: "keep me", describe: "" });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "Saint Hall", assetId: Number(reuseId) });
    await updateAsset(db, { projectId: PROJECT, scriptId, assetId: Number(reuseId), patch: { prompt: "should not overwrite", describe: "补上的说明" } });
    const reuseRow = await db("o_assets").where("id", Number(reuseId)).first();
    expect(reuseRow.prompt).toBe("keep me");
    expect(reuseRow.describe).toBe("补上的说明");

    // 清单外（别的项目 / 本集没认过的）资产 → 403
    const [unrelated] = await db("o_assets").insert({ projectId: PROJECT, name: "无关资产", type: "tool" });
    await expect(
      updateAsset(db, { projectId: PROJECT, scriptId, assetId: Number(unrelated), patch: { name: "x" } }),
    ).rejects.toThrow(/只能修改本集认账清单里的资产/);
  });
});

describe("confirmAssets：落库 + redrawState=2", () => {
  it("★ 没处理的草稿 → 报错并点名；处理完 → created/reused/linked 正确 + 幂等", async () => {
    const scriptId = await newEpisode();
    const [reuseId] = await db("o_assets").insert({ projectId: PROJECT, name: "旧礼堂", type: "scene" });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "旧礼堂", assetId: Number(reuseId) });
    await createAsset(db, { projectId: PROJECT, scriptId, draftName: "Lucia", name: "Lucia", type: "role", describe: "d", prompt: "p" });

    await expect(confirmAssets(db, { projectId: PROJECT, scriptId })).rejects.toThrow(/ledger|Ledger/);

    await createAsset(db, { projectId: PROJECT, scriptId, draftName: "Ledger", name: "Ledger", type: "tool" });
    const r1 = await confirmAssets(db, { projectId: PROJECT, scriptId });
    expect(r1).toEqual({ created: 2, reused: 1, linked: 3 });
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(2);

    const links = await db("o_scriptAssets").where("scriptId", scriptId);
    expect(links.length).toBe(3);
    // 草稿状态变 confirmed
    const view = await getDrafts(db, { projectId: PROJECT, scriptId });
    expect(view.drafts.every((d) => d.state === "confirmed")).toBe(true);

    // 幂等：再确认一次不重复建资产、不重复挂链，状态仍是 2
    const r2 = await confirmAssets(db, { projectId: PROJECT, scriptId });
    expect(r2.linked).toBe(0);
    expect(await db("o_scriptAssets").where("scriptId", scriptId)).toHaveLength(3);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(2);
  });

  it("★ 零资产集：空草稿确认**幂等成功**（{0,0,0} + redrawState=2，否则前端死锁）", async () => {
    const empty = await newEpisode({ drafts: [], redrawState: 1 });
    const r = await confirmAssets(db, { projectId: PROJECT, scriptId: empty });
    expect(r).toEqual({ created: 0, reused: 0, linked: 0 });
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId: empty })).toBe(2);
    // 再确认一次仍然成功（幂等）
    expect(await confirmAssets(db, { projectId: PROJECT, scriptId: empty })).toEqual({ created: 0, reused: 0, linked: 0 });
  });

  it("计划里的资产被删 → 报错（不留半份认账）", async () => {
    const scriptId = await newEpisode();
    const { id } = await createAsset(db, { projectId: PROJECT, scriptId, draftName: "Lucia", name: "Lucia", type: "role" });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "Saint Hall", assetId: Number((await db("o_assets").insert({ projectId: PROJECT, name: "x", type: "scene" })).toString()) });
    await bindDraft(db, { projectId: PROJECT, scriptId, draftName: "Ledger", assetId: Number((await db("o_assets").insert({ projectId: PROJECT, name: "y", type: "tool" })).toString()) });
    await db("o_assets").where("id", id).del();
    await expect(confirmAssets(db, { projectId: PROJECT, scriptId })).rejects.toThrow(/不存在/);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(1);
  });
});

describe("单段上限（confirmSegmentCap）", () => {
  it("范围 4..30；非法值抛 out_of_range", () => {
    expect(normalizeSegmentCap(15)).toBe(15);
    expect(normalizeSegmentCap(4)).toBe(4);
    expect(normalizeSegmentCap(30)).toBe(30);
    for (const bad of [3, 31, 15.5, "abc", null]) {
      expect(() => normalizeSegmentCap(bad), String(bad)).toThrow(SegmentCapError);
    }
  });

  it("★ 不改值 → 只写确认记录；改值不带 force → needRerun 且不写库；带 force → 写库 + 审计", async () => {
    const scriptId = await newEpisode({ redrawState: 2 });
    // 与当前值相同（缺省 15）
    const r1 = await confirmSegmentCap(db, { projectId: PROJECT, scriptId, seconds: 15 });
    expect(r1).toMatchObject({ ok: true, changed: false, cap: 15 });
    const state1 = await getEpisodeState(db, { projectId: PROJECT, scriptId });
    expect(state1!.capConfirmed).toBe(true);
    expect(state1!.segmentCap).toBe(15);

    // 改值不带 force
    const err = await confirmSegmentCap(db, { projectId: PROJECT, scriptId, seconds: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentCapError);
    expect(err.code).toBe("need_rerun");
    expect(Number((await db("o_project").where("id", PROJECT).first()).redrawMaxSegmentSec)).toBe(15);

    // force 写入 + 审计 from
    const r2 = await confirmSegmentCap(db, { projectId: PROJECT, scriptId, seconds: 20, force: true });
    expect(r2).toMatchObject({ ok: true, changed: true, cap: 20 });
    expect(Number((await db("o_project").where("id", PROJECT).first()).redrawMaxSegmentSec)).toBe(20);
    const audit = await db("o_agentWorkData").where({ episodesId: String(scriptId), key: "redrawCapConfirm" }).first();
    expect(JSON.parse(audit.data)).toMatchObject({ seconds: 20, forced: true, from: 15 });
    // force 写的是"新值的确认"（用户同时同意了"要重跑"），所以 capConfirmed = true
    expect((await getEpisodeState(db, { projectId: PROJECT, scriptId }))!.capConfirmed).toBe(true);
    // 还原，避免影响别的用例（同库）
    await db("o_project").where("id", PROJECT).update({ redrawMaxSegmentSec: 15 });
  });

  it("writeCapConfirm 直写（getEpisodeState 的 capConfirmed 判据）", async () => {
    const scriptId = await newEpisode({ redrawState: 2 });
    expect((await getEpisodeState(db, { projectId: PROJECT, scriptId }))!.capConfirmed).toBe(false);
    await writeCapConfirm(db, { projectId: PROJECT, scriptId, seconds: 15 });
    expect((await getEpisodeState(db, { projectId: PROJECT, scriptId }))!.capConfirmed).toBe(true);
  });
});

describe("getEpisodeState：前端契约字段", () => {
  it("assetTotal / assetsConfirmed / clipsReady / segmentCap / capConfirmed", async () => {
    const scriptId = await newEpisode({ redrawState: 2 });
    await db("o_segment").insert([
      { projectId: PROJECT, scriptId, segmentIndex: 1, manual: 0, duration: 10, clipPath: "/a/seg-1.mp4" },
      { projectId: PROJECT, scriptId, segmentIndex: 2, manual: 0, duration: 10, clipPath: null },
      { projectId: PROJECT, scriptId, segmentIndex: 3, manual: 0, duration: 10, clipPath: "" },
    ]);
    const assetId = Number((await db("o_assets").insert({ projectId: PROJECT, name: "a", type: "role" })).toString());
    await db("o_scriptAssets").insert({ scriptId, assetId });
    const state = await getEpisodeState(db, { projectId: PROJECT, scriptId });
    expect(state).toEqual({
      extractState: 1,
      redrawState: 2,
      stage: null,
      progress: null,
      segmentCount: 3,
      assetTotal: 3,
      assetsConfirmed: 1,
      clipsReady: 1,
      segmentCap: 15,
      capConfirmed: false,
    });
  });
});