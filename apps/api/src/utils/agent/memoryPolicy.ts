/**
 * 记忆分层策略（阶段3）
 *
 * 现状问题（真实数据验证过）：
 *   · 用户原话会被压缩进摘要 —— 「台词只保留英文题词口播」这类**口头硬约束**一旦被摘要化，
 *     执行层就再也读不到原句（执行层本来也不读记忆，只有决策层读，再靠一句话转述下去）；
 *   · 执行层产出（六阶段的大段文本）也进了记忆池并参与向量召回 —— 噪音大、token 高，
 *     而且它们的权威副本本来就在数据库/工作区里。
 *
 * 分层后：
 *   用户原话    → **永不压缩**，逐字进上下文（有上限，见 USER_QUOTE_LIMIT）
 *   决策层产出  → 参与压缩成摘要（这是"对话历史"的正确粒度）
 *   执行层产出  → 不进记忆池（只留在数据库/工作区/阶段进度里）
 *
 * 之所以把判定抽成纯函数：`Memory` 依赖 ONNX 嵌入模型，离线跑不起来；
 * 抽出来就能用真数据进行确定性验证（见 `docs/tools/verify-memory-phase3.cjs`）。
 */

/** 压缩批大小下限：设置里默认 10 太小（10 条就切一刀，摘要碎、决策层看不到完整脉络） */
export const PHASE3_FLOOR_MESSAGES_PER_SUMMARY = 20;

/** 用户原话注入上限（永不压缩，但也不能无限增长） */
export const USER_QUOTE_LIMIT = 20;

/** 生效的压缩批大小：设置值不得低于下限 */
export function effectiveBatchSize(setting: number | string, floor: number = PHASE3_FLOOR_MESSAGES_PER_SUMMARY): number {
  const n = Number(setting);
  if (!Number.isFinite(n) || n <= 0) return floor;
  return Math.max(floor, Math.floor(n));
}

/** 这条记忆能不能参与压缩：用户原话不许压缩 */
export function isCompressible(role: string | null | undefined): boolean {
  return (role ?? "") !== "user";
}

type Row = { id: string; role?: string | null; summaryKind?: string | null; content?: string | null; createTime?: number; summarized?: number };

/** 从"未总结消息"里挑出这一批要压缩的：按时间升序、跳过用户原话 */
export function pickCompressionBatch(rows: Row[], size: number): Row[] {
  return [...rows]
    .filter((r) => isCompressible(r.role))
    .sort((a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0))
    .slice(0, size);
}

/** 用户原话：只取 role=user，取**最近** limit 条，返回按时间升序（最旧在前） */
export function pickUserQuotes(rows: Row[], limit: number = USER_QUOTE_LIMIT): Row[] {
  return [...rows]
    .filter((r) => (r.role ?? "") === "user")
    .sort((a, b) => Number(b.createTime ?? 0) - Number(a.createTime ?? 0))
    .slice(0, limit)
    .sort((a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0));
}

/** 非用户的未总结消息（"近期对话"段，用户原话另开一段，避免重复） */
export function pickRecentNonUser(rows: Row[], limit: number): Row[] {
  return [...rows]
    .filter((r) => isCompressible(r.role))
    .sort((a, b) => Number(b.createTime ?? 0) - Number(a.createTime ?? 0))
    .slice(0, limit)
    .sort((a, b) => Number(a.createTime ?? 0) - Number(b.createTime ?? 0));
}
