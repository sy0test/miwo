/**
 * 转绘状态机（spec §4.2）+ 「当前阶段/进度」的工作区读写 + 一集的完整状态读取。
 *
 * ── 为什么必须有独立状态机（不是继续复用 `o_script.extractState`）──
 *  · `extractState` 的语义是"**解析**跑没跑完"：0 跑 / 1 成 / 2 等待 / -1 败。转绘的分层流程
 *    要在解析之后继续走「资产认账 → 转绘分镜 → 确认覆盖」，这三步都是**用户**推进的，
 *    把它们塞进 extractState 会让读它的生产链看到不该看到的值（旧代码写 3 = 待对账，就是个死端点）。
 *  · 所以新增 `o_script.redrawState`（migration 016），extractState 回归自己的语义。
 *
 * ── 本文件的两条纪律 ──
 *  1. **db 由调用方注入**（路由传 `u.db`、job handler 传 `u.db`、单测传裸 knex）。
 *     这样状态机与 SQLite 夹具可以单独测，不需要拉起整个应用；
 *  2. 状态转移**只走 `transitionRedrawState()`**（唯一写入口）。越级转移（如 0→4）必须抛错 ——
 *     "跳步"在界面上看起来和"成功"一模一样，但资产没认账、转绘分镜也没出。
 */

/** 转绘状态。数值是**库里的值**（不要改数字：migration 016 的回填按它写）。 */
export const REDRAW_STATE = {
  /** 未开始（默认 / 重传源片） */
  NONE: 0,
  /** 已解析，待资产认账（解析层成功后写） */
  PARSED: 1,
  /** 资产已确认（认账会话「确认资产」） */
  ASSETS_OK: 2,
  /** 转绘分镜已出，待确认（转绘层写库后） */
  STORYBOARD_READY: 3,
  /** 已确认，可生成（用户点「确认覆盖」） */
  CONFIRMED: 4,
  /** 失败（任一环节；errorReason 同步写） */
  FAILED: -1,
} as const;

export type RedrawState = (typeof REDRAW_STATE)[keyof typeof REDRAW_STATE];

export const REDRAW_STATE_LABELS: Record<number, string> = {
  [REDRAW_STATE.FAILED]: "失败",
  [REDRAW_STATE.NONE]: "待分析",
  [REDRAW_STATE.PARSED]: "待认账",
  [REDRAW_STATE.ASSETS_OK]: "资产已确认",
  [REDRAW_STATE.STORYBOARD_READY]: "转绘待确认",
  [REDRAW_STATE.CONFIRMED]: "可生成",
};

export class RedrawStateError extends Error {
  name = "RedrawStateError";
}

/** 非法状态值（库里出现 5 / "abc" 这类脏值）：**不猜**，直接报出来。 */
export function isRedrawState(v: unknown): v is RedrawState {
  return typeof v === "number" && Object.values(REDRAW_STATE).includes(v as RedrawState);
}

/**
 * 允许的转移。
 *
 *  · 正向：0→1→2→3→4（每一步都要求前一步的产物已落库）；
 *  · 重跑：2/3/4 都可以回到 1（重新解析，旧资产绑定保留，分镜被替换）；
 *  · 回退：3/4 可以回 3（「重跑转绘」）；3/4 → 2（「回退到源片版」= 丢掉转绘版、保留已确认资产）；
 *  · 失败：任意状态 → -1（幂等：-1→-1 允许）；失败后 0（重传）/1（重试解析）。
 *  · **重复写同一状态一律允许**（幂等："确认资产"点两次不该报错）。
 *
 * ⚠ 刻意**不**允许 1→3、2→4、0→4：那等于跳过用户确认点，而每个确认点都是一条"用户拍板"的记录。
 */
const ALLOWED_TRANSITIONS: Record<number, readonly number[]> = {
  [REDRAW_STATE.NONE]: [REDRAW_STATE.NONE, REDRAW_STATE.PARSED, REDRAW_STATE.FAILED],
  [REDRAW_STATE.PARSED]: [REDRAW_STATE.NONE, REDRAW_STATE.PARSED, REDRAW_STATE.ASSETS_OK, REDRAW_STATE.FAILED],
  [REDRAW_STATE.ASSETS_OK]: [REDRAW_STATE.PARSED, REDRAW_STATE.ASSETS_OK, REDRAW_STATE.STORYBOARD_READY, REDRAW_STATE.FAILED],
  [REDRAW_STATE.STORYBOARD_READY]: [
    REDRAW_STATE.PARSED,
    REDRAW_STATE.ASSETS_OK, // 回退到源片版：确认前也可以退回「资产已确认」，丢掉转绘版
    REDRAW_STATE.STORYBOARD_READY,
    REDRAW_STATE.CONFIRMED,
    REDRAW_STATE.FAILED,
  ],
  [REDRAW_STATE.CONFIRMED]: [
    REDRAW_STATE.PARSED,
    REDRAW_STATE.ASSETS_OK, // 回退到源片版：转绘分镜作废、资产仍算已确认
    REDRAW_STATE.STORYBOARD_READY,
    REDRAW_STATE.CONFIRMED,
    REDRAW_STATE.FAILED,
  ],
  [REDRAW_STATE.FAILED]: [REDRAW_STATE.NONE, REDRAW_STATE.PARSED, REDRAW_STATE.FAILED],
};

