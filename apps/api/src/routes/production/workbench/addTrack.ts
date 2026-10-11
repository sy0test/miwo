import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { trackTableForScript, nextSegmentIndex, NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
import { addShot } from "@/utils/shots/editShots";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    duration: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, duration } = req.body;

    // 【退役后】v2 是唯一写入端：「新增段」= 新增一个**片段**（序号接在该集现有片段之后）。
    // 旧实现（给 o_videoTrack 手工生成 id —— 同一毫秒连建会撞主键，所以还要 newTrackId 防撞）
    // 已按 docs/legacy-retirement-plan.md 删除；未结构化的集给出明确提示。
    if ((await trackTableForScript(u.db, scriptId)) !== "o_segment") return res.status(400).send(error(NOT_STRUCTURED_HINT));

    const segmentIndex = await nextSegmentIndex(u.db, scriptId);
    const now = Date.now();
    // ⚠ 必须**同时建一条占位镜**：只建片段会立刻产生"空片段"（旧链路空轨道的等价物），
    // 真机上就这么出现过一个（片段 0 镜、时长 4s、无 videoDesc）—— 校验里的"片段至少一镜"也会报错。
    const [id] = await u.db("o_segment").insert({
      projectId,
      scriptId,
      segmentIndex,
      sceneIndex: 0,
      sceneTitle: "",
      duration: 0,
      videoDesc: "",
      state: "未生成",
      // 1 = 用户手工新增：分镜表文本里没有它的位置，重解析（保存分镜表/重跑阶段4）时要**保住它和它的绑定**
      manual: 1,
      createTime: now,
      updateTime: now,
    });
    // 占位镜时长：把传入时长夹到 1..8s（单镜上限），默认 4s
    const shotSec = Math.min(Math.max(Number(duration) || 4, 1), 8);
    await addShot(u.db, Number(id), { duration: shotSec });
    return res.status(200).send(success(id));
  },
);
