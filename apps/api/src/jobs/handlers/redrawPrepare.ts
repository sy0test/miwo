/**
 * job `redraw.prepare`：转绘「开始分析」的**唯一执行体**（spec §5.6 / R1-G7）。
 *
 * ── 职责（一个任务干完一整集的分析）──
 *   1. 预处理：拼贴图 / 切点表 / 转写稿（`redraw/prep/prep.ts`，进程内跑，不再依赖外部 redraw-prep.cjs）；
 *   2. 解析：调模型解析 `analyzeRedrawAssets`（**必须在 handler 里**，路由只入队，R1-G7）；
 *   3. 落库与状态：成功 `extractState=1` + `redrawState=1`；失败 `extractState=-1` + `redrawState=-1` + errorReason。
 *
 * ── 为什么把「预处理 + 解析」放进一个 job ──
 * 历史实现是路由里 fire-and-forget（`void (async () => …)()`）：进程重启就永久卡 `extractState=0`，
 * 而客户看到的是"一直在分析中"。进队列后：租约到期可回收、失败可诊断、任务中心可看到进度。
 *
 * ── 可以注入的部分 ──
 * `runRedrawPrepare()` 把 DB / 预处理 / 模型解析 / 路径解析 / 进度上报都做成参数，
 * 于是单测能对着**真 SQLite** 断言状态转移，而不需要 ffmpeg、Python、模型与样本视频。
 */
import type { Knex } from "knex";
import u from "@/utils";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { createDefaultPrepDeps, runPrep } from "@/redraw/prep/prep";
import { REDRAW_STATE, transitionRedrawState, writeRedrawStage } from "@/redraw/state";
import { analyzeRedrawAssets, type RedrawAnalyzeResult } from "@/utils/redrawAnalyze";

export interface RedrawPreparePayload {
  projectId: number;
  scriptId: number;
  /** 允许覆盖已有分镜（「重新分析」按钮）。**同一集的两次不同意图必须是不同的幂等键**。 */
  replace?: boolean;
  /** 语种；缺省让 ASR 自己检测 */
  lang?: string;
}

export type RedrawPrepOutcome = {
  /** 切点时间数组（秒），仅供日志/结果摘要 */
  cuts: number[];
  wordCount: number;
  grids: string[];
  warnings: string[];
};

export type RedrawPrepareDeps = {
  /** OSS 相对路径 → 本机绝对路径 */
  resolveVideo(sourceRel: string): Promise<string>;
  /** 产物目录（`u.getPath(["redraw-prep", projectId, scriptId])`） */
  prepDirOf(projectId: number, scriptId: number): string;
  /** 跑预处理；`onStage` 由本模块桥到 job 进度 + redrawStage */
  runPrep(videoAbs: string, prepDir: string, onStage: (stage: string, percent: number) => Promise<void>, opts: { lang?: string }): Promise<RedrawPrepOutcome>;
  /** 调模型解析并落库（`analyzeRedrawAssets`） */
  analyze(opts: { projectId: number; scriptId: number; assetDir: string; replace?: boolean }): Promise<RedrawAnalyzeResult>;
  /** 进度上报：job 的 `ctx.progress` + 工作区 `redrawStage` */
  reportStage(stage: string, progress: number): Promise<void>;
};

const warn = (m: string): void => console.warn(`[redraw.prepare] ${m}`);

/**
 * 体检里 error 级的条目 = 这份产出**不能进下游**（区间解析不出、时间轴有缺口…），按失败报；
 * warn 级不拦（与旧 analyzeSource 的口径一致，只是那套逻辑现在搬进 handler）。
 */
export function hardIssueMessages(issues: RedrawAnalyzeResult["issues"]): string[] {
  return issues.filter((i) => i.level === "error").map((i) => `第${i.shotIndex ?? "-"}镜 ${i.message}`);
}

/** 把一集标成失败。**不抛**（调用方已经在一个 catch 里），写不进去也不掩盖原始错误。 */
async function markFailed(db: Knex, projectId: number, scriptId: number, reason: string): Promise<void> {
  const msg = String(reason ?? "转绘流程失败").slice(0, 1000);
  await db("o_script").where({ id: scriptId, projectId }).update({ extractState: -1, errorReason: msg }).catch(() => undefined);
  // 任意状态 → -1 都合法；写不进去（例如行已被删）不影响把原始错误抛给队列
  await transitionRedrawState(db, { projectId, scriptId, to: REDRAW_STATE.FAILED, errorReason: msg }).catch(() => undefined);
}

/**
 * 执行一集的「预处理 → 解析 → 落库 → 状态」。**抛错 = 本次尝试失败**（由队列记 lastError/重试策略）。
 * 返回解析产出摘要（进 job.result，任务中心可查）。
 */
