import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { updateAsset } from "@/redraw/assets";

const router = express.Router();

/**
 * 修改**本集认账清单里**的资产（改名/说明/提示词/性别）。
 * 复用项目已有资产时只补空、不覆盖用户改过的 describe/prompt（G8）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    assetId: z.number(),
    patch: z
      .object({
        name: z.string().optional(),
        describe: z.string().optional(),
        prompt: z.string().optional(),
        gender: z.string().optional(),
      })
      .default({}),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId, assetId, patch } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await updateAsset(u.db, { projectId, scriptId, assetId, patch })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "修改资产失败");
    }
  },
);
