import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

/**
 * 出海转绘 · 第 3 步的列表：项目下的源片（= `o_script` 行）。
 *
 * 为什么不直接复用 `script/getScrptApi`：那条路由的返回字段是写死的
 * （id / name / content / extractState / errorReason / createTime / relatedAssets），
 * 源片卡要的 `coverPath` `sourceVideo` `sortIndex` 一个都没有。
 * 而它还会顺带去查 `o_scriptAssets`（源片阶段没有资产），白查一次。
 *
 * 排序**只按 `sortIndex`**：上传顺序会被「重传某一集」打乱，
 * 而客户的命名（「第一集」「2-xxx」）才是他们心里的顺序。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    try {
      const { projectId } = req.body;
      const rows = await u.db("o_script").where("projectId", projectId);
      // 排序放在 JS 里做，不写 `order by ... nulls last`：SQLite 的 NULL 默认排最前，
      // 而「没解出序号」恰恰该排最后。方言行为不值得赌，两行比较函数更清楚。
      rows.sort((a: any, b: any) => {
        const x = a.sortIndex ?? Number.MAX_SAFE_INTEGER;
        const y = b.sortIndex ?? Number.MAX_SAFE_INTEGER;
        return x - y || (a.createTime ?? 0) - (b.createTime ?? 0);
      });

      // 已解析出分镜的集：卡片上要能看出「这一集已经分析过了」
      const counts = await u.db("o_storyboard").where("projectId", projectId).groupBy("scriptId").select("scriptId").count("id as n");
      const byScript = new Map<number, number>(counts.map((c: any) => [c.scriptId, Number(c.n)]));

      const data = await Promise.all(
        rows.map(async (r: any) => ({
          id: r.id,
          name: r.name,
          sortIndex: r.sortIndex ?? null,
          sourceVideo: r.sourceVideo ?? null,
          coverPath: r.coverPath ?? null,
          // 顺手把绝对 URL 也算好。前端自己拼 OSS 前缀要抄一遍 dev/prod 的路径规则
          // （见 `u.oss.getFileUrl` 里那三分支），抄错了在打包环境才炸。
          coverUrl: r.coverPath ? await u.oss.getFileUrl(r.coverPath) : null,
          videoUrl: r.sourceVideo ? await u.oss.getFileUrl(r.sourceVideo) : null,
          extractState: r.extractState ?? null,
          errorReason: r.errorReason ?? null,
          createTime: r.createTime ?? null,
          storyboards: byScript.get(r.id) ?? 0,
          analyzed: (byScript.get(r.id) ?? 0) > 0,
        })),
      );

      res.status(200).send(success(data));
    } catch (e: any) {
      res.status(500).send(u.error(e).message);
    }
  },
);