export async function runRedrawPrepare(
  db: Knex,
  payload: RedrawPreparePayload,
  deps: RedrawPrepareDeps,
): Promise<{ scriptId: number; segments: number; assets: number; clipsWarn: string[] }> {
  const { projectId, scriptId, replace, lang } = payload;

  const project = await db("o_project").where("id", projectId).first();
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new Error(`项目 ${projectId} 下没有这条源片：scriptId=${scriptId}`);
  const sourceRel = String(script.sourceVideo ?? "").trim();
  if (!sourceRel) throw new Error(`这一集没有源片：scriptId=${scriptId}（先上传源片再分析）`);

  // 开跑就把"跑没跑完"置 0（路由已置过一次；worker 重投/手工重跑时这一步保证状态一致）。
  // ⚠ redrawState **不动**：失败前的旧值有语义（例如 4=可生成，重跑解析失败时不该先掉回 0）。
  await db("o_script").where("id", scriptId).update({ extractState: 0, errorReason: null });

  try {
    const videoAbs = await deps.resolveVideo(sourceRel);
    const prepDir = deps.prepDirOf(projectId, scriptId);
    // prep 的阶段名里 grid 归到前端的「预处理·切点」；其余同名
    const onStage = async (stage: string, percent: number): Promise<void> => {
      await deps.reportStage(stage === "grid" ? "cut" : stage, percent);
    };
    const prep = await deps.runPrep(videoAbs, prepDir, onStage, { lang });
    for (const w of prep.warnings) warn(`script ${scriptId}：${w}`);

    await deps.reportStage("analysis", 92);
    const r = await deps.analyze({ projectId, scriptId, assetDir: prepDir, replace });

    const hard = hardIssueMessages(r.issues);
    if (hard.length) {
      throw new Error(
        `解析出了 ${r.assets} 个资产 / ${r.segments} 个片段 / ${r.storyboards} 个镜，但体检没过：\n` + hard.join("\n"),
      );
    }

    // 成功：解析完成（extractState=1）+ 待认账（redrawState=1）。2/3/4 → 1 是"重新分析"的合法转移。
    await db("o_script").where("id", scriptId).update({ extractState: 1, errorReason: null });
    await transitionRedrawState(db, { projectId, scriptId, to: REDRAW_STATE.PARSED, errorReason: null });
    await deps.reportStage("analysis", 100);
    return { scriptId, segments: r.segments, assets: r.assets, clipsWarn: prep.warnings };
  } catch (e: any) {
    const msg = u.error(e).message.replace(/^\[.*?\]\s*/, "");
    await markFailed(db, projectId, scriptId, msg);
    // 失败时把阶段进度停在原地（保留 stage，前端能看出卡在哪一步）；progress 不动
    throw e instanceof Error ? e : new Error(msg);
  }
}

/** 生产依赖：真 ffmpeg + 真本地 ASR + 真模型调用。 */
export function createDefaultPrepareDeps(ctx: JobContext, payload: RedrawPreparePayload): RedrawPrepareDeps {
  return {
    resolveVideo: (rel) => u.oss.getAbsPath(rel),
    prepDirOf: (projectId, scriptId) => u.getPath(["redraw-prep", String(projectId), String(scriptId)]),
    runPrep: (videoAbs, prepDir, onStage, opts) =>
      runPrep(videoAbs, prepDir, createDefaultPrepDeps(), {
        lang: opts.lang,
        onStage: (stage, percent) => onStage(stage, percent),
      }),
    analyze: (opts) => analyzeRedrawAssets(opts),
    reportStage: async (stage, progress) => {
      // 先写工作区（前端 3s 轮询读它），再推 job 进度；工作区写失败不影响任务本身
      await writeRedrawStage(u.db as unknown as Knex, { projectId: payload.projectId, scriptId: payload.scriptId, stage, progress }).catch(
        (e: any) => warn(`redrawStage 写入失败：${u.error(e).message}`),
      );
      // progress() 返回 false = 租约已丢失；此时让 handler 继续跑也没意义，直接中止
      const alive = await ctx.progress(progress, stage);
      if (!alive) throw new Error("任务租约已丢失（worker 被回收或停机），停止预处理");
    },
  };
}

/**
 * 任务定义。
 *
 * ⚠ `maxAttempts = 1`：解析会**调模型（计费）**，自动重试等于自动重复扣费。失败后由用户点「重试分析」
 *   显式重跑（幂等键里 replace 区分意图）。
 * ⚠ 幂等键按 spec §5.6：`redraw.prepare:{projectId}:{scriptId}:{replace?1:0}` —— 双击「开始分析」
 *   被同键活跃任务吞掉；点「重新分析」（replace=1）不会被吞。
 */
export const redrawPrepare: JobDefinition<RedrawPreparePayload> = {
  type: "redraw.prepare",
  // 预处理（CPU 转写最慢）+ 解析（模型）合计留 30 分钟（spec §5.6）
  timeoutMs: 30 * 60 * 1000,
  maxAttempts: 1,
  pool: "vendor:text",
  parse(raw) {
    const o = raw as Partial<RedrawPreparePayload> | null;
    if (!o || typeof o !== "object") throw new Error("[job] redraw.prepare payload 必须是对象");
    if (typeof o.projectId !== "number" || !Number.isInteger(o.projectId) || o.projectId <= 0) {
      throw new Error("[job] redraw.prepare payload 缺少合法的 projectId");
    }
    if (typeof o.scriptId !== "number" || !Number.isInteger(o.scriptId) || o.scriptId <= 0) {
      throw new Error("[job] redraw.prepare payload 缺少合法的 scriptId");
    }
    return {
      projectId: o.projectId,
      scriptId: o.scriptId,
      ...(o.replace === true ? { replace: true } : {}),
      ...(typeof o.lang === "string" && o.lang.trim() ? { lang: o.lang.trim() } : {}),
    };
  },
  dedupeKey(p) {
    return `redraw.prepare:${p.projectId}:${p.scriptId}:${p.replace ? 1 : 0}`;
  },
  async handle(ctx, payload) {
    const deps = createDefaultPrepareDeps(ctx, payload);
    const r = await runRedrawPrepare(u.db as unknown as Knex, payload, deps);
    return { scriptId: r.scriptId, segments: r.segments, assets: r.assets };
  },
};