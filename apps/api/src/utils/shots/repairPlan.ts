/**
 * 按片段（按行）修复：把校验出来的问题映射成"待修行集合"，只让模型重写受影响的那几个片段。
 *
 * 解决的实际问题（用户原话）：
 *   · 「修复就得全量重跑」—— 技能要求修复时**一次性输出完整表**，改 2 行要重抄 100+ 行，回归概率极高；
 *   · 「我都不知道现在重跑有没有拿监督层的建议」—— 修复项由决策层用 ≤100 字转述，丢项无法审计；
 *   · 「有时候修复完还是原来的问题，甚至问题更多」—— 改动面远大于需要改的面，且没有 diff 可查。
 *
 * 做法：
 *   1. 校验结果里的每条问题都带定位（场X/片段Y/镜Z）→ **代码**把它映射到具体片段；
 *   2. 每个受影响片段生成一条**局部修复指令**：只重写这一段，附前后邻接上下文（承接句/景别/时长连坐问题）；
 *   3. 模型只回这一段 → 代码把这一段**拼接回**整表结构（其余片段逐字不动）→ 再校验；
 *   4. 落库仍是整集一次性事务（幂等），所以不会出现"新旧并存"（这正是旧 `track` 语义的病根）。
 *
 * 依赖注入：`callModel` 由调用方传（生产里用技能正文 + 该阶段模型），于是本模块可以离线真跑验证。
 */

import type { ParsedSegment, ParsedStoryboard, ValidateIssue, ValidateResult } from "./storyboardTable";
import { parseStoryboardTable, renderStoryboardTable, validateShots, type ValidateOptions } from "./storyboardTable";

export type RepairTask = {
  segmentIndex: number;
  sceneIndex: number;
  label: string;
  /** 该片段被点名的问题（结构化） */
  issues: ValidateIssue[];
  /** 发给模型的局部修复指令（只重写这一段） */
  prompt: string;
};

export type RepairPlan = {
  tasks: RepairTask[];
  /** 没被点名的片段（这些必须逐字不动） */
  untouched: number[];
  summary: string;
};

const WHERE_RE = /^场(\d+)\/(.+?)(?:\/镜(\d+))?$/;

/** 把一个定位串映射到片段；映射不到返回 null（例如"全文"级错误） */
function locate(parsed: ParsedStoryboard, where: string): ParsedSegment | null {
  const m = where.match(WHERE_RE);
  if (!m) return null;
  const sceneIndex = Number(m[1]);
  const label = m[2].trim();
  return parsed.segments.find((s) => s.sceneIndex === sceneIndex && s.label === label) ?? null;
}

/** 单段落的 markdown（与技能 [输出格式] 一致，供"只重写这一段"的指令里做基线） */
export function renderSegment(seg: ParsedSegment): string {
  const out = [`### ${seg.label}${seg.declaredSec != null ? `（约${seg.declaredSec}s）` : ""}`];
  if (seg.assetNames.length) out.push(`**引用资产名称**：[${seg.assetNames.join(", ")}]`);
  if (seg.assetIds.length) out.push(`**引用资产ID**：[${seg.assetIds.join(", ")}]`);
  out.push("| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |");
  out.push("|------|------|------|------|------|------|------|------|");
  for (const s of seg.shots) out.push(`| ${s.index} | ${s.action} | ${s.duration} | ${s.shotSize} | ${s.camera} | ${s.light} | ${s.dialogue} | ${s.sfx} |`);
  return out.join("\n");
}

export type BuildRepairPlanOptions = {
  /** 用户明确确认要修的问题（原文）；给定时只修这些，避免"顺手改" */
  userConfirmedRules?: string[];
  /** 最多修几个片段（一次修复不要铺太大） */
  maxSegments?: number;
  /** 本集约定块（由代码注入，保证修复时也遵守台词语言等约定） */
  briefBlock?: string;
};

/**
 * 生成修复计划：把 issues 按片段聚合，输出「只重写这一段」的指令。
 */
