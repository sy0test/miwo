import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b 收尾轮：本家族 6 个端点全未收权（含写供应商 key 的 agentSetKey）
const router = express.Router();

export default router.post(
  "/",
  requireAdmin,
  validateFields({
    agentUseMode: z.string(),
  }),
  async (req, res) => {
    const { agentUseMode } = req.body;
    await u.db("o_setting").where("key", "agentUseMode").update({
      value: agentUseMode,
    });
    res.status(200).send(success("保存设置成功"));
  },
);
