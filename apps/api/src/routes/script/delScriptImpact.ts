import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

/**
 * 删除剧本的**影响面预检**（只读，不删任何东西）。
 *
 * 给界面用：用户勾选要删的剧本后，先调它把「会连带删掉什么」摆出来 ——
 * 分镜条数、要删磁盘文件的分镜图张数、已生成视频条数、镜头↔资产绑定条数。
 *
 * 为什么单独开一个路由而不是复用 delScript：删除接口是写操作，让它承担"预检"职责会
 * 出现两种调用语义（删 / 只查）；且 `delScript` 在未确认时会直接回 409，前端拿它当预检
 * 会多一层错误处理。只读的走只读接口。
 */
export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    if (!ids.length) return res.status(200).send(success({ scripts: 0, storyboards: 0, imageFiles: 0, videos: 0, videoFiles: 0, assetBindings: 0, hasDownstream: false }));

    const storyboardData = await u.db("o_storyboard").whereIn("scriptId", ids);
    const videoData = await u.db("o_video").whereIn("scriptId", ids);
    const storyboardIds = storyboardData.map((item: any) => item.id);
    const assetBindings = storyboardIds.length
      ? Number((await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).count({ n: "*" }).first())?.n ?? 0)
      : 0;

    const impact = {
      /** 本次要删的剧本条数 */
      scripts: ids.length,
      /** 会被连带删除的分镜条数 */
      storyboards: storyboardData.length,
      /** 其中会**删掉磁盘文件**的分镜图张数（不可恢复） */
      imageFiles: storyboardData.filter((item: any) => item.filePath).length,
      /** 会被连带删除的已生成视频记录数 */
      videos: videoData.length,
      /** 其中会**删掉磁盘文件**的成片数量（不可恢复） */
      videoFiles: videoData.filter((item: any) => item.filePath).length,
      /** 会被清掉的「镜头 ↔ 资产」绑定条数 */
      assetBindings,
      /** 是否存在需要用户二次确认的下游产出 */
      hasDownstream: storyboardData.length > 0 || videoData.length > 0,
    };
    res.status(200).send(success(impact));
  },
);
