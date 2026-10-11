import express from "express";
import u from "@/utils";
import { z } from "zod";
import sharp from "sharp";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { Output } from "ai";
import type { AssetKind } from "@/utils/feicai";
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

    const imageData: { id: number; state: string; src: string }[] = [];
    res.status(200).send(success("开始生成资产图片"));
    const generateSingleAsset = async (item: any) => {
      const imageId = imageIdMap[item.id!];
      const systemPrompt = buildSystemPrompt((item.type || "role") as AssetKind, item.parentDescribe);

      const { text } = await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `
            父级资产描述: ${item.parentDescribe || "无详细描述"}
            当前资产描述: ${item.describe || "无详细描述"}`,
          },
        ],
      });
      // 角色/道具白底资产兜底：即使提示词里没写，也强制带上不透明纯白画布声明（场景不动）
      const assetPrompt = u.feicai.withOpaqueWhiteCanvas(text, item.type);
      await u.db("o_assets").where("id", item.id).update({ prompt: assetPrompt });

      const imageBase64 = imageUrlRecord[item.assetsId!] ? await u.oss.getImageBase64(imageUrlRecord[item.assetsId!]) : null;
      try {
        const repeloadObj = {
          prompt: assetPrompt,
          size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: "16:9" as `${number}:${number}`,
        };
        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: imageBase64 ? [{ type: "image", base64: imageBase64 }] : [],
            ...repeloadObj,
          },
          {
            taskClass: "生成图片",
            describe: "资产图片生成",
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );
        const savePath = `/${projectId}/assets/${scriptId}/${item.type}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        await u.db("o_image").where({ id: imageId }).update({ state: "已完成", filePath: savePath });
        return {
          id: item.id!,
          state: "已完成",
          src: await u.oss.getSmallImageUrl(savePath),
        };
      } catch (e) {
        await u
          .db("o_image")
          .where({ id: imageId })
          .update({ state: "生成失败", errorReason: u.error(e).message });
        return {
          id: item.id!,
          state: "生成失败",
          src: "",
        };
      }
    };

    // 按 concurrentCount 分批并发执行
    for (let i = 0; i < assetsDataArr.length; i += concurrentCount) {
      const batch = assetsDataArr.slice(i, i + concurrentCount);
      const batchResults = await Promise.all(batch.map(generateSingleAsset));
      imageData.push(...batchResults);
    }
  },
);
