import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { trackTableForId } from "@/utils/shots/readShots";
import { NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
const router = express.Router();

/**
 * 删除工作台上的一条"轨道"卡片 —— v2 下这一条就是**片段**（o_segment）：
 * 删除语义 = 连它的镜与资产绑定一起删（不留孤儿）。
 *
 * 旧链路的两处毛病（都已随退役删掉，这里留档说明为什么要这么删）：
 *   1. 旧实现只删 `o_videoTrack` 行 + 把分镜下 `trackId` 置 null → **分镜从工作台永久消失**
 *      （`getGenerateData` 按 `storyboardTrackRecord[i.trackId]` 归组，null 不进任何轨道，
 *       而 `reconcileTracks` 只处理 `track IS NOT NULL` 的行，补不回来）。
 *   2. 只删轨道不删分镜行 → 残留"没有轨道的分镜"，界面上再也看不到。
 */
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;

    // 【退役后】v2 是唯一写入端；非结构化老集给出明确提示（旧删除路径已按退役清单删除）
    if ((await trackTableForId(u.db, id)) !== "o_segment") return res.status(400).send(error(NOT_STRUCTURED_HINT));

    const shots = await u.db("o_shot").where("segmentId", id).select("id");
    const shotIds = shots.map((r: any) => r.id);
    if (shotIds.length) await u.db("o_shotAssets").whereIn("shotId", shotIds).delete();
    await u.db("o_shot").where("segmentId", id).delete();
    await u.db("o_segment").where("id", id).delete();
    return res.status(200).send(success({ message: "片段删除成功", removedShots: shotIds.length }));
  },
);
