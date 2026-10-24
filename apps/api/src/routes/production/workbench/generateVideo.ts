import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueJobInTransaction } from "@/jobs";
import { currentUserId } from "@/jobs/context";
import { submitBilledJob } from "@/billing/submit";
import { resolveSubmissionEstimate } from "@/billing/estimate";
import { videoPricingUnit } from "@/billing/prices";
import { trackTableForScript } from "@/utils/shots/readShots";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  // "clip" = 转绘的原片参考片段（segments 引擎取 o_segment.clipPath，legacy 取 o_storyboard.clipPath）
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
          // 转绘：该段的原片参考片段。供应商侧作为 reference_video 提交（Seedance 的 videoReference）。
          // ⚠ v2 下 id 是**片段 id**（o_segment），不是 legacy 的 o_storyboard 行 id —— 按引擎切表。
          const row = isSegments
            ? await u.db("o_segment").where("id", item.id).select("clipPath").first()
            : await u.db("o_storyboard").where("id", item.id).select("clipPath").first();
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
    // Phase 2: row creation, queue insertion, and reservation share one transaction.
    const userId = currentUserId(req);
    if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
    const submitted = await submitBilledJob({
      db: u.db as any,
      userId,
      estimateMicro: (trx) => resolveSubmissionEstimate(trx, model, videoPricingUnit(resolution), duration),
      idempotencyKey: `job:${userId}:video.generate:${scriptId}:${trackId}`,
      createBusinessRows: async (trx) => {
        const [videoId] = await trx("o_video").insert({
          filePath: videoPath, time: Date.now(), state: "生成中", scriptId, projectId, videoTrackId: trackId,
        });
        return { videoId: Number(videoId), videoPath };
      },
      resolveExistingBusiness: async (trx, existingJobId) => {
        const existing = await trx("o_job").where({ id: existingJobId }).first();
        const existingPayload = JSON.parse(existing.payload) as { items: Array<{ videoId: number; videoPath: string }> };
        const existingVideo = existingPayload.items[0];
        if (!existingVideo) throw new Error(`Existing video job ${existingJobId} has no items`);
        return { videoId: existingVideo.videoId, videoPath: existingVideo.videoPath };
      },
      enqueue: async (trx, business) => enqueueJobInTransaction(trx, {
        type: "video.generate", userId,
        payload: {
          projectId, scriptId, trackId, ...business, prompt, model,
          mode: modeData.length > 0 ? modeData : mode, resolution, duration, audio,
          aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
          refs: images.filter(Boolean).map((it) => ({ path: (it as { path: string }).path, sources: (it as { sources: string }).sources })),
        },
      }),
    });
    res.status(200).send({ ...success(submitted.business.videoId), jobIds: [submitted.jobId] });
  },
);
