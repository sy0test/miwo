/**
 * 分镜结构化落库（事务 + 幂等 + 全量替换）
 *
 * 取代原来的「阶段5 让 agent 一条条调 add_flowData_storyboard」：
 *   · 落库由**代码**做，一次事务写完 `o_segment`（片段=生成单位）→ `o_shot`（一行一镜）→ `o_shotAssets`（镜↔资产）
 *   · **幂等**：同一次解析结果重复落库，内容完全一致（先按 scriptId 清空再写，不会有孤儿/id 冲突）
 *   · **事务**：任何一步失败整批回滚，不再出现「行插了、绑定没插」的半成品
 *
 * 为什么 db 走注入（`db: any`）而不是直接 `import u from "@/utils"`：
 * 与 `src/utils/storyboardTracks.ts` 同一套路 —— 让这段逻辑能脱离应用初始化被真跑验证。
 */

import type { ParsedSegment, ParsedStoryboard } from "./storyboardTable";
import { buildSegmentVideoDesc } from "./storyboardTable";

export type PersistShotsOptions = {
  projectId: number;
  scriptId: number;
  parsed: ParsedStoryboard;
  /** 片段状态初始值（默认「未生成」，与旧 o_storyboard 口径一致） */
  segmentState?: string;
};

export type PersistShotsResult = {
  scriptId: number;
  segments: number;
  shots: number;
  bindings: number;
  /** 该集全部分镜的总时长（秒） */
  totalSec: number;
  before: { segments: number; shots: number; bindings: number };
};

const now = () => Date.now();

/** 一个片段的镜级资产 ID 合集（去重，保序） */
function segmentAssetIds(seg: ParsedSegment): number[] {
  const set = new Set<number>();
  for (const id of seg.assetIds) set.add(id);
  for (const shot of seg.shots) for (const id of shot.assetIds) set.add(id);
  return [...set];
}

/**
 * 把一次解析结果整体写入三张表（事务）。
 *
 * ⚠ 语义是**整集替换**：删掉该集旧的 shots/segments/bindings 再写。
 * 这正好覆盖「修复重跑」——不再需要靠 track 名 + 内容指纹去猜「这是不是同一条重跑」。
 */
