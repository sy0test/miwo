import express from "express";
import fs from "fs";
import path from "path";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cutClip, probeVideo } from "@/utils/ffmpeg";
import { parseRanges } from "@/utils/redraw";

const router = express.Router();

/**
 * 出海转绘 · 第 5 步：按 `o_storyboard.sourceRange` 把源片切成每镜一个片段。
 *
 * 产物落在 `/{projectId}/redraw-clip/{scriptId}/shot-{index}.mp4`，路径写回
 * `o_storyboard.clipPath`。第 7 步的工作台把它作为**参考视频**挂到该镜所在轨道上
 * （`generateVideo` 认 `sources="clip"`，走 vendor 的 `videoReference`）。
 *
 * 纯本地 ffmpeg，不调模型 —— 这一整步零成本，可以反复跑。
 *
 * ⚠ 生成端吃视频的是**供应商**（Seedance 的 reference_video），不是文本模型：
 * 中继（真 OpenAI）不吃视频，所以「带原视频作参考」永远不走模型输入这条路。
 */

/** 允许的越界余量：源片末端的区间常常正好写在总时长上，ffprobe 报的数会差几毫秒 */
const EDGE_TOL = 0.05;
/** 成片时长与「区间跨度之和」的允许偏差。ffmpeg 边界落在帧上，差一帧是正常的 */
const CUT_TOL = 0.1;

type Issue = { level: "error" | "warn"; shotIndex?: number; message: string };

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    /** 源片的 OSS 相对路径（如 `/1790693701128/source/a.mp4`）。不给就用 o_script.sourceVideo */
    videoPath: z.string().optional(),
    /** 已有片段就跳过，只补缺的 */
    onlyMissing: z.boolean().optional(),
    /** 清掉本集目录下不属于当前分镜集合的旧片段文件 */
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

      const shots = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
      if (!shots.length) return res.status(400).send(error(`该剧本下没有分镜，先跑第 4 步解析：scriptId=${scriptId}`));

      const meta = await probeVideo(srcAbs);
      const issues: Issue[] = [];

      const outDirRel = `/${projectId}/redraw-clip/${scriptId}`;
      const outDirAbs = await u.oss.getAbsPath(outDirRel);
      fs.mkdirSync(outDirAbs, { recursive: true });

      const limit = pLimit(3);
      const clips: { index: number; clipPath: string; sec: number }[] = [];
      let skipped = 0;

      await Promise.all(
        shots.map((s: any) =>
          limit(async () => {
            const ranges = parseRanges((s.sourceRange ?? "").trim());
            if (!ranges) {
              issues.push({ level: "error", shotIndex: s.index, message: `第 ${s.index} 镜的源片区间解析不出来：「${s.sourceRange ?? ""}」` });
              return;
            }
            // 越界：整段落在源片之外才判错，压线（源片末尾）按钳制处理
            const clamped: [number, number][] = [];
            for (const [a, b] of ranges) {
              if (a < 0 || b <= a) {
                issues.push({ level: "error", shotIndex: s.index, message: `第 ${s.index} 镜区间不合法：${a}-${b}` });
                return;
              }
              if (meta.duration && a >= meta.duration - EDGE_TOL) {
                issues.push({ level: "error", shotIndex: s.index, message: `第 ${s.index} 镜区间落在源片之外：${a}-${b}（源片 ${meta.duration.toFixed(3)}s）` });
                return;
              }
              if (meta.duration && b > meta.duration) {
                // 压线不算问题：最后一个镜的区间本来就写在整个源片的末尾上，
                // 而 ffprobe 报的总时长与切点表能差几毫秒。只有真的越过去才报。
                if (b - meta.duration > EDGE_TOL)
                  issues.push({ level: "warn", shotIndex: s.index, message: `第 ${s.index} 镜区间越过源片末尾，已收到 ${meta.duration.toFixed(3)}s：「${s.sourceRange}」` });
                clamped.push([a, meta.duration]);
              } else {
                clamped.push([a, b]);
              }
            }

            const clipRel = `${outDirRel}/shot-${s.index}.mp4`;
            const clipAbs = await u.oss.getAbsPath(clipRel);

            if (onlyMissing && s.clipPath === clipRel && fs.existsSync(clipAbs)) {
              skipped++;
              return;
            }

            // 单镜失败不掀桌：一条坏区间不该让另外十五个片段也白切。
            // 错误按镜报出来，成功的照常落库。
            try {
              await cutClip(srcAbs, clamped, clipAbs, meta.hasAudio);

              // 自校验：切出来的时长必须等于「区间跨度之和」。
              // 不去比 o_storyboard.duration —— 那是技能给生成器用的**取整后**秒数
              // （向上取整、下限 4s），天然大于区间跨度，拿它比对会报一堆假警。
              const want = clamped.reduce((sum, [a, b]) => sum + (b - a), 0);
              const got = (await probeVideo(clipAbs)).duration;
              if (got === undefined) issues.push({ level: "warn", shotIndex: s.index, message: `第 ${s.index} 镜切完读不到时长` });
              else if (Math.abs(got - want) > CUT_TOL)
                issues.push({ level: "warn", shotIndex: s.index, message: `第 ${s.index} 镜成片 ${got.toFixed(3)}s，区间跨度 ${want.toFixed(3)}s，差 ${(got - want).toFixed(3)}s` });

              await u.db("o_storyboard").where("id", s.id).update({ clipPath: clipRel });
              clips.push({ index: s.index, clipPath: clipRel, sec: got ?? want });
            } catch (e: any) {
              issues.push({ level: "error", shotIndex: s.index, message: `第 ${s.index} 镜切片失败：${u.error(e).message}` });
            }
          }),
        ),
      );

      // 分镜集合变小（重跑解析）后，目录里会留下没人认领的旧片段
      let removed = 0;
      if (cleanStale) {
        const wanted = new Set(shots.map((s: any) => `shot-${s.index}.mp4`));
        for (const f of fs.readdirSync(outDirAbs)) {
          if (!wanted.has(f)) {
            fs.unlinkSync(path.join(outDirAbs, f));
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
          total: shots.length,
          cut: clips.length,
          skipped,
          removed,
          clips: clips.sort((a, b) => a.index - b.index),
          issues,
        }),
      );
    } catch (e: any) {
      res.status(500).send(error(u.error(e).message));
    }
  },
);
