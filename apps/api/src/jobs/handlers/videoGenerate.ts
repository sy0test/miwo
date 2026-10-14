/**
 * 视频生成 handler（spec §9.1 的两个入口：单个 / 批量）。
 *
 * 与旧代码的关系：旧版本在路由里 `aiVideo.run(...).then(save).then(update).catch(update)`，
 * **fire-and-forget 且只活在内存**（进程重启 → `o_video.state` 永久停在"生成中"）。
 * 现在路由只做"建行 + 入队 + 返回 id"，生成移到这里，由租约保护、可回收、可重试（视频不重试）。
 *
 * ⚠ **abort 是协作式的**（B 组 review-B F6）：worker 的 `ctx.signal` 只能通知，拦不住 handler
 *   直接写业务表。所以每一轮循环开头都要 `if (ctx.signal.aborted) throw`，且写终态前复查。
 *
 * 幂等守卫（"同一任务不重复跑"的第三层）：进入时先看 `o_video.state`；已经是终态
 * （生成成功/生成失败）就直接跳过，**不再调厂商**（省的是真金白银）。
 */
import crypto from "node:crypto";
import u from "@/utils";
import { mediaKindOf } from "@/utils/oss";
import type { ReferenceList } from "@/utils/ai";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { withVendorSlot } from "@/jobs/gate";

export interface VideoRef {
  path: string;
  sources: string;
}
export interface VideoItem {
  videoId: number;
  videoPath: string;
  trackId: number;
  prompt: string;
  duration: number;
  refs: VideoRef[];
}
export interface VideoBatchPayload {
  projectId: number;
  scriptId: number;
  model: string;
  mode: unknown;
  resolution: string;
  audio?: boolean;
  aspectRatio: "16:9" | "9:16";
  items: VideoItem[];
}

function parseBatch(raw: unknown): VideoBatchPayload {
  const o = raw as Partial<VideoBatchPayload>;
  if (!o || typeof o !== "object") throw new Error("[job] video payload 必须是对象");
  if (typeof o.projectId !== "number" || typeof o.scriptId !== "number") throw new Error("[job] video payload 缺少 projectId/scriptId");
  if (typeof o.model !== "string" || typeof o.resolution !== "string") throw new Error("[job] video payload 缺少 model/resolution");
  if (!Array.isArray(o.items) || o.items.length === 0) throw new Error("[job] video payload 的 items 不能为空");
  for (const it of o.items) {
    if (typeof it.videoId !== "number" || typeof it.videoPath !== "string" || typeof it.prompt !== "string") {
      throw new Error("[job] video payload 的 items 元素缺少 videoId/videoPath/prompt");
    }
  }
  return {
    projectId: o.projectId,
    scriptId: o.scriptId,
    model: o.model,
    mode: o.mode,
    resolution: o.resolution,
    audio: o.audio,
    aspectRatio: o.aspectRatio ?? "16:9",
    items: o.items,
  };
}

/**
 * `video.generate` 的 parse。
 *
 * ⚠⚠ **必须幂等**（review-C F1，Critical）：入队时 `store.enqueue()` 会先 `parse()` 归一化再入库，
 * worker 领到后又把**入库的那份 JSON** 再 `parse()` 一次（`worker.ts`）。所以 `parse` 必须满足
 * `parse(parse(raw)) === parse(raw)`：本函数对"已经归一化过的 `items[]` 形状"直接走 `parseBatch`，
 * 否则用 `parseSingle` 把"扁平单条"包成 `items[]`。
 * 改坏这一条的后果是**最常用的单个视频入口**入队成功、worker 领走即 `dead`
 * （实测原文：`lastError=[job] video.generate payload 缺少 videoId`，`o_video.state` 卡在"生成中"）。
 * 机械守卫：`tests/job-parse-roundtrip.test.ts`（对注册表全部类型跑往返）。
 */
function parseSingle(raw: unknown): VideoBatchPayload {
  const o = raw as Partial<VideoBatchPayload> & { trackId?: number; videoId?: number; videoPath?: string; prompt?: string; duration?: number; refs?: VideoRef[] };
  // 已经是归一化形状（入库后的那份）⇒ 直接按批处理解析（幂等分支，F1）。
  // ⚠ 只在 items **非空**时走这条：空 items 必须落到 `parseBatch` 的"items 不能为空"校验里
  //   （幂等化不许把校验放宽 —— 见 job-parse-roundtrip.test.ts 的"坏形状仍然抛"）。
  if (Array.isArray(o?.items) && o.items.length > 0) return parseBatch(o);
  if (typeof o?.videoId !== "number") throw new Error("[job] video.generate payload 缺少 videoId");
  return parseBatch({
    ...o,
    items: [{ videoId: o.videoId, videoPath: o.videoPath as string, trackId: o.trackId as number, prompt: o.prompt as string, duration: o.duration as number, refs: o.refs ?? [] }],
  });
}

