import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { trackTableForId, requireStructured, NOT_STRUCTURED_HINT, readShotsForScript } from "@/utils/shots/readShots";
import { bindSegmentAssets } from "@/utils/shots/bindAssets";

/**
 * 分镜台/工作台里"给这一段选资产"的落库入口（v2）。
 *
 * 真机 bug：以前这件事**没有任何接口落库** —— 选的素材只活在前端缓存里，关掉工作台再进来就没了
 *（`initCacheFromTrackList` 会丢弃「有 id 但服务端不返回」的条目）。这里：
 *   1. 写 `o_shotAssets`（该片段所有镜）
 *   2. 同步分镜表文本里该片段的「引用资产名称/ID」两行（**文本是真相**，不改下次再解析会覆盖）
 * 并把最新的分镜表文本回给前端，免得节点里显示的还是旧的。
 */
export default express.Router().post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    segmentId: z.number(),
    assetIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, scriptId, segmentId, assetIds } = req.body as { projectId: number; scriptId: number; segmentId: number; assetIds: number[] };
    if ((await trackTableForId(u.db, segmentId)) !== "o_segment") return res.status(400).send(error(NOT_STRUCTURED_HINT));
    if (!(await requireStructured(u.db, scriptId))) return res.status(400).send(error(NOT_STRUCTURED_HINT));

    const r = await bindSegmentAssets(u.db, { projectId, scriptId, segmentId, assetIds });
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));

    // 回最新的分镜表文本（文本刚被改过），前端可直接更新节点
    let storyboardTable = "";
    try {
      const row: any = await u
        .db("o_agentWorkData")
        .where("projectId", String(projectId))
        .andWhere("episodesId", String(scriptId))
        .andWhere("key", "productionAgent")
        .select("data")
        .first();
      storyboardTable = row?.data ? (JSON.parse(row.data)?.storyboardTable ?? "") : "";
    } catch {}
    console.log(
      `[shots/bindSegmentAssets] ep=${scriptId} 片段=${segmentId} 绑定 ${r.assetIds.length} 个资产（文本${r.changedText ? "已同步" : "未变"}）` +
        (r.errors.length ? `｜${r.errors.join("；")}` : ""),
    );
    return res.status(200).send(success({ assetIds: r.assetIds, changedText: r.changedText, storyboardTable, segments: (await readShotsForScript(u.db, scriptId)).segments.length }));
  },
);
