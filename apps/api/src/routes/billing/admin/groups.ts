import express from "express";
import { z } from "zod";
import { requireAdmin } from "@/middleware/auth";
import { actorFromCtx, audit } from "@/utils/audit";
import { respondError } from "@/billing/routeScope";
import { systemDb } from "@/utils/db";
import { getModelList } from "@/utils/vendor";
import u from "@/utils";

const idSchema = z.coerce.number().int().positive().safe();
const nameSchema = z.string().trim().min(1).max(128);
const modelItemSchema = z.object({
  vendorId: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(96),
  enabled: z.boolean().default(true),
  dailyLimit: z.number().int().min(0).safe().nullable().optional().default(null),
}).strict();
const modelGroupSchema = z.object({ name: nameSchema, items: z.array(modelItemSchema).min(1).max(500) }).strict();
const modelGroupUpdateSchema = z.object({ name: nameSchema.optional(), items: z.array(modelItemSchema).max(500).optional() }).strict();
const userGroupSchema = z.object({ name: nameSchema, modelGroupIds: z.array(z.number().int().positive().safe()).min(1).max(200) }).strict();

const router = express.Router();

async function getConfiguredModel(vendorId: string, model: string): Promise<boolean> {
  try {
    const models = await getModelList(vendorId);
    if (models.some((item: any) => item && item.modelName === model)) return true;

    const config = await (u.db as any)("o_vendorConfig").where({ id: vendorId }).first("models");
    if (!config?.models) return false;
    const configuredModels = JSON.parse(config.models);
    return Array.isArray(configuredModels) && configuredModels.some((item: any) => item && item.modelName === model);
  } catch {
    return false;
  }
}

async function readGroups(): Promise<any> {
  const [userGroups, modelGroups, mappings, items] = await Promise.all([
    (u.db as any)("o_userGroup").select("id", "name", "isLegacy", "legacyUserId").orderBy("name", "asc"),
    (u.db as any)("o_modelGroup").select("id", "name", "isLegacy", "legacyUserId").orderBy("name", "asc"),
    (u.db as any)("o_userGroupModelGroup").select("userGroupId", "modelGroupId"),
    (u.db as any)("o_modelGroupItem").select("modelGroupId", "vendorId", "model", "enabled", "dailyLimit").orderBy("vendorId", "asc").orderBy("model", "asc"),
  ]);
  const shapedModelGroups = modelGroups.map((group: any) => ({
    id: Number(group.id),
    name: group.name,
    isLegacy: Boolean(group.isLegacy),
    legacyUserId: group.legacyUserId == null ? null : Number(group.legacyUserId),
    items: items.filter((item: any) => Number(item.modelGroupId) === Number(group.id)).map((item: any) => ({
      vendorId: item.vendorId, model: item.model, enabled: Boolean(item.enabled),
      dailyLimit: item.dailyLimit == null ? null : Number(item.dailyLimit),
    })),
  }));
  return {
    userGroups: userGroups.map((group: any) => ({
      id: Number(group.id),
      name: group.name,
      isLegacy: Boolean(group.isLegacy),
      legacyUserId: group.legacyUserId == null ? null : Number(group.legacyUserId),
      modelGroupIds: mappings.filter((mapping: any) => Number(mapping.userGroupId) === Number(group.id)).map((mapping: any) => Number(mapping.modelGroupId)),
    })),
    modelGroups: shapedModelGroups,
  };
}

router.get("/", requireAdmin, async (_req, res, next) => {
  try {
    return res.status(200).send({ code: 200, data: await readGroups(), message: "分组列表已读取" });
  } catch (error) {
    next(error);
  }
});

router.post("/model-groups", requireAdmin, async (req, res, next) => {
  const parsed = modelGroupSchema.safeParse(req.body);
  if (!parsed.success) return respondError(res, 400, "模型组参数无效");
  if (new Set(parsed.data.items.map((item) => `${item.vendorId}\0${item.model}`)).size !== parsed.data.items.length) return respondError(res, 400, "模型组包含重复模型");
  try {
    for (const item of parsed.data.items) {
      if (!(await getConfiguredModel(item.vendorId, item.model))) return respondError(res, 400, "模型组只能包含已配置的模型");
    }
    const duplicate = await (u.db as any)("o_modelGroup").where({ name: parsed.data.name }).first("id");
    if (duplicate) return respondError(res, 409, "模型组名称已存在");
    const inserted = await (u.db as any).transaction(async (trx: any) => {
      const [id] = await trx("o_modelGroup").insert({ name: parsed.data.name, isLegacy: 0, legacyUserId: null, createdAt: Date.now() });
      if (parsed.data.items.length) {
        await trx("o_modelGroupItem").insert(parsed.data.items.map((item) => ({
          modelGroupId: id, vendorId: item.vendorId, model: item.model, enabled: item.enabled, dailyLimit: item.dailyLimit, createdAt: Date.now(),
        })));
      }
      return Number(id);
    });
    const data = { id: inserted, ...parsed.data };
    await audit(actorFromCtx(req.ip), "billing.modelGroup.create", String(inserted), data);
    return res.status(201).send({ code: 201, data, message: "模型组已创建" });
  } catch (error) {
    next(error);
  }
});

