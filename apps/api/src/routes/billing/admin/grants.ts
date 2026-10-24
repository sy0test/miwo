import express from "express";
import { z } from "zod";
import { requireAdmin } from "@/middleware/auth";
import { actorFromCtx, audit } from "@/utils/audit";
import { inAdminTargetTenant, respondError } from "@/billing/routeScope";
import u from "@/utils";
import { grantIdentityKey } from "@/billing/grantIdentity";
import { isUniqueConstraintError } from "@/billing/isUniqueConstraintError";

const schema = z.object({
  userId: z.number().int().positive().safe(),
  agentKey: z.string().min(1).max(64).optional(),
  vendorId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  enabled: z.boolean().default(true),
  dailyLimit: z.number().int().min(0).safe().nullable().optional(),
}).strict();

const router = express.Router();
router.post("/", requireAdmin, async (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return respondError(res, 400, "模型授权参数无效");
  const grant = parsed.data;
  const hasAgent = grant.agentKey !== undefined;
  const hasModel = grant.vendorId !== undefined && grant.model !== undefined;
  if (hasAgent === hasModel || (grant.vendorId !== undefined) !== (grant.model !== undefined)) {
    return respondError(res, 400, "授权必须指定 agentKey 或 vendorId 与 model");
  }
  if (hasModel) return respondError(res, 400, "服务商模型授权请通过用户组与模型组管理");
  const actor = actorFromCtx(req.ip);
  try {
    const result = await inAdminTargetTenant(grant.userId, async () => {
      const target = await u.db("o_user").where({ id: grant.userId }).first("id", "status");
      if (!target) return { missing: true as const };
      const existing = await (u.db as any)("o_modelGrant")
        .where({ userId: grant.userId })
        .modify((query: any) => {
          if (hasAgent) query.where({ agentKey: grant.agentKey });
          else query.where({ vendorId: grant.vendorId, model: grant.model });
        })
        .first("id");
      if (existing) return { conflict: true as const };
      const record = {
        userId: grant.userId,
        agentKey: grant.agentKey ?? null,
        vendorId: grant.vendorId ?? null,
        model: grant.model ?? null,
        identityKey: grantIdentityKey(grant),
        enabled: grant.enabled,
        dailyLimit: grant.dailyLimit ?? null,
        createdAt: Date.now(),
      };
      const [id] = await (u.db as any)("o_modelGrant").insert(record);
      return { record, id };
    });
    if ("missing" in result) return respondError(res, 404, "目标账号不存在");
    if ("conflict" in result) return respondError(res, 409, "相同模型授权已存在");
    await audit(actor, "billing.grant.create", String(grant.userId), result.record);
    return res.status(201).send({ code: 201, data: { id: result.id, ...result.record }, message: "模型授权已创建" });
  } catch (error) {
    if (isUniqueConstraintError(error)) return respondError(res, 409, "相同模型授权已存在");
    next(error);
  }
});

export default router;
