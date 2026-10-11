import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    url: z.string(),
    flowId: z.number(),
  }),
  async (req, res) => {
    const { id, url, flowId } = req.body;
    // 阶段2：v2（多参模式）不出分镜图，这一格 id 是**片段 id**。
    // ⚠ 不加拦截会拿片段 id 去更 o_storyboard —— 改到的是编号撞上的历史行。
    if ((await readShotsEngine(u.db)) === "v2") {
      return res.status(200).send(success({ message: "本集为结构化分镜（多参模式），不需要写分镜图，已忽略" }));
    }
    await u
      .db("o_storyboard")
      .where({ id })
      .update({
        filePath: u.replaceUrl(url),
        flowId,
        state: "已完成",
        shouldGenerateImage:url ? 1 : 0
      });
    res.status(200).send(success({ message: "更新分镜成功" }));
  },
);
