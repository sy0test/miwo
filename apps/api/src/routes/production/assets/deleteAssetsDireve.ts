import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { id, projectId } = req.body;
    const assetsFirstData = await u.db("o_assets").where("id", id).first();
    if (!assetsFirstData) {
      return res.status(404).send({ error: "资源未找到" });
    }
    if (assetsFirstData?.flowId) await u.db("o_imageFlow").where("id", assetsFirstData?.flowId).delete();
    await u.db("o_assets").where("id", id).delete();
    await u.db("o_assets2Storyboard").where("assetId", id).delete();
    // 结构化分镜（v2）的镜↔资产绑定也要清：否则删了资产还留着指向不存在资产的 o_shotAssets 行
    try {
      const removed = await u.db("o_shotAssets").where("assetId", id).del();
      void removed;
    } catch (e: any) {
      console.warn("[deleteAssetsDireve] 清理 o_shotAssets 失败（不影响删除资产）：", e?.message ?? e);
    }
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);