/** 逐条生成。`ctx.signal` 被 abort（租约丢失/超时/停机）时，当前这条会抛错、后续条目不再开始。 */
async function runItems(ctx: JobContext, p: VideoBatchPayload): Promise<unknown> {
  const results: Array<{ videoId: number; ok: boolean; error?: string }> = [];
  let index = 0;
  for (const item of p.items) {
    index += 1;
    if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");

    // 幂等守卫：已经是终态就跳过（重投/回收后不重复烧钱）
    const row = await u.db("o_video").where("id", item.videoId).select("state").first();
    if (!row) {
      results.push({ videoId: item.videoId, ok: false, error: "o_video 行不存在" });
      continue;
    }
    if (row.state === "生成成功" || row.state === "生成失败") {
      results.push({ videoId: item.videoId, ok: row.state === "生成成功", error: row.state === "生成失败" ? "已失败（跳过重跑）" : undefined });
      continue;
    }

    await ctx.progress(Math.round(((index - 1) / p.items.length) * 100), `生成视频 ${index}/${p.items.length}`);

    const referenceList: ReferenceList[] = [];
    for (const ref of item.refs ?? []) {
      if (!ref?.path) continue;
      referenceList.push({ base64: await u.oss.getImageBase64(ref.path), type: mediaKindOf(ref.path) } as ReferenceList);
    }

    try {
      // Phase 1d Task 9：厂商调用前过全局闸门（spec §9.3）。⚠ 只包**这一次厂商调用**，
      // 不包整条任务（一条视频任务可能跑 15 分钟，包整条会让 globalMaxRunning 退化成 1）。
      // 超时（gateWaitMs，默认 120s）⇒ 抛错 ⇒ 下面 catch 把它写成"生成失败"（可诊断、可重跑）。
      const aiVideo = await withVendorSlot("vendor:video", ctx.workerId, async () => {
        const cls = u.Ai.Video(p.model as `${string}:${string}`);
        await cls.run(
          {
            prompt: item.prompt,
            referenceList,
            mode: (p.mode ?? []) as never,
            duration: item.duration,
            aspectRatio: p.aspectRatio,
            resolution: p.resolution,
            audio: p.audio,
          },
          {
            projectId: p.projectId,
            taskClass: "视频生成",
            describe: "根据提示词生成视频",
            relatedObjects: JSON.stringify({ projectId: p.projectId, videoId: item.videoId, scriptId: p.scriptId, type: "视频" }),
          },
        );
        return cls;
      });
      await aiVideo.save(item.videoPath);
      // ⚠ 写终态前复查 abort（协作式 abort：厂商调用可能刚被中止）
      if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
      await u.db("o_video").where("id", item.videoId).update({ state: "生成成功" });
      results.push({ videoId: item.videoId, ok: true });
    } catch (e) {
      const msg = u.error(e).message;
      // ⚠ 被中止时**不写"生成失败"**：租约已丢失，这一行该留给回收后的重跑/对账（B 组 I4 同族纪律）
      if (ctx.signal.aborted) throw new Error(`被中止（租约丢失或停机）：${msg}`);
      await u.db("o_video").where("id", item.videoId).update({ state: "生成失败", errorReason: msg });
      results.push({ videoId: item.videoId, ok: false, error: msg });
    }
  }
  const failed = results.filter((r) => !r.ok);
  await ctx.progress(100, "完成");
  // 部分失败：视为任务失败（可诊断），但已成功的那几条的产物已经落库且不会被重跑（幂等守卫）
  if (failed.length > 0) throw new Error(`${failed.length}/${results.length} 条视频生成失败：${failed.map((f) => `${f.videoId}=${f.error}`).join("; ")}`);
  return { items: results };
}

/** `onAbandon` 共用：把该任务写过的 `o_video` 行从"生成中"改判为"生成失败"（幂等）。 */
async function abandonVideos(payload: VideoBatchPayload, reason: string): Promise<void> {
  const ids = payload.items.map((i) => i.videoId);
  if (!ids.length) return;
  await u.db("o_video").whereIn("id", ids).andWhere("state", "生成中").update({ state: "生成失败", errorReason: `任务放弃（${reason}）`.slice(0, 1000) });
}

export const videoGenerate: JobDefinition<VideoBatchPayload> = {
  type: "video.generate",
  timeoutMs: 900_000, // spec §9.3：视频 ≤ 15 分钟
  maxAttempts: 1, // 视频不重试（重复调用=重复扣费；失败交给人看死信）
  pool: "vendor:video",
  parse: parseSingle,
  dedupeKey: (p, userId) => `${userId ?? "anon"}:video.generate:${p.scriptId}:${p.items[0]?.trackId ?? 0}`,
  handle: runItems,
  onAbandon: abandonVideos,
};

export const videoBatchGenerate: JobDefinition<VideoBatchPayload> = {
  type: "video.batchGenerate",
  timeoutMs: 900_000,
  maxAttempts: 1,
  pool: "vendor:video",
  parse: parseBatch,
  dedupeKey: (p, userId) => {
    const tracks = p.items.map((i) => i.trackId).join(",");
    return `${userId ?? "anon"}:video.batch:${p.scriptId}:${crypto.createHash("sha1").update(tracks).digest("hex")}`;
  },
  handle: runItems,
  onAbandon: abandonVideos,
};
