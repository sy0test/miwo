import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { mergeBrief, saveBrief, loadBrief, type EpisodeBrief } from "@/utils/shots/episodeBrief";

/**
 * 写「本集约定」（`o_script.brief`）。
 *
 * 用途：用户在对话里提的硬约束（如「台词只保留英文题词口播」）此前只活在会被压缩的会话记忆里，
 * 执行层/监督层根本读不到 → 到阶段4 就丢了。落成集级数据后，由代码在每次派发时注入三层。
 *
 * 这是**过渡期**的写入口：界面/决策层自动写入在后续步骤接。
 * 请求：{ scriptId, brief: { constraints?: string[], dialogueLanguage?, dialogueSource?, notes? } }
 * 语义：与已有约定**合并**（constraints 去重追加），不是覆盖。
 */
export default express.Router().post(
  "/",
  validateFields({
    scriptId: z.number(),
    brief: z.any(),
  }),
  async (req, res) => {
    const { scriptId, brief } = req.body as { scriptId: number; brief: Partial<EpisodeBrief> };
    const prev = await loadBrief(u.db, scriptId);
    const next = mergeBrief(prev, brief ?? {});
    await saveBrief(u.db, scriptId, next);
    return res.status(200).send(success(next));
  },
);
