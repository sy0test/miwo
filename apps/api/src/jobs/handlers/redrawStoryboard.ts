/**
 * job `redraw.storyboard`：转绘分镜层（M3-T12 / spec §8）。
 *
 * 顺序：读上下文（已确认资产 / 剧本 / 导演计划 / 源片分镜）→ 一次模型调用
 * (`redrawAgent:storyboardAgent` + 技能) → 解析校验 → `writeRedrawStoryboard`（快照 + 重建）→ redrawState=3。
 *
 * ── 前置条件 ──
 *  · redrawState ∈ {2,3,4}（资产已确认才允许出转绘分镜；从 3/4 重跑也允许）；
 *  · 至少一个已确认资产（否则模型只能新造名字 —— 宁可失败也不生成跑偏的分镜）。
 *
 * ── 可注入 ──
 * `invoke(system, user)` 与 DB 全部可注入：单测用假模型回复就能覆盖解析/校验/落库/状态。
 */
import type { Knex } from "knex";
import u from "@/utils";
import { currentAiBillingContext } from "@/billing/context";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { RedrawHttpError } from "@/redraw/http";
import { REDRAW_STATE, readRedrawState, transitionRedrawState } from "@/redraw/state";
import {
  attachVideoDesc,
  buildStoryboardPrompt,
  parseStoryboardOutput,
  renderSourceStoryboard,
  validateRedrawStoryboard,
} from "@/redraw/storyboard";
import {
  readCurrentStoryboard,
  writeRedrawStoryboard,
} from "@/redraw/storyboardWrite";
import { readWorkData } from "@/redraw/state";
import { readSegmentCap } from "@/redraw/cap";

export interface RedrawStoryboardPayload {
  projectId: number;
  scriptId: number;
}

export type RedrawStoryboardDeps = {
  /** 调模型；生产用 `u.Ai.Text("redrawAgent:storyboardAgent")` */
  invoke(system: string, user: string): Promise<string>;
  /** job 进度（0..100） */
  report?(percent: number, stage: string): Promise<void>;
  /** 技能正文；缺省读 `MIWO_DATA_DIR/skills/feicai/redraw-storyboard-skill/SKILL.md`（测试可注入） */
  loadSkill?(): string;
};

export type RedrawStoryboardOutcome = {
  segments: number;
  shots: number;
  changes: string[];
  inheritedClips: number;
};

