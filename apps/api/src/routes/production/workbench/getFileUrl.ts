import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
const router = express.Router();

export default router.post(
    "/",
    validateFields({
        items: z.array(z.object({
            id: z.number(),
            sources: z.string()
        }))
    }),
    async (req, res) => {
        const { items } = req.body;
        const result: Record<string, string> = {};
        const storyboardIds = items.filter((item: any) => item.sources == "storyboard").map((item: any) => item.id)
        const totalFilePaths = []
        // 阶段2：v2（多参模式）没有"分镜图"，而且这里传进来的 id 是**镜 id**。
        // ⚠ 拿镜 id 去查 o_storyboard 会命中"编号撞上的历史行" —— 把别的集的分镜图当参考图返回。
        // 所以 v2 下直接给空路径（键仍返回，调用方不用改）。
        const engine = await readShotsEngine(u.db);
        if (storyboardIds.length) {
            if (engine === "v2") {
                totalFilePaths.push(...storyboardIds.map((id: number) => ({ id, filePath: null, sources: "storyboard" })));
            } else {
                const storyBoardPaths = await u.db("o_storyboard").whereIn("id", storyboardIds).select("id", "filePath");
                totalFilePaths.push(...storyBoardPaths.map(i => ({ id: i.id, filePath: i.filePath, sources: "storyboard" })))
            }
        }
        const assetsIds = items.filter((item: any) => item.sources == "assets").map((item: any) => item.id)
        if (assetsIds.length) {
            const assetsPaths = await u.db("o_assets").leftJoin("o_image", "o_image.id", "o_assets.imageId").whereIn("o_assets.id", assetsIds).select("o_assets.id", "o_image.filePath");
            totalFilePaths.push(...assetsPaths.map(i => ({ id: i.id, filePath: i.filePath, sources: "assets" })))
        }

        // 转绘的原片参考片段（sources:"clip"）：v2 在 o_segment.clipPath，legacy 在 o_storyboard.clipPath。
        // 以前没有这条分支 ⇒ 前端 warmUpUrls 拿不到 clip 的签名 URL，缓存回退成没有 /oss 前缀、没有签名的裸路径，
        // 真机症状就是「原片切片不在素材列表里 / 点开也播不了」（403/404）。
        const clipIds = items.filter((item: any) => item.sources == "clip").map((item: any) => item.id)
        if (clipIds.length) {
            const clipRows = engine === "v2"
                ? await u.db("o_segment").whereIn("id", clipIds).select("id", "clipPath")
                : await u.db("o_storyboard").whereIn("id", clipIds).select("id", "clipPath");
            totalFilePaths.push(...clipRows.map((i: any) => ({ id: i.id, filePath: i.clipPath, sources: "clip" })))
        }

        await Promise.all(
            totalFilePaths.map(async (item: { id: string, filePath: string, sources: string }) => {
                // 视频不能走缩略图分支（&size=20 是给图片看的；对 mp4 生成缩略图会失败并返回不可播的 URL）
                result[`${item.id}:${item.sources}`] = item.filePath
                    ? (item.sources === "clip" ? await u.oss.getFileUrl(item.filePath) : await u.oss.getSmallImageUrl(item.filePath))
                    : "";
            }))

        res.status(200).send(success({ data: result }));
    },
);
