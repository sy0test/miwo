import express from "express";
import u from "@/utils";
import { mediaKindOf } from "@/utils/oss";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { trackTableForScript } from "@/utils/shots/readShots";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  // "clip" = 转绘的原片参考片段（按 id 取 o_storyboard.clipPath）
  sources?: "assets" | "storyboard" | "clip";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    // 阶段2：v2（结构化分镜）没有"分镜图"（多参模式 shouldGenerateImage=0），
    // 传进来的 id 是镜 id —— 不做 o_storyboard 查询，直接给空参考。legacy 行为不变。
    const isSegments = (await trackTableForScript(u.db, scriptId)) === "o_segment";
    //查询出图片数据
    const images = await Promise.all(
      uploadData.map(async (item: UploadItem) => {
        if (item.sources === "storyboard") {
          if (isSegments) return undefined;
          const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
          return { path: filePath?.filePath, sources: "storyBoard" };
        }
        if (item.sources === "clip") {
          // 转绘：该镜的原片参考片段。供应商侧作为 reference_video 提交（Seedance 的 videoReference）
          const row = await u.db("o_storyboard").where("id", item.id).select("clipPath").first();
          return { path: row?.clipPath, sources: "clip" };
        }
        if (item.sources === "assets") {
          const filePath = await u
            .db("o_assets")
            .where("o_assets.id", item.id)
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type")
            .first();
          return { path: filePath?.filePath, sources: filePath.type };
        }
      }),
    );
    //把images里面的图片转成base64格式
    const base64 = await Promise.all(
      images.map(async (item) => {
        if (!item) return null;
        // 类型按扩展名判，不能只看 o_image.type —— clip 资产的 o_image.type 存的是 "clip"，
        // 一律当 image 会把 mp4 当图片参考送出去（供应商只会静默忽略）
        return { base64: await u.oss.getImageBase64(item.path), type: mediaKindOf(item.path) };
      }),
    );
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    res.status(200).send(success(videoId));
    const relatedObjects = {
      projectId,
      videoId,
      scriptId,
      type: "视频",
    };
    const aiVideo = u.Ai.Video(model);
    aiVideo
      .run(
        {
          prompt,
          referenceList: base64.filter(Boolean) as ReferenceList[],
          mode: modeData.length > 0 ? modeData : mode,
          duration,
          aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
          resolution,
          audio,
        },
        {
          projectId,
          taskClass: "视频生成",
          describe: "根据提示词生成视频",
          relatedObjects: JSON.stringify(relatedObjects),
        },
      )
      .then(async () => await aiVideo.save(videoPath))
      .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" }))
      .catch(async (error: any) => {
        await u
          .db("o_video")
          .where("id", videoId)
          .update({
            state: "生成失败",
            errorReason: u.error(error).message,
          });
      });
  },
);
