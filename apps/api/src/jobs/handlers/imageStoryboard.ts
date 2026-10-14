/**
 * 分镜图批量生成 handler（从 `routes/production/storyboard/batchGenerateImage.ts:102-147` 的生成段搬来）。
 *
 * 搬运时的 5 点改造（brief Step 2 的统一清单）：
 *  1. ✅ 生成段整段搬进 `handle(ctx, payload)`（含 `getAssetsImageBase64` 现取参考图）。
 *  2. ✅ 入参全走 payload（`projectId`/`scriptId`/`storyboardIds`/`compulsory`），不再读 `req.body`。
 *  3. ✅ 每轮开头 `if (ctx.signal.aborted) throw`，并在开始/结束写 `ctx.progress`。
 *  4. ✅ 幂等守卫：`o_storyboard.state` 已是终态（已完成/生成失败）就跳过。
 *  5. ✅ `onAbandon` 把"生成中"改判为"生成失败"并写 **`reason`**（该表**只有 `reason`**，
 *     没有 `errorReason` —— B 组 F1 的教训）。
 *
 * ⚠ payload 键是 **`storyboardIds`（复数数组）**，与 Task 7 契约表（`task-7-brief.md:43`）一致；
 *   B 组 reconcile 已按同一键对齐（review-B F2）。
 */
import u from "@/utils";
import type { JobContext, JobDefinition } from "@/jobs/types";

export interface StoryboardImagePayload {
  projectId: number;
  scriptId: number;
  storyboardIds: number[];
  compulsory?: boolean;
}

/** 按 imageId 列表现取 base64（与路由里 `getAssetsImageBase64` 同源；base64 不进 payload）。 */
async function getAssetsImageBase64(imageIds: number[]): Promise<Array<{ type: "image"; base64: string }>> {
  if (!imageIds.length) return [];
  const imagePaths = await u.db("o_image").whereIn("o_image.id", imageIds).select("o_image.id", "o_image.filePath");
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) id2Path.set(row.id, row.filePath);
  const imageUrls = await Promise.all(
    imageIds.map(async (id) => {
      const filePath = id2Path.get(id);
      if (filePath) {
        try {
          return await u.oss.getImageBase64(filePath);
        } catch {
          return null;
        }
      }
      return null;
    }),
  );
  return (imageUrls.filter(Boolean) as string[]).map((url) => ({ type: "image" as const, base64: url }));
}

export const imageStoryboardBatch: JobDefinition<StoryboardImagePayload> = {
  type: "image.storyboard.batch",
  timeoutMs: 300_000,
  maxAttempts: 2,
  pool: "vendor:image",
  parse(raw) {
    const o = raw as Partial<StoryboardImagePayload>;
    if (!o || typeof o.projectId !== "number" || typeof o.scriptId !== "number") {
      throw new Error("[job] image.storyboard.batch payload 缺少 projectId/scriptId");
    }
    if (!Array.isArray(o.storyboardIds) || o.storyboardIds.length === 0) {
      throw new Error("[job] image.storyboard.batch 的 storyboardIds 不能为空");
    }
    return { projectId: o.projectId, scriptId: o.scriptId, storyboardIds: o.storyboardIds, compulsory: o.compulsory };
  },
  dedupeKey: (p, userId) => `${userId ?? "anon"}:image.storyboard.batch:${p.scriptId}:${p.storyboardIds.slice().sort((a, b) => a - b).join(",")}`,
  async handle(ctx: JobContext, p: StoryboardImagePayload) {
    const projectSettingData = await u.db("o_project").where("id", p.projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();
    // 产物行（只处理本次 payload 点名、且**仍然存在**的分镜）
    const storyboardData = await u.db("o_storyboard").where("scriptId", p.scriptId).where("projectId", p.projectId).whereIn("id", p.storyboardIds);
    if (!storyboardData.length) return { total: 0 };

    // 关联资产 → imageId（顺序按 assetId，MySQL 无 rowid；与路由同源）
    const storyIds = storyboardData.map((i: any) => i.id);
    const assets2StoryboardRows = await u.db("o_assets2Storyboard").whereIn("storyboardId", storyIds).orderBy("assetId").select("storyboardId", "assetId");
    const allAssetIds = [...new Set(assets2StoryboardRows.map((r: any) => r.assetId))];
    const assetImageMap: Record<number, number> = {};
    if (allAssetIds.length > 0) {
      const assetRows = await u.db("o_assets").whereIn("id", allAssetIds).select("id", "imageId");
      assetRows.forEach((row: any) => { assetImageMap[row.id] = row.imageId; });
    }
    const assetRecord: Record<number, number[]> = {};
    assets2StoryboardRows.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) assetRecord[item.storyboardId] = [];
      const imageId = assetImageMap[item.assetId];
      if (imageId != null) assetRecord[item.storyboardId].push(imageId);
    });

    // ⚠ `compulsory` 时不看 shouldGenerateImage；否则只做 shouldGenerateImage !== 0 的（与路由同口径）
    const generateList = p.compulsory ? storyboardData : storyboardData.filter((item: any) => item.shouldGenerateImage !== 0);
    const failed: string[] = [];
    let index = 0;
    for (const item of generateList) {
      index += 1;
      if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
      // 幂等守卫：已是终态就跳过（重投/回收后不重复烧钱）
      if (item.state === "已完成" || item.state === "生成失败") continue;
      await ctx.progress(Math.round(((index - 1) / Math.max(1, generateList.length)) * 100), `生成分镜图 ${index}/${generateList.length}`);

      const repeloadObj = {
        prompt: item.prompt!,
        size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
        aspectRatio: projectSettingData?.videoRatio as `${number}:${number}`,
      };
      try {
        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          { referenceList: await getAssetsImageBase64(assetRecord[item.id!] || []), ...repeloadObj },
          {
            taskClass: "生成分镜图片",
            describe: "分镜图片生成",
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: p.projectId,
          },
        );
        const savePath = `/${p.projectId}/assets/${p.scriptId}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
        await u.db("o_storyboard").where("id", item.id).update({ filePath: savePath, state: "已完成" });
      } catch (e) {
        const msg = u.error(e).message;
        if (ctx.signal.aborted) throw new Error(`被中止（租约丢失或停机）：${msg}`);
        // ⚠ 该表只有 `reason`（没有 `errorReason`）
        await u.db("o_storyboard").where("id", item.id).update({ filePath: "", reason: msg, state: "生成失败" });
        failed.push(`${item.id}=${msg}`);
      }
    }
    await ctx.progress(100, "完成");
    if (failed.length) throw new Error(`${failed.length} 条分镜图生成失败：${failed.join("; ")}`);
    return { total: generateList.length };
  },
  async onAbandon(payload, reason) {
    if (!payload.storyboardIds.length) return;
    // ⚠ 原因列是 `reason`（`o_storyboard` 没有 `errorReason`）
    await u.db("o_storyboard")
      .whereIn("id", payload.storyboardIds)
      .andWhere("state", "生成中")
      .update({ state: "生成失败", reason: `任务放弃（${reason}）`.slice(0, 1000) });
  },
};
