import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { getDrafts } from "@/redraw/assets";

const router = express.Router();

/**
 * 资产认账数据（会话页第②步 / 资产页「本集待确认」面板共用）。
 * 返回 `{ drafts, existing, bindings, segments, segmentCap }`，字段名是前端契约。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await getDrafts(u.db, { projectId, scriptId })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "读取资产草稿失败");
    }
  },
);
