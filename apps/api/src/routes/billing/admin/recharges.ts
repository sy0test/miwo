import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { requireAdmin } from "@/middleware/auth";
import { actorFromCtx, audit } from "@/utils/audit";
import { inAdminTargetTenant, respondError } from "@/billing/routeScope";
import { parseCnyToMicro } from "@/billing/money";
import { creditInTransaction, withLedgerRetry } from "@/billing/ledger";
import { ensureAccountInTransaction } from "@/billing/accounts";
import u from "@/utils";

const MAX_I64 = 9_223_372_036_854_775_807n;
const createSchema = z.object({
  userId: z.number().int().positive().safe(),
  amount: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().uuid(),
}).strict();
const confirmSchema = z.object({
  userId: z.number().int().positive().safe(),
  amount: z.string().min(1).max(64),
  externalTradeId: z.string().min(1).max(96),
}).strict();

const router = express.Router();
router.post("/", requireAdmin, async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return respondError(res, 400, "充值参数无效");
  let amountMicro: bigint;
  try { amountMicro = parseCnyToMicro(parsed.data.amount); }
  catch { return respondError(res, 400, "充值金额格式无效"); }
  if (amountMicro <= 0n || amountMicro > MAX_I64) return respondError(res, 400, "充值金额超出有效范围");

  const actor = actorFromCtx(req.ip);
  if (!actor.userId) return respondError(res, 403, "管理员身份无效");
  const operatorId = actor.userId;
  const outTradeNo = `manual_${crypto.createHash("sha256").update(`${operatorId}:${parsed.data.idempotencyKey}`).digest("hex")}`;
  try {
    const result: any = await inAdminTargetTenant(parsed.data.userId, () => withLedgerRetry(u.db as any, () =>
      u.db.transaction(async (trx: any) => {
        const target = await trx("o_user").where({ id: parsed.data.userId }).forUpdate().first("id");
        if (!target) return { kind: "missing" as const };
        await ensureAccountInTransaction(trx, parsed.data.userId);

        const existing = await trx("o_order").where({ outTradeNo }).first();
        if (existing) {
          if (Number(existing.userId) !== parsed.data.userId
            || BigInt(String(existing.amountMicro)) !== amountMicro
            || Number(existing.operatorId) !== operatorId
            || String(existing.operatorNote ?? "") !== parsed.data.note
            || existing.status !== "paid") return { kind: "conflict" as const };
          const account = await trx("o_account").where({ userId: parsed.data.userId }).first("balanceMicro");
          return { kind: "replayed" as const, order: existing, balanceMicro: String(account.balanceMicro) };
        }

        const now = Date.now();
        const order = {
          userId: parsed.data.userId,
          outTradeNo,
          channel: "manual_admin",
          amountMicro: amountMicro.toString(),
          status: "paid",
          paidAt: now,
          type: "recharge",
          externalTradeId: null,
          operatorId,
          operatorNote: parsed.data.note,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = await trx("o_order").insert(order);
        const id = Number(Array.isArray(inserted) ? inserted[0] : inserted);
        const credited = await creditInTransaction(trx, {
          userId: parsed.data.userId,
          amountMicro,
          orderId: outTradeNo,
          operatorId,
          idempotencyKey: `recharge:${outTradeNo}`,
        });
        return { kind: "created" as const, order: { id, ...order }, balanceMicro: credited.balanceMicro.toString() };
      }),
    ));
    if (result.kind === "missing") return respondError(res, 404, "目标账号不存在");
    if (result.kind === "conflict") return respondError(res, 409, "幂等键已用于不同的充值请求");
    await audit(actor, "billing.recharge.create", String(parsed.data.userId), {
      orderId: result.order.id, amountMicro: amountMicro.toString(), note: parsed.data.note,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    const status = result.kind === "created" ? 201 : 200;
    return res.status(status).send({
      code: status,
      data: { ...result.order, userId: parsed.data.userId, balanceMicro: result.balanceMicro },
      message: "充值已完成",
    });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (message.includes("o_order.outTradeNo") || message.includes("o_order_outtradeno_unique")) {
      return respondError(res, 409, "幂等键已用于不同的充值请求");
    }
    next(error);
  }
});

router.post("/:id/confirm", requireAdmin, async (req, res, next) => {
  const orderId = z.coerce.number().int().positive().safe().safeParse(req.params.id);
  const parsed = confirmSchema.safeParse(req.body);
  if (!orderId.success || !parsed.success) return respondError(res, 400, "充值确认参数无效");
  let amountMicro: bigint;
  try { amountMicro = parseCnyToMicro(parsed.data.amount); }
  catch { return respondError(res, 400, "充值金额格式无效"); }
  if (amountMicro <= 0n || amountMicro > MAX_I64) return respondError(res, 400, "充值金额超出有效范围");
  const actor = actorFromCtx(req.ip);
  if (!actor.userId) return respondError(res, 403, "管理员身份无效");

  try {
    const result: any = await inAdminTargetTenant(parsed.data.userId, () => withLedgerRetry(u.db as any, () =>
      u.db.transaction(async (trx: any) => {
        const order = await trx("o_order").where({ id: orderId.data, userId: parsed.data.userId }).forUpdate().first();
        if (!order) return { kind: "missing" as const };
        if (order.status !== "pending" || order.channel !== "manual_admin") return { kind: "conflict" as const };
        if (BigInt(String(order.amountMicro)) !== amountMicro) return { kind: "amount" as const };
        const collision = await trx("o_order").where({ externalTradeId: parsed.data.externalTradeId }).whereNot({ id: orderId.data }).first("id");
        if (collision) return { kind: "external" as const };

        const credited = await creditInTransaction(trx, {
          userId: parsed.data.userId,
          amountMicro,
          orderId: String(order.outTradeNo),
          operatorId: actor.userId!,
          idempotencyKey: `recharge:${orderId.data}`,
        });
        const now = Date.now();
        const changed = await trx("o_order").where({ id: orderId.data, userId: parsed.data.userId, status: "pending" }).update({
          status: "paid",
          paidAt: now,
          externalTradeId: parsed.data.externalTradeId,
          updatedAt: now,
        });
        if (Number(changed) !== 1) throw new Error("Recharge order state changed during confirmation");
        return { kind: "paid" as const, balanceMicro: credited.balanceMicro.toString() };
      }),
    ));
    if (result.kind === "missing") return respondError(res, 404, "充值订单不存在");
    if (result.kind === "amount") return respondError(res, 400, "确认金额与订单金额不一致");
    if (result.kind === "external") return respondError(res, 409, "外部交易号已使用");
    if (result.kind === "conflict") return respondError(res, 409, "充值订单已处理");
    await audit(actor, "billing.recharge.confirm", String(parsed.data.userId), {
      orderId: orderId.data, amountMicro: amountMicro.toString(), externalTradeId: parsed.data.externalTradeId,
    });
    return res.status(200).send({ code: 200, data: { orderId: orderId.data, userId: parsed.data.userId, status: "paid", balanceMicro: result.balanceMicro }, message: "充值已确认" });
  } catch (error) {
    next(error);
  }
});

export default router;
