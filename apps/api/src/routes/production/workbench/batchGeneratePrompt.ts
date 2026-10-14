import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { trackTableForId, updateTrackById, storyboardItemsForShots } from "@/utils/shots/readShots";
import { enqueueJob } from "@/jobs";
import { currentUserId } from "@/jobs/context";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    trackData: z.array(
      z.object({
        trackId: z.number(),
        info: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
          }),
        ),
      }),
    ),
    mode: z.string(),
    model: z.string(),
    concurrentCount: z.number().optional(), //并发数
  }),
  async (req, res) => {
    const { trackData, projectId, mode, model, concurrentCount = 5 } = req.body;
    try {
      // 预加载公共数据
      const [id, modelData] = model.split(/:(.+)/);
      const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
      const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
      let videoPromptGeneration = "" as string | undefined;

      const modelPromptData = await u.db("o_modelPrompt").where("vendorId", id).where("model", modelData).first();
      //查询到 有绑定对应视频提示词
      if (modelPromptData) {
        const modelPromptRoot = u.getPath(["modelPrompt"]);
        try {
          const fullPath = path.join(modelPromptRoot, modelPromptData?.path!);
          const content = await fs.readFile(fullPath, "utf-8");
          videoPromptGeneration = content ?? "";
        } catch {}
      }

      // 未查询到绑定，根据模型名称 + mode 自动匹配 modelPrompt/video/ 下的文件
      if (!videoPromptGeneration) {
        const modelPromptRoot = u.getPath(["modelPrompt"]);
        const videoPromptDir = path.join(modelPromptRoot, "video");
        const modelLower = (modelData ?? "").toLowerCase();

        let fileName: string | null = null;

        if (/seedance/i.test(modelLower)) {
          // seedance 全族（2-0 / 2-5 / 后续 2-x）一律走 seedance2 多参模板
          fileName = "seedance2Multi-parameterMode.md";
        } else if (modelLower.includes("wan") && modelLower.includes("2.6")) {
          // wan2.6 系列 => 单图首尾帧模式（非 seedance 模型的兜底，现用不到）
          fileName = "wan2.6Single-imageFirstFrameMode.md";
        } else if (mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional") {
          // body.mode 为首尾帧相关 => 通用首尾帧模式
          fileName = "universalFirstAndLastFrameMode.md";
        } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
          // 其他 => 通用多参模式
          fileName = "universalMulti-parameterMode.md";
        }
        if (fileName) {
          try {
            const fullPath = path.join(videoPromptDir, fileName);
            videoPromptGeneration = await fs.readFile(fullPath, "utf-8");
          } catch {
            // 文件不存在则忽略，继续用备选
          }
        }
      }

      //备选
      if (!videoPromptGeneration) {
        if (videoPrompt && videoPrompt.useData) {
          videoPromptGeneration = videoPrompt.useData;
        } else {
          videoPromptGeneration = videoPrompt?.data ?? undefined;
        }
      }

      const styleGuide = u.feicai.buildStyleGuide(projectData);
      // 阶段2：v2 下"轨道"= 片段（o_segment），两表字段名一致 → 用助手逐个更新
      await Promise.all(trackData.map((t: { trackId: number }) => updateTrackById(u.db, t.trackId, { state: "生成中" })));
      // 并发控制：每个 track 独立走 查询→拼装→AI调用→更新 流程
      const limit = pLimit(concurrentCount ?? 5);
      const tasks = trackData.map((track: { trackId: number; info: { id: number; sources: string }[] }) =>
        limit(async () => {
          // 阶段2：v2 下 info 里的 id 是**镜 id**，素材与绑定从新表取
          const isSegments = (await trackTableForId(u.db, track.trackId)) === "o_segment";
          // v2：生成单位是片段 → 先收敛成"一片段一条"（否则同一段描述会被渲染多遍）
          const segItems = isSegments
            ? await storyboardItemsForShots(
                u.db,
                track.info.filter((i: any) => i.sources === "storyboard").map((i: any) => i.id),
              )
            : [];
          // 查询参数
          const images = await Promise.all(
            track.info.map(async (item: { id: number; sources: string }) => {
              if (item.sources === "storyboard") {
                if (isSegments) return null; // 片段项在上面统一生成
                // 查询分镜主信息
                const storyboard = await u
                  .db("o_storyboard")
                  .where("o_storyboard.id", item.id)
                  .select("videoDesc", "prompt", "track", "duration", "shouldGenerateImage")
                  .first();
                // 查询分镜关联的资产ID（⚠ MySQL 无 `rowid` ⇒ 用 assetId 作确定性顺序；插入序要显式排序列，Phase 1c）
                const assetRows = await u.db("o_assets2Storyboard").where("storyboardId", item.id).orderBy("assetId").select("assetId");
                const associateAssetsIds = assetRows.map((row: any) => row.assetId);
                return {
                  ...storyboard,
                  associateAssetsIds,
                  _type: "storyboard",
                };
              }
              if (item.sources === "assets") {
                // 查询素材
                const assetsData = await u
                  .db("o_assets")
                  .leftJoin("o_image", "o_image.id", "o_assets.imageId")
                  .where("o_assets.id", item.id)
                  .select("o_assets.id", "o_assets.type", "o_assets.name", "o_image.filePath")
                  .first();
                return {
                  ...assetsData,
                  _type: "assets",
                };
              }
            }),
          );

          // 拆分 assets 和 storyboard
          const assets: any[] = [];
          const storyboard: any[] = [];
          storyboard.push(...segItems); // v2：片段项先行（一片段一条）
          for (const item of images) {
            if (!item) continue;
            if (item._type === "assets")
              assets.push({
                id: item.id,
                type: item.type,
                name: item.name,
                filePath: item.filePath,
              });
            if (item._type === "storyboard")
              storyboard.push({
                videoDesc: item.videoDesc,
                prompt: item.prompt,
                track: item.track,
                duration: item.duration,
                associateAssetsIds: item.associateAssetsIds,
                shouldGenerateImage: item.shouldGenerateImage,
              });
          }

          const content = `
          **模型名称**：${modelData},
          **资产信息**（角色、场景、道具、音频):${assets
            .filter((i: any) => i.filePath)
            .map((i: any) => `[${i.id},${i.type},${i.name}]`)
            .join("，")},
          **分镜信息**：${storyboard.map(
            (i: any) => `<storyboardItem
  videoDesc='${i.videoDesc}'
  duration='${i.duration}'
  associateAssetsIds="[${(i.associateAssetsIds ?? []).join(",")}]"
></storyboardItem>`,
          )},
          `;

          try {
            const { text } = await u.Ai.Text("universalAi").invoke({
              system: videoPromptGeneration,
              messages: [
                {
                  role: "assistant",
                  content: `${styleGuide}`,
                },
                {
                  role: "user",
                  content: content,
                },
              ],
            });

            await updateTrackById(u.db, track.trackId, {
              prompt: text,
              state: "已完成",
            });

            return { trackId: track.trackId, text };
          } catch (e: any) {
            await updateTrackById(u.db, track.trackId, { state: "生成失败", reason: u.error(e).message });
          }
        }),
      );

      // 后台执行，不等待结果
      Promise.all(tasks);
      res.status(200).send(success("开始生成提示词"));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
