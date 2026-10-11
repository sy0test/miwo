/**
 * 监督层结构化输出（阶段1 补强项）
 *
 * 为什么需要：监督层的报告是**自由文本**，散在里面的"哪一场哪一镜有问题"没法被代码用：
 *   · 决策层只能拿一段总结去转述 → 丢项、无审计；
 *   · 修复环节定位不到行 → 只能整表重跑（"修复完还是原来的问题"的来源之一）。
 *
 * 做法（不重写技能正文，由代码追加一段**输出契约**）：
 *   报告末尾追加 `<issues>` 块，一行一条：
 *     - [规则] 场X/片段Y/镜Z：说明
 *   代码解析这个块 → 把 `场X/片段Y/镜Z` 映射到 `o_segment`/`o_shot` 的**行 id** →
 *   写进工作区（`productionIssues`）供审计与下游（按行修复/决策层）使用。
 *
 * 不 import 任何 `@/` 模块 → 可用 `docs/tools/*.cjs` 离线确定性验证。
 */

export type SupervisionIssue = {
  rule: string;
  where: string;
  message: string;
  /** 由 locateSupervisionIssue 回填 */
  sceneIndex?: number;
  segmentIndex?: number;
  segmentId?: number;
  shotIndex?: number;
  shotId?: number;
  matched?: boolean;
};

/** 追加给监督层的输出契约（代码注入，不依赖技能正文改动） */
export function buildIssuesInstruction(): string {
  return [
    "## [结构化问题清单（必须输出，代码要解析）]",
    "在报告的最后，追加一段 `<issues>` 块，**一行一条**问题，格式严格如下：",
    "```",
    "<issues>",
    "- [规则名] 场X/片段Y/镜Z：一句说明（哪条铁律被违反、要怎么改）",
    "- [规则名] 场X/片段Y：片段级问题",
    "</issues>",
    "```",
    "- `场X` 用阿拉伯数字（如 `场1`）；`片段Y` 用中文数字（如 `片段三`）；`镜Z` 用该片段内的镜序号（阿拉伯数字，可省略表示片段级问题）。",
    "- 一条问题一行，不要换行、不要嵌套列表、不要加别的符号。",
    "- **没有问题时输出空块** `<issues></issues>`，不要省略这个块。",
    "- 这个块是给代码读的，不要在里面写解释性段落。",
  ].join("\n");
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字 → 阿拉伯（支持 一..二十 与 "十二" 这种写法） */
export function cnToNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (t === "十") return 10;
  if (t.startsWith("十")) return 10 + (CN_NUM[t.slice(1)] ?? 0);
  if (t.includes("十")) {
    const [a, b] = t.split("十");
    return (CN_NUM[a] ?? 1) * 10 + (b ? (CN_NUM[b] ?? 0) : 0);
  }
  return CN_NUM[t] ?? null;
}

/**
 * 解析 `<issues>` 块。
 * 容错：全角/半角括号与冒号、`-`/`*`/`1.` 前缀、`【规则】` 写法、行内多余空白。
 */
export function parseIssueList(text: string): { ok: boolean; issues: SupervisionIssue[]; raw: string } {
  const m = text.match(/<issues>([\s\S]*?)<\/issues>/);
  if (!m) return { ok: false, issues: [], raw: "" };
  const raw = m[1];
  const issues: SupervisionIssue[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 前缀：- * • 1. 1、
    const body = t.replace(/^[-*•]\s*/, "").replace(/^\d+[.、)]\s*/, "").trim();
    if (!body) continue;
    const mm = body.match(/^[\[【]\s*([^\]】]+?)\s*[\]】]\s*(.+)$/);
    if (!mm) continue;
    const rule = mm[1].trim();
    const rest = mm[2].trim();
    // 位置与说明之间：第一个 ：或 :
    const idx = rest.search(/[：:]/);
    const where = (idx >= 0 ? rest.slice(0, idx) : rest).trim();
    const message = idx >= 0 ? rest.slice(idx + 1).trim() : "";
    if (!where) continue;
    issues.push({ rule, where, message });
  }
  return { ok: true, issues, raw };
}

/** 从 `场1/片段三/镜2` 里拆出 场序 / 片段序号（中文或阿拉伯）/ 镜序 */
export function parseWhere(where: string): { sceneIndex?: number; segOrdinal?: number; shotIndex?: number } {
  const out: { sceneIndex?: number; segOrdinal?: number; shotIndex?: number } = {};
  const scene = where.match(/场\s*(\d+)/);
  if (scene) out.sceneIndex = Number(scene[1]);
  const seg = where.match(/片段\s*([一二三四五六七八九十百\d]+)/);
  if (seg) {
    const n = cnToNumber(seg[1]);
    if (n != null) out.segOrdinal = n;
  }
  const shot = where.match(/镜\s*(\d+)/);
  if (shot) out.shotIndex = Number(shot[1]);
  return out;
}

/**
 * 把 issue 映射到具体的片段/镜**行 id**。
 *
 * 口径：`片段Y` 是"该场内的第 Y 个片段"（与分镜表里 `### 片段Y` 的写法一致），
 * 所以用 `sceneIndex` 过滤 + 场内顺序定位；镜用片段内 `shotIndex`。
 */
export function locateSupervisionIssue(
  issue: SupervisionIssue,
  rows: { segments: any[]; shots: any[] },
): SupervisionIssue {
  const { sceneIndex, segOrdinal, shotIndex } = parseWhere(issue.where);
  // 先默认"没定位到"：这样调用方拿到的永远是真布尔，不用区分 undefined/false
  const out: SupervisionIssue = { ...issue, sceneIndex, shotIndex, matched: false };
  if (sceneIndex != null && segOrdinal != null) {
    const inScene = rows.segments.filter((s) => Number(s.sceneIndex) === sceneIndex).sort((a, b) => Number(a.segmentIndex) - Number(b.segmentIndex));
    const seg = inScene[segOrdinal - 1];
    if (seg) {
      out.segmentId = Number(seg.id);
      out.segmentIndex = Number(seg.segmentIndex);
      if (shotIndex != null) {
        const shot = rows.shots.find((s) => Number(s.segmentId) === Number(seg.id) && Number(s.shotIndex) === shotIndex);
        if (shot) out.shotId = Number(shot.id);
        out.matched = out.shotId != null;
      } else {
        out.matched = true;
      }
    }
  }
  return out;
}

/** 批量定位 + 统计（给日志/工作区用） */
export function locateAll(issues: SupervisionIssue[], rows: { segments: any[]; shots: any[] }): { located: SupervisionIssue[]; matched: number; unmatched: number } {
  const located = issues.map((i) => locateSupervisionIssue(i, rows));
  const matched = located.filter((i) => i.matched).length;
  return { located, matched, unmatched: located.length - matched };
}
