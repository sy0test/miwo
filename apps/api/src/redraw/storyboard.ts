/**
 * 转绘分镜层（M3-T12）：prompt 拼装 + 输出解析 + 校验。
 *
 * ── 解析器不要重写（R1-G9）──
 * 表格主体复用生产链的 `utils/shots/storyboardTable.ts`（`parseStoryboardTable`），
 * videoDesc 也复用它的 `buildSegmentVideoDesc`（"承接上镜：…" + 管道表格行）——
 * 生产 v2 与转绘层写出**同一种形状**，下游 seedance 模板只认这一种。
 * 本文件只补转绘特有的三件事：
 *   ① 解析 `<redrawStoryboard>` / `<changeSummary>` 两块；
 *   ② 按转绘规则校验（段时长区间、镜和=段头、资产名必须在已确认清单里）；
 *   ③ 把 `ParsedStoryboard` 适配成 `RedrawSegmentPlan[]`（写入层要的形状）。
 *
 * 校验失败抛 `StoryboardValidationError`（422）——可重试一次由 job 层决定，不在这里重试。
 */
import fs from "node:fs";
import path from "node:path";
import { extractBlock } from "@/utils/redraw";
import { buildSegmentVideoDesc, parseStoryboardTable, type ParsedSegment, type ParsedStoryboard, type ParsedShot } from "@/utils/shots/storyboardTable";
import { RedrawHttpError } from "@/redraw/http";
import u from "@/utils";

/** 分镜层输出不合格（422）。消息里要带**能改的点**（第几段、哪条资产、差多少秒）。 */
export class StoryboardValidationError extends RedrawHttpError {
  constructor(message: string) {
    super(422, message);
    this.name = "StoryboardValidationError";
  }
}

/** 一个待写入的片段（写入层直接消费）。 */
export type RedrawSegmentPlan = {
  /** 全片连续 1..N */
  segmentIndex: number;
  sceneIndex: number;
  sceneTitle: string;
  label: string;
  /** 段内镜时长之和（= 声称的段时长） */
  duration: number;
  /** 段头声明的秒数（用于核对 duration） */
  declaredSec: number | null;
  shots: ParsedShot[];
  assetNames: string[];
  /** 已确认资产里解析出的 ID（顺序与 assetNames 对齐，缺的为 null） */
  assetIds: number[];
  /** 管道格式 videoDesc（生产 v2 同款） */
  videoDesc: string;
};

export type ParsedRedrawOutput = {
  parsed: ParsedStoryboard;
  changes: string[];
  /** 段落之外的其他文本（排查用；不写入） */
  raw: string;
};

const SKILL_DIR = ["skills", "feicai", "redraw-storyboard-skill"];

/** 读技能正文（首次调用缓存；技能文件随包发布，不会在运行期变）。 */
let skillCache: string | null = null;
export function loadStoryboardSkill(): string {
  if (skillCache !== null) return skillCache;
  skillCache = fs.readFileSync(u.getPath([...SKILL_DIR, "SKILL.md"]), "utf8");
  return skillCache;
}

