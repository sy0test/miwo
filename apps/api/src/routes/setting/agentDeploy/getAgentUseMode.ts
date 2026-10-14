import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b 收尾轮：本家族 6 个端点全未收权（含写供应商 key 的 agentSetKey）

const router = express.Router();

export default router.get("/", requireAdmin, async (req, res) => {
  const useMode = await u.db("o_setting").where("key", "agentUseMode").first();
  console.log("%c Line:9 🍓 useMode", "background:#33a5ff", useMode);
  res.status(200).send(success(useMode?.value || "0"));
});
