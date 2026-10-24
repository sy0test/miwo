import express from "express";
import u from "@/utils";
import { getAccount } from "@/billing/accounts";
import { currentTenant } from "@/db/tenant-context";
import { respondError, requestedUserId } from "@/billing/routeScope";

const router = express.Router();
router.get("/", async (req, res, next) => {
  const requested = requestedUserId(req, res);
  if (requested === null) return;
  const ctx = currentTenant();
  if (!ctx) return next(new Error("Missing tenant context"));
  try {
    const account = await getAccount(u.db as any, ctx.userId);
    res.status(200).send({
      code: 200,
      data: {
        ...account,
        balanceMicro: account.balanceMicro.toString(),
        frozenMicro: account.frozenMicro.toString(),
      },
      message: "成功",
    });
  } catch (error) {
    if (error instanceof Error && /Account not found/.test(error.message)) return respondError(res, 404, "账户不存在");
    next(error);
  }
});

export default router;
