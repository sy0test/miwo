import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { trackTableForScript } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackIds } = req.body;
    // 阶段2：v2 下提示词写在片段表上（字段名一致）
    const trackTable = await trackTableForScript(u.db, scriptId);
    const promptList = await u
      .db(trackTable)
      .where("projectId", projectId)
      .where("scriptId", scriptId)
      .whereIn("id", trackIds)
      .whereIn("state", ["已完成", "生成失败"])
      .select("id", "state", "reason", "prompt");
    res.status(200).send(success(promptList));
  },
);
