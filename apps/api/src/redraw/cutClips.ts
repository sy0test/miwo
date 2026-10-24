/**
 * 切原片（按段）：从 `routes/redraw/cutSource.ts` 抽出的**可复用内核**（M3-G9）。
 *
 * 为什么要抽出来：确认覆盖（`confirmStoryboard`）与手动「切原片」必须**同一套逻辑**
 * （同样的区间解析、同样的越界钳制、同样的自校验、同样的 `cleanStale`），否则两条路径会漂。
 *
 * db / oss / probeVideo / cutClip 全注入：路由传 `u.db`/`u.oss`/真 ffmpeg，单测可注入假实现。
 */
import fs from "node:fs";
import pLimit from "p-limit";
import { parseRanges } from "@/utils/redraw";

/** 允许的越界余量：源片末端的区间常常正好写在总时长上，ffprobe 报的数会差几毫秒 */
const EDGE_TOL = 0.05;
/** 成片时长与「区间跨度之和」的允许偏差。ffmpeg 边界落在帧上，差一帧是正常的 */
const CUT_TOL = 0.1;

export class CutSourceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CutSourceError";
    this.status = status;
  }
}

type Issue = { level: "error" | "warn"; segmentIndex?: number; message: string };

/**
 * 把切出来的原片片段登记成 **素材资产**（`o_assets.type = "clip"` + `o_image`）。
 *
 * 为什么必须登记：工作台的「添加参考」是从**资产库**里选素材的（`assetsCheck({ types: [..., "clip"] })`）。
 * 如果只写 `o_segment.clipPath`，用户把某段的参考片删掉之后，就再也**选不回来**了 —— 真机反馈
 * 「源视频切片不在资产的素材列表里」。登记后它和手传的素材一样可复用/可再次选中。
 *
 * 幂等：以 `o_image.filePath = clipPath` 为唯一判据（同一段重切路径不变，不会重复建资产）。
 * 失败不阻断切片主流程（资产表异常时仍应把原片切出来）。
 */
async function ensureClipAsset(
  db: any,
  o: { projectId: number; scriptId: number; scriptName?: string; segmentIndex: number; clipPath: string; userId?: number },
): Promise<void> {
  const name = "第" + o.segmentIndex + "段原片" + (o.scriptName ? "（" + o.scriptName + "）" : "");
  const img = await db("o_image").where({ filePath: o.clipPath, type: "clip" }).first("id", "assetsId");
  if (img?.assetsId) {
    await db("o_assets").where("id", img.assetsId).update({ name });
    return;
  }
  const assetRow: Record<string, any> = {
    type: "clip",
    projectId: o.projectId,
    scriptId: o.scriptId,
    name,
    startTime: Date.now(),
  };
  if (o.userId != null) assetRow.userId = o.userId;
  const [assetId] = await db("o_assets").insert(assetRow);
  const imageRow: Record<string, any> = { filePath: o.clipPath, type: "clip", assetsId: assetId, state: "已完成" };
  if (o.userId != null) imageRow.userId = o.userId;
  const [imageId] = await db("o_image").insert(imageRow);
  await db("o_assets").where("id", assetId).update({ imageId });
}

export type CutSourceDeps = {
  probeVideo(file: string): Promise<{ duration?: number; hasAudio: boolean }>;
  cutClip(src: string, ranges: [number, number][], out: string, hasAudio: boolean): Promise<void>;
};

export type CutSourceOptions = {
  projectId: number;
  scriptId?: number;
  videoPath?: string;
  onlyMissing?: boolean;
  cleanStale?: boolean;
};

export type CutSourceResult = {
  scriptId: number;
  sourceVideo: string;
  videoSec: number | null;
  hasAudio: boolean;
  total: number;
  cut: number;
  skipped: number;
  removed: number;
  clips: Array<{ segmentIndex: number; clipPath: string; sec: number }>;
  issues: Issue[];
};

/**
 * 按 `o_segment` 的段集合切原片。`onlyMissing` = 已有 clip 且文件在就跳过；
 * `cleanStale` = 清掉本集目录里不属于当前段集合的旧文件。
 */
