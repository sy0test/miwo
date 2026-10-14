import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { assetItemSchema } from "@/agents/productionAgent/tools";
import { readShotsEngine } from "@/utils/shots/readShots";
import { enqueueJob } from "@/jobs";
import { currentUserId } from "@/jobs/context";
const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().int().min(1).max(8).optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      concurrentCount = 5,
      compulsory = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
    } = req.body;
    if (!storyboardIds || storyboardIds.length === 0) return res.status(400).send(error("storyboardIds不能为空"));
    // 阶段2：v2（多参模式）不出分镜图 —— 传来的 id 是**片段 id**。
    // ⚠ 不加拦截会把片段 id 当 storyboard id 去改 state/shouldGenerateImage（撞上历史行就写坏了）。
    if ((await readShotsEngine(u.db)) === "v2") {
      return res.status(400).send(error("本集为结构化分镜（多参模式），不需要生成分镜图"));
    }
    // 当没有 storyboardIds 时，通过 AI 生成新的分镜面板数据
    let finalStoryboardIds: number[] = storyboardIds || [];
    // shouldGenerateImage === 0 的分镜标记为「未生成」，其余标记为「生成中」
    const storyboardData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", finalStoryboardIds);
    if (!storyboardData.length) return res.status(500).send(error("未查到分镜数据"));
    const storyIds = storyboardData.map((i) => i.id);
    if (compulsory) {
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).update({ state: "生成中", shouldGenerateImage: 1 });
    } else {
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).where("shouldGenerateImage", 0).update({ state: "未生成" });
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).where("shouldGenerateImage", 1).update({ state: "生成中" });
    }

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();

    // 按 **assetId** 顺序查出每个 storyboard 关联的 assetId 列表。
    // ⚠ MySQL 必坏点修复：原 `orderBy("rowid")` 依赖 SQLite 隐式列，MySQL 无 `rowid` ⇒ `ER_BAD_FIELD_ERROR`（500）。
    //   本表只有 (storyboardId, assetId, userId) ⇒ 确定性排序只能用 assetId；"插入顺序"要显式排序列（Phase 1c，已登记）。
    const assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("assetId")
      .select("storyboardId", "assetId");

    // 收集所有 assetId，批量查对应的 imageId
    const allAssetIds = [...new Set(assets2StoryboardRows.map((r: any) => r.assetId))];
    const assetImageMap: Record<number, number> = {};
    if (allAssetIds.length > 0) {
      const assetRows = await u.db("o_assets").whereIn("id", allAssetIds).select("id", "imageId");
      assetRows.forEach((row: any) => {
        assetImageMap[row.id] = row.imageId;
      });
    }

    // 按 rowid 顺序重建 assetRecord，值为有序的 imageId 列表
    const assetRecord: Record<number, number[]> = {};
    assets2StoryboardRows.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) {
        assetRecord[item.storyboardId] = [];
      }
      const imageId = assetImageMap[item.assetId];
      if (imageId != null) {
        assetRecord[item.storyboardId].push(imageId);
      }
    });
    const realStoryData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", storyIds);

    // Phase 1d：入队（生成段搬到 handler），不再进程内 Promise.all 后台跑。
    // ⚠ 响应形状不变（`data` 仍是那个分镜数组）；jobIds 走新顶层字段。
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
    const { jobId } = await enqueueJob({
      type: "image.storyboard.batch",
      userId,
      // ⚠ payload 键是 **storyboardIds（复数数组）**，与 task-7 契约表一致（B 组 reconcile 已对齐）
      payload: { projectId, scriptId, storyboardIds: storyIds, compulsory },
    });

    res.status(200).send({
      ...success(
        realStoryData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetRecord[i.id!],
          src: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
        })),
      ),
      jobIds: [jobId],
    });
  },
);
