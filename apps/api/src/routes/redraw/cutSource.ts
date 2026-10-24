import express from "express";
import fs from "fs";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cutClip, probeVideo } from "@/utils/ffmpeg";
import { parseRanges } from "@/utils/redraw";

const router = express.Router();

/**
 * 出海转绘 · 第 5 步：按**片段**把源片切成本段一个参考视频。
 *
 * 2026-10-21 迁 v2 后的口径（用户决策：切原片**按段**，不按镜）：
 *   - 片段 = `o_segment`（生成单位）；它的源片区间由段内各镜 `o_shot.sourceRange` 按顺序拼起来；
 *   - 产物：`/{projectId}/redraw-clip/{scriptId}/seg-{segmentIndex}.mp4`，路径写回 `o_segment.clipPath`；
 *   - 工作台把它作为 `sources:"clip"` 的**参考视频**挂到该段上（供应商侧走 `videoReference`）。
 *
 * 为什么不是每镜一个：转绘的生成单位是"一段"（≤15s、最多 3 镜），一段对应一次生成；
 * 每镜切一份再拼反而多一步、且播放器/供应商侧只吃一个参考视频。
 *
 * 纯本地 ffmpeg，不调模型 —— 这一整步零成本，可以反复跑。
 * ⚠ 生成端吃视频的是**供应商**（Seedance 的 reference_video），不是文本模型。
 */

/** 允许的越界余量：源片末端的区间常常正好写在总时长上，ffprobe 报的数会差几毫秒 */
const EDGE_TOL = 0.05;
/** 成片时长与「区间跨度之和」的允许偏差。ffmpeg 边界落在帧上，差一帧是正常的 */
const CUT_TOL = 0.1;

