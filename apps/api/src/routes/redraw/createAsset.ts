import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { createAsset } from "@/redraw/assets";

const router = express.Router();

/**
 * 按草稿新建资产。返回 `{ id }`。
 * 出图复用现有资产出图路由（这里不新增出图链路，G8）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    draftName: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["role", "scene", "tool"]),
    describe: z.string().optional(),
    prompt: z.string().optional(),
    gender: z.string().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId, draftName, name, type, describe, prompt, gender } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      const r = await createAsset(u.db, { projectId, scriptId, draftName, name, type, describe, prompt, gender });
      res.status(200).send(success(r));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "新建资产失败");
    }
  },
);
