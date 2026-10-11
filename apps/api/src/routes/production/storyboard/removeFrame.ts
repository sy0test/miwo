import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { deleteSegment } from "@/utils/shots/editShots";
import { NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;

    // 【退役后】v2 是唯一写入端：这一格就是**片段**（id 是 o_segment.id）。
    // ⚠ 不加这个判断、拿片段 id 去删 o_storyboard 会删掉**编号撞上的别的历史行** ——
    // 所以旧路径整段已按退役清单删除，未结构化的集直接给明确提示。
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error(NOT_STRUCTURED_HINT));
    const r = await deleteSegment(u.db, id);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success({ message: "视频删除成功", removedShots: r.data!.shots }));
  },
);
