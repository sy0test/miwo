import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { updateTrackByVideoId } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    await u.db("o_video").where("id", id).delete();
    // 清掉"这条视频挂在哪一段上"的引用：v2 走 o_segment，否则 o_videoTrack
    await updateTrackByVideoId(u.db, id, { videoId: null });
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);
