import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueJobInTransaction } from "@/jobs";
import { currentUserId } from "@/jobs/context";

const router = express.Router();

/**
 * 出海转绘 · 第 3→4 步：「开始分析」按钮。源片来自 `o_script.sourceVideo`。
 *
 * ── 2026-10-24 起（M1 原生化 + 任务化，spec §5.6 / R1-G7）──
 * 这条路由**只做三件事**：校验 → 同一事务里置 `extractState=0` 并入队 → 返回 jobId。
 * 「预处理（拼贴图/切点/本地 ASR）→ 模型解析 → 落库 → 状态」全部在 job `redraw.prepare` 的 handler 里
 * （`src/jobs/handlers/redrawPrepare.ts`）。
 *
 * 为什么不再 fire-and-forget：
 *  · 旧实现把预处理 + 解析挂在路由的 async 闭包里，进程重启后 `extractState` 永久卡 0；
 *  · 现在任务可被 worker 回收/重试、进度进任务中心、失败有 lastError + errorReason。
 *
 * 为什么"置 0"和"入队"必须在**同一事务**：
 *  分开写的话，中间崩溃会留下"extractState=0 但队列里没有任务"的永久转圈状态（客户只能重传源片）。
 *
 * 幂等：`redraw.prepare:{projectId}:{scriptId}:{replace?1:0}`（spec §5.6）——
 *  双击「开始分析」被同键活跃任务吞掉（返回同一个 jobId，`deduped: true`）；
 *  点「重新分析」带 `replace: true`，是不同的键，不会被吞。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    /** 语种。默认 auto（ASR 先本地检出再显式传）—— 给错语种 Whisper 会「翻译」而非转写 */
    lang: z.string().optional(),
    /** 覆盖已有分镜（「重新分析」）。默认 false —— 重跑会抹掉界面上改过的内容 */
    replace: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, scriptId, lang, replace } = req.body as {
        projectId: number;
        scriptId: number;
        lang?: string;
        replace?: boolean;
      };

      const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
      if (!script) return res.status(400).send(error(`项目 ${projectId} 下没有这条源片：scriptId=${scriptId}`));
      if (!String(script.sourceVideo ?? "").trim()) {
        return res.status(400).send(error(`这一集没有源片：scriptId=${scriptId}（先上传源片再分析）`));
      }

      // 同一事务：置 0 + 入队。入队走 `enqueueJobInTransaction`（R1-G2 对非计费任务的同一要求）。
      //
      // ⚠ 并发闸门（review P1-2）：幂等键里带 replace，所以「开始分析(:0)」与「重新分析(:1)」是**两个键**，
      //   同键去重管不住这一对 —— 两个请求同时来会跑两个任务（重复计费 + 写库互踩）。
      //   这里在事务内显式查"本集是否已有活跃的 redraw.prepare 任务"（两种键都查）：
      //   有就返回那一条（deduped:true），不新建、也不把 extractState 重置一遍。
      const userId = currentUserId(req);
      const result = await u.db.transaction(async (trx: any) => {
        const activeKeys = [
          "redraw.prepare:" + projectId + ":" + scriptId + ":0",
          "redraw.prepare:" + projectId + ":" + scriptId + ":1",
        ];
        const active = await trx("o_job")
          .whereIn("dedupeActive", activeKeys)
          .whereIn("state", ["queued", "running"]) // knex 没有 andWhereIn：连续 whereIn 就是 AND
          .first();
        if (active) return { jobId: String(active.id), created: false };

        await trx("o_script").where("id", scriptId).update({ extractState: 0, errorReason: null });
        return enqueueJobInTransaction(trx, {
          type: "redraw.prepare",
          userId,
          payload: {
            projectId,
            scriptId,
            ...(replace === true ? { replace: true } : {}),
            ...(typeof lang === "string" && lang.trim() ? { lang: lang.trim() } : {}),
          },
        });
      });

      res.status(200).send(
        success({
          started: true,
          scriptId,
          jobId: Number(result.jobId),
          // true = 命中了"同一集、同一 replace 意图"的活跃任务（双击），没有新建
          deduped: !result.created,
          extractState: 0,
        }),
      );
    } catch (e: any) {
      res.status(500).send(error(u.error(e).message));
    }
  },
);