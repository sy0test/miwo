import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireTenantCtx } from "@/db/tenant-context";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video", "all"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const tenant = requireTenantCtx();
    const allowedModelsByVendor = new Map<string, Set<string>>();
    if (tenant.role !== "admin") {
      const grants = (await u.db("o_userGroupMembership as membership")
        .join("o_userGroupModelGroup as mapping", "mapping.userGroupId", "membership.userGroupId")
        .join("o_modelGroupItem as item", "item.modelGroupId", "mapping.modelGroupId")
        .where("membership.userId", tenant.userId)
        .where("item.enabled", true)
        .select("item.vendorId", "item.model")) as Array<{ vendorId: string; model: string }>;
      for (const grant of grants) {
        const models = allowedModelsByVendor.get(grant.vendorId) ?? new Set<string>();
        models.add(grant.model);
        allowedModelsByVendor.set(grant.vendorId, models);
      }
    }

    const dataList = await u.db("o_vendorConfig").select("id").where("enable", 1);
    if (!dataList || dataList.length === 0) {
      return res.status(404).send({ error: "模型未找到" });
    }
    const modelList = await Promise.all(dataList.map((i) => u.vendor.getModelList(i.id!)));
    const result = await Promise.all(
      dataList.map(async (data, index) => {
        const vendorData = await u.vendor.getVendor(data.id!);
        const models = modelList[index];
        const filtered =
          type === "all"
            ? models.filter((item: { type: string }) => item.type !== "video")
            : models.filter((item: { type: string }) => item.type === type);
        const visible = tenant.role === "admin"
          ? filtered
          : filtered.filter((item: { modelName: string }) => allowedModelsByVendor.get(String(data.id))?.has(item.modelName));
        return visible.map((item: { name: string; modelName: string; type: string }) => ({
          id: data.id,
          label: item.name,
          value: item.modelName,
          type: item.type,
          name: vendorData.name,
        }));
      }),
    );
    res.status(200).send(success(result.flat()));
  },
);
