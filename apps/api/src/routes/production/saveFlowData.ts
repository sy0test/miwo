import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
import { flowDataSchema } from "@/agents/productionAgent/tools";
import { guardStoryboardTable } from "@/utils/storyboardTableGuard";
import { readShotsEngine } from "@/utils/shots/readShots";
import { runShotsShadow } from "@/utils/shots/shadowJob";

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  async (req, res) => {
    const {
      data,
      projectId,
      episodesId,
    }: {
      data: z.infer<typeof flowDataSchema>;
      projectId: number;
      episodesId: number;
    } = req.body;
    // ⚠ 必须带 key 过滤。同一 (projectId, episodesId) 下还有转绘写的
    // redrawStage / redrawDirectorPlan / redrawAssetDraft 等行（o_agentWorkData 只有 id 单主键，
    // 没有 (projectId,episodesId,key) 唯一约束）。原来这里不带 key 取 .first()，
    // 一旦命中的是别的 key，下面的 `!sqlData` 判定就会走错分支：
    // 判为「已存在」→ 执行 update().where("key","productionAgent")，而该行并不存在
    // → update 命中 0 行，整块工作区数据被静默丢弃，接口还返回成功。
    const sqlData = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .andWhere("key", "productionAgent")
      .first();

    // 分镜表兜底：前端把 <storyboardTable> 标签内容盲写进来，模型举例/拒答时的空壳标签会覆盖真表（见 storyboardTableGuard.ts）
    const guard = guardStoryboardTable(data?.storyboardTable, sqlData?.data);
    if (guard.restored) {
      console.warn(`[saveFlowData] 拦截疑似被空壳标签污染的分镜表（projectId=${projectId} episodesId=${episodesId}）：${guard.reason}`);
      data.storyboardTable = guard.value as string;
    }

    // 阶段2：v2 下"分镜表文本"就是结构化表的**投影**。用户在分镜表里手动改完保存时，
    // 必须由代码重新解析 + 事务落库，否则 `o_shot`/`o_segment` 会与用户看到的文本脱节
    // （旧链路正是在这里断的：文本改了，结构没改，两边各说各话）。
    // 只写不读、失败不影响保存；解析不出结构时**不动已有行**（宁可保留旧结构，也不清空）。
    let shotsNote: string | undefined;
    let shotsValidateErrors: string[] = [];
    let shotsWarnings: string[] = [];
    let shotsParseErrors: string[] = [];
    if (data?.storyboardTable && (await readShotsEngine(u.db)) === "v2") {
      try {
        const r = await runShotsShadow({
          db: u.db,
          projectId: Number(projectId),
          scriptId: Number(episodesId),
          replyText: String(data.storyboardTable),
          // 拍摄计划当权威清单：核对分镜表有没有"只写了一小段"
          planText: typeof data.scriptPlan === "string" ? data.scriptPlan : null,
        });
        shotsNote = r.note;
        shotsParseErrors = r.parseErrors.map((e) => `${e.where} ${e.message}`);
        shotsValidateErrors = r.validateErrors.map((e) => `${e.where}【${e.rule}】${e.message}`);
        shotsWarnings = r.warnings.map((w) => `${w.where}【${w.rule}】${w.message}`);
        console.log(`[saveFlowData][分镜表再解析] ep=${episodesId} ok=${r.ok} ${r.note}`);
      } catch (e: any) {
        console.error("[saveFlowData][分镜表再解析] 异常（不影响保存）：", u.error(e).message);
      }
    }

    // 【退役后】旧链路那段「把 data.storyboard 的顺序回写到 o_storyboard.index」已删除：
    // v2 下 `data.storyboard` 是**由片段投影出来**的（id 是 o_segment.id），拿它去更 `o_storyboard.index`
    // 会改到编号撞上的历史行；而顺序本来也由 `segmentIndex` 决定，不需要再写。

    if (!sqlData) {
      await u.db("o_agentWorkData").insert({
        projectId,
        episodesId,
        key: "productionAgent",
        data: JSON.stringify(data),
      });
    } else {
      await u
        .db("o_agentWorkData")
        .where("projectId", String(projectId))
        .where("key", "productionAgent")
        .andWhere("episodesId", String(episodesId))
        .update({
          data: JSON.stringify(data),
        });
    }
    return res.status(200).send(
      success(
        shotsNote
          ? { shotsNote, shotsParseErrors, shotsValidateErrors, shotsWarnings }
          : undefined,
      ),
    );
  },
);
