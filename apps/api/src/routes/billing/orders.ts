import express from "express";
import u from "@/utils";
import { currentTenant } from "@/db/tenant-context";
import { pageQuery, requestedUserId } from "@/billing/routeScope";

const router = express.Router();
router.get("/", async (req, res) => {
  const parsed = pageQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).send({ code: 400, data: null, message: "分页参数无效" });
  const requested = requestedUserId(req, res);
  if (requested === null) return;
  const ctx = currentTenant();
  if (!ctx) return res.status(401).send({ code: 401, data: null, message: "未提供token" });
  const rows = await u.db("o_order").select(
    "id", "userId", "outTradeNo", "channel", "amountMicro", "status", "paidAt", "type", "externalTradeId", "operatorId", "operatorNote", "createdAt", "updatedAt",
  ).orderBy("createdAt", "desc").orderBy("id", "desc").limit(parsed.data.limit).offset(parsed.data.offset);
  res.status(200).send({ code: 200, data: rows, message: "成功" });
});

export default router;