router.patch("/model-groups/:id", requireAdmin, async (req, res, next) => {
  const id = idSchema.safeParse(req.params.id);
  const parsed = modelGroupUpdateSchema.safeParse(req.body);
  if (!id.success || !parsed.success || Object.keys(parsed.data).length === 0) return respondError(res, 400, "模型组参数无效");
  if (parsed.data.items && new Set(parsed.data.items.map((item) => `${item.vendorId}\0${item.model}`)).size !== parsed.data.items.length) return respondError(res, 400, "模型组包含重复模型");
  try {
    const group = await (u.db as any)("o_modelGroup").where({ id: id.data }).first("id", "isLegacy");
    if (!group) return respondError(res, 404, "模型组不存在");
    if (group.isLegacy) return respondError(res, 409, "历史授权组不可修改");
    if (parsed.data.items) {
      for (const item of parsed.data.items) {
        if (!(await getConfiguredModel(item.vendorId, item.model))) return respondError(res, 400, "模型组只能包含已配置的模型");
      }
    }
    if (parsed.data.name) {
      const duplicate = await (u.db as any)("o_modelGroup").where({ name: parsed.data.name }).whereNot({ id: id.data }).first("id");
      if (duplicate) return respondError(res, 409, "模型组名称已存在");
    }
    await (u.db as any).transaction(async (trx: any) => {
      if (parsed.data.name) await trx("o_modelGroup").where({ id: id.data }).update({ name: parsed.data.name });
      if (parsed.data.items) {
        await trx("o_modelGroupItem").where({ modelGroupId: id.data }).del();
        if (parsed.data.items.length) await trx("o_modelGroupItem").insert(parsed.data.items.map((item) => ({
          modelGroupId: id.data, vendorId: item.vendorId, model: item.model, enabled: item.enabled, dailyLimit: item.dailyLimit, createdAt: Date.now(),
        })));
      }
    });
    await audit(actorFromCtx(req.ip), "billing.modelGroup.update", String(id.data), parsed.data);
    return res.status(200).send({ code: 200, data: { id: id.data, ...parsed.data }, message: "模型组已更新" });
  } catch (error) {
    next(error);
  }
});

router.delete("/model-groups/:id", requireAdmin, async (req, res, next) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return respondError(res, 400, "模型组 ID 无效");
  try {
    const group = await (u.db as any)("o_modelGroup").where({ id: id.data }).first("id", "isLegacy");
    if (!group) return respondError(res, 404, "模型组不存在");
    if (group.isLegacy) return respondError(res, 409, "历史授权组不可删除");
    const references = await (u.db as any)("o_userGroupModelGroup").where({ modelGroupId: id.data }).first("userGroupId");
    if (references) return respondError(res, 409, "模型组仍被用户组引用");
    await (u.db as any).transaction(async (trx: any) => {
      await trx("o_modelGroupItem").where({ modelGroupId: id.data }).del();
      await trx("o_modelGroup").where({ id: id.data }).del();
    });
    await audit(actorFromCtx(req.ip), "billing.modelGroup.delete", String(id.data), {});
    return res.status(200).send({ code: 200, data: { id: id.data }, message: "模型组已删除" });
  } catch (error) {
    next(error);
  }
});

