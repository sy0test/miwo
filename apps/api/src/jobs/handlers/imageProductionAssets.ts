/**
 * 生产资产图批量生成 handler（从 `routes/production/assets/batchGenerateAssetsImage.ts:60-124` 的生成段搬来）。
 *
 * 搬运 5 点改造（brief Step 2 清单）：
 *  1. ✅ 生成段搬进 `handle`（含"先调文本模型生成资产提示词，再调图像模型"两步）。
 *  2. ✅ 入参全走 payload（`projectId`/`scriptId`/`assetIds`）。
 *  3. ✅ 每轮 `if (ctx.signal.aborted) throw` + `ctx.progress`。
 *  4. ✅ 幂等守卫：`o_image.state` 已是终态就跳过。
 *  5. ✅ `onAbandon` 把该任务写过的 `o_image` 行从"生成中"改判为"生成失败"。
 *
 * ⚠ `o_image` 占位行仍由**路由**建（`:47-55`），handler 只按 `assetsId` 反查 imageId —— 与旧代码同源。
 */
import u from "@/utils";
import type { AssetKind } from "@/utils/feicai";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { withVendorSlot } from "@/jobs/gate";

export interface ProductionAssetsPayload {
  projectId: number;
  scriptId: number;
  assetIds: number[];
}

export const imageProductionAssetsBatch: JobDefinition<ProductionAssetsPayload> = {
  type: "image.productionAssets.batch",
  timeoutMs: 300_000,
  maxAttempts: 2,
  pool: "vendor:image",
  parse(raw) {
    const o = raw as Partial<ProductionAssetsPayload>;
    if (!o || typeof o.projectId !== "number" || typeof o.scriptId !== "number") {
      throw new Error("[job] image.productionAssets.batch payload 缺少 projectId/scriptId");
    }
    if (!Array.isArray(o.assetIds) || o.assetIds.length === 0) throw new Error("[job] image.productionAssets.batch 的 assetIds 不能为空");
    return { projectId: o.projectId, scriptId: o.scriptId, assetIds: o.assetIds };
  },
  dedupeKey: (p, userId) => `${userId ?? "anon"}:image.productionAssets.batch:${p.projectId}:${p.assetIds.slice().sort((a, b) => a - b).join(",")}`,
  async handle(ctx: JobContext, p: ProductionAssetsPayload) {
    const projectSettingData = await u.db("o_project").where("id", p.projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio", "targetCountry").first();
    const assetsDataArr = (await u.db("o_assets").whereIn("id", p.assetIds).select("id", "describe", "name", "type", "assetsId", "imageId")) as Array<{
      id: number; describe: string | null; name: string | null; type: string | null; assetsId: number | null; imageId: number | null; parentDescribe?: string | null;
    }>;
    if (!assetsDataArr.length) return { total: 0 };

    // 父级资产描述 + 参考图（与路由同源）
    const parentIds = assetsDataArr.map((item: any) => item.assetsId).filter((id: any) => id !== null);
    const parentAssetsData = parentIds.length
      ? await u.db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").whereIn("o_assets.id", parentIds as number[]).select("o_assets.id", "o_image.filePath", "o_assets.describe")
      : [];
    assetsDataArr.forEach((i: any) => {
      const parent = parentAssetsData.find((item: any) => item.id === i.assetsId);
      if (parent) i.parentDescribe = parent.describe;
    });
    const imageUrlRecord: Record<number, string> = {};
    parentAssetsData.forEach((item: any) => { if (item.filePath) imageUrlRecord[item.id] = item.filePath; });

    const failed: string[] = [];
    let index = 0;
    for (const item of assetsDataArr) {
      index += 1;
      if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
      const imageId = item.imageId;
      if (!imageId) continue;
      // 幂等守卫：终态就跳过
      const current = await u.db("o_image").where("id", imageId).select("state").first();
      if (!current) continue;
      if (current.state === "已完成" || current.state === "生成失败") continue;

      await ctx.progress(Math.round(((index - 1) / assetsDataArr.length) * 100), `生成资产图 ${index}/${assetsDataArr.length}`);
      const systemPrompt = u.feicai.buildAssetPromptSystem({ project: projectSettingData, kind: (item.type || "role") as AssetKind, parentDescribe: item.parentDescribe });
      try {
        // Phase 1d Task 9：这一次条目里有**两次**厂商调用（先文本润色、再出图）⇒ 各自过一次闸门，
        // 池子按调用类型分开（`vendor:text` / `vendor:image`）。只包调用，不包整条任务。
        const { text } = await withVendorSlot("vendor:text", ctx.workerId, () =>
          u.Ai.Text("universalAi").invoke({
            system: systemPrompt,
            messages: [{ role: "user", content: `\n            父级资产描述: ${item.parentDescribe || "无详细描述"}\n            当前资产描述: ${item.describe || "无详细描述"}` }],
          }),
        );
        const assetPrompt = u.feicai.withOpaqueWhiteCanvas(text, item.type);
        await u.db("o_assets").where("id", item.id).update({ prompt: assetPrompt });
        const parentPath = item.assetsId ? imageUrlRecord[item.assetsId] : undefined;
        const imageBase64 = parentPath ? await u.oss.getImageBase64(parentPath) : null;
        const repeloadObj = {
          prompt: assetPrompt,
          size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: "16:9" as `${number}:${number}`,
        };
        const imageCls = await withVendorSlot("vendor:image", ctx.workerId, () =>
          u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
            { referenceList: imageBase64 ? [{ type: "image", base64: imageBase64 }] : [], ...repeloadObj },
            {
              taskClass: "生成图片",
              describe: "资产图片生成",
              relatedObjects: JSON.stringify(repeloadObj),
              projectId: p.projectId,
            },
          ),
        );
        const savePath = `/${p.projectId}/assets/${p.scriptId}/${item.type}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
        await u.db("o_image").where({ id: imageId }).update({ state: "已完成", filePath: savePath });
      } catch (e) {
        const msg = u.error(e).message;
        if (ctx.signal.aborted) throw new Error(`被中止（租约丢失或停机）：${msg}`);
        await u.db("o_image").where({ id: imageId }).update({ state: "生成失败", errorReason: msg });
        failed.push(`${imageId}=${msg}`);
      }
    }
    await ctx.progress(100, "完成");
    if (failed.length) throw new Error(`${failed.length}/${assetsDataArr.length} 张资产图失败：${failed.join("; ")}`);
    return { total: assetsDataArr.length };
  },
  async onAbandon(payload, reason) {
    if (!payload.assetIds.length) return;
    // 该任务写过的 `o_image` 行（按 assetsId 反查）从"生成中"改判
    await u.db("o_image")
      .whereIn("assetsId", payload.assetIds)
      .andWhere("state", "生成中")
      .update({ state: "生成失败", errorReason: `任务放弃（${reason}）`.slice(0, 1000) });
  },
};
