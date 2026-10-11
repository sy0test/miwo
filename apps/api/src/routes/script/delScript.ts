import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

/**
 * 删除剧本（连带下游）。
 *
 * ⚠ 这个接口是**不可逆**的，而且删的不只是数据库行：
 *   - `o_storyboard` 行 + **它引用的分镜图文件**（`o.oss.deleteFile(item.filePath)`）
 *   - `o_video` 行（已生成的视频记录）+ `o_videoTrack`（轨道）
 *   - `o_assets2Storyboard`（镜头↔资产绑定）、`o_scriptAssets`、该集的 `o_agentWorkData`
 *
 * 事故背景：前端确认框只写「确定删除选中的 N 个剧本吗？」，用户不知道自己会连带
 * 删掉整集分镜表和已出的视频。所以这里加了**两级保护**：
 *   1. 预检（`POST /api/script/delScriptImpact`）：删除前先问清影响面，界面把数字摆给用户看；
 *   2. 本路由的写入端拦截：没带 `force: true` 且确实有下游产出时，**拒绝执行**并回 409，
 *      把影响面一起回给调用方。这样即使有人绕过界面直接打接口，也不会静默清空下游。
 */
export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
    /** 用户已在「影响面」确认框里明确点过确认。不带则视为未确认 */
    force: z.boolean().optional(),
  }),
  async (req, res) => {
    const { ids, force = false } = req.body;

    // ---- 先算影响面（只读）----
    const storyboardData = await u.db("o_storyboard").whereIn("scriptId", ids);
    const videoData = await u.db("o_video").whereIn("scriptId", ids);
    const storyboardIds = storyboardData.map((item: any) => item.id);
    const bindingCount = storyboardIds.length
      ? Number((await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).count({ n: "*" }).first())?.n ?? 0)
      : 0;
    const impact = {
      scripts: ids.length,
      storyboards: storyboardData.length,
      /** 会被删掉磁盘文件的分镜图数量 */
      imageFiles: storyboardData.filter((item: any) => item.filePath).length,
      videos: videoData.length,
      /** 会被删掉磁盘文件的成片数量 */
      videoFiles: videoData.filter((item: any) => item.filePath).length,
      /** 镜头↔资产绑定条数 */
      assetBindings: bindingCount,
    };

    // 需要用户确认的两种情形：
    //   hasDownstream  —— 有分镜/视频产出，删了就是白干（界面用它决定是否展开影响面清单）
    //   isDestructive  —— 还会删磁盘文件（分镜图/成片），这类**必须**拦住，哪怕下游行已经不在
    const hasDownstream = impact.storyboards > 0 || impact.videos > 0;
    const isDestructive = hasDownstream || impact.imageFiles > 0 || impact.videoFiles > 0;
    if (!force && isDestructive) {
      return res.status(409).send(
        error(
          `该集已有下游产出（分镜 ${impact.storyboards} 条、分镜图 ${impact.imageFiles} 张、已生成视频 ${impact.videos} 条），删除会一并永久移除。请确认后再执行。`,
          { ...impact, hasDownstream },
        ),
      );
    }

    // ---- 执行删除 ----
    const scriptData = await u.db("o_script").whereIn("id", ids);
    if (scriptData && scriptData.length) {
      const scriptProjectId = new Set(scriptData.map((item: any) => item.projectId));
      await u.db("o_agentWorkData").whereIn("projectId", Array.from(scriptProjectId)).whereIn("episodesId", ids).delete();
    }
    if (storyboardData.length) {
      await Promise.all(
        storyboardData.map(async (item: any) => {
          try {
            item.filePath && (await u.oss.deleteFile(item.filePath));
          } catch (e) {}
        }),
      );
      if (storyboardIds.length) await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).delete();
    }
    // 轨道行也要删：留着的空轨道会在工作台渲染成永远生成不了的空卡片
    await u.db("o_videoTrack").whereIn("scriptId", ids).delete();
    // 结构化分镜（v2）也要跟着删：否则删了剧集还留着 o_segment/o_shot/o_shotAssets 孤儿行
    try {
      const segRows = await u.db("o_segment").whereIn("scriptId", ids).select("id");
      const segIds = segRows.map((r: any) => r.id);
      if (segIds.length) {
        const shotRows = await u.db("o_shot").whereIn("segmentId", segIds).select("id");
        const shotIds = shotRows.map((r: any) => r.id);
        if (shotIds.length) await u.db("o_shotAssets").whereIn("shotId", shotIds).delete();
        await u.db("o_shot").whereIn("segmentId", segIds).delete();
        await u.db("o_segment").whereIn("id", segIds).delete();
      }
    } catch (e: any) {
      console.warn("[delScript] 清理结构化分镜失败（不影响删除剧本）：", e?.message ?? e);
    }
    // 监督层结构化问题存档（工作区 productionIssues）也要清：否则删了剧集还留着孤儿审计行
    try {
      await u.db("o_agentWorkData").whereIn("episodesId", ids.map((i: number) => String(i))).andWhere("key", "productionIssues").delete();
    } catch (e: any) {
      console.warn("[delScript] 清理 productionIssues 失败（不影响删除剧本）：", e?.message ?? e);
    }
    await u.db("o_scriptAssets").whereIn("scriptId", ids).delete();
    await u.db("o_script").whereIn("id", ids).delete();
    await u.db("o_storyboard").whereIn("scriptId", ids).delete();
    await u.db("o_video").whereIn("scriptId", ids).delete();
    res.status(200).send(success({ message: "删除剧本成功", impact }));
  },
);
