import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { bindDraft } from "@/redraw/assets";

const router = express.Router();

/** 把一条草稿绑到项目里已有的资产（复用）。 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number(), draftName: z.string().min(1), assetId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId, draftName, assetId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await bindDraft(u.db, { projectId, scriptId, draftName, assetId })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "绑定资产失败");
    }
  },
);
