/**
 * 视频提示词批量生成 handler（从 `routes/production/workbench/batchGeneratePrompt.ts:91-207` 的生成段搬来）。
 *
 * 搬运 5 点改造（brief Step 2 清单）：
 *  1. ✅ 生成段搬进 `handle`（含"按模型挑模板 → 拼装 content → 调文本模型 → 写轨道行"）。
 *  2. ✅ 入参全走 payload（`projectId`/`model`/`mode`/`trackData`），不再读 `req.body`。
 *  3. ✅ 每个 track 开头 `if (ctx.signal.aborted) throw` + `ctx.progress`。
 *  4. ✅ 幂等守卫：轨道行 state 已是终态（已完成/生成失败）就跳过。
 *  5. ✅ `onAbandon` 用现成的 **`updateTrackById`** 把轨道行改判为"生成失败"并写 `reason`
 *     （v2=o_segment / legacy=o_videoTrack，**不自己判断表名** —— brief 明确要求）。
 *
 * ⚠ `trackData` 只含 `info[].id/sources`（**不带 base64**）：参考图由 handler 按 id 现取。
 */
import fs from "fs/promises";
import path from "path";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import { storyboardItemsForSegment, storyboardItemsForShots, trackTableForId, updateTrackById } from "@/utils/shots/readShots";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { withVendorSlot } from "@/jobs/gate";

export interface PromptTrackData {
  trackId: number;
  info: Array<{ id: number; sources: string }>;
}
export interface PromptBatchPayload {
  projectId: number;
  model: string;
  mode: string;
  trackData: PromptTrackData[];
}

/** 按模型/mode 挑提示词模板（与路由 `:40-89` 逐条对应）。 */
async function loadPromptTemplate(model: string, mode: string): Promise<string> {
  const [id, modelData] = model.split(/:(.+)/);
  const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
  let videoPromptGeneration: string | undefined = "";

  const modelPromptData = await u.db("o_modelPrompt").where("vendorId", id).where("model", modelData).first();
  if (modelPromptData) {
    const modelPromptRoot = u.getPath(["modelPrompt"]);
    try {
      videoPromptGeneration = (await fs.readFile(path.join(modelPromptRoot, modelPromptData?.path!), "utf-8")) ?? "";
    } catch {}
  }

  if (!videoPromptGeneration) {
    const modelPromptRoot = u.getPath(["modelPrompt"]);
    const videoPromptDir = path.join(modelPromptRoot, "video");
    const modelLower = (modelData ?? "").toLowerCase();
    let fileName: string | null = null;
    if (/seedance/i.test(modelLower)) fileName = "seedance2Multi-parameterMode.md";
    else if (modelLower.includes("wan") && modelLower.includes("2.6")) fileName = "wan2.6Single-imageFirstFrameMode.md";
    else if (mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional") fileName = "universalFirstAndLastFrameMode.md";
    else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) fileName = "universalMulti-parameterMode.md";
    if (fileName) {
      try {
        videoPromptGeneration = await fs.readFile(path.join(videoPromptDir, fileName), "utf-8");
      } catch {}
    }
  }

  if (!videoPromptGeneration) {
    videoPromptGeneration = videoPrompt?.useData ? videoPrompt.useData : (videoPrompt?.data ?? undefined);
  }
  return videoPromptGeneration ?? "";
}

export interface PromptBatchContext {
  modelData: string;
  videoPromptGeneration: string;
  styleGuide: string;
}

export async function loadPromptBatchContext(projectId: number, model: string, mode: string): Promise<PromptBatchContext> {
  const [, modelData] = model.split(/:(.+)/);
  const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
  return {
    modelData,
    videoPromptGeneration: await loadPromptTemplate(model, mode),
    styleGuide: u.feicai.buildStyleGuide(projectData),
  };
}

