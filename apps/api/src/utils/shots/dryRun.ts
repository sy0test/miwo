/**
 * v2 干跑（dry-run）：**不改任何数据**，只回答"如果现在翻到 v2，这一集会怎么处理"
 *
 * 用途：翻开关之前先看清楚 —— 解析能不能成功、会报哪些问题、待修哪几个片段、将写入多少行。
 * 只读，且**与引擎开关无关**（legacy 下也能跑）。
 *
 * 文本来源优先级：显式传入 → 工作区 `o_agentWorkData(key=productionAgent).data.storyboardTable`。
 *
 * 不 import 任何 `@/` 模块 → 可用 `docs/tools/*.cjs` 离线验证。
 */

import type { ParsedStoryboard, ValidateIssue, ValidateOptions } from "./storyboardTable";
import { parseStoryboardTable, validateShots } from "./storyboardTable";
import { buildRepairPlan, type RepairPlan } from "./repairPlan";
import { buildBriefBlock, loadBrief } from "./episodeBrief";

export type DryRunResult = {
  source: "given" | "workData" | "none";
  ok: boolean;
  note: string;
  /** 将写入的行数（片段/镜/绑定）与总时长 —— 只是"将要写多少" */
  preview: { segments: number; shots: number; bindings: number; totalSec: number } | null;
  parseErrors: string[];
  validateErrors: ValidateIssue[];
  warnings: ValidateIssue[];
  plan: RepairPlan | null;
  /** 已有的结构化行数（若该集之前落过库，用来看 diff 量级） */
  existing: { segments: number; shots: number; bindings: number };
  parsed?: ParsedStoryboard;
};

/** 从工作区取这一集的分镜表文本 */
export async function readStoryboardTableFromWorkData(db: any, projectId: number, scriptId: number): Promise<string | null> {
  const row = await db("o_agentWorkData").where("projectId", String(projectId)).andWhere("episodesId", String(scriptId)).andWhere("key", "productionAgent").first();
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data);
    const text = parsed?.storyboardTable;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

export async function dryRunV2(
  db: any,
  opts: { projectId: number; scriptId: number; text?: string | null; maxRepairSegments?: number },
): Promise<DryRunResult> {
  const existing = { segments: 0, shots: 0, bindings: 0 };
  try {
    existing.segments = Number((await db("o_segment").where("scriptId", opts.scriptId).count({ n: "*" }).first())?.n ?? 0);
    existing.shots = Number((await db("o_shot").where("scriptId", opts.scriptId).count({ n: "*" }).first())?.n ?? 0);
    // 绑定数要经镜 id 关联（o_shotAssets 没有 scriptId 列）—— 之前这里没算，真机干跑显示"现有 绑定0"是错的
    const shotIdRows: any[] = existing.shots ? await db("o_shot").where("scriptId", opts.scriptId).select("id") : [];
    existing.bindings = shotIdRows.length
      ? Number((await db("o_shotAssets").whereIn("shotId", shotIdRows.map((r) => Number(r.id))).count({ n: "*" }).first())?.n ?? 0)
      : 0;
  } catch {
    // 表还没建（没重启过）→ 保持 0
  }

  let text = opts.text && opts.text.trim() ? opts.text : null;
  let source: DryRunResult["source"] = text ? "given" : "none";
  if (!text) {
    text = await readStoryboardTableFromWorkData(db, opts.projectId, opts.scriptId).catch(() => null);
    if (text) source = "workData";
  }
  if (!text) {
    return {
      source: "none",
      ok: false,
      note: "这一集还没有分镜表文本（工作区里没有 storyboardTable，也没传 text）——先跑到阶段4 再干跑。",
      preview: null,
      parseErrors: [],
      validateErrors: [],
      warnings: [],
      plan: null,
      existing,
    };
  }

  const parsed = parseStoryboardTable(text);
  if (parsed.errors.length) {
    return {
      source,
      ok: false,
      note: `解析失败（共 ${parsed.errors.length} 条）：${parsed.errors.map((e) => e.message).join("；")}`,
      preview: null,
      parseErrors: parsed.errors.map((e) => e.message),
      validateErrors: [],
      warnings: [],
      plan: null,
      existing,
    };
  }

  // 上下文：存在性权威 = o_assets；未挂本集只做软提示
  const referenced = [...new Set(parsed.segments.flatMap((s) => [...s.assetIds, ...s.shots.flatMap((k) => k.assetIds)]))].filter((n) => typeof n === "number" && !Number.isNaN(n));
  let validAssetIds: Set<number> | undefined;
  if (referenced.length) {
    try {
      const rows: any[] = await db("o_assets").whereIn("id", referenced).select("id");
      validAssetIds = new Set(rows.map((r) => Number(r.id)));
    } catch {
      /* 老库没这张表/查不到就不做该项校验 */
    }
  }
  let unlinked: number[] = [];
  try {
    const links: any[] = await db("o_scriptAssets").where("scriptId", opts.scriptId).select("assetId");
    const linked = new Set(links.map((r) => Number(r.assetId)));
    unlinked = validAssetIds ? referenced.filter((id) => validAssetIds!.has(id) && !linked.has(id)) : [];
  } catch {
    /* 忽略 */
  }
  let scriptContent: string | undefined;
  try {
    scriptContent = (await db("o_script").where("id", opts.scriptId).select("content").first())?.content ?? undefined;
  } catch {
    /* 忽略 */
  }
  let briefBlock = "";
  let requireDialogueFromScript = false;
  try {
    const brief = await loadBrief(db, opts.scriptId);
    requireDialogueFromScript = brief?.dialogueSource === "script-original";
    briefBlock = buildBriefBlock(brief);
  } catch {
    /* 忽略 */
  }

  const validateOptions: ValidateOptions = { validAssetIds, scriptContent, requireDialogueFromScript };
  const v = validateShots(parsed, validateOptions);
  const plan = v.errors.length || v.warnings.length ? buildRepairPlan(parsed, v, { briefBlock, maxSegments: opts.maxRepairSegments ?? 6 }) : null;

  // 将写入的行数：片段 = 片段数；镜 = 镜数；绑定 = 每镜去重后的资产数（镜没写则继承所属片段列表）
  let bindings = 0;
  for (const seg of parsed.segments) {
    for (const shot of seg.shots) {
      const ids = new Set(shot.assetIds.length ? shot.assetIds : seg.assetIds);
      bindings += ids.size;
    }
  }
  const totalSec = Math.round(parsed.segments.reduce((a, s) => a + s.shots.reduce((x, y) => x + y.duration, 0), 0) * 10) / 10;

  const warnings: ValidateIssue[] = [
    ...v.warnings,
    ...unlinked.map((id) => ({ level: "warning" as const, where: "本集挂载", rule: "资产未挂到本集", message: `资产 ${id} 存在于资产库，但未挂到本集` })),
  ];

  const note =
    `干跑（未写库）：片段 ${parsed.segments.length} / 镜 ${parsed.shots.length} / 绑定 ${bindings} / 总时长 ${totalSec}s` +
    `（现有 片段${existing.segments} 镜${existing.shots} 绑定${existing.bindings}）` +
    `；校验 error ${v.errors.length} / warning ${warnings.length}` +
    (plan?.tasks.length ? `；${plan.summary}` : "");

  return {
    source,
    ok: true,
    note,
    preview: { segments: parsed.segments.length, shots: parsed.shots.length, bindings, totalSec },
    parseErrors: [],
    validateErrors: v.errors,
    warnings,
    plan,
    existing,
    parsed,
  };
}
