import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cutClip, probeVideo } from "@/utils/ffmpeg";
import { CutSourceError, cutSourceClips } from "@/redraw/cutClips";
import { requireOwnedScript, sendRedrawRouteError } from "@/redraw/http";
import { REDRAW_STATE, transitionRedrawState } from "@/redraw/state";

const router = express.Router();

/**
 * 「确认覆盖并进入制作」（M3 / spec §10.6）：
 *  1. `redrawState → 4`（3/4 → 4 合法；幂等）；
 *  2. 按**最终段集合**自动切原片：`cutSourceClips({ onlyMissing: true, cleanStale: true })`（G9）。
 *     已有 clip 且文件在就复用；段集合变化留下的旧文件被清掉。
 *
 * ⚠ 切原片失败**不把状态回滚**（用户已经确认了分镜；切片问题可以「重切」）：
 *   issues 原样返回，前端提示「N 段切片失败，请重切」。
 */
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number(), fast: z.boolean().optional() }),
  async (req, res) => {
    try {
      const { projectId, scriptId, fast } = req.body;
      await requireOwnedScript(u.db, projectId, scriptId);
      // fast=true：「资产确认 → 直接进分镜板」的新流程：不再生成/并排确认转绘分镜，
      // 沿用解析阶段已落库的分镜，把状态从 2 顺推 3→4（不做越级写，保持状态机白名单干净）。
      if (fast) {
        const row = await u.db("o_script").where({ id: scriptId, projectId }).first("redrawState");
        if (Number(row?.redrawState ?? 0) === REDRAW_STATE.ASSETS_OK) {
          await transitionRedrawState(u.db, { projectId, scriptId, to: REDRAW_STATE.STORYBOARD_READY, errorReason: null });
        }
      }
      await transitionRedrawState(u.db, { projectId, scriptId, to: REDRAW_STATE.CONFIRMED, errorReason: null });

      let cut: { total: number; cut: number; skipped: number; removed: number; issues: unknown[] } | null = null;
      let cutError: string | null = null;
      try {
        const r = await cutSourceClips(u.db as any, u.oss, { projectId, scriptId, onlyMissing: true, cleanStale: true }, { probeVideo, cutClip });
        cut = { total: r.total, cut: r.cut, skipped: r.skipped, removed: r.removed, issues: r.issues };
      } catch (e: any) {
        // 源片不在/没有分镜这类错误只影响切片，不影响"已确认覆盖"这个事实
        cutError = e instanceof CutSourceError ? e.message : (e?.message ?? String(e));
      }
      res.status(200).send(success({ ok: true, cut, cutError }));
    } catch (e: any) {
      sendRedrawRouteError(res, e, "确认转绘分镜失败");
    }
  },
);
