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
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    // 阶段2：v2（多参模式）不出分镜图，传进来的 id 是**片段/镜 id**。
    // ⚠ 拿它查 o_storyboard 会返回"编号撞上的历史行"，前端会把那些 state 写到卡片上（状态被污染）。
    if ((await readShotsEngine(u.db)) === "v2") {
      return res.status(200).send(success([]));
    }
    const data = await u.db("o_storyboard").whereIn("id", ids).whereNot("state", "生成中").select("id", "state", "reason", "filePath", "prompt");
    const result = await Promise.all(
      data.map(async (item: any) => ({
        ...item,
        src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : null,
      })),
    );
    res.status(200).send(success(result));
  },
);
