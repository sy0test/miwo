/**
 * 转绘分镜落库（M3-T13 / spec §8.3）。
 *
 * 顺序（**快照在前、重建在事务里**）：
 *   1. 把**当前**源片分镜写进工作区 `redrawSourceStoryboard`（并排确认页的左边、回退的依据）；
 *   2. 事务内：删自动段（`manual=0`）+ 它们的镜与资产绑定 → 按转绘版重建；
 *   3. 继承：按 `segmentIndex`（+ 旧 `sourceRange`）把 `clipPath` / `sourceRange` 从旧段带过来 ——
 *      重跑转绘/重新解析后**已切好的原片不丢**（spec §4.4）；
 *   4. `o_segment.videoDesc` 用生产 v2 同款管道格式（`buildSegmentVideoDesc`，G9/D6）；
 *   5. 写 `redrawStoryboardChanges`（变更摘要，前端对比页用）。
 *
 * `manual=1` 的段（工作台手工新增）**保留**，与 `persistShots` 的口径一致。
 * 幂等：同一份输入重复执行结果相同（每次都先删自建段再写；快照会被覆盖成"上一次的当前态"）。
 */
import { readWorkData, upsertWorkData } from "@/redraw/state";
import type { RedrawSegmentPlan } from "@/redraw/storyboard";

/** 源片分镜快照（并排确认页左边 / 回退） */
export const SOURCE_STORYBOARD_KEY = "redrawSourceStoryboard";
/** 变更摘要（并排确认页底部） */
export const STORYBOARD_CHANGES_KEY = "redrawStoryboardChanges";

export type SegmentView = { index: number; duration: number; sourceRange: string | null; videoDesc: string };

export type SourceStoryboard = {
  segments: SegmentView[];
  at: number;
};

export type SegmentRow = {
  id: number;
  segmentIndex: number;
  sceneIndex: number;
  sceneTitle: string;
  duration: number;
  sourceRange: string | null;
  clipPath: string | null;
  videoDesc: string;
};

export type ShotRow = {
  id: number;
  segmentId: number;
  segmentIndex: number;
  shotIndex: number;
  duration: number;
  shotSize: string;
  camera: string;
  light: string;
  action: string;
  dialogue: string;
  sfx: string;
  sourceRange: string | null;
};

/** 读当前分镜的展示视图（分段）。 */
export async function readSegmentViews(db: any, opts: { projectId: number; scriptId: number }): Promise<SegmentView[]> {
  const rows = (await db("o_segment")
    .where({ projectId: opts.projectId, scriptId: opts.scriptId })
    .orderBy("segmentIndex", "asc")
    .select("segmentIndex", "duration", "sourceRange", "videoDesc")) as any[];
  return rows.map((r) => ({
    index: Number(r.segmentIndex),
    duration: Number(r.duration ?? 0),
    sourceRange: r.sourceRange ?? null,
    videoDesc: String(r.videoDesc ?? ""),
  }));
}