/** 从 `<changeSummary>` 里抠出每条 `- xxx`（容忍 `*` / `·` 开头与编号）。 */
export function parseChangeSummary(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:[-*●·]|\d+[.)、])\s*(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
    else if (!/^<\/?changeSummary>/.test(line)) out.push(line.replace(/^#+\s*/, "").trim());
  }
  return out.filter(Boolean);
}

/** 解析模型回复：两块缺一 → 422。 */
export function parseStoryboardOutput(reply: string): ParsedRedrawOutput {
  const text = String(reply ?? "");
  const boardBlock = extractBlock(text, "redrawStoryboard");
  const changeBlock = extractBlock(text, "changeSummary");
  const missing = [!boardBlock && "<redrawStoryboard>", !changeBlock && "<changeSummary>"].filter(Boolean).join(" ");
  if (missing) throw new StoryboardValidationError("模型回复里缺块：" + missing + "（回复 " + text.length + " 字符）");
  const parsed = parseStoryboardTable(boardBlock!);
  const changes = parseChangeSummary(changeBlock);
  if (!changes.length) throw new StoryboardValidationError("<changeSummary> 里没有任何变更条目（每条以 - 开头）");
  return { parsed, changes, raw: text };
}

export type ValidateRedrawOptions = {
  /** 项目单段上限（秒） */
  segmentCap: number;
  /** 已确认资产：目标国名 → assetId */
  confirmedAssets: Map<string, number>;
  /** 模型能力上限（seedance 2.0 = 15 / 2.5 = 30）；缺省 = segmentCap */
  modelMaxSec?: number;
  /** 镜数上限（视频模型单条最多 3 个参考视频） */
  maxShotsPerSegment?: number;
};

/** 校验并转成写入计划。任何不合格都抛 422（消息里逐条列清楚）。 */
export function validateRedrawStoryboard(parsed: ParsedStoryboard, opts: ValidateRedrawOptions): RedrawSegmentPlan[] {
  const problems: string[] = [];
  if (parsed.errors?.length) for (const e of parsed.errors) problems.push(e.message);
  if (!parsed.segments.length) problems.push("没有解析出任何片段");

  const cap = Math.max(4, Math.min(Number(opts.segmentCap) || 15, Number(opts.modelMaxSec ?? opts.segmentCap) || 15));
  const maxShots = opts.maxShotsPerSegment ?? 3;
  const plans: RedrawSegmentPlan[] = [];

  for (const seg of parsed.segments) {
    const where = "第 " + seg.segmentIndex + " 段（" + (seg.label || "未命名") + "）";
    if (!seg.shots.length) {
      problems.push(where + " 没有镜");
      continue;
    }
    if (seg.shots.length > maxShots) problems.push(where + " 有 " + seg.shots.length + " 个镜，超过单段上限 " + maxShots + " 个");
    const duration = seg.shots.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0);
    if (seg.declaredSec === null) problems.push(where + " 的段头没写秒数（格式：### 片段一（约11s））");
    else if (Math.abs(duration - seg.declaredSec) > 0.1) {
      problems.push(where + " 段头写 " + seg.declaredSec + "s，镜时长之和是 " + Math.round(duration * 1000) / 1000 + "s（差 >0.1s）");
    }
    if (duration < 4) problems.push(where + " 时长 " + duration + "s 小于下限 4s");
    if (duration > cap) problems.push(where + " 时长 " + duration + "s 超过单段上限 " + cap + "s");

    const unknown = seg.assetNames.filter((n) => !opts.confirmedAssets.has(n));
    if (unknown.length) problems.push(where + " 引用了未确认/不存在的资产：" + unknown.join("、") + "（只能用已确认资产名）");

    for (const shot of seg.shots) {
      if (!Number.isFinite(shot.duration) || shot.duration <= 0) problems.push(where + " 的镜 " + shot.index + " 时长非法：" + shot.duration);
    }

    plans.push({
      segmentIndex: seg.segmentIndex,
      sceneIndex: seg.sceneIndex,
      sceneTitle: seg.sceneTitle,
      label: seg.label,
      duration: Math.round(duration * 1000) / 1000,
      declaredSec: seg.declaredSec,
      shots: seg.shots,
      assetNames: [...seg.assetNames],
      assetIds: seg.assetNames.map((n) => opts.confirmedAssets.get(n) ?? 0),
      // 管道格式：生产 v2 同款（G9/D6）。buildSegmentVideoDesc 处理好「承接上镜」与表格行。
      videoDesc: "",
    });
  }

  if (problems.length) throw new StoryboardValidationError("转绘分镜校验失败（" + problems.length + " 项）：\n" + problems.join("\n"));
  return plans;
}

/** 给写入层补 videoDesc（需要整份 parsed 才能算"承接上镜"）。 */
export function attachVideoDesc(plans: RedrawSegmentPlan[], parsed: ParsedStoryboard): RedrawSegmentPlan[] {
  const byIndex = new Map<number, ParsedSegment>(parsed.segments.map((s) => [s.segmentIndex, s]));
  return plans.map((p) => {
    const seg = byIndex.get(p.segmentIndex);
    return { ...p, videoDesc: seg ? (buildSegmentVideoDescSafe(parsed, seg)) : "" };
  });
}

