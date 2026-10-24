import express from "express";
import { z } from "zod";
import { requireAdmin } from "@/middleware/auth";
import { actorFromCtx, audit } from "@/utils/audit";
import { inAdminTargetTenant, respondError } from "@/billing/routeScope";
import u from "@/utils";

const listSchema = z.object({
  search: z.string().trim().max(128).optional().default(""),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();
const membershipSchema = z.object({ groupIds: z.array(z.number().int().positive().safe()).max(200) }).strict();

const router = express.Router();
router.get("/", requireAdmin, async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return respondError(res, 400, "用户查询参数无效");
  const { search, limit, offset } = parsed.data;
  try {
    const usersQuery = (u.db as any)("o_user").modify((query: any) => {
      if (!search) return;
      query.where((nested: any) => {
        if (/^\d+$/.test(search)) nested.where({ id: Number(search) }).orWhere("username", "like", `%${search}%`);
        else nested.where("username", "like", `%${search}%`);
      });
    });
    const countRow = await usersQuery.clone().count({ total: "id" }).first();
    const users = await usersQuery.clone().select("id", "username", "role", "status").orderBy("id", "desc").limit(limit).offset(offset);
    const items = await Promise.all(users.map(async (user: any) => {
      const userId = Number(user.id);
      const summary = await inAdminTargetTenant(userId, async () => {
        const [account, groups] = await Promise.all([
          (u.db as any)("o_account").where({ userId }).first("balanceMicro", "frozenMicro"),
          (u.db as any)("o_userGroupMembership as membership")
            .join("o_userGroup as userGroup", "membership.userGroupId", "userGroup.id")
            .where("membership.userId", userId)
            .select("userGroup.id", "userGroup.name"),
        ]);
        return { account, groups };
      });
      return {
        id: userId,
        username: user.username,
        role: user.role,
        status: user.status,
        balanceMicro: String(summary.account?.balanceMicro ?? "0"),
        frozenMicro: String(summary.account?.frozenMicro ?? "0"),
        groupIds: summary.groups.map((group: any) => Number(group.id)),
        groupNames: summary.groups.map((group: any) => String(group.name)),
      };
    }));
    return res.status(200).send({ code: 200, data: { items, total: Number(countRow?.total ?? 0), limit, offset }, message: "用户列表已读取" });
  } catch (error) {
    next(error);
  }
});

router.put("/:userId/groups", requireAdmin, async (req, res, next) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.userId);
  const parsed = membershipSchema.safeParse(req.body);
  if (!id.success || !parsed.success || new Set(parsed.data.groupIds).size !== parsed.data.groupIds.length) {
    return respondError(res, 400, "用户组成员参数无效或包含重复 ID");
  }
  const userId = id.data;
  try {
    const result = await inAdminTargetTenant(userId, async () => {
      const user = await (u.db as any)("o_user").where({ id: userId }).first("id");
      if (!user) return { missingUser: true as const };
      const found = parsed.data.groupIds.length
        ? await (u.db as any)("o_userGroup").whereIn("id", parsed.data.groupIds).count({ total: "id" }).first()
        : { total: 0 };
      if (Number(found?.total ?? 0) !== parsed.data.groupIds.length) return { missingGroup: true as const };
      await (u.db as any).transaction(async (trx: any) => {
        await trx("o_userGroupMembership").where({ userId }).del();
        if (parsed.data.groupIds.length) {
          await trx("o_userGroupMembership").insert(parsed.data.groupIds.map((userGroupId) => ({ userId, userGroupId })));
        }
      });
      return { ok: true as const };
    });
    if ("missingUser" in result) return respondError(res, 404, "目标账号不存在");
    if ("missingGroup" in result) return respondError(res, 400, "用户组不存在");
    await audit(actorFromCtx(req.ip), "billing.user.groups.update", String(userId), { groupIds: parsed.data.groupIds });
    return res.status(200).send({ code: 200, data: { userId, groupIds: parsed.data.groupIds }, message: "用户组已更新" });
  } catch (error) {
    next(error);
  }
});

export default router;