/** 已确认资产（名称 → id）。名称重复时取第一个（技能要求名称唯一，这里不额外造错）。 */
export async function readConfirmedAssets(
  db: Knex,
  opts: { projectId: number; scriptId: number },
): Promise<Array<{ id: number; name: string; type: string; describe: string | null }>> {
  const links = (await db("o_scriptAssets").where({ scriptId: opts.scriptId }).select("assetId")) as any[];
  const ids = links.map((l) => Number(l.assetId)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const rows = await db("o_assets").whereIn("id", ids).andWhere("projectId", opts.projectId).select("id", "name", "type", "describe");
  return rows.map((r: any) => ({ id: Number(r.id), name: String(r.name ?? ""), type: String(r.type ?? ""), describe: r.describe ?? null }));
}

/**
 * 执行一次转绘分镜生成（供 job handler 与单测共用）。
 * 抛错 = 本次失败（job 记 lastError；用户看到的是 errorReason/任务中心）。
 */
export async function runRedrawStoryboard(
  db: Knex,
  payload: RedrawStoryboardPayload,
  deps: RedrawStoryboardDeps,
): Promise<RedrawStoryboardOutcome> {
  const { projectId, scriptId } = payload;
  const project = await db("o_project").where("id", projectId).first();
  if (!project) throw new RedrawHttpError(400, "项目不存在：" + projectId);
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new RedrawHttpError(400, "项目 " + projectId + " 下没有这一集：scriptId=" + scriptId);

  const state = (await readRedrawState(db, { projectId, scriptId })) ?? REDRAW_STATE.NONE;
  if (![REDRAW_STATE.ASSETS_OK, REDRAW_STATE.STORYBOARD_READY, REDRAW_STATE.CONFIRMED].includes(state as any)) {
    throw new RedrawHttpError(409, "资产还没确认（redrawState=" + state + "）：先完成资产认账，再生成转绘分镜");
  }

  const assets = await readConfirmedAssets(db, { projectId, scriptId });
  if (!assets.length) throw new RedrawHttpError(409, "本集没有任何已确认资产：先完成资产认账");
  const confirmedMap = new Map<string, number>();
  for (const a of assets) if (a.name) confirmedMap.set(a.name, a.id);

  const current = await readCurrentStoryboard(db, { projectId, scriptId });
  if (!current.segments.length) throw new RedrawHttpError(409, "本集没有源片分镜（o_segment 为空）：先跑解析");
  const sourceText = renderSourceStoryboard(
    current.segments.map((s) => ({
      segmentIndex: s.segmentIndex,
      sceneIndex: s.sceneIndex,
      sceneTitle: s.sceneTitle,
      duration: s.duration,
      sourceRange: s.sourceRange,
    })),
    current.shots.map((s) => ({
      segmentIndex: s.segmentIndex,
      shotIndex: s.shotIndex,
      duration: s.duration,
      shotSize: s.shotSize,
      camera: s.camera,
      light: s.light,
      action: s.action,
      dialogue: s.dialogue,
      sfx: s.sfx,
      sourceRange: s.sourceRange,
    })),
    current.assetNamesBySegment,
  );

  const plan = await readWorkData<{ plan?: string }>(db, projectId, scriptId, "redrawDirectorPlan");
  const segmentCap = await readSegmentCap(db, projectId);
  const prompt = buildStoryboardPrompt({
    projectName: String(project.name ?? ""),
    targetCountry: String(project.targetCountry ?? ""),
    artStyle: project.artStyle ?? null,
    segmentCap,
    scriptContent: String(script.content ?? ""),
    directorPlan: String(plan?.plan ?? ""),
    sourceStoryboard: sourceText,
    confirmedAssets: assets,
  }, deps.loadSkill ? { system: deps.loadSkill() } : {});

  await deps.report?.(20, "生成转绘分镜");
  const reply = await deps.invoke(prompt.system, prompt.user);
  await deps.report?.(60, "校验转绘分镜");

  const out = parseStoryboardOutput(reply);
  const plans = attachVideoDesc(
    validateRedrawStoryboard(out.parsed, { segmentCap, confirmedAssets: confirmedMap }),
    out.parsed,
  );
  const written = await writeRedrawStoryboard(db, { projectId, scriptId, segments: plans, changes: out.changes });

  // 2/3/4 → 3 都合法（首次生成 / 重跑转绘层）
  await transitionRedrawState(db, { projectId, scriptId, to: REDRAW_STATE.STORYBOARD_READY, errorReason: null });
  await deps.report?.(100, "转绘分镜已就绪");
  return { segments: written.segmentCount, shots: written.shotCount, changes: out.changes, inheritedClips: written.inheritedClips };
}

/** 生产 invoke：技能 + 部署行 `redrawAgent:storyboardAgent`。 */
async function defaultInvoke(system: string, user: string): Promise<string> {
  const out = await u.Ai.Text("redrawAgent:storyboardAgent", currentAiBillingContext()).invoke({
    system,
    messages: [{ role: "user", content: user }],
  });
  return String(out.text ?? "");
}

/**
 * 任务定义。
 * ⚠ `maxAttempts = 1`：一次文本调用 = 一次计费，自动重试等于自动重复扣费。
 * ⚠ 幂等键不含 replace：同一集的"重新生成"在上一条完成后就能再投（dedupeActive 在终态置 NULL）。
 */
export const redrawStoryboard: JobDefinition<RedrawStoryboardPayload> = {
  type: "redraw.storyboard",
  timeoutMs: 10 * 60 * 1000,
  maxAttempts: 1,
  pool: "vendor:text",
  parse(raw) {
    const o = raw as Partial<RedrawStoryboardPayload> | null;
    if (!o || typeof o !== "object") throw new Error("[job] redraw.storyboard payload 必须是对象");
    if (typeof o.projectId !== "number" || !Number.isInteger(o.projectId) || o.projectId <= 0) {
      throw new Error("[job] redraw.storyboard payload 缺少合法的 projectId");
    }
    if (typeof o.scriptId !== "number" || !Number.isInteger(o.scriptId) || o.scriptId <= 0) {
      throw new Error("[job] redraw.storyboard payload 缺少合法的 scriptId");
    }
    return { projectId: o.projectId, scriptId: o.scriptId };
  },
  dedupeKey(p) {
    return "redraw.storyboard:" + p.projectId + ":" + p.scriptId;
  },
  async handle(ctx: JobContext, payload) {
    return await runRedrawStoryboard(u.db as unknown as Knex, payload, {
      invoke: defaultInvoke,
      report: async (percent, stage) => {
        const alive = await ctx.progress(percent, stage);
        if (!alive) throw new Error("任务租约已丢失，停止转绘分镜生成");
      },
    });
  },
};