/** 包一层：解析器内部若因缺列抛错，也不能把整份产出毁掉（返回空串，校验层已报过格）。 */
function buildSegmentVideoDescSafe(parsed: ParsedStoryboard, seg: ParsedSegment): string {
  try {
    return buildSegmentVideoDesc(parsed, seg);
  } catch {
    return "";
  }
}

/** 源片分镜（DB 里的段/镜）→ 给模型看的 markdown 表文本。 */
export function renderSourceStoryboard(
  segments: Array<{ segmentIndex: number; sceneIndex: number; sceneTitle: string; duration: number; sourceRange?: string | null }>,
  shots: Array<{ segmentIndex: number; shotIndex: number; duration: number; shotSize: string; camera: string; light: string; action: string; dialogue: string; sfx: string; sourceRange?: string | null }>,
  assetNamesBySegment: Map<number, string[]>,
): string {
  const lines: string[] = [];
  let lastScene = -1;
  for (const seg of segments) {
    if (seg.sceneIndex !== lastScene) {
      lines.push("## 场" + seg.sceneIndex + "：" + (seg.sceneTitle || "未命名"));
      lastScene = seg.sceneIndex;
    }
    lines.push("### 片段" + seg.segmentIndex + "（约" + Math.round(seg.duration) + "s）  源片区间：" + (seg.sourceRange || "未知"));
    const names = assetNamesBySegment.get(seg.segmentIndex) ?? [];
    if (names.length) lines.push("**引用资产名称**：[" + names.join(", ") + "]");
    lines.push("| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |");
    lines.push("|------|------|------|------|------|------|------|------|");
    for (const s of shots.filter((x) => x.segmentIndex === seg.segmentIndex)) {
      const esc = (v: string) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      lines.push("| " + s.shotIndex + " | " + esc(s.action || "（见源片）") + " | " + s.duration + " | " + esc(s.shotSize) + " | " + esc(s.camera) + " | " + esc(s.light) + " | " + esc(s.dialogue || "无台词") + " | " + esc(s.sfx) + " |");
    }
    lines.push("");
  }
  return lines.join("\n");
}

export type StoryboardPromptInput = {
  projectName: string;
  targetCountry: string;
  artStyle?: string | null;
  segmentCap: number;
  scriptContent: string;
  directorPlan: string;
  sourceStoryboard: string;
  confirmedAssets: Array<{ id: number; name: string; type: string; describe?: string | null }>;
};

/** 拼 prompt：system = 技能正文；user = 本次输入（项目/资产/剧本/导演计划/源片分镜/约束）。 */
export function buildStoryboardPrompt(input: StoryboardPromptInput, opts: { system?: string } = {}): { system: string; user: string } {
  const assets = input.confirmedAssets
    .map((a) => "- [" + a.id + "] " + a.name + "（" + a.type + "）" + (a.describe ? "：" + a.describe : ""))
    .join("\n");
  const user = [
    "## 项目配置",
    "- 项目：" + input.projectName,
    "- 目标国家：" + input.targetCountry,
    "- 视觉风格：" + (input.artStyle?.trim() || "未指定"),
    "- 单段上限：" + input.segmentCap + "s（每段时长必须 4.." + input.segmentCap + "s）",
    "",
    "## 已确认资产（引用名称与 ID 只能从这里取）",
    assets || "（无 —— 先完成资产认账，不要新造资产）",
    "",
    "## 用户改过的剧本",
    input.scriptContent.trim() || "（未改）",
    "",
    "## 导演计划（目标国适配策略）",
    input.directorPlan.trim() || "（无）",
    "",
    "## 源片分镜（它的段/镜结构、动作与台词是改编基础）",
    input.sourceStoryboard,
    "",
    "按 [输出格式] 输出 <redrawStoryboard> 与 <changeSummary> 两块。",
  ].join("\n");
  // system = 技能正文；测试可注入（技能文件在 MIWO_DATA_DIR/skills 下，测试库不播种它）
  return { system: opts.system ?? loadStoryboardSkill(), user };
}