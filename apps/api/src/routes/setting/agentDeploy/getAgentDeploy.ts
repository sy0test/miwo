import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b 收尾轮：本家族 6 个端点全未收权（含写供应商 key 的 agentSetKey）
const router = express.Router();

export default router.post("/", requireAdmin, async (req, res) => {
  const allData = await u.db("o_agentDeploy").leftJoin("o_vendorConfig", "o_vendorConfig.id", "o_agentDeploy.vendorId").select("o_agentDeploy.*");
  const qrdinaryData = allData.filter((item: any) => !item.key?.includes(":"));
  const advancedData = allData.filter((item: any) => item.key?.includes(":") || item.key == "universalAi");
  res.status(200).send(success({ qrdinaryData, advancedData }));
});
