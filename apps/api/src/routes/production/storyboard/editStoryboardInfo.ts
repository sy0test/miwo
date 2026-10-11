import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { updateSegment } from "@/utils/shots/editShots";
import { NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    prompt: z.string(),
    videoDesc: z.string(),
  }),
  async (req, res) => {
    const { id, prompt, videoDesc } = req.body;
    // 【退役后】v2 是唯一写入端："面板卡片"就是片段 → 改的是 o_segment 的 prompt/videoDesc。
    // 旧路径（写没人读的 o_storyboard）已按退役清单删除，改为明确提示。
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error(NOT_STRUCTURED_HINT));
    const r = await updateSegment(u.db, id, { prompt, videoDesc });
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success({ message: "更新提示词成功" }));
  },
);
