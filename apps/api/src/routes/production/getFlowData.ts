import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
import { FlowData } from "@/agents/productionAgent/tools";
import { readShotsEngine, readShotsForScript, hasStructuredShots, segmentsToLegacyStoryboard } from "@/utils/shots/readShots";

/**
 * 读取引擎开关（阶段1 → 阶段2 的过渡）：
 *   · `o_setting.shotsEngine` 未设置 / "legacy" → 一切照旧（**默认，零行为变化**）
 *   · "v2" → 该集若有结构化分镜（o_segment/o_shot/o_shotAssets），就用它**替换** storyboard 数组，
 *     同时把原始结构化数据一并返回（segments/shots），供分镜台/生成台切换数据源。
 * 没有结构化数据的集自动保持不变（逐集降级），不会出现"半边空"。
 */
async function applyShotsEngine(flowData: any, episodesId: number, projectId: number) {
  const engine = await readShotsEngine(u.db);
  flowData.shotsEngine = engine;
  flowData.hasStructuredShots = false;
  // 本集约定 + 监督层结构化问题：一起带给前端（它们都是"代码的产物"，前端可直接展示）
  try {
    const brief = await u.db("o_script").where("id", episodesId).select("brief").first();
    if (brief?.brief) {
      try {
        flowData.brief = JSON.parse(brief.brief);
      } catch {
        flowData.brief = { constraints: [String(brief.brief)] };
      }
    }
  } catch {
    /* 老库没有这一列就跳过 */
  }
  try {
    // 口径与 saveFlowData/监督层写入一致：同一个 (projectId, episodesId, key) 才是同一行
    const issueRow = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .andWhere("key", "productionIssues")
      .first();
    if (issueRow?.data) flowData.productionIssues = JSON.parse(issueRow.data);
  } catch {
    /* 没有就算了 */
  }
  if (engine !== "v2") return flowData;
  if (!(await hasStructuredShots(u.db, episodesId))) return flowData;
  try {
    const rows = await readShotsForScript(u.db, episodesId);
    flowData.segments = rows.segments;
    flowData.shots = rows.shots;
    flowData.assetIdsBySegmentIndex = rows.assetIdsBySegmentIndex;
    flowData.storyboard = segmentsToLegacyStoryboard(rows);
    flowData.hasStructuredShots = true;
  } catch (e: any) {
    console.error("[getFlowData] 读取结构化分镜失败，退回旧结构：", u.error(e).message);
  }
  return flowData;
}
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  async (req, res) => {
    const { projectId, episodesId }: { projectId: number; episodesId: number } = req.body;
    // ⚠ key 必须过滤：同一 (projectId, episodesId) 下还可能有转绘写的
    // redrawStage / redrawDirectorPlan / redrawAssetDraft（同一张表、靠 key 区分）。
    // 不带 key 取 .first() 可能拿到 {stage,at} 之类形状 → 下面 JSON.parse 后
    // flowData.storyboard / scriptPlan 全是 undefined → 整个画布空白。
    const sqlData = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .andWhere("key", "productionAgent")
      .select("data")
      .first();

    const scriptData = await u.db("o_script").where("projectId", projectId).where("id", episodesId).first();
    const scriptAssets = await u.db("o_scriptAssets").where("scriptId", episodesId);
    const assetIds = scriptAssets.map((i) => i.assetId);
    const assetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
      // @ts-ignore
      .where("o_assets.id", "in", assetIds)
      .andWhere("o_assets.assetsId", null)
      .where("o_assets.projectId", projectId);

    let childAssetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
      .where("o_assets.projectId", projectId)
      // @ts-ignore
      .where("o_assets.assetsId", "in", assetIds)
      .whereNotNull("o_assets.assetsId");

    if (!sqlData) {
      const flowData: FlowData = {
        script: scriptData?.content ?? "",
        scriptPlan: "",
        assets: await Promise.all(
          assetsData.map(async (item) => ({
            id: item.id,
            name: item.name ?? "",
            type: item.type ?? "",
            prompt: item.prompt ?? "",
            desc: item.describe ?? "",
            src: item.filePath && (await u.oss.getSmallImageUrl(item.filePath!)),
            derive: await Promise.all(
              childAssetsData
                .filter((child) => child.assetsId === item.id)
                .map(async (child) => ({
                  id: child.id,
                  assetsId: item.id,
                  name: child.name ?? "",
                  type: child.type,
                  prompt: child.prompt,
                  desc: child.describe ?? "",
                  src: child.filePath && (await u.oss.getSmallImageUrl(child.filePath!)),
                  state: child.state ?? "未生成", //todo：矫正状态值
                })),
            ),
          })),
        ),
        storyboardTable: "",
        storyboard: [],
        //todo：矫正workbench数据
        //@ts-ignore
        workbench: {
          videoList: [],
        },
        // //todo：矫正封面数据
        // poster: {
        //   items: [],
        // },
      };
      return res.status(200).send(success(await applyShotsEngine(flowData, episodesId, projectId)));
    } else {
      try {
        const storyboardData = await u.db("o_storyboard").where("scriptId", episodesId);

        await Promise.all(
          storyboardData.map(async (i) => {
            if (i.filePath) {
              try {
                i.filePath = await u.oss.getSmallImageUrl(i.filePath);
              } catch {
                i.filePath = "";
              }
            } else {
              i.filePath = "";
            }
          }),
        );
        const storyboardIds = storyboardData.map((i) => i.id);
        // ⚠ MySQL 必坏点修复：原 `orderBy("rowid")` 依赖 **SQLite 隐式列** `rowid`，MySQL 无此列 ⇒ `ER_BAD_FIELD_ERROR`
        //   ⇒ 这条"分镜资产顺序 → 提示词"链在 MySQL 上是 500（sqlite 上正常）。本表只有 (storyboardId, assetId, userId)，
        //   没有 createTime/id ⇒ 确定性排序只能用 `assetId`；真正的"插入顺序"要显式排序列（Phase 1c 加 `sortIndex`，已登记）。
        const assetsIds = await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).orderBy("assetId");

        const assets2StoryboardMap: Record<number, number[]> = {};
        assetsIds.forEach((i) => {
          if (!assets2StoryboardMap[i.storyboardId!]) {
            assets2StoryboardMap[i.storyboardId!] = [];
          }
          assets2StoryboardMap[i.storyboardId!].push(i.assetId!);
        });
        const flowData = JSON.parse(sqlData!.data ?? "{}");
        flowData.assets = await Promise.all(
          assetsData.map(async (item) => ({
            id: item.id,
            name: item.name ?? "",
            type: item.type ?? "",
            prompt: item.prompt ?? "",
            desc: item.describe ?? "",
            src: item.filePath && (await u.oss.getSmallImageUrl(item.filePath!)),
            flowId: item.flowId,
            derive: await Promise.all(
              childAssetsData
                .filter((child) => child.assetsId === item.id)
                .map(async (child) => ({
                  id: child.id,
                  assetsId: item.id,
                  name: child.name ?? "",
                  prompt: child.prompt,
                  type: child.type,
                  desc: child.describe ?? "",
                  src: child.filePath && (await u.oss.getSmallImageUrl(child.filePath!)),
                  state: child.state ?? "未生成",
                  errorReason: child?.errorReason ?? "",
                  flowId: child.flowId,
                })),
            ),
          })),
        );
        flowData.storyboard = storyboardData
          .map((i) => ({
            id: i.id,
            index: i.index,
            duration: i.duration ? +i.duration : 0,
            prompt: i.prompt,
            associateAssetsIds: assets2StoryboardMap[i.id!] ?? [],
            src: i.filePath,
            state: i.state,
            videoDesc: i.videoDesc,
            shouldGenerateImage: i.shouldGenerateImage,
            reason: i?.reason ?? "",
            flowId: i.flowId,
          }))
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        flowData.script = scriptData?.content ?? "";
        res.status(200).send(success(await applyShotsEngine(flowData, episodesId, projectId)));
      } catch (err) {
        res.status(400).send(error());
      }
    }
  },
);
