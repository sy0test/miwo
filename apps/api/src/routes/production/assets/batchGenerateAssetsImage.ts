import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import type { AssetKind } from "@/utils/feicai";
import { enqueueJobInTransaction } from "@/jobs";
import { currentUserId } from "@/jobs/context";
import { submitBilledJob } from "@/billing/submit";
import { resolveSubmissionEstimate } from "@/billing/estimate";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    assetIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().int().min(1).max(8).optional(),
  }),
  async (req, res) => {
    const { assetIds, projectId, scriptId, concurrentCount = 5 } = req.body;

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio", "targetCountry").first();

    const assetsDataArr = await u.db("o_assets").whereIn("id", assetIds).select("id", "describe", "name", "type", "assetsId");
    const parentIds = assetsDataArr.map((item) => item.assetsId).filter((id) => id !== null);
    const parentAssetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .whereIn("o_assets.id", parentIds as number[])
      .select("o_assets.id", "o_image.filePath", "o_assets.describe");
    assetsDataArr.forEach((i: any) => {
      const parent = parentAssetsData.find((item) => item.id === i.assetsId);
      if (parent) {
        i.parentDescribe = parent.describe;
      }
    });
    const imageUrlRecord: Record<number, string> = {};
    parentAssetsData.forEach((item) => {
      if (item.filePath) imageUrlRecord[item.id] = item.filePath;
    });
    // 本流程只处理衍生资产，故一律走[衍生资产模式]
    const buildSystemPrompt = (kind: AssetKind, parentDescribe?: string | null) =>
      u.feicai.buildAssetPromptSystem({ project: projectSettingData, kind, parentDescribe });
    // Submission now creates generated-image placeholders within the billed transaction.
    // ⚠ 响应形状不变（`success("开始生成资产图片")`）；jobIds 走新顶层字段。
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
    const selectedAssetIds = assetsDataArr.map((item: any) => Number(item.id));
    const modelRef = projectSettingData?.imageModel;
    if (typeof modelRef !== "string" || modelRef.length === 0) return res.status(400).send(error("项目未配置图像模型"));
    const estimateMicro = await resolveSubmissionEstimate(u.db as any, modelRef, "image", selectedAssetIds.length);
    const submitted = await submitBilledJob({
      db: u.db as any,
      userId,
      estimateMicro,
      idempotencyKey: `job:${userId}:image.productionAssets.batch:${projectId}:${selectedAssetIds.slice().sort((a: number, b: number) => a - b).join(",")}`,
      createBusinessRows: async (trx) => {
        for (const item of assetsDataArr) {
          const [imageId] = await trx("o_image").insert({
            assetsId: item.id, type: item.type, state: "生成中",
            resolution: projectSettingData?.imageQuality, model: modelRef,
          });
          await trx("o_assets").where("id", item.id).update({ imageId });
        }
        return { assetIds: selectedAssetIds };
      },
      resolveExistingBusiness: async (trx, existingJobId) => {
        const existing = await trx("o_job").where({ id: existingJobId }).first();
        return { assetIds: (JSON.parse(existing.payload) as { assetIds: number[] }).assetIds };
      },
      enqueue: async (trx, business) => enqueueJobInTransaction(trx, {
        type: "image.productionAssets.batch", userId,
        payload: { projectId, scriptId, assetIds: business.assetIds },
      }),
    });

    res.status(200).send({ ...success("开始生成资产图片"), jobIds: [submitted.jobId] });
  },
);
