import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { analyzeRedrawAssets, sendRedrawError } from "@/utils/redrawAnalyze";

const router = express.Router();

/**
 * 出海转绘 · 第 4 步：解析。**调用方自己指预处理产物目录**。
 *
 * 内核在 `src/utils/redrawAnalyze.ts` —— 界面上的「开始分析」走的是另一条路由
 * （`redraw/analyzeSource`，源片来自 `o_script.sourceVideo`，由它先跑预处理），
 * 两条共用同一份拼 prompt / 调模型 / 解析 / 落库。
 *
 * 保留这条是因为：预处理目前还是外部脚本（redraw-prep），产物目录在仓库外，
 * 开发期要能对着任意一个产物目录单跑解析、不重跑一遍转写。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    /** 预处理产物目录（redraw-prep 的 out/<名字>） */
    assetDir: z.string(),
    scriptId: z.number().optional(),
    /** 允许覆盖已有分镜。默认 false —— 重跑会抹掉界面上改过的内容 */
    replace: z.boolean().optional(),
    /** 只拼 prompt、不调模型。零成本核对技能与材料装得对不对 */
    dryRun: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const r = await analyzeRedrawAssets(req.body);
      if (req.body.dryRun) {
        return res.status(200).send(
          success({
            dryRun: true,
            systemChars: r.systemChars,
            promptChars: r.promptChars,
            images: r.grids,
            scriptId: r.scriptId,
            promptPath: r.promptPath,
          }),
        );
      }
      res.status(200).send(
        success({
          scriptId: r.scriptId,
          // 解析出来的资产数（解析层不写 o_assets，所以与 writtenAssets 分开报）
          assets: r.assets,
          writtenAssets: r.writtenAssets,
          // v2：片段数（= 生成单位）；storyboards 只是兼容字段，v2 下 = 镜数
          segments: r.segments,
          storyboards: r.storyboards,
          missingAssetNames: r.missingAssetNames,
          issues: r.issues,
        }),
      );
    } catch (e: any) {
      sendRedrawError(res, e);
    }
  },
);
