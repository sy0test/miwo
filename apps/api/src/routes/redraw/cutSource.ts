import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cutClip, probeVideo } from "@/utils/ffmpeg";
import { CutSourceError, cutSourceClips } from "@/redraw/cutClips";

const router = express.Router();

/**
 * 出海转绘 · 第 5 步：按**片段**把源片切成本段一个参考视频。
 *
 * 2026-10-21 迁 v2 后的口径（用户决策：切原片**按段**，不按镜）：
 *   - 片段 = `o_segment`（生成单位）；它的源片区间由段内各镜 `o_shot.sourceRange` 按顺序拼起来；
 *   - 产物：`/{projectId}/redraw-clip/{scriptId}/seg-{segmentIndex}.mp4`，路径写回 `o_segment.clipPath`；
 *   - 工作台把它作为 `sources:"clip"` 的**参考视频**挂到该段上。
 *
 * ⚠ 内核已抽到 `src/redraw/cutClips.ts`（M3-G9）：确认覆盖（confirmStoryboard）调的是**同一个函数**，
 *   否则"手动切"与"确认后自动切"迟早漂成两套。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    videoPath: z.string().optional(),
    onlyMissing: z.boolean().optional(),
    cleanStale: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const r = await cutSourceClips(u.db as any, u.oss, req.body, { probeVideo, cutClip });
      res.status(200).send(success(r));
    } catch (e: any) {
      if (e instanceof CutSourceError) return res.status(e.status).send(error(e.message));
      res.status(500).send(error(u.error(e).message));
    }
  },
);
