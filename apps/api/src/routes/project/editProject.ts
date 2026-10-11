import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    projectType: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
    // 出海转绘专用；其它项目类型不传
    targetCountry: z.string().optional(),
  }),
  async (req, res) => {
    const { id, name, intro, type, artStyle, videoRatio, imageModel, videoModel, imageQuality, projectType, mode, targetCountry } = req.body;

    await u.db("o_project").where("id", id).update({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      imageModel,
      videoModel,
      imageQuality,
      projectType,
      mode,
      ...(targetCountry !== undefined ? { targetCountry } : {}),
    });

    res.status(200).send(success({ message: "编辑项目成功" }));
  },
);
