/**
 * 转绘分镜落库 + job 执行（M3-T12/T13）的测试：真 SQLite（全量迁移）+ 注入假模型回复。
 *
 * 钉住的判据（spec §8.3 / R1-G9）：
 *  · 成功：redrawState=3、自动段按转绘版重建、`manual=1` 段保留；
 *  · 继承：同 segmentIndex 的旧 `clipPath`/`sourceRange` 保留（已切好的原片不丢）；
 *  · videoDesc 是管道格式（生产 v2 同款）；快照与变更摘要落工作区；
 *  · 重复执行幂等（不翻倍）；
 *  · 模型产出不合格（未确认资产）→ 抛错、**旧分镜与状态不变**；
 *  · 资产未确认（redrawState=1）→ 拒绝生成。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource, MIGRATIONS } from "@/db/migrations";
import { runRedrawStoryboard } from "@/jobs/handlers/redrawStoryboard";
import { readRedrawState, readWorkData, upsertWorkData } from "@/redraw/state";
import { readSourceStoryboard, readStoryboardChanges } from "@/redraw/storyboardWrite";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-redraw-sb-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let db: Knex;
const PROJECT = 9401;

const VALID = [
  "<redrawStoryboard>",
  "## 场1：圣修学院礼堂 ｜ 参演角色：Lucia、Saint Hall",
  "### 片段一（约11s）",
  "**引用资产名称**：[Lucia, Saint Hall]",
  "**引用资产ID**：[1, 2]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|------|",
  "| 1 | 银发少女推开大门 | 4 | 全景 | 缓慢前移 | 冷调侧光 | 无台词 | 门声 |",
  "| 2 | 她停在账本前 | 3 | 近景 | 固定 | 顶光偏暗 | 无台词 | 呼吸声 |",
  "| 3 | 翻开账本 | 4 | 特写 | 轻微推近 | 暖色台灯 | 无台词 | 翻页声 |",
  "### 片段二（约10s）",
  "**引用资产名称**：[Lucia]",
  "**引用资产ID**：[1]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|------|",
  "| 1 | Lucia 抬头看向窗外 | 5 | 中景 | 横移 | 晨光 | 无台词 | 鸟鸣 |",
  "| 2 | 她合上账本离开 | 5 | 全景 | 后拉 | 冷调 | 无台词 | 脚步声 |",
  "</redrawStoryboard>",
  "<changeSummary>",
  "- 角色「沈公子」→「Lucia（女）」",
  "</changeSummary>",
].join("\n");

beforeAll(async () => {
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, "sb.sqlite") },
  } as MiwoConfig;
  db = createKnex(cfg);
  await db.migrate.latest({ migrationSource: makeMigrationSource(MIGRATIONS) });
  await db("o_project").insert({ id: PROJECT, name: "转绘项目", projectType: "redraw", targetCountry: "美国" });
});

afterAll(async () => {
  await db.destroy().catch(() => {});
});

let seq = 0;

/** 造一集：2 个自动段（第 1 段已有 clip）+ 1 个手工段 + 2 个已确认资产。 */
async function newEpisode(opts: { redrawState?: number } = {}): Promise<number> {
  seq += 1;
  const [id] = await db("o_script").insert({
    name: "第" + seq + "集",
    projectId: PROJECT,
    sourceVideo: "/src.mp4",
    content: "剧本正文",
    extractState: 1,
    redrawState: opts.redrawState ?? 2,
  });
  const scriptId = Number(id);
  const [a1] = await db("o_assets").insert({ projectId: PROJECT, name: "Lucia", type: "role", describe: "银发少女" });
  const [a2] = await db("o_assets").insert({ projectId: PROJECT, name: "Saint Hall", type: "scene", describe: "哥特礼堂" });
  await db("o_scriptAssets").insert([
    { scriptId, assetId: Number(a1) },
    { scriptId, assetId: Number(a2) },
  ]);
  const segs = [
    { segmentIndex: 1, sceneIndex: 1, sceneTitle: "旧礼堂", duration: 11, sourceRange: "0.000-11.000", clipPath: "/" + PROJECT + "/redraw-clip/" + scriptId + "/seg-1.mp4", manual: 0 },
    { segmentIndex: 2, sceneIndex: 1, sceneTitle: "旧礼堂", duration: 10, sourceRange: "11.000-21.000", clipPath: null, manual: 0 },
    { segmentIndex: 3, sceneIndex: 2, sceneTitle: "账房", duration: 5, sourceRange: "21.000-26.000", clipPath: "/manual/seg-3.mp4", manual: 1 },
  ];
  for (const seg of segs) {
    const [segId] = await db("o_segment").insert({ projectId: PROJECT, scriptId, sceneIndex: seg.sceneIndex, sceneTitle: seg.sceneTitle, segmentIndex: seg.segmentIndex, duration: seg.duration, sourceRange: seg.sourceRange, clipPath: seg.clipPath, manual: seg.manual, state: "未生成" });
    const shotCount = seg.manual ? 1 : 3;
    for (let i = 1; i <= shotCount; i += 1) {
      await db("o_shot").insert({
        projectId: PROJECT, scriptId, sceneIndex: seg.sceneIndex, sceneTitle: seg.sceneTitle,
        segmentIndex: seg.segmentIndex, segmentId: Number(segId), shotIndex: i, duration: 3,
        shotSize: "全景", camera: "固定", light: "冷光", action: "动作" + i, dialogue: "无台词", sfx: "声",
        sourceRange: (seg.segmentIndex - 1) * 10 + (i - 1) * 3 + ".000-" + ((seg.segmentIndex - 1) * 10 + i * 3) + ".000",
        revision: 1,
      });
    }
  }
  await upsertWorkData(db, PROJECT, scriptId, "redrawDirectorPlan", { plan: "导演计划" });
  return scriptId;
}

