import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { updateTrackById } from "@/utils/shots/readShots";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    prompt: z.string().optional(),
  }),
  async (req, res) => {
    const { id, prompt, duration } = req.body;
    // v2 下写 o_segment，默认写 o_videoTrack（字段名一致）
    await updateTrackById(u.db, id, { prompt });
    res.status(200).send(success("更新成功"));
  },
);
