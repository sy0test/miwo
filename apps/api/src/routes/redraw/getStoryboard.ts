import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { readSegmentViews, readSourceStoryboard, readStoryboardChanges } from "@/redraw/storyboardWrite";

const router = express.Router();

/**
 * 并排确认页的数据（M3）：`{ source, redraw, changes }`。
 *  · source = 转绘层覆盖前写下的**源片分镜快照**；还没生成过时退回"当前分镜"（页面不会空着）；
 *  · redraw = 当前 `o_segment` 的视图；
 *  · changes = 模型给的变更摘要条目。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      const [snapshot, current, changes] = await Promise.all([
        readSourceStoryboard(u.db, { projectId, scriptId }),
        readSegmentViews(u.db, { projectId, scriptId }),
        readStoryboardChanges(u.db, { projectId, scriptId }),
      ]);
      res.status(200).send(success({ source: snapshot?.segments ?? current, redraw: current, changes }));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "读取转绘分镜失败");
    }
  },
);