export function canRedrawTransition(from: unknown, to: unknown): boolean {
  if (!isRedrawState(from) || !isRedrawState(to)) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** 非法转移抛 `RedrawStateError`（路由层翻成 409，见 `sendRedrawError` 的同类做法）。 */
export function assertRedrawTransition(from: unknown, to: unknown): void {
  if (!isRedrawState(from)) throw new RedrawStateError(`当前转绘状态不合法：${String(from)}`);
  if (!isRedrawState(to)) throw new RedrawStateError(`目标转绘状态不合法：${String(to)}`);
  if (from === to) return;
  if (!canRedrawTransition(from, to)) {
    throw new RedrawStateError(
      `不允许的转绘状态转移：${from}(${REDRAW_STATE_LABELS[from] ?? from}) → ${to}(${REDRAW_STATE_LABELS[to] ?? to})`,
    );
  }
}

/** 库里脏值（NULL / 未回填）归一成 0 —— **只在读取时**归一，写入一律走 assert。 */
export function normalizeRedrawState(v: unknown): RedrawState {
  if (v === null || v === undefined) return REDRAW_STATE.NONE;
  if (!isRedrawState(v)) throw new RedrawStateError(`库里的 redrawState 不是合法状态：${String(v)}`);
  return v;
}

// ============================================================
// 工作区（o_agentWorkData）
// ============================================================

/** 制作进度（沿用解析层的键；值形状 `{stage, progress, at}`） */
export const REDRAW_STAGE_KEY = "redrawStage";
/** 源片分镜快照（转绘层覆盖前写，供并排对比/回退） */
export const REDRAW_SOURCE_STORYBOARD_KEY = "redrawSourceStoryboard";
/** 会话摘要 + 三个确认点的结论 */
export const REDRAW_CHAT_SUMMARY_KEY = "redrawChatSummary";

/** 阶段顺序：只前不后（用户回头重跑某一步，不该把进度条退回去） */
export const REDRAW_STAGE_ORDER = ["grid", "cut", "transcribe", "analysis"] as const;
export type RedrawStageName = (typeof REDRAW_STAGE_ORDER)[number];

export type RedrawStageRow = { stage: string; progress: number | null; at: number };

/**
 * `o_agentWorkData` 的 upsert。键法与 `routes/production/getFlowData.ts:18-21` 一致：
 * where 用 `String()`、insert 用数字（库里这两个列的实际类型因历史数据而不一致，两边都写才稳）。
 */
export async function upsertWorkData(
  db: any,
  projectId: number,
  scriptId: number,
  key: string,
  value: unknown,
): Promise<void> {
  const data = JSON.stringify(value);
  const hit = await db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(scriptId))
    .andWhere("key", key)
    .first();
  if (hit) {
    await db("o_agentWorkData").where("id", hit.id).update({ data, updateTime: Date.now() });
    return;
  }
  await db("o_agentWorkData").insert({
    projectId,
    episodesId: scriptId,
    key,
    data,
    createTime: Date.now(),
    updateTime: Date.now(),
  });
}

/** 读工作区的 JSON 值；没有 / 坏 JSON → null（调用方据 null 说"未知"，不当成某个默认值）。 */
export async function readWorkData<T = unknown>(
  db: any,
  projectId: number,
  scriptId: number,
  key: string,
): Promise<T | null> {
  const hit = await db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(scriptId))
    .andWhere("key", key)
    .first();
  if (!hit?.data) return null;
  try {
    return JSON.parse(hit.data) as T;
  } catch {
    return null;
  }
}

// ============================================================
// 阶段 / 进度
// ============================================================

/**
 * 写阶段进度。
 *
 * `stage` 取 `REDRAW_STAGE_ORDER` 里的名字（grid / cut / transcribe / analysis）；
 * `progress` 是 0..100 的粗进度（前端画细进度条）。**只前不后**：
 * 同一阶段内进度可以前进，但不会退；跨阶段一律按顺序表比较（未知阶段名直接写入，不拿旧的挡住新的）。
 */
