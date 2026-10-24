import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { REDRAW_STATE, transitionRedrawState } from "@/redraw/state";

const router = express.Router();

/**
 * 「回退到源片版」（spec §10.6 / §4.2 的 4→2）：**只换显示与工作区快照，不删转绘结果**
 * （转绘版仍在 `o_segment` 里，重跑转绘或再确认都能回来）。
 *  · redrawState 4/3 → 2（ASSETS_OK）；资产仍算已确认，时长确认记录保留；
 *  · 3→2 也允许（用户没确认覆盖就想退）。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      await transitionRedrawState(u.db, { projectId, scriptId, to: REDRAW_STATE.ASSETS_OK, errorReason: null });
      res.status(200).send(success({ ok: true }));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "回退到源片版失败");
    }
  },
);