export function buildRepairPlan(parsed: ParsedStoryboard, validation: ValidateResult, opts: BuildRepairPlanOptions = {}): RepairPlan {
  const tasks: RepairTask[] = [];
  const bySegment = new Map<number, ValidateIssue[]>();

  for (const issue of validation.issues) {
    // 严格模式：用户确认过就只修被确认的那几类规则
    if (opts.userConfirmedRules?.length && !opts.userConfirmedRules.some((r) => issue.rule.includes(r) || issue.message.includes(r))) continue;
    const seg = locate(parsed, issue.where);
    if (!seg) continue;
    const list = bySegment.get(seg.segmentIndex) ?? [];
    list.push(issue);
    bySegment.set(seg.segmentIndex, list);
  }

  const affected = [...bySegment.keys()].sort((a, b) => a - b).slice(0, opts.maxSegments ?? 6);
  for (const idx of affected) {
    const seg = parsed.segments.find((s) => s.segmentIndex === idx)!;
    const issues = bySegment.get(idx)!;
    const prev = parsed.segments.find((s) => s.segmentIndex === idx - 1);
    const next = parsed.segments.find((s) => s.segmentIndex === idx + 1);

    const lines: string[] = [];
    lines.push("你是执行层Agent，请**只重写下面这一个片段**，不要输出整张分镜表、不要输出其它片段。");
    if (opts.briefBlock) lines.push("", opts.briefBlock);
    lines.push("", `## 需要重写的片段（场${seg.sceneIndex} / ${seg.label}）`, "```markdown", renderSegment(seg), "```");
    lines.push("", "## 必须修掉的问题（逐条处理，不得遗漏）");
    issues.forEach((it, i) => lines.push(`${i + 1}. 【${it.rule}】${it.where}：${it.message}`));
    lines.push("", "## 邻接上下文（只读参考，**不要重写**它们，但你的改动不能与它们冲突）");
    if (prev?.shots.length) {
      const last = prev.shots[prev.shots.length - 1];
      lines.push(`- 上一片段（${prev.label}）最后一镜：${last.action}（${last.duration}s / ${last.shotSize} / ${last.camera} / ${last.light}）`);
    } else {
      lines.push("- 这是全片第一个片段，没有上一片段。");
    }
    if (next?.shots.length) {
      const first = next.shots[0];
      lines.push(`- 下一片段（${next.label}）第一镜：${first.action}（${first.duration}s / ${first.shotSize} / ${first.camera} / ${first.light}）`);
    } else {
      lines.push("- 这是全片最后一个片段，没有下一片段。");
    }
    lines.push(
      "",
      "## 输出要求",
      `1. 只输出 ${seg.label} 这一个片段，格式与上面基线完全一致（\`### ${seg.label}（约Ns）\` + 引用资产两行 + 8 列表格）。`,
      "2. 除被点名的问题外，**其余文字逐字保留**（画面描述、台词、音效一个字符都不要动）。",
      "3. 仍然遵守：单镜 ≤8s、片段累计 ≤15s、台词逐字来自剧本原文、引用资产 ID 必须来自本片段已有列表。",
      "4. 不要解释、不要加前后缀。",
    );

    tasks.push({ segmentIndex: idx, sceneIndex: seg.sceneIndex, label: seg.label, issues, prompt: lines.join("\n") });
  }

  const untouched = parsed.segments.filter((s) => !affected.includes(s.segmentIndex)).map((s) => s.segmentIndex);
  const summary = tasks.length
    ? `待修 ${tasks.length} 个片段（共 ${validation.issues.length} 条问题）：` +
      tasks.map((t) => `片段${t.segmentIndex}(${t.issues.length}条)`).join("、") +
      `；其余 ${untouched.length} 个片段逐字不动`
    : "无需修复";

  return { tasks, untouched, summary };
}