const deps = (reply: string) => ({ invoke: async () => reply, loadSkill: () => "技能正文（测试注入）" });

async function segmentRows(scriptId: number, manual = 0) {
  return (await db("o_segment").where({ projectId: PROJECT, scriptId, manual }).orderBy("segmentIndex")) as any[];
}

describe("runRedrawStoryboard：成功路径", () => {
  it("★ 写库：redrawState=3、自动段重建、手工段保留、clipPath 继承、videoDesc 管道格式、快照+摘要", async () => {
    const scriptId = await newEpisode();
    const r = await runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(VALID));

    expect(r.segments).toBe(2);
    expect(r.shots).toBe(5);
    expect(r.inheritedClips).toBe(1);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(3);

    const autos = await segmentRows(scriptId, 0);
    expect(autos.map((s: any) => s.segmentIndex)).toEqual([1, 2]);
    // 第 1 段继承旧 clipPath 与 sourceRange；第 2 段没有旧 clip（保持 null）
    expect(autos[0].clipPath).toBe("/" + PROJECT + "/redraw-clip/" + scriptId + "/seg-1.mp4");
    expect(autos[0].sourceRange).toBe("0.000-11.000");
    expect(autos[1].clipPath).toBeNull();
    // videoDesc 是生产 v2 管道格式
    expect(autos[1].videoDesc).toContain("承接上镜：");
    expect(autos[1].videoDesc).toContain("| 1 |");

    // 手工段保留（manual=1，clip 也在）
    const manuals = await segmentRows(scriptId, 1);
    expect(manuals.length).toBe(1);
    expect(manuals[0].clipPath).toBe("/manual/seg-3.mp4");

    // 镜与资产绑定：段1 三镜 ×2 资产 + 段2 两镜 ×1 资产 = 8
    const shots = (await db("o_shot").where({ projectId: PROJECT, scriptId }).orderBy(["segmentIndex", "shotIndex"])) as any[];
    expect(shots.filter((s: any) => Number(s.segmentIndex) <= 2).length).toBe(5);
    const shotIds = shots.filter((s: any) => Number(s.segmentIndex) <= 2).map((s: any) => Number(s.id));
    expect(await db("o_shotAssets").whereIn("shotId", shotIds)).toHaveLength(8);

    // 快照 + 变更摘要
    const snap = await readSourceStoryboard(db, { projectId: PROJECT, scriptId });
    expect(snap).not.toBeNull();
    expect(snap!.segments.length).toBe(3); // 快照 = 覆盖前的全部段（含手工段）
    expect(snap!.segments[0]).toMatchObject({ index: 1, duration: 11, sourceRange: "0.000-11.000" });
    expect(await readStoryboardChanges(db, { projectId: PROJECT, scriptId })).toEqual(["角色「沈公子」→「Lucia（女）」"]);
  });

  it("★ 重复执行幂等：段数/镜数不翻倍，手工段仍只有 1 个", async () => {
    const scriptId = await newEpisode();
    await runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(VALID));
    await runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(VALID));
    expect((await segmentRows(scriptId, 0)).length).toBe(2);
    expect((await segmentRows(scriptId, 1)).length).toBe(1);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(3);
  });
});

describe("runRedrawStoryboard：失败路径（旧分镜与状态不变）", () => {
  it("★ 模型引用了未确认资产 → 抛错；segments/状态不变", async () => {
    const scriptId = await newEpisode();
    const before = (await segmentRows(scriptId, 0)).map((s: any) => [s.segmentIndex, s.duration, s.clipPath]);
    const bad = VALID.replace("**引用资产名称**：[Lucia, Saint Hall]", "**引用资产名称**：[Lucia, 沈公子]");
    await expect(runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(bad))).rejects.toThrow(/未确认/);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(2);
    const after = (await segmentRows(scriptId, 0)).map((s: any) => [s.segmentIndex, s.duration, s.clipPath]);
    expect(after).toEqual(before);
    // 失败时也不该写快照/摘要
    expect(await readSourceStoryboard(db, { projectId: PROJECT, scriptId })).toBeNull();
  });

  it("资产未确认（redrawState=1）→ 拒绝生成（409 语义）", async () => {
    const scriptId = await newEpisode({ redrawState: 1 });
    await expect(runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(VALID))).rejects.toThrow(/资产还没确认/);
    expect(await readRedrawState(db, { projectId: PROJECT, scriptId })).toBe(1);
  });

  it("没有已确认资产（草稿还没认账）→ 拒绝", async () => {
    const scriptId = await newEpisode();
    await db("o_scriptAssets").where({ scriptId }).del();
    await expect(runRedrawStoryboard(db, { projectId: PROJECT, scriptId }, deps(VALID))).rejects.toThrow(/没有任何已确认资产/);
  });
});