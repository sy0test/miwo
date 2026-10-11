import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { updateSegment } from "@/utils/shots/editShots";

/**
 * 改一个片段（videoDesc / prompt / state）。请求：{ segmentId, patch }
 * 说明：`duration` 不在可改字段里 —— 片段时长永远等于其镜之和（由 `recalcSegmentDuration` 维护）。
 */
export default express.Router().post(
  "/",
  validateFields({
    segmentId: z.number(),
    patch: z.object({
      videoDesc: z.string().optional(),
      prompt: z.string().optional(),
      state: z.string().optional(),
    }),
  }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { segmentId, patch } = req.body as { segmentId: number; patch: any };
    const r = await updateSegment(u.db, segmentId, patch);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success(r.data));
  },
);