export async function persistShots(db: any, opts: PersistShotsOptions): Promise<PersistShotsResult> {
  const { projectId, scriptId, parsed } = opts;
  const segmentState = opts.segmentState ?? "未生成";

  return db.transaction(async (trx: any) => {
    // ---- 1. 记录替换前的行数（用于影子期对比日志）----
    const oldShots: any[] = await trx("o_shot").where("scriptId", scriptId).select("id");
    const oldShotIds = oldShots.map((r) => r.id);
    const beforeBindings = oldShotIds.length ? await trx("o_shotAssets").whereIn("shotId", oldShotIds).count({ n: "*" }).first() : { n: 0 };
    const beforeSegments = await trx("o_segment").where("scriptId", scriptId).count({ n: "*" }).first();
    const before = {
      segments: Number(beforeSegments?.n ?? 0),
      shots: oldShotIds.length,
      bindings: Number(beforeBindings?.n ?? 0),
    };

    // ---- 2. 清空该集旧数据（顺序：绑定 → 镜 → 片段）----
    // ⚠ **手工新增的片段要保住**（`manual=1`，见 workbench/addTrack）：
    // 它们只存在于库里（分镜表文本里没有它们的位置），若按"整集替换"删掉，
    // 用户在工作台手工加的段、以及它上面绑的资产会在下一次保存分镜表/重跑阶段4 时**整段消失**。
    const manualSegs: any[] = await trx("o_segment").where("scriptId", scriptId).andWhere("manual", 1).select("id", "segmentIndex");
    const manualIds = manualSegs.map((r) => Number(r.id));

    const parsedMaxIndex = parsed.segments.reduce((m, s) => Math.max(m, Number(s.segmentIndex) || 0), 0);
    // 手工片段避让：解析结果也用到了同号时，把手工程挪到解析结果之后（保持两套都不丢）
    let nextManualIndex = parsedMaxIndex + 1;
    for (const m of manualSegs) {
      if (Number(m.segmentIndex) <= parsedMaxIndex) {
        const newIndex = nextManualIndex++;
        await trx("o_segment").where("id", m.id).update({ segmentIndex: newIndex });
        await trx("o_shot").where("segmentId", m.id).update({ segmentIndex: newIndex });
      } else {
        nextManualIndex = Math.max(nextManualIndex, Number(m.segmentIndex) + 1);
      }
    }

    const autoSegIds: number[] = (await trx("o_segment").where("scriptId", scriptId).where("manual", 0).select("id")).map((r: any) => Number(r.id));
    const autoShotIds: number[] = autoSegIds.length ? (await trx("o_shot").whereIn("segmentId", autoSegIds).select("id")).map((r: any) => Number(r.id)) : [];
    if (autoShotIds.length) await trx("o_shotAssets").whereIn("shotId", autoShotIds).del();
    if (autoSegIds.length) {
      await trx("o_shot").whereIn("segmentId", autoSegIds).del();
      await trx("o_segment").whereIn("id", autoSegIds).del();
    }

    // ---- 3. 逐片段写入 ----
    let shotCount = 0;
    let bindingCount = 0;
    let totalSec = 0;

    for (const seg of parsed.segments) {
      const segDuration = seg.shots.reduce((sum, s) => sum + (Number.isNaN(s.duration) ? 0 : s.duration), 0);
      const ts = now();
      const [segmentId] = await trx("o_segment").insert({
        projectId,
        scriptId,
        segmentIndex: seg.segmentIndex,
        sceneIndex: seg.sceneIndex,
        sceneTitle: seg.sceneTitle,
        duration: segDuration,
        videoDesc: buildSegmentVideoDesc(parsed, seg),
        state: segmentState,
        // 0 = 由分镜表文本生成（会被下次解析整体替换）；1 = 用户手工新增（见 workbench/addTrack，重解析时保留）
        manual: 0,
        createTime: ts,
        updateTime: ts,
      });

      for (let si = 0; si < seg.shots.length; si++) {
        const shot = seg.shots[si];
        const [shotId] = await trx("o_shot").insert({
          projectId,
          scriptId,
          sceneIndex: seg.sceneIndex,
          sceneTitle: seg.sceneTitle,
          segmentIndex: seg.segmentIndex,
          segmentId,
          // ⚠ 用**片段内的位置**（1..N）作为 shotIndex，而不是表里的「序号」列：
          // 真实分镜表的序号常常是**全片连续**编号（1..镜总数），那是给人看的；
          // 结构化模型里镜序必须每片段从 1 起（删镜重排、按行修复、校验都依赖这个不变式）。
          shotIndex: si + 1,
          duration: Number.isNaN(shot.duration) ? 0 : shot.duration,
          shotSize: shot.shotSize,
          camera: shot.camera,
          light: shot.light,
          action: shot.action,
          dialogue: shot.dialogue,
          sfx: shot.sfx,
          revision: 1,
          createTime: ts,
          updateTime: ts,
        });
        shotCount += 1;
        totalSec += Number.isNaN(shot.duration) ? 0 : shot.duration;

        // 镜级绑定：优先用镜自己的（表里有该列时），否则回落到片段级 —— 与旧口径一致
        const ids = shot.assetIds.length ? shot.assetIds : seg.assetIds;
        const uniq = [...new Set(ids)];
        if (uniq.length) {
          await trx("o_shotAssets").insert(uniq.map((assetId) => ({ shotId, assetId })));
          bindingCount += uniq.length;
        }
      }
    }

    return { scriptId, segments: parsed.segments.length, shots: shotCount, bindings: bindingCount, totalSec, before };
  });
}

/** 读回一集的结构化分镜（供下游读取方与新链路自检） */
export async function loadShotsForScript(db: any, scriptId: number) {
  const segments = await db("o_segment").where("scriptId", scriptId).orderBy("segmentIndex", "asc");
  const shots = await db("o_shot").where("scriptId", scriptId).orderBy(["segmentIndex", "shotIndex"]);
  const shotIds = shots.map((s: any) => s.id);
  const bindings = shotIds.length ? await db("o_shotAssets").whereIn("shotId", shotIds) : [];
  return { segments, shots, bindings };
}

/**
 * 结构指纹：用于断言「重复落库内容一致」。
 * ⚠ 绑定必须用 **(片段序#镜序, assetId)** 而不是自增 shotId —— 每次整集替换都会分配新 id，
 * 用 id 做指纹会把「内容没变」误判成「变了」。
 */
export function shotsFingerprint(rows: { shots: any[]; segments: any[]; bindings: any[] }): string {
  const shots = rows.shots.map((s) => [s.segmentIndex, s.shotIndex, s.duration, s.shotSize, s.camera, s.light, s.action, s.dialogue, s.sfx].join("\u0001")).join("\u0002");
  const segs = rows.segments.map((s) => [s.segmentIndex, s.duration, s.videoDesc].join("\u0001")).join("\u0002");
  const key = new Map<number, string>(rows.shots.map((s) => [s.id, `${s.segmentIndex}#${s.shotIndex}`]));
  const binds = rows.bindings
    .map((b) => `${key.get(b.shotId) ?? "orphan:" + b.shotId}:${b.assetId}`)
    .sort()
    .join(",");
  return [shots, segs, binds].join("\u0003");
}
