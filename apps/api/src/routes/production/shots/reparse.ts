import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { runShotsShadow } from "@/utils/shots/shadowJob";

/**
 * 用手动编辑过的**分镜表文本**重建结构化数据（解析 → 校验 → 事务落库）。
 *
 * 用途：
 *   · 分镜表节点里手动改完保存（`saveFlowData` 已自动接一次，这里是显式入口，便于排查/脚本调用）；
 *   · 修好某几行后想让结构表跟上，而不必重跑整个阶段4。
 *
 * 语义：
 *   · 解析不出结构（空壳/散文）→ **不动已有行**，返回 ok=false 与原因（宁可保留旧的，也不清空）；
 *   · 解得出来但违反规则（单镜>8s、片段>15s、引用不存在资产）→ **照落库**，同时把问题列表返回（硬错误不阻断落库，
 *     因为此时"用户看到的就是这个文本"，结构必须跟上；改不改由人和监督层决定）。
 *
 * 仅在 `shotsEngine = v2` 时可用。
 */
export default express.Router().post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    text: z.string(),
  }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { projectId, scriptId, text } = req.body as { projectId: number; scriptId: number; text: string };
    const r = await runShotsShadow({ db: u.db, projectId, scriptId, replyText: text });
    return res.status(200).send(
      success({
        ok: r.ok,
        note: r.note,
        parseErrors: r.parseErrors.map((e) => `${e.where} ${e.message}`),
        validateErrors: r.validateErrors.map((e) => `${e.where}【${e.rule}】${e.message}`),
        warnings: r.warnings.map((w) => `${w.where}【${w.rule}】${w.message}`),
        segments: r.persisted?.segments ?? 0,
        shots: r.persisted?.shots ?? 0,
        bindings: r.persisted?.bindings ?? 0,
        repairPlan: r.plan?.summary ?? null,
      }),
    );
  },
);
