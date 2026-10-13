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

    // ⚠ 改动点（Phase 1b / Task 4）：
    //   · 删掉 `id: Date.now()` —— 001_schema 里 o_project.id 是自增主键，
    //     显式传时间戳会与自增语义打架（spec §5.3；Phase 1a deferred #5）
    //   · 删掉 `userId: 1` —— 租户守卫会在 insert 时自动填 `ctx.userId`；显式写 1 会被守卫
    //     判成"写别人的行"而抛错（`tenant-guard.ts` 的注入规则 3）
    await u.db("o_project").insert({
      projectType,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
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
