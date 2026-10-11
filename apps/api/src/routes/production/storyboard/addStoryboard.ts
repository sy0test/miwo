import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireStructured, NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
import { addSegmentWithShot } from "@/utils/shots/editShots";
const router = express.Router();
interface Storyboard {
  id: number;
  track: string;
  src: string | null;
  associateAssetsIds: number[];
  duration: number;
  state: string;
}
export default router.post(
  "/",
  validateFields({
    prompt: z.string(),
    duration: z.number(),
    state: z.string(),
    videoDesc: z.string(),
    shouldGenerateImage: z.number(),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { prompt, duration, state, scriptId, projectId, videoDesc } = req.body;

    // 【退役后】v2 是唯一写入端：加一张卡片 = 新建一个片段 + 一条占位镜
    //（新表里片段时长 = 镜之和，不给镜就会造出"时长 0 的空片段"—— 正是旧"空轨道"的翻版）。
    // 旧的"轨道复用 + 写 o_storyboard"整段已按 docs/legacy-retirement-plan.md 删除，改为明确提示。
    if (!(await requireStructured(u.db, scriptId))) return res.status(400).send(error(NOT_STRUCTURED_HINT));

    const r = await addSegmentWithShot(u.db, {
      projectId,
      scriptId,
      prompt,
      videoDesc,
      duration,
      state: state || "未生成",
    });
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success({ id: r.data!.id, trackId: r.data!.id }));
  },
);
