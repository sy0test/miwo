import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { deleteSegment } from "@/utils/shots/editShots";

/** 删一个片段（连同它的镜与资产绑定）—— 等价于旧的"删掉工作台上这一段"，但不再留孤儿。请求：{ segmentId } */
export default express.Router().post(
  "/",
  validateFields({ segmentId: z.number() }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { segmentId } = req.body as { segmentId: number };
    const r = await deleteSegment(u.db, segmentId);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success(r.data));
  },
);