/** 读当前分镜（段 + 镜 + 段级资产名）——给 prompt 拼装用。 */
export async function readCurrentStoryboard(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<{ segments: SegmentRow[]; shots: ShotRow[]; assetNamesBySegment: Map<number, string[]> }> {
  const segments = (await db("o_segment")
    .where({ projectId: opts.projectId, scriptId: opts.scriptId })
    .orderBy("segmentIndex", "asc")) as any[];
  const shots = (await db("o_shot")
    .where({ projectId: opts.projectId, scriptId: opts.scriptId })
    .orderBy(["segmentIndex", "shotIndex"])) as any[];
  const assetNamesBySegment = new Map<number, string[]>();
  if (shots.length) {
    const shotIds = shots.map((s) => Number(s.id));
    const links = (await db("o_shotAssets").whereIn("shotId", shotIds)) as any[];
    if (links.length) {
      const assetIds = [...new Set(links.map((l) => Number(l.assetId)))];
      const assets = (await db("o_assets").whereIn("id", assetIds).select("id", "name")) as any[];
      const nameById = new Map(assets.map((a) => [Number(a.id), String(a.name ?? "")]));
      const segByShot = new Map(shots.map((s) => [Number(s.id), Number(s.segmentIndex)]));
      for (const l of links) {
        const segIndex = segByShot.get(Number(l.shotId));
        const name = nameById.get(Number(l.assetId));
        if (segIndex === undefined || !name) continue;
        const list = assetNamesBySegment.get(segIndex) ?? [];
        if (!list.includes(name)) list.push(name);
        assetNamesBySegment.set(segIndex, list);
      }
    }
  }
  return {
    segments: segments.map((r) => ({
      id: Number(r.id),
      segmentIndex: Number(r.segmentIndex),
      sceneIndex: Number(r.sceneIndex ?? 1),
      sceneTitle: String(r.sceneTitle ?? ""),
      duration: Number(r.duration ?? 0),
      sourceRange: r.sourceRange ?? null,
      clipPath: r.clipPath ?? null,
      videoDesc: String(r.videoDesc ?? ""),
    })),
    shots: shots.map((r) => ({
      id: Number(r.id),
      segmentId: Number(r.segmentId),
      segmentIndex: Number(r.segmentIndex),
      shotIndex: Number(r.shotIndex),
      duration: Number(r.duration ?? 0),
      shotSize: String(r.shotSize ?? ""),
      camera: String(r.camera ?? ""),
      light: String(r.light ?? ""),
      action: String(r.action ?? ""),
      dialogue: String(r.dialogue ?? ""),
      sfx: String(r.sfx ?? ""),
      sourceRange: r.sourceRange ?? null,
    })),
    assetNamesBySegment,
  };
}

/** 读源片分镜快照（没有就 null）。 */
export async function readSourceStoryboard(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<SourceStoryboard | null> {
  const row = await readWorkData<SourceStoryboard>(db, opts.projectId, opts.scriptId, SOURCE_STORYBOARD_KEY);
  if (!row || !Array.isArray(row.segments)) return null;
  return { segments: row.segments, at: Number(row.at ?? 0) };
}

/** 读变更摘要。 */
export async function readStoryboardChanges(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<string[]> {
  const row = await readWorkData<{ changes?: string[] }>(db, opts.projectId, opts.scriptId, STORYBOARD_CHANGES_KEY);
  return Array.isArray(row?.changes) ? row!.changes!.map(String) : [];
}

/**
 * 写入转绘版分镜。
 *
 * @returns `{ segmentCount, shotCount, inheritedClips }`（inheritedClips = 成功继承旧 clipPath 的段数）
 */
export async function writeRedrawStoryboard(
  db: any,
  opts: { projectId: number; scriptId: number; segments: RedrawSegmentPlan[]; changes: string[] },
): Promise<{ segmentCount: number; shotCount: number; inheritedClips: number }> {
  const { projectId, scriptId, segments, changes } = opts;
  if (!segments.length) throw new Error("转绘分镜为空：拒绝覆盖（先修好模型产出）");

  // ---- 1. 快照（事务外先读旧态）----
  const current = await readCurrentStoryboard(db, { projectId, scriptId });
  const previousView = current.segments.map((s) => ({
    index: s.segmentIndex,
    duration: s.duration,
    sourceRange: s.sourceRange,
    videoDesc: s.videoDesc,
  }));
  await upsertWorkData(db, projectId, scriptId, SOURCE_STORYBOARD_KEY, { segments: previousView, at: Date.now() });
  await upsertWorkData(db, projectId, scriptId, STORYBOARD_CHANGES_KEY, { changes, at: Date.now() });

  // 旧段索引：segmentIndex → {sourceRange, clipPath}；旧镜：segmentIndex:shotIndex → sourceRange
  const oldSegByIndex = new Map(current.segments.map((s) => [s.segmentIndex, s]));
  const oldShotRange = new Map(current.shots.map((s) => [s.segmentIndex + ":" + s.shotIndex, s.sourceRange]));

  const now = Date.now();
  return db.transaction(async (trx: any) => {
    // ---- 2. 删自动段（manual=0）+ 它们的镜/绑定；manual=1 保留 ----
    const autoSegs = (await trx("o_segment").where({ projectId, scriptId, manual: 0 }).select("id")) as any[];
    const autoIds = autoSegs.map((r) => Number(r.id));
    if (autoIds.length) {
      const oldShots = (await trx("o_shot").whereIn("segmentId", autoIds).select("id")) as any[];
      const oldShotIds = oldShots.map((r) => Number(r.id));
      if (oldShotIds.length) await trx("o_shotAssets").whereIn("shotId", oldShotIds).del();
      await trx("o_shot").whereIn("segmentId", autoIds).del();
      await trx("o_segment").whereIn("id", autoIds).del();
    }

    // ---- 3. 重建 ----
    let shotCount = 0;
    let inheritedClips = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const plan = segments[i];
      const segmentIndex = i + 1; // 全片连续 1..N（不信模型给的序号：可能重复/跳号）
      const old = oldSegByIndex.get(segmentIndex);
      const sourceRange = old?.sourceRange ?? null;
      const clipPath = old?.clipPath ?? null;
      const [segId] = await trx("o_segment").insert({
        projectId,
        scriptId,
        segmentIndex,
        sceneIndex: plan.sceneIndex || 1,
        sceneTitle: plan.sceneTitle || "",
        duration: plan.duration,
        videoDesc: plan.videoDesc,
        state: "未生成",
        manual: 0,
        sourceRange,
        clipPath,
        createTime: now,
        updateTime: now,
      });
      if (clipPath) inheritedClips += 1;

      const assetIds = plan.assetIds.filter((id) => Number.isInteger(id) && id > 0);
      for (let j = 0; j < plan.shots.length; j += 1) {
        const shot = plan.shots[j];
        const shotIndex = j + 1;
        const [shotId] = await trx("o_shot").insert({
          projectId,
          scriptId,
          sceneIndex: plan.sceneIndex || 1,
          sceneTitle: plan.sceneTitle || "",
          segmentIndex,
          segmentId: Number(segId),
          shotIndex,
          duration: shot.duration,
          shotSize: shot.shotSize || "",
          camera: shot.camera || "",
          light: shot.light || "",
          action: shot.action || "",
          dialogue: shot.dialogue || "",
          sfx: shot.sfx || "",
          // 镜级源片区间：同一 segmentIndex+shotIndex 的旧镜有就继承（供核对）
          sourceRange: oldShotRange.get(segmentIndex + ":" + shotIndex) ?? "",
          revision: 1,
          createTime: now,
          updateTime: now,
        });
        shotCount += 1;
        if (assetIds.length) {
          await trx("o_shotAssets").insert(assetIds.map((assetId) => ({ shotId: Number(shotId), assetId })));
        }
      }
    }
    return { segmentCount: segments.length, shotCount, inheritedClips };
  });
}