export async function cutSourceClips(
  db: any,
  oss: any,
  opts: CutSourceOptions,
  deps: CutSourceDeps,
): Promise<CutSourceResult> {
  const { projectId, scriptId: given, videoPath, onlyMissing, cleanStale } = opts;
  const script = given
    ? await db("o_script").where({ id: given, projectId }).first()
    : await db("o_script").where("projectId", projectId).first();
  if (!script) throw new CutSourceError(400, "项目下没有剧本：" + projectId);
  const scriptId = Number(script.id);

  const srcRel = (videoPath || script.sourceVideo || "").trim();
  if (!srcRel) throw new CutSourceError(400, "没有源片路径：请求里给 videoPath，或先给剧本写上 sourceVideo");
  const srcAbs = await oss.getAbsPath(srcRel);
  if (!fs.existsSync(srcAbs)) throw new CutSourceError(400, "源片不存在：" + srcRel);
  if (srcRel !== script.sourceVideo) await db("o_script").where("id", scriptId).update({ sourceVideo: srcRel });

  const segments = (await db("o_segment").where({ scriptId, projectId }).orderBy("segmentIndex", "asc")) as any[];
  if (!segments.length) {
    throw new CutSourceError(400, "该剧本下没有结构化分镜（o_segment），先跑解析/转绘：scriptId=" + scriptId);
  }
  const shots = (await db("o_shot").where({ scriptId, projectId }).orderBy(["segmentIndex", "shotIndex"])) as any[];
  const shotsBySegment = new Map<number, any[]>();
  for (const s of shots) {
    const key = Number(s.segmentId);
    const list = shotsBySegment.get(key) ?? [];
    list.push(s);
    shotsBySegment.set(key, list);
  }

  const meta = await deps.probeVideo(srcAbs);
  const issues: Issue[] = [];

  const outDirRel = "/" + projectId + "/redraw-clip/" + scriptId;
  const outDirAbs = await oss.getAbsPath(outDirRel);
  fs.mkdirSync(outDirAbs, { recursive: true });

  const limit = pLimit(3);
  const clips: Array<{ segmentIndex: number; clipPath: string; sec: number }> = [];
  let skipped = 0;

  await Promise.all(
    segments.map((seg: any) =>
      limit(async () => {
        const segmentIndex = Number(seg.segmentIndex);
        const segShots = shotsBySegment.get(Number(seg.id)) ?? [];
        if (!segShots.length) {
          issues.push({ level: "error", segmentIndex, message: "片段 " + segmentIndex + " 下没有镜，无法确定源片区间" });
          return;
        }
        // 段级区间优先：转绘分镜重写后，段内镜数可能和源片不同，多出来的镜没有 sourceRange
        // （真机症状：seg 9/11 的第二镜区间为空 ⇒ 整段切不出来 ⇒ 工作台这两段没有原片参考）。
        // 段上的 sourceRange 是解析层按整个片段聚合好的，比逐镜更可靠。
        const ranges: [number, number][] = [];
        const segRanges = parseRanges(String(seg.sourceRange ?? "").trim());
        if (segRanges && segRanges.length) {
          ranges.push(...segRanges);
        } else {
          for (const sh of segShots) {
            const parsed = parseRanges(String(sh.sourceRange ?? "").trim());
            if (!parsed) {
              issues.push({ level: "error", segmentIndex, message: "片段 " + segmentIndex + " 的镜 " + sh.shotIndex + " 区间解析不出来：" + String(sh.sourceRange ?? "") });
              return;
            }
            ranges.push(...parsed);
          }
        }
        const clamped: [number, number][] = [];
        for (const [a, b] of ranges) {
          if (a < 0 || b <= a) {
            issues.push({ level: "error", segmentIndex, message: "片段 " + segmentIndex + " 区间不合法：" + a + "-" + b });
            return;
          }
          if (meta.duration && a >= meta.duration - EDGE_TOL) {
            issues.push({ level: "error", segmentIndex, message: "片段 " + segmentIndex + " 区间落在源片之外：" + a + "-" + b + "（源片 " + meta.duration.toFixed(3) + "s）" });
            return;
          }
          if (meta.duration && b > meta.duration) {
            if (b - meta.duration > EDGE_TOL) {
              issues.push({ level: "warn", segmentIndex, message: "片段 " + segmentIndex + " 区间越过源片末尾，已收到 " + meta.duration.toFixed(3) + "s" });
            }
            clamped.push([a, meta.duration]);
          } else {
            clamped.push([a, b]);
          }
        }

        const clipRel = outDirRel + "/seg-" + segmentIndex + ".mp4";
        const clipAbs = await oss.getAbsPath(clipRel);
        // 复用判据（G9）：路径一致 + 文件存在 + **切片已静音**。
        // 为什么要查静音：把带原声的源片当参考视频发给 Seedance 时，模型会照搬背景音/台词；
        // 所以历史切片（升级前带音轨）必须重切一次，不能只因为文件在就跳过。
        if (onlyMissing && seg.clipPath === clipRel && fs.existsSync(clipAbs)) {
          const existing = await deps.probeVideo(clipAbs).catch(() => null);
          if (existing && !existing.hasAudio) {
            skipped++;
            // 已经有切片：也要补登记（历史上只写了 clipPath 的段，升级后第一次「重切」即可补齐资产）
            await ensureClipAsset(db, {
              projectId,
              scriptId,
              scriptName: script.name,
              segmentIndex,
              clipPath: clipRel,
              userId: script.userId != null ? Number(script.userId) : undefined,
            }).catch(() => undefined);
            return;
          }
          // 带音轨 → 继续往下重切（本次会切成静音）
        }
        try {
          // 参考片段一律**去掉音轨**：只剩画面给 Seedance 做动作/节奏参考，
          // 否则模型会连原片的背景音和台词一起照搬（真机反馈）。
          await deps.cutClip(srcAbs, clamped, clipAbs, false);
          await oss.writeFile(clipRel, await fs.promises.readFile(clipAbs));
          const want = clamped.reduce((sum, [a, b]) => sum + (b - a), 0);
          const got = (await deps.probeVideo(clipAbs)).duration;
          if (got === undefined) issues.push({ level: "warn", segmentIndex, message: "片段 " + segmentIndex + " 切完读不到时长" });
          else if (Math.abs(got - want) > CUT_TOL) {
            issues.push({ level: "warn", segmentIndex, message: "片段 " + segmentIndex + " 成片 " + got.toFixed(3) + "s，区间跨度 " + want.toFixed(3) + "s，差 " + (got - want).toFixed(3) + "s" });
          }
          await db("o_segment").where("id", seg.id).update({ clipPath: clipRel });
          await ensureClipAsset(db, {
            projectId,
            scriptId,
            scriptName: script.name,
            segmentIndex,
            clipPath: clipRel,
            userId: script.userId != null ? Number(script.userId) : undefined,
          }).catch(() => undefined);
          clips.push({ segmentIndex, clipPath: clipRel, sec: got ?? want });
        } catch (e: any) {
          issues.push({ level: "error", segmentIndex, message: "片段 " + segmentIndex + " 切片失败：" + (e?.message ?? String(e)) });
        }
      }),
    ),
  );

  let removed = 0;
  if (cleanStale) {
    const wanted = new Set(segments.map((s: any) => "seg-" + Number(s.segmentIndex) + ".mp4"));
    for (const f of fs.readdirSync(outDirAbs)) {
      if (!wanted.has(f)) {
        const stalePath = outDirRel + "/" + f;
        await oss.deleteFile(stalePath);
        // 同步清掉指向该文件的 clip 素材（段已不存在，留着只会是死链）
        const staleImgs = await db("o_image").where({ filePath: stalePath, type: "clip" }).select("id", "assetsId");
        for (const img of staleImgs) {
          if (img.assetsId != null) await db("o_assets").where("id", img.assetsId).del();
          await db("o_image").where("id", img.id).del();
        }
        removed++;
      }
    }
  }

  return {
    scriptId,
    sourceVideo: srcRel,
    videoSec: meta.duration ?? null,
    hasAudio: meta.hasAudio,
    total: segments.length,
    cut: clips.length,
    skipped,
    removed,
    clips: clips.sort((a, b) => a.segmentIndex - b.segmentIndex),
    issues,
  };
}