router.post("/user-groups", requireAdmin, async (req, res, next) => {
  const parsed = userGroupSchema.safeParse(req.body);
  if (!parsed.success || new Set(parsed.data.modelGroupIds).size !== parsed.data.modelGroupIds.length) return respondError(res, 400, "用户组参数无效或包含重复 ID");
  try {
    const duplicate = await (u.db as any)("o_userGroup").where({ name: parsed.data.name }).first("id");
    if (duplicate) return respondError(res, 409, "用户组名称已存在");
    const found = parsed.data.modelGroupIds.length
      ? await (u.db as any)("o_modelGroup").whereIn("id", parsed.data.modelGroupIds).count({ total: "id" }).first()
      : { total: 0 };
    if (Number(found?.total ?? 0) !== parsed.data.modelGroupIds.length) return respondError(res, 400, "模型组不存在");
    const id = await (u.db as any).transaction(async (trx: any) => {
      const [createdId] = await trx("o_userGroup").insert({ name: parsed.data.name, isLegacy: 0, legacyUserId: null, createdAt: Date.now() });
      if (parsed.data.modelGroupIds.length) await trx("o_userGroupModelGroup").insert(parsed.data.modelGroupIds.map((modelGroupId) => ({ userGroupId: createdId, modelGroupId })));
      return Number(createdId);
    });
    const data = { id, ...parsed.data };
    await audit(actorFromCtx(req.ip), "billing.userGroup.create", String(id), data);
    return res.status(201).send({ code: 201, data, message: "用户组已创建" });
  } catch (error) {
    next(error);
  }
});

router.patch("/user-groups/:id", requireAdmin, async (req, res, next) => {
  const id = idSchema.safeParse(req.params.id);
  const parsed = userGroupSchema.partial().strict().safeParse(req.body);
  if (!id.success || !parsed.success || Object.keys(parsed.data).length === 0) return respondError(res, 400, "用户组参数无效");
  if (parsed.data.modelGroupIds && new Set(parsed.data.modelGroupIds).size !== parsed.data.modelGroupIds.length) return respondError(res, 400, "用户组包含重复模型组");
  try {
    const group = await (u.db as any)("o_userGroup").where({ id: id.data }).first("id", "isLegacy");
    if (!group) return respondError(res, 404, "用户组不存在");
    if (group.isLegacy) return respondError(res, 409, "历史授权组不可修改");
    if (parsed.data.name) {
      const duplicate = await (u.db as any)("o_userGroup").where({ name: parsed.data.name }).whereNot({ id: id.data }).first("id");
      if (duplicate) return respondError(res, 409, "用户组名称已存在");
    }
    if (parsed.data.modelGroupIds) {
      const found = parsed.data.modelGroupIds.length
        ? await (u.db as any)("o_modelGroup").whereIn("id", parsed.data.modelGroupIds).count({ total: "id" }).first()
        : { total: 0 };
      if (Number(found?.total ?? 0) !== parsed.data.modelGroupIds.length) return respondError(res, 400, "模型组不存在");
    }
    await (u.db as any).transaction(async (trx: any) => {
      if (parsed.data.name) await trx("o_userGroup").where({ id: id.data }).update({ name: parsed.data.name });
      if (parsed.data.modelGroupIds) {
        await trx("o_userGroupModelGroup").where({ userGroupId: id.data }).del();
        if (parsed.data.modelGroupIds.length) await trx("o_userGroupModelGroup").insert(parsed.data.modelGroupIds.map((modelGroupId) => ({ userGroupId: id.data, modelGroupId })));
      }
    });
    await audit(actorFromCtx(req.ip), "billing.userGroup.update", String(id.data), parsed.data);
    return res.status(200).send({ code: 200, data: { id: id.data, ...parsed.data }, message: "用户组已更新" });
  } catch (error) {
    next(error);
  }
});

router.delete("/user-groups/:id", requireAdmin, async (req, res, next) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return respondError(res, 400, "用户组 ID 无效");
  try {
    const group = await (u.db as any)("o_userGroup").where({ id: id.data }).first("id", "isLegacy");
    if (!group) return respondError(res, 404, "用户组不存在");
    if (group.isLegacy) return respondError(res, 409, "历史授权组不可删除");
    const [members, modelGroups] = await Promise.all([
      systemDb("o_userGroupMembership").where({ userGroupId: id.data }).first("userId"),
      (u.db as any)("o_userGroupModelGroup").where({ userGroupId: id.data }).first("modelGroupId"),
    ]);
    if (members || modelGroups) return respondError(res, 409, "用户组仍有成员或模型组关联");
    await (u.db as any)("o_userGroup").where({ id: id.data }).del();
    await audit(actorFromCtx(req.ip), "billing.userGroup.delete", String(id.data), {});
    return res.status(200).send({ code: 200, data: { id: id.data }, message: "用户组已删除" });
  } catch (error) {
    next(error);
  }
});

export default router;
