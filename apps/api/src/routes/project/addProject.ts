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
    projectType: z.string(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
    // 出海转绘专用；其它项目类型不传
    targetCountry: z.string().optional(),
  }),
  async (req, res) => {
    const { projectType, name, intro, type, artStyle, videoRatio, imageModel, videoModel, imageQuality, mode, targetCountry } = req.body;

    await u.db("o_project").insert({
      id: Date.now(),
      projectType,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      userId: 1,
      imageModel,
      videoModel,
      createTime: Date.now(),
      imageQuality,
      mode,
      targetCountry: targetCountry ?? null,
    });

    res.status(200).send(success({ message: "新增项目成功" }));
  },
);
