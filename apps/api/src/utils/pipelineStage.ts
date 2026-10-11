import u from "@/utils";

/**
 * 流水线进度：把「最远已完成到哪个阶段」落进工作区，供决策层在上下文里读取。
 *
 * 为什么需要它：决策层判断「当前第几阶段」此前只能靠记忆（deepRetrieve），
 * 而记忆会被压缩/清空（换集、清记忆、摘要策略都会动它）——一清就失忆，
 * 于是把跑完的阶段重跑一遍、或跳错阶段。进度是**确定性状态**，不该存在会漂移的地方。
 *
 * 两条流水线各用**独立的键**，因为它们的阶段编号会撞车：
 *   · 生产：阶段1 导演规划 / 2 衍生资产 / 3 资产生成 / 4 分镜表 / 5 分镜面板 / 6 分镜图
 *   · 转绘：第1~7 步，其中 `stage5` 是「切原片片段」，与生产的「分镜面板」完全不是一回事
 * 共用一个键会让两边互相覆盖。
 */
export const PRODUCTION_STAGE_KEY = "productionStage";
export const REDRAW_STAGE_KEY = "redrawStage";

/** 工作区那一行的 upsert。键法与读法照 `routes/production/getFlowData.ts`：where 用 String()、insert 用数字 */
export async function upsertWorkData(projectId: number, episodesId: number, key: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  const hit = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(episodesId))
    .andWhere("key", key)
    .first();
  if (hit) {
    await u.db("o_agentWorkData").where("id", hit.id).update({ data, updateTime: Date.now() });
    return;
  }
  await u.db("o_agentWorkData").insert({
    projectId,
    episodesId,
    key,
    data,
    createTime: Date.now(),
    updateTime: Date.now(),
  });
}

/**
 * 写进度。`order` 给出该流水线的阶段顺序，只保留**最远**的那个 ——
 * 用户在阶段5 之后回头重跑阶段1，不该把进度退回阶段1。
 */
export async function persistStage(projectId: number, episodesId: number, key: string, stage: string, order: string[]): Promise<void> {
  const current = await readStage(projectId, episodesId, key);
  const prevRank = current ? order.indexOf(current) : -1;
  const nextRank = order.indexOf(stage);
  // 阶段名不在表里（技能改了措辞）就当未知，直接写入，不拿旧的挡住新的
  if (nextRank >= 0 && prevRank > nextRank) return;
  await upsertWorkData(projectId, episodesId, key, { stage, at: Date.now() });
}

/** 读进度。读不到返回 null —— 调用方据此如实说「未知」，而不是当成某个默认阶段 */
export async function readStage(projectId: number, episodesId: number, key: string): Promise<string | null> {
  const hit = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(episodesId))
    .andWhere("key", key)
    .first();
  if (!hit?.data) return null;
  try {
    const parsed = JSON.parse(hit.data);
    return typeof parsed?.stage === "string" ? parsed.stage : null;
  } catch {
    return null;
  }
}

// ============================================================
// 生产流水线（阶段1~6）
// ============================================================

/**
 * 阶段名 → 顺序。**必须与 `productionAgent/index.ts` 里传给 `runAgent` 的 `stage` 文案一字不差**，
 * 否则 `indexOf` 返回 -1、比较失效。改文案时两处一起改。
 */
export const PRODUCTION_STAGES = [
  "阶段1 导演规划",
  "阶段2 衍生资产分析",
  "阶段3 衍生资产生成",
  "阶段4 构建分镜表",
  "阶段5 分镜面板写入",
  "阶段6 分镜图生成",
] as const;

/** 记录生产进度（只前不后） */
export async function persistProductionStage(projectId: number, episodesId: number, stage: string): Promise<void> {
  await persistStage(projectId, episodesId, PRODUCTION_STAGE_KEY, stage, [...PRODUCTION_STAGES]);
}

/** 读生产进度 */
export async function readProductionStage(projectId: number, episodesId: number): Promise<string | null> {
  return readStage(projectId, episodesId, PRODUCTION_STAGE_KEY);
}

// ============================================================
// 转绘流水线
// ============================================================

/**
 * 转绘阶段名 → 顺序。目前只落了 `"analysis"`（解析层完成），
 * 后面的 `"stage5"` 等尚未在代码里写入；表先备着，等有了就自动"只前不后"。
 * 与生产的阶段名**故意分开**：生产的 stage5 是分镜面板，转绘的 stage5 是切原片片段。
 */
export const REDRAW_STAGES = ["analysis", "stage5", "stage6", "stage7"] as const;
