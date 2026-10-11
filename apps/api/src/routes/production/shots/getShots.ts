import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine, readShotsForScript, hasStructuredShots, segmentsToLegacyStoryboard, segmentsToLegacyTracks } from "@/utils/shots/readShots";

/**
 * 读结构化分镜（阶段1 的读取入口）。
 *
 * 用途：分镜台/生成台切到新表时读这一份；同时把片段投影成旧 storyboard/track 形状，
 * 让下游在改造完成前可以无感消费。
 *
 * 请求：{ scriptId: number }
 * 返回：{
 *   engine: "legacy" | "v2",          // 设置 o_setting.shotsEngine 决定
 *   hasStructured: boolean,           // 该集是否已有结构化数据（没有则调用方应走旧结构）
 *   segments, shots, assetIdsBySegment,
 *   storyboard, tracks                // 投影出的旧形状（便于过渡期直接替换数据源）
 * }
 */
export default express.Router().post(
  "/",
  validateFields({
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { scriptId } = req.body as { scriptId: number };
    const engine = await readShotsEngine(u.db);
    const hasStructured = await hasStructuredShots(u.db, scriptId);
    if (engine !== "v2" || !hasStructured) {
      return res.status(200).send(success({ engine, hasStructured, segments: [], shots: [], assetIdsBySegmentIndex: {}, storyboard: [], tracks: [] }));
    }
    const rows = await readShotsForScript(u.db, scriptId);
    return res.status(200).send(
      success({
        engine,
        hasStructured,
        segments: rows.segments,
        shots: rows.shots,
        assetIdsBySegmentIndex: rows.assetIdsBySegmentIndex,
        storyboard: segmentsToLegacyStoryboard(rows),
        tracks: segmentsToLegacyTracks(rows),
      }),
    );
  },
);
