import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { confirmAssets } from "@/redraw/assets";

const router = express.Router();

/**
 * 「全部确认」：落 `o_assets` + `o_scriptAssets`，成功后 `redrawState=2`。
 * 返回 `{ created, reused, linked }`。事务内完成；重复确认幂等（只补缺失挂链）。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await confirmAssets(u.db, { projectId, scriptId })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "确认资产失败");
    }
  },
);
