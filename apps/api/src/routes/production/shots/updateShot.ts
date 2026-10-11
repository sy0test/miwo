import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";
import { updateShot, getShotAssets } from "@/utils/shots/editShots";

/**
 * 改一条镜（分镜台按行编辑 + 引用资产增删改）。
 *
 * 请求：{ shotId: number, patch: { duration?, shotSize?, camera?, light?, action?, dialogue?, sfx?, assetIds?: number[] } }
 * 语义：
 *   · `assetIds` 给了就**整体设置**（增删差集自动算；传空数组 = 清空绑定）—— 这就是旧链路缺的 U/D；
 *   · 校验由代码做（单镜 ≤8s、片段合计 ≤15s、资产 ID 必须存在），失败**不写库**并返回原因；
 *   · 写完回填 `o_segment.duration`（片段时长永远等于镜之和）。
 *
 * 仅在 `o_setting.shotsEngine = "v2"` 时可用（避免 legacy 期误写新表）。
 */
export default express.Router().post(
  "/",
  validateFields({
    shotId: z.number(),
    patch: z.object({
      duration: z.number().optional(),
      shotSize: z.string().optional(),
      camera: z.string().optional(),
      light: z.string().optional(),
      action: z.string().optional(),
      dialogue: z.string().optional(),
      sfx: z.string().optional(),
      assetIds: z.array(z.number()).optional(),
    }),
  }),
  async (req, res) => {
    if ((await readShotsEngine(u.db)) !== "v2") return res.status(400).send(error("未启用结构化分镜（o_setting.shotsEngine != v2）"));
    const { shotId, patch } = req.body as { shotId: number; patch: any };
    const r = await updateShot(u.db, shotId, patch);
    if (!r.ok) return res.status(400).send(error(r.errors.join("；")));
    return res.status(200).send(success({ ...r.data, assetIds: await getShotAssets(u.db, shotId) }));
  },
);
