import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { updateTrackById } from "@/utils/shots/readShots";
import { enqueueJob } from "@/jobs";
import { currentUserId } from "@/jobs/context";
const router = express.Router();

/**
 * 视频提示词批量生成入口 —— **Phase 1d Task 7 第 6 个入口：入队**。
 *
 * ⚠⚠ **review-C F4（High）修正**：本入口此前**根本没改入队** —— 仍然是
 * `pLimit` + `Promise.all(tasks)` 的进程内 fire-and-forget，厂商调用**没过闸门**，
 * 于是注册表里的 `prompt.batch` handler **没有任何调用方（死代码）**。
 * brief 的判据 1（`git grep '\.then(async'` = 0 命中）**漏掉**它：`Promise.all(tasks)` 不匹配那个正则
 * ⇒ 判据本身太弱。本轮的机械守卫换成"**每个已注册业务类型都必须有入队调用点**"
 * （`tests/job-enqueue-coverage.test.ts`），不再依赖某个写法正则。
 *
 * 现在只做三件事：**置轨道行为"生成中" → 入队 `prompt.batch` → 原样返回 + `jobIds`**。
 * `data` 形状保持不变（仍是那句 `"开始生成提示词"`），`jobIds` 只做**顶层新增**。
 * 生成段（挑模板 / 拼 content / 调模型 / 写回）全部在 `src/jobs/handlers/promptBatch.ts` 里由 worker 按租约执行。
 *
 * ⚠ base64 不进队列：`trackData[].info[]` 只带 `{id, sources}`（参考图由 handler 按 id 现取）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    trackData: z.array(
      z.object({
        trackId: z.number(),
        info: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
          }),
        ),
      }),
    ),
    mode: z.string(),
    model: z.string(),
    concurrentCount: z.number().int().min(1).max(8).optional(), //并发数（spec §9.3：上限 8，超限在 validateFields 阶段 400）
  }),
  async (req, res) => {
    const { trackData, projectId, mode, model } = req.body;
    try {
      // 归属校验（读库走受守卫的 u.db：别人的 projectId 查不到 ⇒ 下面 400）
      const projectData = await u.db("o_project").select("id").where({ id: projectId }).first();
      if (!projectData) return res.status(400).send(error("项目不存在或无权访问"));

      // 阶段2：v2 下"轨道"= 片段（o_segment），两表字段名一致 → 用助手逐个更新
      await Promise.all(trackData.map((t: { trackId: number }) => updateTrackById(u.db, t.trackId, { state: "生成中" })));

      const userId = currentUserId(req);
      if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
      const { jobId } = await enqueueJob({
        type: "prompt.batch",
        userId,
        // ⚠ 只存引用 id/sources；不带 base64（handler 按 id 现取）
        payload: { projectId, model, mode, trackData },
      });

      res.status(200).send({ ...success("开始生成提示词"), jobIds: [jobId] });
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
