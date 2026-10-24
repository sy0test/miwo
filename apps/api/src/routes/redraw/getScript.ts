import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { readRedrawScript } from "@/redraw/script";

const router = express.Router();

/** 会话页第①步：读剧本正文。返回 `{ content, name }`。 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await readRedrawScript(u.db, { projectId, scriptId })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "读取剧本失败");
    }
  },
);