/** 把模型返回的"单片段（或修复后拆成的多片段）markdown"解析出来 */
export function parseSegmentReply(reply: string): { ok: boolean; segments: ParsedSegment[]; note: string } {
  const cleaned = reply
    .replace(/```markdown/g, "")
    .replace(/```/g, "")
    .trim();
  const p = parseStoryboardTable(cleaned);
  const segs = p.segments.filter((s) => s.shots.length > 0);
  if (!segs.length) return { ok: false, segments: [], note: `模型回复里没有解析出片段（${cleaned.slice(0, 60)}…）` };
  return { ok: true, segments: segs, note: `解析出 ${segs.length} 个片段 / ${segs.reduce((n, s) => n + s.shots.length, 0)} 镜` };
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnOrdinal(n: number): string {
  if (n <= 10) return CN[n];
  if (n < 20) return "十" + CN[n - 10];
  return String(n);
}

/** 按"场内顺序"重命名片段标签（片段一/二/三…）—— 防止模型重写后出现同名片段，导致后续定位错位 */
export function relabelSegments(parsed: ParsedStoryboard): void {
  for (const scene of parsed.scenes) {
    scene.segments.forEach((seg, i) => (seg.label = `片段${cnOrdinal(i + 1)}`));
  }
  parsed.segments.forEach((seg) => {
    const scene = parsed.scenes.find((s) => s.index === seg.sceneIndex);
    const i = scene ? scene.segments.indexOf(seg) : -1;
    if (i >= 0) seg.label = `片段${cnOrdinal(i + 1)}`;
  });
}

/**
 * 把重写好的片段**拼接回**整表（其余片段逐字不动）。
 *
 * ⚠ 支持「1 个片段 → 多个片段」：修复超长片段的正确做法是切分，而不是把时长硬压下去
 * （硬压会违反台词时长换算与"台词零删改"）。切分后下游片段序号会顺移，这里统一重建 + 重新编号。
 */
export function applySegmentRewrite(parsed: ParsedStoryboard, segmentIndex: number, reply: string): { ok: boolean; parsed: ParsedStoryboard; note: string } {
  const r = parseSegmentReply(reply);
  if (!r.ok) return { ok: false, parsed, note: r.note };
  const target = parsed.segments.find((s) => s.segmentIndex === segmentIndex);
  if (!target) return { ok: false, parsed, note: `找不到片段 ${segmentIndex}` };

  // 规范性重建：逐场逐片段渲染，命中目标的位置换成模型给的那 1..k 个片段
  const parts: string[] = [];
  for (const scene of parsed.scenes) {
    parts.push(`## 场${scene.index}：${scene.title}${scene.cast.length ? ` ｜ 参演角色：${scene.cast.join("、")}` : ""}`);
    parts.push("");
    for (const seg of scene.segments) {
      const list = seg.segmentIndex === segmentIndex ? r.segments : [seg];
      for (const s of list) parts.push(renderSegment(s));
      parts.push("  ");
    }
  }
  const rebuilt = parseStoryboardTable(parts.join("\n"));
  relabelSegments(rebuilt);
  return { ok: true, parsed: rebuilt, note: `已替换片段${segmentIndex} → ${r.segments.length} 个片段（${r.note}）` };
}

export type RepairRound = {
  segmentIndex: number;
  ok: boolean;
  note: string;
  errorsBefore: number;
  errorsAfter: number;
};

/**
 * 代码驱动的修复闭环：定位 → 逐个片段问模型 → 拼接回去 → 重新校验。
 * `callModel(prompt)` 由调用方注入（生产里用阶段4 的技能正文 + 该阶段模型）。
 */
export async function repairSegments(
  parsed: ParsedStoryboard,
  validation: ValidateResult,
  deps: {
    callModel: (prompt: string) => Promise<string>;
    validateOptions?: ValidateOptions;
    briefBlock?: string;
    maxRounds?: number;
    maxSegments?: number;
  },
): Promise<{ parsed: ParsedStoryboard; validation: ValidateResult; rounds: RepairRound[]; plan: RepairPlan }> {
  const plan = buildRepairPlan(parsed, validation, { briefBlock: deps.briefBlock, maxSegments: deps.maxSegments });
  let current = parsed;
  let currentValidation = validation;
  const rounds: RepairRound[] = [];

  for (const task of plan.tasks) {
    const errorsBefore = currentValidation.errors.length;
    let note = "";
    let ok = false;
    try {
      const reply = await deps.callModel(task.prompt);
      const applied = applySegmentRewrite(current, task.segmentIndex, reply);
      if (applied.ok) {
        // 只有"改完之后确实更好"才采纳：错误数不能变多
        const after = validateShots(applied.parsed, deps.validateOptions);
        if (after.errors.length <= errorsBefore) {
          current = applied.parsed;
          currentValidation = after;
          ok = true;
          note = `${applied.note}；错误 ${errorsBefore} → ${after.errors.length}`;
        } else {
          note = `${applied.note}，但错误数反而升到 ${after.errors.length}，已丢弃该次修复`;
        }
      } else {
        note = applied.note;
      }
    } catch (e: any) {
      note = `调用模型失败：${e?.message ?? e}`;
    }
    rounds.push({ segmentIndex: task.segmentIndex, ok, note, errorsBefore, errorsAfter: currentValidation.errors.length });
  }

  return { parsed: current, validation: currentValidation, rounds, plan };
}
