/**
 * 转绘认账工具集（M2-T7）的参数校验与副作用。
 *
 * 直接用 `tool().execute` 调（不经过模型）：判据都在**工具契约层**：
 *  · 工具名固定（前端/技能引用）；
 *  · 跨项目 assetId 一律拒绝（租户守卫之上的第二道）；
 *  · confirmSegmentCap 改值必须显式 force（否则返回 needRerun 且不写库）；
 *  · 写操作会通知 socket 侧（redraw:updated 的来源）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource, MIGRATIONS } from "@/db/migrations";
import { createRedrawTools } from "@/agents/redrawAgent/tools";
import { upsertWorkData } from "@/redraw/state";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-redraw-agent-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let db: Knex;
const PROJECT = 9201;
const OTHER = 9202;
let scriptId = 0;

beforeAll(async () => {
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, "agent.sqlite") },
  } as MiwoConfig;
  db = createKnex(cfg);
  await db.migrate.latest({ migrationSource: makeMigrationSource(MIGRATIONS) });
  await db("o_project").insert([
    { id: PROJECT, name: "p", projectType: "redraw", targetCountry: "美国" },
    { id: OTHER, name: "other", projectType: "redraw" },
  ]);
  const [id] = await db("o_script").insert({ name: "第1集", projectId: PROJECT, content: "旧剧本", extractState: 1, redrawState: 1, sourceVideo: "/a.mp4" });
  scriptId = Number(id);
  await upsertWorkData(db, PROJECT, scriptId, "redrawAssetDraft", {
    assets: [
      { type: "role", name: "Lucia", sourceName: "沈公子", describe: "d", prompt: "p" },
      { type: "scene", name: "Hall", sourceName: "礼堂", describe: "d", prompt: "p" },
    ],
  });
});

afterAll(async () => {
  await db.destroy().catch(() => {});
});

function tools(notify?: (kind: string) => void): Record<string, any> {
  return createRedrawTools({ db, projectId: PROJECT, scriptId, notify: notify as any });
}

describe("工具集契约", () => {
  it("工具名固定为 9 个（前端/技能都引用这些名字）", () => {
    const names = Object.keys(tools()).sort();
    expect(names).toEqual(
      [
        "redraw_getScript",
        "redraw_updateScript",
        "redraw_listAssetDrafts",
        "redraw_listProjectAssets",
        "redraw_bindDraft",
        "redraw_createAsset",
        "redraw_updateAsset",
        "redraw_confirmAssets",
        "redraw_confirmSegmentCap",
      ].sort(),
    );
  });

  it("redraw_getScript / updateScript 往返 + 通知 script", async () => {
    const kinds: string[] = [];
    const t = tools((k) => kinds.push(k));
    const before = await t.redraw_getScript.execute({});
    expect(before).toMatchObject({ content: "旧剧本", name: "第1集" });

    const r = await t.redraw_updateScript.execute({ content: "改过的剧本" });
    expect(r).toEqual({ changed: true });
    expect(kinds).toEqual(["script"]);
    expect((await t.redraw_getScript.execute({})).content).toBe("改过的剧本");
    expect(await t.redraw_updateScript.execute({ content: "改过的剧本" })).toEqual({ changed: false });
  });

  it("redraw_listAssetDrafts 返回草稿/已有资产/绑定/段/上限", async () => {
    const r = await tools().redraw_listAssetDrafts.execute({});
    expect(r.drafts.length).toBe(2);
    expect(r).toHaveProperty("existing");
    expect(r).toHaveProperty("bindings");
    expect(r).toHaveProperty("segments");
    expect(r.segmentCap).toBe(15);
  });

  it("★ 跨项目 assetId 被拒绝（bindDraft）", async () => {
    const [foreign] = await db("o_assets").insert({ projectId: OTHER, name: "别人的", type: "role" });
    await expect(tools().redraw_bindDraft.execute({ draftName: "Lucia", assetId: Number(foreign) })).rejects.toThrow(
      /不属于该项目/,
    );
  });

  it("redraw_createAsset → redraw_updateAsset → confirmAssets 全链路可用，且每步都通知", async () => {
    const kinds: string[] = [];
    const t = tools((k) => kinds.push(k));
    const created = await t.redraw_createAsset.execute({ draftName: "Lucia", name: "Lucia", type: "role", describe: "d", prompt: "p" });
    expect(created.id).toBeGreaterThan(0);
    const upd = await t.redraw_updateAsset.execute({ assetId: created.id, name: "Lucia V2", gender: "女" });
    expect(upd.changed).toBe(true);
    await t.redraw_bindDraft.execute({ draftName: "Hall", assetId: Number((await db("o_assets").insert({ projectId: PROJECT, name: "旧礼堂", type: "scene" })).toString()) });
    const confirmed = await t.redraw_confirmAssets.execute({});
    expect(confirmed).toMatchObject({ created: 1, reused: 1, linked: 2 });
    expect(kinds).toEqual(["assets", "assets", "assets", "assets"]);
  });

  it("★ confirmSegmentCap 改值不带 force → 返回 needRerun 且不写库；带 force 才写", async () => {
    const t = tools();
    const need = await t.redraw_confirmSegmentCap.execute({ seconds: 20 });
    expect(need).toMatchObject({ ok: false, code: "need_rerun", needRerun: true });
    expect(Number((await db("o_project").where("id", PROJECT).first()).redrawMaxSegmentSec)).toBe(15);

    const ok = await t.redraw_confirmSegmentCap.execute({ seconds: 20, force: true });
    expect(ok).toMatchObject({ ok: true, changed: true, cap: 20 });
    expect(Number((await db("o_project").where("id", PROJECT).first()).redrawMaxSegmentSec)).toBe(20);
    await db("o_project").where("id", PROJECT).update({ redrawMaxSegmentSec: 15 });
  });

  it("confirmSegmentCap 非法值 → 返回 out_of_range（不抛，模型能解释给用户）", async () => {
    const r = await tools().redraw_confirmSegmentCap.execute({ seconds: 99 });
    expect(r).toMatchObject({ ok: false, code: "out_of_range" });
  });
});
