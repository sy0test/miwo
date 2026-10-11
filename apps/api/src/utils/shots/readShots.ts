/**
 * 结构化分镜的**读取层**（阶段1：切换读取的过渡实现）
 *
 * 背景：落库已经切到 `o_segment` / `o_shot` / `o_shotAssets`（阶段1 前几步），
 * 但读取方（`getFlowData`、分镜台、生成台）还在读旧结构。这一步把"读新表"的能力先建起来，
 * 并用设置 `o_setting.shotsEngine` 做**开关**：
 *
 *   · 未设置 / "v2"        → 新链路（**默认**；旧写入口退役后未设置也必须是它）
 *   · "legacy"             → 读取方整体走旧结构（**只读老集**，写入口已退役；用于回滚读行为）
 *   · 任意模式下，某集没有结构化数据时都会自动降级回旧结构（逐集降级）
 *
 * 另外提供 `segmentsToLegacyStoryboard()`：把新结构**投影成旧的 storyboard 数组形状**，
 * 这样下游（工作台/生成台/提示词生成）在彻底改造前可以无感消费 —— 避免"一次切太狠"。
 *
 * 不 import 任何 `@/` 模块：便于 `docs/tools/*.cjs` 用真 SQLite 离线验证。
 */

export type ShotsEngine = "legacy" | "v2";

/** 引擎开关（读设置表）。
 *
 * **默认 v2**：旧写入口已按退役清单删除（`docs/legacy-retirement-plan.md`），
 * 此时若"未设置 = legacy"，新装用户（空库）会一直卡在"写入被拒绝"。
 * `legacy` 现在只剩**读老集**的能力（写入端已不存在），需要回滚读行为时显式设成 "legacy"；
 * 新库由 `initDB` 显式写成 v2、老库由 `fixDB` 补写（只在完全没有这一行时）。
 */
export async function readShotsEngine(db: any): Promise<ShotsEngine> {
  try {
    const row = await db("o_setting").where("key", "shotsEngine").first();
    return row?.value === "legacy" ? "legacy" : "v2";
  } catch {
    return "v2";
  }
}

