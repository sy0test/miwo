import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import type { AssetKind } from "@/utils/feicai";
import { enqueueJob } from "@/jobs";
import { currentUserId } from "@/jobs/context";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    assetIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
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
    // 先批量为所有 assets 创建 image 记录并标记为"生成中"
    const imageIdMap: Record<number, number> = {};
    for (const item of assetsDataArr) {
      const [imageId] = await u.db("o_image").insert({
        assetsId: item.id,
        type: item.type,
        state: "生成中",
        resolution: projectSettingData?.imageQuality,
        model: projectSettingData?.imageModel,
      });
      imageIdMap[item.id!] = imageId;
      await u.db("o_assets").where("id", item.id).update({ imageId: imageId });
    }

    // Phase 1d：入队（生成段搬到 handler），不再进程内分批后台跑。
    // ⚠ 响应形状不变（`success("开始生成资产图片")`）；jobIds 走新顶层字段。
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
    const { jobId } = await enqueueJob({
      type: "image.productionAssets.batch",
      userId,
      // ⚠ 只存引用 id；base64 由 handler 按 assetsId 现取
      payload: { projectId, scriptId, assetIds: assetsDataArr.map((i: any) => i.id) },
    });

    res.status(200).send({ ...success("开始生成资产图片"), jobIds: [jobId] });
  },
);