export async function writeRedrawStage(
  db: any,
  opts: { projectId: number; scriptId: number; stage: string; progress?: number | null },
): Promise<void> {
  const { projectId, scriptId, stage } = opts;
  const progress =
    typeof opts.progress === "number" && Number.isFinite(opts.progress)
      ? Math.max(0, Math.min(100, Math.round(opts.progress)))
      : null;
  const current = await readRedrawStage(db, { projectId, scriptId });
  if (current) {
    const prevRank = (REDRAW_STAGE_ORDER as readonly string[]).indexOf(current.stage);
    const nextRank = (REDRAW_STAGE_ORDER as readonly string[]).indexOf(stage);
    if (prevRank >= 0 && nextRank >= 0) {
      if (nextRank < prevRank) return; // 阶段后退：忽略（重跑的进度不倒退）
      if (nextRank === prevRank) {
        // 同一阶段：进度只前不后；进度未知时保留旧值
        const next = progress === null ? current.progress : Math.max(current.progress ?? 0, progress);
        await upsertWorkData(db, projectId, scriptId, REDRAW_STAGE_KEY, { stage, progress: next, at: Date.now() });
        return;
      }
    }
  }
  await upsertWorkData(db, projectId, scriptId, REDRAW_STAGE_KEY, { stage, progress, at: Date.now() });
}

/** 读阶段进度；没有就返回 null（"从没跑过" ≠ "停在阶段 0"）。 */
export async function readRedrawStage(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<RedrawStageRow | null> {
  const row = await readWorkData<Partial<RedrawStageRow>>(db, opts.projectId, opts.scriptId, REDRAW_STAGE_KEY);
  if (!row || typeof row.stage !== "string") return null;
  return {
    stage: row.stage,
    progress: typeof row.progress === "number" && Number.isFinite(row.progress) ? row.progress : null,
    at: typeof row.at === "number" ? row.at : 0,
  };
}

/** 清掉阶段进度（重传源片 = 从零开始）。 */
export async function clearRedrawStage(db: any, opts: { projectId: number; scriptId: number }): Promise<void> {
  await db("o_agentWorkData")
    .where("projectId", String(opts.projectId))
    .andWhere("episodesId", String(opts.scriptId))
    .andWhere("key", REDRAW_STAGE_KEY)
    .del();
}

// ============================================================
// 状态写入（唯一入口）
// ============================================================

/**
 * 转绘状态的**唯一写入口**：读当前值 → 校验转移 → 更新。
 *
 * `errorReason` 的语义：
 *  · 写到 FAILED 时必写（缺省给一句可读文案）；
 *  · 写到非 FAILED 时**默认保留**（不清空），除非显式传 `errorReason: null` 或字符串。
 *    "成功后顺手清掉上一次的失败原因"由调用方显式决定，避免把调试信息静默丢掉。
 */
export async function transitionRedrawState(
  db: any,
  opts: {
    projectId: number;
    scriptId: number;
    to: RedrawState;
    errorReason?: string | null;
  },
): Promise<void> {
  const { projectId, scriptId, to } = opts;
  const row = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!row) throw new RedrawStateError(`项目 ${projectId} 下没有这一集：scriptId=${scriptId}`);
  const from = normalizeRedrawState(row.redrawState);
  assertRedrawTransition(from, to);
  const patch: Record<string, unknown> = { redrawState: to };
  if (to === REDRAW_STATE.FAILED) {
    patch.errorReason = String(opts.errorReason ?? "转绘流程失败").slice(0, 1000);
  } else if (opts.errorReason !== undefined) {
    patch.errorReason = opts.errorReason === null ? null : String(opts.errorReason).slice(0, 1000);
  }
  await db("o_script").where("id", scriptId).update(patch);
}

