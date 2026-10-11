import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { trackTableForId } from "@/utils/shots/readShots";
const router = express.Router();
export default router.post(
    "/",
    validateFields({
        id: z.number(),
        duration: z.number().optional(),
    }),
    async (req, res) => {
        const { id, duration } = req.body;
        // ⚠ v2 下**不能**写 `o_segment.duration`：那个字段是"镜之和"（内容时长），
        // 被写坏之后下一次再解析分镜表会被覆盖回去（用户选的生成时长静默丢失）。
        // 所以这里写独立的 `videoDuration`（工作台读的时候优先用它）。
        const table = await trackTableForId(u.db, id);
        if (table === "o_segment") {
            await u.db("o_segment").where("id", id).update({ videoDuration: duration, updateTime: Date.now() });
        } else {
            await u.db("o_videoTrack").where("id", id).update({ duration });
        }
        res.status(200).send(success("更新成功"));
    },
);
