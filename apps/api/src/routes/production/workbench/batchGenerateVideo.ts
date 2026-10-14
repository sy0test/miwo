import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueJob } from "@/jobs";
import { currentUserId } from "@/jobs/context";
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
    trackData: z.array(
      z.object({
        uploadData: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
          }),
        ),
        trackId: z.number(),
        prompt: z.string(),
        duration: z.number(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body;

    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }

    // 获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();

    // 为每个 track 预处理数据并插入数据库，返回任务列表
    const tasks = await Promise.all(
      (trackData as { uploadData: { id: number; sources: string }[]; trackId: number; prompt: string; duration: number }[]).map(async (track) => {
        const { uploadData, trackId, prompt, duration } = track;

        // 查询出图片数据
        // 阶段2：v2 无分镜图（多参模式），传进来的 id 是镜 id → 不做 o_storyboard 查询
        const isSegments = (await trackTableForScript(u.db, scriptId)) === "o_segment";
        const images = await Promise.all(
          uploadData.map(async (item) => {
            if (item.sources === "storyboard") {
              if (isSegments) return undefined;
              const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
              return { path: filePath?.filePath, sources: "storyBoard" };
            }
            if (item.sources === "clip") {
              // 转绘：该镜的原片参考片段，供应商侧作为 reference_video 提交
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

        const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
        const [videoId] = await u.db("o_video").insert({
          filePath: videoPath,
          time: Date.now(),
          state: "生成中",
          scriptId,
          projectId,
          videoTrackId: trackId,
        });

        return { videoId, videoPath, prompt, duration, images, trackId };
      }),
    );

    // Phase 1d：入队（一个 `video.batchGenerate` 任务带全部 items），不再进程内 fire-and-forget。
    // ⚠ 响应形状不变（前端 `track.vue:336` 把 data 当**数组**用）；jobIds 走新顶层字段。
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
    const { jobId } = await enqueueJob({
      type: "video.batchGenerate",
      userId,
      payload: {
        projectId,
        scriptId,
        model,
        mode: modeData.length > 0 ? modeData : mode,
        resolution,
        audio,
        aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
        items: tasks.map((t) => ({
          videoId: t.videoId,
          videoPath: t.videoPath,
          trackId: t.trackId,
          prompt: t.prompt,
          duration: t.duration,
          // ⚠ refs 只带路径（base64 由 handler 现取）
          refs: t.images.filter(Boolean).map((it) => ({ path: (it as { path: string }).path, sources: (it as { sources: string }).sources })),
        })),
      },
    });
    res.status(200).send({ ...success(tasks.map((t) => ({ videoId: t.videoId, trackId: t.trackId }))), jobIds: [jobId] });
  },
);
