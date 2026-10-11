import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsForScript, segmentsToLegacyStoryboard, requireStructured, NOT_STRUCTURED_HINT } from "@/utils/shots/readShots";
import { bindSegmentAssets, syncAllSegmentAssetLines } from "@/utils/shots/bindAssets";
const router = express.Router();

/**
 * 前端逐条提交的分镜数据（形状与下面 zod 校验一致）。
 * 只为让类型清晰 —— v2 下这些提交内容**不落库**（分镜的真相是分镜表文本），
 * 所以仅用于请求校验与"数据不能为空"判断。
 */
interface IncomingStoryboard {
  prompt: string;
  duration: number;
  track: string;
  state: string;
  src: string | null;
  videoDesc: string;
  shouldGenerateImage: number;
  associateAssetsIds: number[];
  /** 写入后回填的新行 id */
  id?: number;
}

export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        prompt: z.string(),
        duration: z.number(),
        track: z.string(),
        state: z.string(),
        src: z.string().nullable(),
        videoDesc: z.string(),
        shouldGenerateImage: z.number(),
        associateAssetsIds: z.array(z.number()),
      }),
    ),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const data: IncomingStoryboard[] = req.body.data;
    const { scriptId } = req.body as { scriptId: number; projectId: number };
    if (!data.length) return res.status(400).send({ success: false, message: "数据不能为空" });

    // 【退役后】v2 是唯一写入端：分镜面板的数据由**代码从结构化表生成**（阶段5 已停），
    // 这里不写 `o_storyboard`。但**卡片的引用资产必须落库** —— 以前这里只回投影，
    // 面板侧手工选/改的资产被静默丢弃（真机 bug：关掉再进来就没了）。
    if (!(await requireStructured(u.db, scriptId))) return res.status(400).send(error(NOT_STRUCTURED_HINT));

    // 面板提交的"卡片"就是片段（id = o_segment.id）→ 逐个把引用资产写进 o_shotAssets
    let bound = 0;
    let skippedNoId = 0;
    for (const item of data) {
      const segId = Number(item.id);
      if (!Number.isFinite(segId)) {
        if (item.associateAssetsIds?.length) skippedNoId++;
        continue; // 新卡片还没 id：它由 addStoryboard 建好片段后、下一次提交才带 id
      }
      if (!Array.isArray(item.associateAssetsIds)) continue;
      const r = await bindSegmentAssets(u.db, { projectId: req.body.projectId, scriptId, segmentId: segId, assetIds: item.associateAssetsIds, syncText: false });
      if (r.ok) bound++;
    }
    // 文本只在最后统一刷一次（避免 N 次重写整表）
    if (bound) await syncAllSegmentAssetLines(u.db, { projectId: req.body.projectId, scriptId });
    if (bound || skippedNoId) console.log(`[batchAddStoryboardInfo] v2：面板资产落库 ${bound} 个片段${skippedNoId ? `；${skippedNoId} 个新卡片无 id 被跳过` : ""}`);

    const rows = await readShotsForScript(u.db, scriptId);
    const projection = segmentsToLegacyStoryboard(rows);
    const storyboardData = projection.map((p) => ({
      associateAssetsIds: p.associateAssetsIds,
      src: "",
      id: p.id,
      trackId: p.id,
      prompt: p.prompt,
      duration: p.duration,
      state: p.state,
      scriptId,
      reason: "",
      videoDesc: p.videoDesc,
    }));
    console.log(`[batchAddStoryboardInfo] v2：不写库，直接返回结构化面板数据 ${storyboardData.length} 条`);
    return res.status(200).send(success(storyboardData));
  },
);