/** 这一集是否有结构化数据（切换期用来"逐集降级"） */
export async function hasStructuredShots(db: any, scriptId: number): Promise<boolean> {
  try {
    const row = await db("o_segment").where("scriptId", scriptId).count({ n: "*" }).first();
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export type ShotRows = {
  segments: any[];
  shots: any[];
  /**
   * 每片段的参考资产（按镜保序去重）。
   * ⚠ 键是 **segmentIndex**（片段序号），不是 `o_segment.id` —— 名字写全以免混用。
   */
  assetIdsBySegmentIndex: Record<number, number[]>;
};

/** 读一集的结构化分镜（片段按 segmentIndex、镜按 segmentIndex+shotIndex 排序） */
export async function readShotsForScript(db: any, scriptId: number): Promise<ShotRows> {
  const segments = await db("o_segment").where("scriptId", scriptId).orderBy("segmentIndex", "asc");
  const shots = await db("o_shot").where("scriptId", scriptId).orderBy(["segmentIndex", "shotIndex"]);
  const shotIds = shots.map((s: any) => s.id);
  const bindings = shotIds.length ? await db("o_shotAssets").whereIn("shotId", shotIds) : [];

  const shotOwner: Record<number, number> = {}; // shotId → segmentIndex
  for (const s of shots) shotOwner[s.id] = s.segmentIndex;
  const bySegment: Record<number, number[]> = {};
  for (const b of bindings) {
    const segIdx = shotOwner[b.shotId];
    if (segIdx == null) continue;
    const list = (bySegment[segIdx] ??= []);
    if (!list.includes(b.assetId)) list.push(b.assetId);
  }
  return { segments, shots, assetIdsBySegmentIndex: bySegment };
}

/** 旧 `flowData.storyboard` 的元素形状（见 routes/production/getFlowData.ts 的返回） */
export type LegacyStoryboardRow = {
  id: number;
  index: number;
  duration: number;
  prompt: string;
  associateAssetsIds: number[];
  src: string;
  state: string;
  videoDesc: string;
  shouldGenerateImage: number;
  reason: string;
  flowId: number | null;
  /** 新增：告诉下游"这条来自结构化片段"（旧结构没有这个字段，加了不冲突） */
  segmentIndex: number;
};

/**
 * 把结构化片段**投影成旧 storyboard 数组形状**。
 *
 * 对照关系（阶段2 之前让下游无感）：
 *   segment.id          → id            （片段 id 当卡片 id）
 *   segment.segmentIndex→ index / track （原按 track 排序/分组的语义）
 *   segment.duration    → duration
 *   segment.prompt      → prompt        （生成提示词本来就写在"轨道/片段"上）
 *   segment.videoDesc   → videoDesc     （多参模式：承接句 + 行原文）
 *   镜级绑定聚合         → associateAssetsIds
 *   （分镜图在 v2 里由阶段6 之外的东西负责，这里给空串；shouldGenerateImage 恒 0 —— 多参模式不出分镜图）
 */
export function segmentsToLegacyStoryboard(rows: ShotRows): LegacyStoryboardRow[] {
  return [...rows.segments]
    .sort((a, b) => Number(a.segmentIndex) - Number(b.segmentIndex))
    .map((seg, i) => ({
      id: Number(seg.id),
      index: i,
      duration: Number(seg.duration) || 0,
      prompt: seg.prompt ?? "",
      associateAssetsIds: rows.assetIdsBySegmentIndex[Number(seg.segmentIndex)] ?? [],
      src: "",
      state: seg.state ?? "未生成",
      videoDesc: seg.videoDesc ?? "",
      shouldGenerateImage: 0,
      reason: "",
      flowId: null,
      segmentIndex: Number(seg.segmentIndex),
    }));
}

/**
 * 结构化片段 → 生成台需要的"轨道"形状（`o_videoTrack` 的字段子集）。
 * 阶段2 把工作台从 `o_videoTrack` 换到 `o_segment` 时用这个函数，字段名保持不变。
 */
export function segmentsToLegacyTracks(rows: ShotRows) {
  return [...rows.segments]
    .sort((a, b) => Number(a.segmentIndex) - Number(b.segmentIndex))
    .map((seg) => ({
      id: Number(seg.id),
      scriptId: Number(seg.scriptId),
      projectId: Number(seg.projectId),
      // 工作台读的"时长"优先用**生成时长**（模式菜单选的模型时长），没选过才退回内容时长（镜之和）
      duration: Number(seg.videoDuration ?? seg.duration) || 0,
      state: seg.state ?? "未生成",
      prompt: seg.prompt ?? "",
      // 与 o_videoTrack 同形：工作台的段列表/失败提示都用它（o_segment 也有这一列）
      reason: seg.reason ?? "",
      selectVideoId: seg.selectVideoId ?? null,
      videoId: seg.videoId ?? null,
      videoList: [],
      segmentIndex: Number(seg.segmentIndex),
    }));
}

// ============================================================
// 「轨道」表的解析与读写（阶段2：工作台从 o_videoTrack 切到 o_segment）
//
// 关键前提：**`o_segment` 的字段名与 `o_videoTrack` 完全一致**
// （state / prompt / videoId / selectVideoId / duration / scriptId / projectId），
// 所以"切表"对调用方就是换个表名；这里把它收敛成几个助手，避免 12 处各自判断。
// 默认（shotsEngine != v2）一律走旧表 —— 零行为变化。
// ============================================================

type TrackTable = "o_videoTrack" | "o_segment";

/** 该集该用哪张表：v2 且该集有结构化数据 → o_segment；否则旧表（逐集降级） */
export async function trackTableForScript(db: any, scriptId: number): Promise<TrackTable> {
  if ((await readShotsEngine(db)) !== "v2") return "o_videoTrack";
  return (await hasStructuredShots(db, scriptId)) ? "o_segment" : "o_videoTrack";
}

/** 只知道 trackId 时：v2 下该 id 在 o_segment 里就认新表，否则旧表 */
export async function trackTableForId(db: any, trackId: number): Promise<TrackTable> {
  if ((await readShotsEngine(db)) !== "v2") return "o_videoTrack";
  try {
    const hit = await db("o_segment").where("id", trackId).first();
    if (hit) return "o_segment";
  } catch {
    // 表不存在（老库还没建）→ 走旧表
  }
  return "o_videoTrack";
}

/** 按 id 更新"轨道级"字段（字段名两表一致） */
export async function updateTrackById(db: any, trackId: number, patch: Record<string, any>): Promise<{ table: TrackTable; updated: number }> {
  const table = await trackTableForId(db, trackId);
  const updated = await db(table).where("id", trackId).update(patch);
  return { table, updated: Number(updated ?? 0) };
}

/** 按 videoId 反查并清空（删视频时用） */
export async function updateTrackByVideoId(db: any, videoId: number, patch: Record<string, any>): Promise<{ tables: TrackTable[] }> {
  const tables: TrackTable[] = [];
  // v2 下也可能有历史轨道，两张表都清一遍（各自命中才算）
  const candidates: TrackTable[] = (await readShotsEngine(db)) === "v2" ? ["o_segment", "o_videoTrack"] : ["o_videoTrack"];
  for (const t of candidates) {
    try {
      const n = await db(t).where("videoId", videoId).update(patch);
      if (Number(n ?? 0) > 0) tables.push(t);
    } catch {
      /* 表不存在就跳过 */
    }
  }
  return { tables };
}

/** 按 id 读一条"轨道" */
export async function readTrackById(db: any, trackId: number): Promise<any | undefined> {
  const table = await trackTableForId(db, trackId);
  return db(table).where("id", trackId).first();
}

/** 读该集全部"轨道"（v2 → 由片段投影；旧表 → 原样） */
export async function tracksForScript(db: any, projectId: number, scriptId: number): Promise<any[]> {
  if ((await trackTableForScript(db, scriptId)) === "o_segment") {
    const rows = await readShotsForScript(db, scriptId);
    return segmentsToLegacyTracks(rows);
  }
  return db("o_videoTrack").where({ projectId, scriptId });
}

/**
 * 视频状态归一化。
 *
 * ⚠ 两个词表本来就不一样，收敛错了界面就显示"未生成"：
 *   · `o_video.state`（生成/轮询端写的）  = 生成中 / **生成成功** / **生成失败**
 *   · 工作台段级 state（前端认的）        = 未生成 / 生成中 / 已完成 / 生成失败
 * 真机上 115 条成功视频全被显示成"未生成"就是这个原因（老代码只认 `已完成`）。
 */
export function normalizeVideoState(raw: unknown): "未生成" | "生成中" | "已完成" | "生成失败" {
  const s = String(raw ?? "");
  if (s === "已完成" || s === "生成成功" || s === "成功") return "已完成";
  if (s === "生成中" || s === "处理中" || s === "排队中") return "生成中";
  if (s === "生成失败" || s === "失败" || s === "错误") return "生成失败";
  return "未生成";
}

/**
 * 旧写入路径退役后的统一提示（见 docs/legacy-retirement-plan.md）。
 *
 * 旧链路（`o_storyboard` / `o_videoTrack` 写入口）已删除，v2 是唯一写入端；
 * 对**还没结构化**的老集，所有写操作都回这一句，而不是偷偷写另一套真身
 *（那会造成"写进去的东西在界面上看不见"）。要升级某一集只需在「分镜表」节点保存一次，
 * 或重跑阶段4 —— 两条路都零成本把该集变成结构化集。
 */
export const NOT_STRUCTURED_HINT = "本集尚未启用结构化分镜（未落库）：请打开「分镜表」节点保存一次，或重跑阶段4，然后重试";

/** 引擎 + 该集是否已结构化（写接口用：非 v2 就拒绝，不再写旧表） */
export async function requireStructured(db: any, scriptId: number): Promise<boolean> {
  return (await readShotsEngine(db)) === "v2" && (await hasStructuredShots(db, scriptId));
}

/** v2 下"新增一个空片段"用：下一个片段序号 */
export async function nextSegmentIndex(db: any, scriptId: number): Promise<number> {
  const row = await db("o_segment").where("scriptId", scriptId).max({ m: "segmentIndex" }).first();
  return Number(row?.m ?? 0) + 1;
}

/**
 * 把"按镜的素材项"收敛成"按片段的 storyboardItem"（v2 专用）。
 *
 * 为什么需要：v2 的**生成单位是片段**，但前端传进来的 `info` 是"该片段的每一镜"各一项。
 * 如果照项渲染 `<storyboardItem>`，同一个片段的描述会被渲染**多遍** ——
 * 实测后果：生成的提示词里「镜头1/镜头2」出现了两遍（模型把同一段写了两轮）。
 *
 * 收敛规则：同一 `segmentId` 只出一条；`videoDesc` 取片段（本来就含"承接句 + 全部镜的行原文"）；
 * `duration` 取片段时长；`associateAssetsIds` 取该片段**所有镜**的绑定并集（参考资料不能漏）。
 */
export async function storyboardItemsForShots(
  db: any,
  shotIds: number[],
): Promise<Array<{ videoDesc: string; prompt: string; track: string; duration: number; shouldGenerateImage: number; associateAssetsIds: number[]; _type: "storyboard" }>> {
  const ids = [...new Set(shotIds.filter((n) => typeof n === "number" && !Number.isNaN(n)))];
  if (!ids.length) return [];
  const shots: any[] = await db("o_shot").whereIn("id", ids);
  if (!shots.length) return [];

  const segmentIds = [...new Set(shots.map((s) => Number(s.segmentId)))].filter((n) => !Number.isNaN(n));
  const segments: any[] = await db("o_segment").whereIn("id", segmentIds);
  const segById = new Map<number, any>(segments.map((s) => [Number(s.id), s]));

  const allShots: any[] = await db("o_shot").whereIn("segmentId", segmentIds).select("id", "segmentId");
  const bindings: any[] = allShots.length ? await db("o_shotAssets").whereIn("shotId", allShots.map((s) => Number(s.id))) : [];
  const owner = new Map<number, number>(allShots.map((s) => [Number(s.id), Number(s.segmentId)]));
  const assetsBySegment = new Map<number, number[]>();
  for (const b of bindings) {
    const segId = owner.get(Number(b.shotId));
    if (segId == null) continue;
    const list = assetsBySegment.get(segId) ?? [];
    if (!list.includes(Number(b.assetId))) list.push(Number(b.assetId));
    assetsBySegment.set(segId, list);
  }

  // 按传入顺序（= 片段内镜序）输出，同一片段只出一条
  const out: Array<any> = [];
  const seen = new Set<number>();
  for (const s of shots) {
    const segId = Number(s.segmentId);
    if (seen.has(segId)) continue;
    seen.add(segId);
    const seg = segById.get(segId);
    out.push({
      videoDesc: seg?.videoDesc ?? "",
      prompt: seg?.prompt ?? "",
      track: String(seg?.segmentIndex ?? ""),
      duration: Number(seg?.duration ?? 0),
      shouldGenerateImage: 0,
      associateAssetsIds: assetsBySegment.get(segId) ?? [],
      _type: "storyboard" as const,
    });
  }
  return out;
}

/**
 * 直接按**片段**取它的分镜项（v2 下生成提示词用）。
 *
 * 为什么需要：v2 里"分镜"的单位就是**片段**，提示词要的也是"一片段一条"。
 * 以前只能从客户端传来的 `info` 里收集镜 id 再收敛，一旦界面不再把"段内镜"当卡片发上来
 * （真机反馈：那些只有"文"的空卡是多余颗粒度），提示词的**分镜信息**就会整块丢掉。
 * 所以改成**服务端自己按片段取**，与界面颗粒度解耦 —— 产出与
 * `storyboardItemsForShots(db, 该段所有镜 id)` 完全一致（有回归用例比对两者）。
 */
export async function storyboardItemsForSegment(db: any, segmentId: number): Promise<ReturnType<typeof storyboardItemsForShots> extends Promise<infer T> ? T : never> {
  const shots: any[] = await db("o_shot").where("segmentId", segmentId).select("id");
  return storyboardItemsForShots(db, shots.map((s) => Number(s.id)));
}
