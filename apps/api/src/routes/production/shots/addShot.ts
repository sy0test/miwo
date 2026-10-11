import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { addShot } from "@/utils/shots/editShots";

/**
 * 往一个片段末尾加一条镜（分镜台"新建分镜"）。
 * 请求：{ segmentId, shot: { duration, shotSize?, camera?, light?, action?, dialogue?, sfx?, assetIds? } }
 * 校验：单镜 ≤8s、加完之后片段合计 ≤15s、资产 ID 必须存在；失败不写库。
 */
export default express.Router().post(
  "/",
  validateFields({
    segmentId: z.number(),
    shot: z.object({
      duration: z.number(),
      shotSize: z.string().optional(),
      camera: z.string().optional(),
      light: z.string().optional(),
      action: z.string().optional(),
      dialogue: z.string().optional(),
      sfx: z.string().optional(),
      assetIds: z.array(z.number()).optional(),
    }),
  }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { segmentId, shot } = req.body as { segmentId: number; shot: any };
    const r = await addShot(u.db, segmentId, shot);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success(r.data));
  },
);
