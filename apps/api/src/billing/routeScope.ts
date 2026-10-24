import type { Request, Response } from "express";
import { z } from "zod";
import { currentTenant, runWithTenant } from "@/db/tenant-context";

export function respondError(res: Response, status: number, message: string): void {
  res.status(status).send({ code: status, data: null, message });
}

export function requestedUserId(req: Request, res: Response): number | undefined | null {
  const supplied = req.query.userId;
  if (supplied === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(supplied);
  if (!parsed.success) {
    respondError(res, 400, "userId must be a positive integer");
    return null;
  }
  const ctx = currentTenant();
  if (!ctx || parsed.data !== ctx.userId) {
    respondError(res, 403, "只能访问自己的计费数据");
    return null;
  }
  return parsed.data;
}

export function inAdminTargetTenant<T>(userId: number, work: () => T): T {
  const actor = currentTenant();
  if (!actor || actor.role !== "admin") throw new Error("Admin authorization is required before target tenant access");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("target userId must be a positive safe integer");
  return runWithTenant({ ...actor, userId, role: "admin", source: "http" }, work);
}

export const pageQuery = z.object({
  userId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();
