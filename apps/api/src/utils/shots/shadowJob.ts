/**
 * 阶段4 之后的「影子作业」：解析分镜表文本 → 校验 → （可选）按行修复 → 写结构化三张表
 *
 * 为什么是"影子"：这一版**只写不读** —— 分镜台/生成台/getFlowData 仍然读旧结构，
 * 所以任何解析失败都不会影响用户看到的阶段4 结果（失败只记一条日志）。
 * 等读取方逐个切过来（后续步骤）再摘掉影子。
 *
 * 修复是不是自动跑：由设置 `o_setting.shotsAutoRepair` 控制（"1" 开）。
 *   · 默认**关**：只把"待修哪几个片段"打进日志（零额外模型调用，先积累证据）；
 *   · 开了之后：代码按片段局部重写 → 拼回 → 重新校验（错误数不降就丢弃），再整集事务落库。
 *   注意：修复**不是**重跑整张表 —— 这正是「修复完还是原来的问题 / 问题更多了」的病根。
 *
 * 依赖注入（db / callModel 由调用方传）且不 import 任何 `@/` 模块 —— 于是这段逻辑可以用
 * `docs/tools/verify-shots-*.cjs` 那套真 SQLite 适配离线跑。
 */

import type { ParsedStoryboard, ValidateIssue, ValidateOptions } from "./storyboardTable";
import { parseStoryboardTable, validateShots } from "./storyboardTable";
import { persistShots, type PersistShotsResult } from "./persistShots";
import { buildBriefBlock, loadBrief } from "./episodeBrief";
import { buildRepairPlan, repairSegments, type RepairPlan, type RepairRound } from "./repairPlan";

export type ShadowResult = {
  ok: boolean;
  note: string;
  parsed?: ParsedStoryboard;
  persisted?: PersistShotsResult;
  parseErrors: ValidateIssue[];
  validateErrors: ValidateIssue[];
  warnings: ValidateIssue[];
  /** 待修片段计划（无论是否自动修都给出，便于审计） */
  plan?: RepairPlan;
  /** 实际执行的局部修复轮次（自动修开着时才有） */
  rounds?: RepairRound[];
  /** 覆盖度：分镜表实际覆盖的场次 vs 拍摄计划里规划的场次（真机上出现过"只写了一小段就收尾"） */
  coverage: { tableScenes: number; plannedScenes: number; complete: boolean };
};

/** 取 `<tag>…</tag>` 之间的内容（标签无关；拿不到就退回全文） */
export function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