export async function buildPromptBatchInput(context: PromptBatchContext, track: PromptTrackData): Promise<{ system: string; messages: Array<{ role: "assistant" | "user"; content: string }> }> {
  const trackTable = await trackTableForId(u.db, track.trackId);
  const isSegments = trackTable === "o_segment";
  const segItems = isSegments ? await storyboardItemsForSegment(u.db, track.trackId) : [];
  const images = await Promise.all(track.info.map(async (item) => {
    if (item.sources === "storyboard") {
      if (isSegments) return null;
      const storyboard = await u.db("o_storyboard").where("o_storyboard.id", item.id).select("videoDesc", "prompt", "track", "duration", "shouldGenerateImage").first();
      const assetRows = await u.db("o_assets2Storyboard").where("storyboardId", item.id).orderBy("assetId").select("assetId");
      return { ...storyboard, associateAssetsIds: assetRows.map((row: any) => row.assetId), _type: "storyboard" };
    }
    if (item.sources === "assets") {
      const assetsData = await u.db("o_assets").leftJoin("o_image", "o_image.id", "o_assets.imageId").where("o_assets.id", item.id).select("o_assets.id", "o_assets.type", "o_assets.name", "o_image.filePath").first();
      return { ...assetsData, _type: "assets" };
    }
    return null;
  }));

  const assets: any[] = [];
  const storyboard: any[] = [...segItems];
  for (const item of images) {
    if (!item) continue;
    if (item._type === "assets") assets.push({ id: item.id, type: item.type, name: item.name, filePath: item.filePath });
    if (item._type === "storyboard") storyboard.push({
      videoDesc: item.videoDesc,
      prompt: item.prompt,
      track: item.track,
      duration: item.duration,
      associateAssetsIds: item.associateAssetsIds,
      shouldGenerateImage: item.shouldGenerateImage,
    });
  }

  const content = `
          **模型名称**：${context.modelData},
          **资产信息**（角色、场景、道具、音频):${assets.filter((i: any) => i.filePath).map((i: any) => `[${i.id},${i.type},${i.name}]`).join("，")},
          **分镜信息**：${storyboard.map((i: any) => `<storyboardItem
  videoDesc='${i.videoDesc}'
  duration='${i.duration}'
  associateAssetsIds="[${(i.associateAssetsIds ?? []).join(",")}]"
></storyboardItem>`)},
          `;
  return {
    system: context.videoPromptGeneration,
    messages: [
      { role: "assistant", content: `${context.styleGuide}` },
      { role: "user", content },
    ],
  };
}

export const promptBatch: JobDefinition<PromptBatchPayload> = {
  type: "prompt.batch",
  timeoutMs: 600_000,
  maxAttempts: 2,
  pool: "vendor:text",
  parse(raw) {
    const o = raw as Partial<PromptBatchPayload>;
    if (!o || typeof o.projectId !== "number" || typeof o.model !== "string") {
      throw new Error("[job] prompt.batch payload 缺少 projectId/model");
    }
    if (!Array.isArray(o.trackData) || o.trackData.length === 0) throw new Error("[job] prompt.batch 的 trackData 不能为空");
    for (const t of o.trackData) {
      if (typeof t.trackId !== "number" || !Array.isArray(t.info)) throw new Error("[job] prompt.batch 的 trackData 元素缺少 trackId/info");
    }
    return { projectId: o.projectId, model: o.model, mode: String(o.mode ?? ""), trackData: o.trackData };
  },
  dedupeKey: (p, userId) => {
    const ids = p.trackData.map((t) => t.trackId).slice().sort((a, b) => a - b).join(",");
    return `${userId ?? "anon"}:prompt.batch:${p.projectId}:${ids}`;
  },
  async handle(ctx: JobContext, p: PromptBatchPayload) {
    const context = await loadPromptBatchContext(p.projectId, p.model, p.mode);

    const failed: string[] = [];
    let index = 0;
    for (const track of p.trackData) {
      index += 1;
      if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");

      // 幂等守卫：轨道行已是终态就跳过（先读一次；v2/legacy 表名由助手判定）
      const trackTable = await trackTableForId(u.db, track.trackId);
      if (trackTable) {
        const trackRow = await u.db(trackTable).where("id", track.trackId).select("state").first();
        if (trackRow && (trackRow.state === "已完成" || trackRow.state === "生成失败")) continue;
      }

      await ctx.progress(Math.round(((index - 1) / p.trackData.length) * 100), `生成提示词 ${index}/${p.trackData.length}`);

      const input = await buildPromptBatchInput(context, track);
      try {
        // Phase 1d Task 9：厂商调用前过 `vendor:text` 闸门（spec §9.3）。只包这一次调用。
        const { text } = await withVendorSlot("vendor:text", ctx.workerId, () =>
          u.Ai.Text("universalAi", currentAiBillingContext()).invoke(input),
        );
        if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
        await updateTrackById(u.db, track.trackId, { prompt: text, state: "已完成" });
      } catch (e) {
        const msg = u.error(e).message;
        if (ctx.signal.aborted) throw new Error(`被中止（租约丢失或停机）：${msg}`);
        await updateTrackById(u.db, track.trackId, { state: "生成失败", reason: msg });
        failed.push(`${track.trackId}=${msg}`);
      }
    }
    await ctx.progress(100, "完成");
    if (failed.length) throw new Error(`${failed.length}/${p.trackData.length} 条提示词生成失败：${failed.join("; ")}`);
    return { total: p.trackData.length };
  },
  async onAbandon(payload, reason) {
    // ⚠ 用现成的 `updateTrackById`：v2=o_segment / legacy=o_videoTrack，**不自己判断表名**（brief 要求）
    for (const t of payload.trackData) {
      await updateTrackById(u.db, t.trackId, { state: "生成失败", reason: `任务放弃（${reason}）`.slice(0, 1000) });
    }
  },
};
