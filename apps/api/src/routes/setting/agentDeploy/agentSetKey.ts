import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b 收尾轮：本家族 6 个端点全未收权（含写供应商 key 的 agentSetKey）
import { audit, AUDIT_ACTIONS, actorFromCtx } from "@/utils/audit";
const router = express.Router();

export default router.post(
  "/",
  requireAdmin,
  validateFields({
    key: z.string().optional(),
  }),
  async (req, res) => {
    const { key } = req.body;
    const vendorConfigData = await u.db("o_vendorConfig").where("id", "miwo").first();
    if (!vendorConfigData) return res.status(500).send(error("未找到该供应商配置"));
    if (!vendorConfigData.inputValues) return res.status(500).send(error("未找到模型配置数据"));
    const inputValue = JSON.parse(vendorConfigData.inputValues!);
    inputValue.apiKey = key;
    await u
      .db("o_vendorConfig")
      .where("id", "miwo")
      .update({
        inputValues: JSON.stringify(inputValue),
      });
    // Phase 1c Task 9：写供应商凭据 ⇒ 落审计。`detail` 只记**键名**（不记 key 本身）。
    await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.VENDOR_SET_KEY, "miwo", { keys: ["apiKey"] });
    try {
      const resText = await u.Ai.Text(`miwo:claude-haiku-4-5-20251001`).invoke({
        prompt: "1+1等于几？,请直接回答2，不要解释",
      });
      if (resText.text) {
        await u.db("o_agentDeploy").where("key", "scriptAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "miwo:claude-sonnet-4-6",
          vendorId: "miwo",
        });
        await u.db("o_agentDeploy").where("key", "productionAgent").update({
          model: "claude-sonnet-4-6",
          modelName: "miwo:claude-sonnet-4-6",
          vendorId: "miwo",
        });
        await u.db("o_agentDeploy").where("key", "universalAi").update({
          model: "claude-haiku-4-5",
          modelName: "miwo:claude-haiku-4-5-20251001",
          vendorId: "miwo",
        });
        // 响应**只有固定文案**（不回显 key，也不回显掩码 —— 调用方刚把它发上来，回显无信息量）。
        res.status(200).send(success("一键填入成功"));
      }
    } catch (err) {
      console.error(err);
      inputValue.apiKey = "";
      await u
        .db("o_vendorConfig")
        .where("id", "miwo")
        .update({ inputValues: JSON.stringify(inputValue) });
      // 失败响应同样**不回显 key**（改前也不回显；这条是"自己 try/catch 的接口也不得泄漏"的守卫）。
      res.status(400).send(error("KEY无效，请重新输入"));
    }
  },
);