export async function runShotsShadow(opts: {
  db: any;
  projectId: number;
  scriptId: number;
  /** 阶段4 子 agent 的完整返回文本 */
  replyText: string;
  /** 是否自动执行按片段局部修复（默认 false：只出计划 + 记日志） */
  autoRepair?: boolean;
  /** 局部修复用的模型调用（autoRepair 打开时必传） */
  callModel?: (prompt: string) => Promise<string>;
  validateOptions?: ValidateOptions;
  /** 一次最多修几个片段 */
  maxRepairSegments?: number;
  /** 拍摄计划（`scriptPlan`）原文 —— 用来核对分镜表有没有"只写了一小段" */
  planText?: string | null;
}): Promise<ShadowResult> {
  const { db, projectId, scriptId, replyText } = opts;

  const block = extractTag(replyText, "storyboardTable") ?? replyText;
  const parsed = parseStoryboardTable(block);
  if (parsed.errors.length) {
    return { ok: false, note: `解析失败：${parsed.errors.map((e) => e.message).join("；")}`, parsed, parseErrors: parsed.errors, validateErrors: [], warnings: [], coverage: { tableScenes: 0, plannedScenes: 0, complete: true } };
  }

  // 校验所需的上下文：**资产库**、本集挂载、剧本正文、本集约定
  //
  // ⚠ 「引用资产必须存在」的权威是 `o_assets`（资产库），**不是** `o_scriptAssets`（本集挂载表）：
  //    用后者会把"库里有、只是没挂到这一集"误判成"资产不存在"（实测 ep10/ep15 各有一两个这种 id）。
  //    没挂到本集另有软提示（warning），不当作错误。
  let validAssetIds: Set<number> | undefined;
  let referencedIds: number[] = [];
  let unlinkedIds: number[] = [];
  let scriptContent: string | undefined;
  let briefBlock = "";
  let requireDialogueFromScript = false;
  // 每项上下文**各自容错**：某一张表查不到不该让其它校验一起失效（曾因此把台词校验整块跳过）
  const safe = async <T>(fn: () => Promise<T>, dflt: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return dflt;
    }
  };

  referencedIds = [...new Set(parsed.segments.flatMap((s) => [...s.assetIds, ...s.shots.flatMap((k) => k.assetIds)]))].filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (referencedIds.length) {
    validAssetIds = await safe(async () => {
      const inLibrary: any[] = await db("o_assets").whereIn("id", referencedIds).select("id");
      return new Set<number>(inLibrary.map((r) => Number(r.id)));
    }, undefined as Set<number> | undefined);
  }
  const linked = await safe(async () => {
    const links: any[] = await db("o_scriptAssets").where("scriptId", scriptId).select("assetId");
    return new Set<number>(links.map((r) => Number(r.assetId)));
  }, undefined as Set<number> | undefined);
  unlinkedIds = linked && validAssetIds ? referencedIds.filter((id) => validAssetIds!.has(id) && !linked!.has(id)) : [];
  scriptContent = await safe(async () => {
    const script = await db("o_script").where("id", scriptId).select("content").first();
    return script?.content ?? undefined;
  }, undefined as string | undefined);
  const brief = await safe(async () => await loadBrief(db, scriptId), null as any);
  requireDialogueFromScript = brief?.dialogueSource === "script-original";
  briefBlock = buildBriefBlock(brief);

  const validateOptions: ValidateOptions = { validAssetIds, scriptContent, requireDialogueFromScript, ...(opts.validateOptions ?? {}) };
  const v = validateShots(parsed, validateOptions);

  // ---- 修复计划（代码定位，不靠决策层转述）----
  const plan = v.errors.length || v.warnings.length ? buildRepairPlan(parsed, v, { briefBlock }) : undefined;

  // ---- 可选：按片段局部修复（只重写被点名的片段）----
  let finalParsed = parsed;
  let rounds: RepairRound[] | undefined;
  let finalErrors = v.errors;
  if (plan?.tasks.length && opts.autoRepair && opts.callModel) {
    const rep = await repairSegments(parsed, v, {
      callModel: opts.callModel,
      validateOptions,
      briefBlock,
      maxSegments: opts.maxRepairSegments ?? 4,
    });
    finalParsed = rep.parsed;
    rounds = rep.rounds;
    finalErrors = rep.validation.errors;
  }

  const persisted = await persistShots(db, { projectId, scriptId, parsed: finalParsed });

  // ---- 覆盖度校验（真机教训）----
  // 技能里明确写着「XML 一次性完整、禁止拆多次」，但实测出现过执行层只写了「场1片段一」就收尾
  // （839 字符，远低于任何长度限制 —— 不是截断，是模型没照做）。
  // 拍摄计划 `scriptPlan` 里有「分场汇总表」（`| Sc1 | … | Sc6 |`），拿它当权威清单核对覆盖度，
  // 不完整就把告警同时给到**面板提示**和**决策层**（后者据此重派阶段4 补全）。
  const planText = String(opts.planText ?? "");
  const plannedScenes = (planText.match(/^\|\s*Sc\d+\s*\|/gm) || []).length || (planText.match(/^##\s*场\s*\d+/gm) || []).length;
  const tableScenes = finalParsed.scenes.length;
  const coverage = { tableScenes, plannedScenes, complete: plannedScenes === 0 || tableScenes >= plannedScenes };
  const coverageWarning: ValidateIssue[] = coverage.complete
    ? []
    : [
        {
          level: "warning" as const,
          where: "全表",
          rule: "完整覆盖",
          message: `分镜表只覆盖 ${tableScenes}/${plannedScenes} 场（技能要求一次性输出完整表），疑似未完整输出`,
        },
      ];

  const note =
    `影子落库完成：片段 ${persisted.segments} / 镜 ${persisted.shots} / 绑定 ${persisted.bindings} / 总时长 ${persisted.totalSec}s` +
    `（替换前 片段${persisted.before.segments} 镜${persisted.before.shots} 绑定${persisted.before.bindings}）` +
    `；校验 error ${finalErrors.length} / warning ${v.warnings.length}` +
    (coverage.plannedScenes ? `；覆盖 ${tableScenes}/${plannedScenes} 场${coverage.complete ? "" : "（疑似不完整）"}` : "") +
    (unlinkedIds.length ? `；有 ${unlinkedIds.length} 个引用资产存在但未挂到本集（${unlinkedIds.join(",")}）` : "") +
    (plan?.tasks.length ? `；${plan.summary}` : "") +
    (rounds?.length ? `；局部修复：${rounds.map((r) => `片段${r.segmentIndex}${r.ok ? "✓" : "✗"}(${r.errorsBefore}→${r.errorsAfter})`).join(" ")}` : "") +
    (finalErrors.length ? `；残留：${finalErrors.slice(0, 3).map((e) => `${e.where} ${e.message}`).join(" | ")}` : "");

  return {
    ok: true,
    note,
    parsed: finalParsed,
    persisted,
    coverage,
    parseErrors: [],
    validateErrors: finalErrors,
    warnings: [
      ...v.warnings,
      ...coverageWarning,
      // 「库里有、没挂到本集」是软提示：前端资产列表按 o_scriptAssets 取，没挂就可能看不到
      ...unlinkedIds.map((id) => ({ level: "warning" as const, where: "本集挂载", rule: "资产未挂到本集", message: `资产 ${id} 存在于资产库，但未挂到本集（o_scriptAssets）；前端资产列表可能看不到它` })),
      ...parsed.warnings.map((w) => ({ level: "warning" as const, where: "解析", rule: "解析告警", message: w })),
    ],
    plan,
    rounds,
  };
}
