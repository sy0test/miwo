import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getEpisodeState } from "@/redraw/state";
import { sendRedrawRouteError } from "@/redraw/http";

const router = express.Router();

/**
 * 一集的完整转绘状态（M2 会话页 / 输入页轮询用）。
 *
 * 返回字段是**前端契约**（联调定稿，勿改名）：
 * `{ extractState, redrawState, stage, progress, segmentCount, assetTotal, assetsConfirmed, clipsReady, segmentCap, capConfirmed }`
 *
 * 跨租户在守卫层查不到 ⇒ 返回 400（不区分"不存在"与"不是你的"，避免探测）。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      const state = await getEpisodeState(u.db, { projectId, scriptId });
      if (!state) return res.status(400).send({ code: 400, data: null, message: "项目或这一集不存在：" + projectId + "/" + scriptId });
      res.status(200).send(success(state));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "读取集状态失败");
    }
  },
);