/** 读一集的转绘状态（脏值归一；行不存在返回 null）。 */
export async function readRedrawState(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<RedrawState | null> {
  const row = await db("o_script").where({ id: opts.scriptId, projectId: opts.projectId }).first();
  if (!row) return null;
  return normalizeRedrawState(row.redrawState);
}

// ============================================================
// 一集的完整状态（前端一次拿齐）
// ============================================================

export type EpisodeState = {
  /** 解析状态（0 跑 / 1 成 / 2 等待 / -1 败）—— 与转绘状态**分开** */
  extractState: number | null;
  /** 转绘状态机（见 REDRAW_STATE） */
  redrawState: RedrawState;
  /** 当前阶段（cut / transcribe / analysis）；null = 从没跑过 */
  stage: string | null;
  /** 0..100；null = 未知（阶段没进度） */
  progress: number | null;
  /** 片段数（生成单位） */
  segmentCount: number;
  /** 草稿资产总数（前端字段名 assetTotal） */
  assetTotal: number;
  /** 本集已关联的资产数（o_scriptAssets） */
  assetsConfirmed: number;
  /** 已切出 clip 的段数 */
  clipsReady: number;
  /** 项目设置的「单段上限」秒（缺省 15） */
  segmentCap: number;
  /** 时长步骤是否已确认（且与当前 segmentCap 一致） */
  capConfirmed: boolean;
  /** 这一集当前在跑的转绘任务（queued/running）；没有则 null。
   *  前端用它显示「生成中 + 进度条」，而不是靠猜状态 —— 转绘分镜是长任务、没有 streaming。 */
  job: {
    id: number;
    type: string;
    state: string;
    stage: string | null;
    progress: number | null;
  } | null;
};

/** 时长确认记录的工作区 key（M2 的会话页第③步） */
export const REDRAW_CAP_CONFIRM_KEY = "redrawCapConfirm";
export type RedrawCapConfirm = { seconds: number; at: number; forced?: boolean; from?: number };

/** 读"时长步骤已确认"的记录；没有返回 null。 */
export async function readCapConfirm(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<RedrawCapConfirm | null> {
  const row = await readWorkData<Partial<RedrawCapConfirm>>(db, opts.projectId, opts.scriptId, REDRAW_CAP_CONFIRM_KEY);
  if (!row || typeof row.seconds !== "number") return null;
  return {
    seconds: Number(row.seconds),
    at: typeof row.at === "number" ? row.at : 0,
    ...(row.forced === true ? { forced: true } : {}),
    ...(typeof row.from === "number" ? { from: row.from } : {}),
  };
}

/** 写"时长步骤已确认"。 */
export async function writeCapConfirm(
  db: any,
  opts: { projectId: number; scriptId: number; seconds: number; forced?: boolean; from?: number },
): Promise<void> {
  const value: RedrawCapConfirm = { seconds: opts.seconds, at: Date.now(), ...(opts.forced ? { forced: true } : {}), ...(opts.from !== undefined ? { from: opts.from } : {}) };
  await upsertWorkData(db, opts.projectId, opts.scriptId, REDRAW_CAP_CONFIRM_KEY, value);
}

/** 计数查询的返回值在 sqlite/mysql 两种驱动下类型不稳（number | string | bigint），统一 Number。 */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 一次拿齐前端要的一集状态（spec §10.9 的 `POST /redraw/getEpisodeState`）。
 * **只读**、不写库；行不存在返回 null（路由翻 400）。
 *
 * ⚠ 返回字段名是**前端契约**（M2 联调时定的）：assetTotal / segmentCap / capConfirmed 不要改名。
 */
export async function getEpisodeState(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<EpisodeState | null> {
  const { projectId, scriptId } = opts;
  const project = await db("o_project").where("id", projectId).first();
  if (!project) return null;
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) return null;

  const segmentRows = await db("o_segment").where({ projectId, scriptId }).select("id", "clipPath");
  const segmentCount = segmentRows.length;
  const clipsReady = segmentRows.filter((seg: any) => String(seg.clipPath ?? "").trim() !== "").length;

  const linkedRow = await db("o_scriptAssets").where({ scriptId }).count({ n: "*" }).first();
  const draft = await readWorkData<{ assets?: unknown[] }>(db, projectId, scriptId, "redrawAssetDraft");
  const stage = await readRedrawStage(db, { projectId, scriptId });
  const segmentCap = num(project.redrawMaxSegmentSec) || 15;
  const cap = await readCapConfirm(db, { projectId, scriptId });

  // 当前活跃的转绘任务（o_job.payload 里有 projectId/scriptId；表是 platform 表，查询不受租户过滤）
  let job: EpisodeState["job"] = null;
  try {
    const activeJobs = await db("o_job")
      .whereIn("state", ["queued", "running"])
      .andWhere("type", "like", "redraw.%")
      .orderBy("id", "desc")
      .limit(20);
    for (const j of activeJobs) {
      let payload: any = null;
      try {
        payload = JSON.parse(String(j.payload ?? "{}"));
      } catch {
        continue;
      }
      if (Number(payload?.scriptId) === scriptId && Number(payload?.projectId) === projectId) {
        job = {
          id: Number(j.id),
          type: String(j.type),
          state: String(j.state),
          stage: j.stage ?? null,
          progress: j.progress == null ? null : Number(j.progress),
        };
        break;
      }
    }
  } catch {
    job = null;
  }

  return {
    extractState: typeof script.extractState === "number" ? script.extractState : null,
    redrawState: normalizeRedrawState(script.redrawState),
    stage: stage?.stage ?? null,
    progress: stage?.progress ?? null,
    segmentCount,
    assetTotal: Array.isArray(draft?.assets) ? draft!.assets!.length : 0,
    assetsConfirmed: num(linkedRow?.n),
    clipsReady,
    segmentCap,
    capConfirmed: Boolean(cap && cap.seconds === segmentCap),
    job,
  };
}