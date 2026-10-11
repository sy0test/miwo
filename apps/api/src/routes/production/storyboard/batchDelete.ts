import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { deleteSegment } from "@/utils/shots/editShots";
import { NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { ids } = req.body;
    if (!ids.length) return res.status(400).send(error("请先选择分镜"));

    // 【退役后】v2 是唯一写入端：删"卡片"= 删片段（级联删它的镜与绑定，不留孤儿）。
    // 旧路径（删 o_storyboard / o_assets2Storyboard / o_imageFlow）已按退役清单删除。
    // 这些 id 在 o_segment 里一个都找不到 → 说明是本集还没结构化，给出明确提示。
    const existing = await u.db("o_segment").whereIn("id", ids).select("id");
    if (!existing.length) return res.status(400).send(error(NOT_STRUCTURED_HINT));

    let removed = 0;
    for (const id of ids) {
      const r = await deleteSegment(u.db, id);
      if (r.ok) removed += 1;
    }
    return res.status(200).send(success({ message: "视频删除成功", removed }));
  },
);
