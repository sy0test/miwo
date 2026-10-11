import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { deleteShot } from "@/utils/shots/editShots";

/** 删一条镜（连同它的资产绑定），删完重排镜序并回填片段时长。请求：{ shotId } */
export default express.Router().post(
  "/",
  validateFields({ shotId: z.number() }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { shotId } = req.body as { shotId: number };
    const r = await deleteShot(u.db, shotId);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success(r.data));
  },
);