type Issue = { level: "error" | "warn"; segmentIndex?: number; message: string };

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    /** 源片的 OSS 相对路径（如 `/1790693701128/source/a.mp4`）。不给就用 o_script.sourceVideo */
    videoPath: z.string().optional(),
    /** 已有片段就跳过，只补缺的 */
    onlyMissing: z.boolean().optional(),
    /** 清掉本集目录下不属于当前片段集合的旧文件（含迁移前的 shot-*.mp4） */
    cleanStale: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId: given, videoPath, onlyMissing, cleanStale } = req.body;

      const script = given
        ? await u.db("o_script").where({ id: given, projectId }).first()
        : await u.db("o_script").where("projectId", projectId).first();
      if (!script) return res.status(400).send(error(`项目下没有剧本：${projectId}`));
      const scriptId = script.id as number;

      // 源片路径：请求里给的优先（还没做上传页时从外部拷进来用），否则用记录下来的
      const srcRel = (videoPath || script.sourceVideo || "").trim();
      if (!srcRel) return res.status(400).send(error("没有源片路径：请求里给 videoPath，或先给剧本写上 sourceVideo"));

      const srcAbs = await u.oss.getAbsPath(srcRel);
      if (!fs.existsSync(srcAbs)) return res.status(400).send(error(`源片不存在：${srcRel}`));

      // 记下来，下次不用再传（新上传页落地后由它写，这里顺手兜住）
      if (srcRel !== script.sourceVideo) await u.db("o_script").where("id", scriptId).update({ sourceVideo: srcRel });

      // v2：生成单位是片段。先按段取，再取段内镜（镜上带自己的源片区间）。
      const segments = await u.db("o_segment").where({ scriptId, projectId }).orderBy("segmentIndex", "asc");
      if (!segments.length) {
        return res
          .status(400)
          .send(error(`该剧本下没有结构化分镜（o_segment），先跑第 4 步解析：scriptId=${scriptId}`));
      }
      const shots = await u.db("o_shot").where({ scriptId, projectId }).orderBy(["segmentIndex", "shotIndex"]);
      const shotsBySegment = new Map<number, any[]>();
      for (const s of shots) {
        const key = Number(s.segmentId);
        const list = shotsBySegment.get(key) ?? [];
        list.push(s);
        shotsBySegment.set(key, list);
      }

      const meta = await probeVideo(srcAbs);
      const issues: Issue[] = [];

      const outDirRel = `/${projectId}/redraw-clip/${scriptId}`;
      const outDirAbs = await u.oss.getAbsPath(outDirRel);
      fs.mkdirSync(outDirAbs, { recursive: true });

      const limit = pLimit(3);
      const clips: { segmentIndex: number; clipPath: string; sec: number }[] = [];
      let skipped = 0;

      await Promise.all(
        segments.map((seg: any) =>
          limit(async () => {
            const segmentIndex = Number(seg.segmentIndex);
            const segShots = shotsBySegment.get(Number(seg.id)) ?? [];
            if (!segShots.length) {
              issues.push({ level: "error", segmentIndex, message: `片段 ${segmentIndex} 下没有镜，无法确定源片区间` });
              return;
            }

            // 按镜序把区间摊平：一段 = 这几个镜覆盖的源片区间之和
            const ranges: [number, number][] = [];
            for (const sh of segShots) {
              const parsed = parseRanges(String(sh.sourceRange ?? "").trim());
              if (!parsed) {
                issues.push({
                  level: "error",
                  segmentIndex,
                  message: `片段 ${segmentIndex} 的镜 ${sh.shotIndex} 区间解析不出来：「${sh.sourceRange ?? ""}」`,
                });
                return;
              }
              ranges.push(...parsed);
            }

            // 越界：整段落在源片之外才判错，压线（源片末尾）按钳制处理
            const clamped: [number, number][] = [];
            for (const [a, b] of ranges) {
              if (a < 0 || b <= a) {
                issues.push({ level: "error", segmentIndex, message: `片段 ${segmentIndex} 区间不合法：${a}-${b}` });
                return;
              }
              if (meta.duration && a >= meta.duration - EDGE_TOL) {
                issues.push({
                  level: "error",
                  segmentIndex,
                  message: `片段 ${segmentIndex} 区间落在源片之外：${a}-${b}（源片 ${meta.duration.toFixed(3)}s）`,
                });
                return;
              }
              if (meta.duration && b > meta.duration) {
                if (b - meta.duration > EDGE_TOL)
                  issues.push({
                    level: "warn",
                    segmentIndex,
                    message: `片段 ${segmentIndex} 区间越过源片末尾，已收到 ${meta.duration.toFixed(3)}s`,
                  });
                clamped.push([a, meta.duration]);
              } else {
                clamped.push([a, b]);
              }
            }

            const clipRel = `${outDirRel}/seg-${segmentIndex}.mp4`;
            const clipAbs = await u.oss.getAbsPath(clipRel);

            if (onlyMissing && seg.clipPath === clipRel && fs.existsSync(clipAbs)) {
              skipped++;
              return;
            }

            // 单段失败不掀桌：一段坏区间不该让其它片段也白切。
            try {
              await cutClip(srcAbs, clamped, clipAbs, meta.hasAudio);
              await u.oss.writeFile(clipRel, await fs.promises.readFile(clipAbs));

              // 自校验：切出来的时长必须等于「区间跨度之和」。
              const want = clamped.reduce((sum, [a, b]) => sum + (b - a), 0);
              const got = (await probeVideo(clipAbs)).duration;
              if (got === undefined)
                issues.push({ level: "warn", segmentIndex, message: `片段 ${segmentIndex} 切完读不到时长` });
              else if (Math.abs(got - want) > CUT_TOL)
                issues.push({
                  level: "warn",
                  segmentIndex,
                  message: `片段 ${segmentIndex} 成片 ${got.toFixed(3)}s，区间跨度 ${want.toFixed(3)}s，差 ${(got - want).toFixed(3)}s`,
                });

              await u.db("o_segment").where("id", seg.id).update({ clipPath: clipRel });
              clips.push({ segmentIndex, clipPath: clipRel, sec: got ?? want });
            } catch (e: any) {
              issues.push({ level: "error", segmentIndex, message: `片段 ${segmentIndex} 切片失败：${u.error(e).message}` });
            }
          }),
        ),
      );

      // 片段集合变小（重跑解析）后，目录里会留下没人认领的旧文件
      let removed = 0;
      if (cleanStale) {
        const wanted = new Set(segments.map((s: any) => `seg-${Number(s.segmentIndex)}.mp4`));
        for (const f of fs.readdirSync(outDirAbs)) {
          if (!wanted.has(f)) {
            await u.oss.deleteFile(`${outDirRel}/${f}`);
            removed++;
          }
        }
      }

      res.status(200).send(
        success({
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
        }),
      );
    } catch (e: any) {
      res.status(500).send(error(u.error(e).message));
    }
  },
);
