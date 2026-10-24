import express from "express";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { trackTableForId, updateTrackById, storyboardItemsForSegment } from "@/utils/shots/readShots";
import { withVendorSlot, apiHolderId } from "@/jobs/gate";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    projectId: z.number(),
    info: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    const { trackId, projectId, info, model, mode } = req.body;
    // 阶段2：状态与提示词写在"这一段"上（v2 → o_segment，legacy → o_videoTrack；字段名一致）
    await updateTrackById(u.db, trackId, { state: "生成中" });
    //查询参数
    // 阶段2：v2 下 info 里的 id 是**镜 id**（o_shot），参考素材与绑定都从新表取；
    // legacy 下仍是 o_storyboard 行 id。用 trackId 判定本集走哪条。
    const isSegments = (await trackTableForId(u.db, trackId)) === "o_segment";
    // v2：生成单位是片段（=界面上的"分镜"）→ 分镜信息由**服务端按片段直接取**，
    // 不再依赖客户端把"段内每一镜"当卡片传上来（界面已不再这样传；依赖 info 会让这块整块丢）。
    // 产出与旧路径（收集 info 里的镜 id 再收敛）完全一致，有回归用例比对。
    const segItems = isSegments ? await storyboardItemsForSegment(u.db, Number(trackId)) : [];
    const images = await Promise.all(
      info.map(async (item: { id: number; sources: string }) => {
        if (item.sources === "storyboard") {
          if (isSegments) return null; // 片段项在上面统一生成（见 segItems）
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
            _type: "storyboard", // 标记类型，便于后续区分
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
            _type: "assets", // 标记类型
          };
        }
      }),
    );

    // 拆分 assets 和 storyboard
    const assets: any[] = [];
    const storyboard: any[] = [];
    // v2：片段项先行（一片段一条），再遍历 assets
    storyboard.push(...segItems);
    for (const item of images) {
      if (!item) continue; // 忽略空
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
    // 音色表：o_assetsRole2Audio 的两端含义是「角色资产 → 音频资产」。
    // 前端传进来的 audio 素材，其 id 是**音频根资产自己的 id**（getAudioBindAssetsList 返回的
    // 就是 o_assets.id），所以必须按 `assetsAudioId` 去查、取出 `assetsRoleId`。
    //
    // ⚠ 这里原来是反的：拿音频资产 id 去 `whereIn("o_assets.id", …)` 再
    // `join(o_assetsRole2Audio, assetsAudioId, o_assets.assetsId)` —— 音频资产是根资产
    // （assetsId 为空），这个 join 永不命中，`assetsAudioRecord` 恒为 {}。
    // 后果：模板里「音色：取自 @图片M」永远拿不到数据，模型只能按 9 维表瞎猜声音。
    // 口径与 getGenerateData.ts / getAudioBindAssetsList.ts 一致（都按 assetsRoleId 关联）。
    const audioAssetIds = assets.filter((i) => i.type == "audio").map((i) => i.id);
    const assets2Audio = audioAssetIds.length
      ? await u.db("o_assetsRole2Audio").whereIn("assetsAudioId", audioAssetIds).select("assetsAudioId", "assetsRoleId")
      : [];

    const assetsAudioRecord: Record<number, number> = {};
    assets2Audio.forEach((i: any) => {
      // key = 角色资产 id（模板按角色找音色），value = 音频资产 id（要挂的参考图）
      if (i.assetsRoleId != null && i.assetsAudioId != null) assetsAudioRecord[i.assetsRoleId] = i.assetsAudioId;
    });

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
    const content = `
          **模型名称**：${modelData},

          **资产信息**（角色、场景、道具、音频):${assets
            .filter((i) => i.filePath)
            .map((i) => `[${i.id},${i.type},${i.name} ${assetsAudioRecord[i.id] ? `audio:${assetsAudioRecord[i.id]}` : ""} ] `)
            .join("，")},
          **分镜信息**：${storyboard.map(
            (i) => `<storyboardItem
  videoDesc='${i.videoDesc}'
  duration='${i.duration}'
  associateAssetsIds="[${(i.associateAssetsIds ?? []).join(",")}]"
></storyboardItem>`,
          )},
          `;

    try {
      // Phase 1d Task 9：厂商调用前过全局闸门（spec §9.3）。响应形态不变（仍同步返回 text）。
      const { text } = await withVendorSlot("vendor:text", apiHolderId(), () =>
        u.Ai.Text("universalAi", currentAiBillingContext()).invoke({
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
      }),
      );
      await updateTrackById(u.db, trackId, {
        state: "已完成",
        prompt: text,
      });
      res.status(200).send(success(text));
    } catch (e) {
      await updateTrackById(u.db, trackId, {
        state: "生成失败",
        reason: u.error(e).message,
      });
      res.status(400).send(error(u.error(e).message));
    }
  },
);
