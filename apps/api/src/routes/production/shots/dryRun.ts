import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { dryRunV2 } from "@/utils/shots/dryRun";

/**
 * v2 干跑：**不改任何数据**，先看"如果翻到 v2，这一集会怎么处理"。
 *
 * 为什么需要：翻开关是有风险的动作，用户想先看清楚会发生什么。
 * 这个接口**与引擎开关无关**（legacy 下也能跑），只读：
 *   · 分镜表文本：优先用传入的 `text`，否则读工作区 `o_agentWorkData(key=productionAgent).storyboardTable`
 *   · 返回：解析结果规模 / 校验错误与警告 / 待修片段计划 / 将写入的行数 / 现有行数（看 diff 量级）
 *
 * 请求：{ projectId: number, scriptId: number, text?: string }
 */
export default express.Router().post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    text: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, text } = req.body as { projectId: number; scriptId: number; text?: string };
    try {
      const r = await dryRunV2(u.db, { projectId, scriptId, text });
      return res.status(200).send(
        success({
          source: r.source,
          ok: r.ok,
          note: r.note,
          preview: r.preview,
          existing: r.existing,
          parseErrors: r.parseErrors,
          validateErrors: r.validateErrors.map((e) => `${e.where}【${e.rule}】${e.message}`),
          warnings: r.warnings.map((w) => `${w.where}【${w.rule}】${w.message}`),
          repairPlan: r.plan ? { summary: r.plan.summary, tasks: r.plan.tasks.map((t) => ({ segmentIndex: t.segmentIndex, label: t.label, issues: t.issues.length })) } : null,
        }),
      );
    } catch (e: any) {
      return res.status(500).send(error(u.error(e).message));
    }
  },
);
