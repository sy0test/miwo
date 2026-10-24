import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { SegmentCapError, confirmSegmentCap } from "@/redraw/cap";

const router = express.Router();

/**
 * 会话页第③步：确认单段上限。
 *
 * · 不改值 ⇒ `{ ok: true }`（只写"已确认"记录，第③步闸门打开）；
 * · 改值且没带 `force` ⇒ **HTTP 409 + body.data.needRerun = true**（前端弹"需要重跑解析"确认框）；
 * · 改值且 `force: true` ⇒ 写项目并留审计，`{ ok: true }`。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number(), seconds: z.number(), force: z.boolean().optional() }),
  async (req, res) => {
    try {
      const { projectId, scriptId, seconds, force } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      const r = await confirmSegmentCap(u.db, { projectId, scriptId, seconds, force });
      res.status(200).send(success({ ok: true, changed: r.changed }));
    } catch (e: any) {
      if (e instanceof SegmentCapError) {
        if (e.code === "need_rerun") {
          return res.status(409).send({ code: 409, data: { needRerun: true }, message: e.message });
        }
        return res.status(400).send({ code: 400, data: null, message: e.message });
      }
      sendRedrawRouteError(res, e, "确认单段上限失败");
    }
  },
);
