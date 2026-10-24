import express from "express";
import { z } from "zod";
import { requireAdmin } from "@/middleware/auth";
import { actorFromCtx, audit } from "@/utils/audit";
import u from "@/utils";
import { respondError } from "@/billing/routeScope";
import { isUniqueConstraintError } from "@/billing/isUniqueConstraintError";

const MAX_U64 = 18_446_744_073_709_551_615n;
const schema = z.object({
  vendorId: z.string().min(1).max(32),
  model: z.string().min(1).max(96),
  unit: z.enum(["token", "call", "image", "video_second", "video_second_480p", "video_second_720p", "character"]),
  unitPriceMicro: z.string().regex(/^\d+$/),
  effectiveFrom: z.number().int().safe().nonnegative(),
}).strict();

const listSchema = z.object({
  vendorId: z.string().trim().min(1).max(32).optional(),
  model: z.string().trim().min(1).max(96).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();

const router = express.Router();
router.get("/", requireAdmin, async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return respondError(res, 400, "定价查询参数无效");
  const { vendorId, model, limit, offset } = parsed.data;
  try {
    const historyQuery = (u.db as any)("o_price").modify((query: any) => {
      if (vendorId !== undefined) query.where({ vendorId });
      if (model !== undefined) query.where({ model });
    });
    const [countRow, rows] = await Promise.all([
      historyQuery.clone().count({ total: "id" }).first(),
      historyQuery.clone()
        .select("id", "vendorId", "model", "unit", "unitPriceMicro", "effectiveFrom", "createdBy")
        .orderBy("effectiveFrom", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .offset(offset),
    ]);
    const items = rows.map((row: any) => ({ ...row, unitPriceMicro: String(row.unitPriceMicro) }));
    return res.status(200).send({
      code: 200,
      data: { items, total: Number(countRow?.total ?? 0), limit, offset },
      message: "定价历史已读取",
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return respondError(res, 400, "定价参数无效");
  const price = BigInt(parsed.data.unitPriceMicro);
  if (price > MAX_U64) return respondError(res, 400, "单价超出无符号64位范围");
  try {
    const existing = await (u.db as any)("o_price")
      .where({
        vendorId: parsed.data.vendorId,
        model: parsed.data.model,
        unit: parsed.data.unit,
        effectiveFrom: parsed.data.effectiveFrom,
      })
      .first("id");
    if (existing) return respondError(res, 409, "相同生效时间的定价已存在");

    const [id] = await (u.db as any)("o_price").insert({
      vendorId: parsed.data.vendorId,
      model: parsed.data.model,
      unit: parsed.data.unit,
      unitPriceMicro: price.toString(),
      effectiveFrom: parsed.data.effectiveFrom,
      createdBy: actorFromCtx().userId ?? null,
    });
    const data = { id, ...parsed.data };
    const actor = actorFromCtx(req.ip);
    await audit(actor, "billing.price.create", `${parsed.data.vendorId}/${parsed.data.model}/${parsed.data.unit}`, data);
    return res.status(201).send({ code: 201, data, message: "定价已追加" });
  } catch (error) {
    if (isUniqueConstraintError(error)) return respondError(res, 409, "相同生效时间的定价已存在");
    next(error);
  }
});

export default router;
