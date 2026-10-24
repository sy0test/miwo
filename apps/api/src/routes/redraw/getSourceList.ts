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

      // 转绘状态与阶段进度（M2：输入页/画布直接读这几个字段）。
      //  · redrawState —— 专用状态机（migration 016）；旧数据没这一列时按 0 处理
      //  · stage/progress —— 来自工作区 redrawStage（job handler 写；只前不后），没跑过就是 null
      //  · clipsReady —— 已切出参考视频的段数（o_segment.clipPath 非空）
      //  · segmentCap —— 项目「单段上限」（缺省 15）
      const project = await u.db("o_project").where("id", projectId).first();
      const capRaw = Number(project?.redrawMaxSegmentSec);
      const segmentCap = Number.isInteger(capRaw) && capRaw >= 4 && capRaw <= 30 ? capRaw : 15;

      // 一次查出全项目的阶段进度（按集分组），避免每行一次查询
      const stageByScript = new Map<number, { stage: string | null; progress: number | null }>();
      const stageRows = await u.db("o_agentWorkData")
        .where("projectId", String(projectId))
        .andWhere("key", "redrawStage")
        .select("episodesId", "data");
      for (const row of stageRows) {
        try {
          const parsed = JSON.parse(String(row.data ?? "{}"));
          if (typeof parsed?.stage === "string") {
            stageByScript.set(Number(row.episodesId), {
              stage: parsed.stage,
              progress: typeof parsed.progress === "number" && Number.isFinite(parsed.progress) ? parsed.progress : null,
            });
          }
        } catch {
          // 坏 JSON 当作"没有进度"（不因为一行脏数据让整页 500）
        }
      }

      const clipRows = (await u.db("o_segment")
        .where("projectId", projectId)
        .whereNotNull("clipPath")
        .andWhereNot("clipPath", "")
        .groupBy("scriptId")
        .select("scriptId")
        .count("id as n")) as unknown as Array<{ scriptId: number; n: number | string }>;
      const clipsByScript = new Map<number, number>();
      for (const c of clipRows) clipsByScript.set(Number(c.scriptId), Number(c.n));

      // 已解析出分镜的集：卡片上要能看出「这一集已经分析过了」。
      // v2 起「分镜」的单位是**片段**（o_segment）：转绘解析层写的就是它；
      // 迁移前的旧集没有 o_segment，只能数 legacy 的 o_storyboard —— 两张都数，逐集相加。
      const [segCounts, legacyCounts, shotCounts] = await Promise.all([
        u.db("o_segment").where("projectId", projectId).groupBy("scriptId").select("scriptId").count("id as n"),
        u.db("o_storyboard").where("projectId", projectId).groupBy("scriptId").select("scriptId").count("id as n"),
        u.db("o_shot").where("projectId", projectId).groupBy("scriptId").select("scriptId").count("id as n"),
      ]);
      const addCounts = (target: Map<number, number>, rows: any[]) => {
        for (const c of rows) target.set(Number(c.scriptId), (target.get(Number(c.scriptId)) ?? 0) + Number(c.n));
      };
      const segByScript = new Map<number, number>();
      addCounts(segByScript, segCounts as any[]);
      addCounts(segByScript, legacyCounts as any[]);
      const shotByScript = new Map<number, number>();
      addCounts(shotByScript, shotCounts as any[]);

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
          // 转绘专用状态机（0 未开始 / 1 待认账 / 2 资产已确认 / 3 转绘待确认 / 4 可生成 / -1 失败）
          redrawState: typeof r.redrawState === "number" ? r.redrawState : 0,
          // 当前阶段与细进度（job handler 写的工作区 redrawStage）
          stage: stageByScript.get(Number(r.id))?.stage ?? null,
          progress: stageByScript.get(Number(r.id))?.progress ?? null,
          // 已切出参考视频的段数（前端「已切 N 段 · 重切」）
          clipsReady: clipsByScript.get(Number(r.id)) ?? 0,
          segmentCap,
          errorReason: r.errorReason ?? null,
          createTime: r.createTime ?? null,
          // v2 起「分镜」的单位是片段：界面上的数字用 segments（保留 storyboards 这个键名，
          // 前端与文案沿用；值 = 片段数）。shots 是段内镜数，给排查/展示用。
          storyboards: segByScript.get(Number(r.id)) ?? 0,
          shots: shotByScript.get(Number(r.id)) ?? 0,
          analyzed: (segByScript.get(Number(r.id)) ?? 0) > 0,
        })),
      );

      res.status(200).send(success(data));
    } catch (e: any) {
      res.status(500).send(u.error(e).message);
    }
  },
);