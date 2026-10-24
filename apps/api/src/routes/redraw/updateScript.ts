import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { writeRedrawScript } from "@/redraw/script";

const router = express.Router();

/** 会话页第①步：存剧本正文（自动保存 2s 防抖调用）。返回 `{ changed }`。 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number(), content: z.string() }),
  async (req, res) => {
    try {
      const { projectId, scriptId, content } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      res.status(200).send(success(await writeRedrawScript(u.db, { projectId, scriptId, content })));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "保存剧本失败");
    }
  },
);
