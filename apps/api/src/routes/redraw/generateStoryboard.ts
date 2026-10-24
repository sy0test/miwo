import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueJobInTransaction } from "@/jobs";
import { currentUserId } from "@/jobs/context";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";

const router = express.Router();

/**
 * 生成转绘分镜（M3）：只入队，不 fire-and-forget。
 * 返回 `{ jobId, deduped }`；同一集的活跃任务被幂等键 `redraw.storyboard:{projectId}:{scriptId}` 吞掉。
 * 资产没确认时 job 会失败（409 语义写在 errorReason 里）；这里不预检，避免与 job 的判据漂。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    try {
      const { projectId, scriptId } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      const result = await u.db.transaction(async (trx: any) =>
        enqueueJobInTransaction(trx, { type: "redraw.storyboard", userId: currentUserId(req), payload: { projectId, scriptId } }),
      );
      res.status(200).send(success({ jobId: Number(result.jobId), deduped: !result.created }));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "生成转绘分镜失败");
    }
  },
);
