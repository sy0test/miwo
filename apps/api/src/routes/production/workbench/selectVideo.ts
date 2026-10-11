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
    trackId: z.number(),
    videoId: z.number(),
  }),
  async (req, res) => {
    const { trackId, videoId } = req.body;
    // 阶段2：v2 下「轨道」就是片段（o_segment），两表字段名一致；默认仍写 o_videoTrack
    await updateTrackById(u.db, trackId, { videoId: videoId });
    res.status(200).send(success({ message: "视频选择成功" }));
  },
);
