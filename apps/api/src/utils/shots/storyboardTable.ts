/**
 * 分镜表文本 → 结构化（解析 + 体检 + videoDesc 生成）
 *
 * 为什么要有这个文件：现在 `productionAgent` 的阶段4 把整张分镜表当**一段 markdown 文本**
 * 存进 `o_agentWorkData.data.storyboardTable`，代码从不解析它 —— 于是「数量/时长/绑定/台词」
 * 全部只能靠模型自检（技能里那句「条数必须等于写入单位数」只是提示词，没有代码兜底）。
 * 本模块把那段文本变成**结构化数据**，让代码来负责格式契约与校验。
 *
 * 输入契约（现行分镜表格式，见 data/skills/production_execution_storyboard_table.md 的 [输出格式]）：
 *
 *   ## 场1：场景名 ｜ 参演角色：A、B
 *   ### 片段一（约12s）
 *   **引用资产名称**：[夜间礼堂, 莫拉·奎因]
 *   **引用资产ID**：[87, 17]
 *   | 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |
 *   |------|------|------|------|------|------|------|------|
 *   | 1 | …… | 4 | 全景 | 缓慢前移 | 深夜冷暗…… | Moira says: "…" | 音效：…… |
 *
 * 设计取舍：
 * 1. **按表头名映射列**，不靠位置 —— 模型偶尔会调整列顺序或加列（如把 `引用资产ID` 放进表里）。
 * 2. **解析失败不抛异常，全部进 errors/warnings** —— 调用方（agent）要能「指出第几场第几镜不对」
 *    而不是整段崩掉。
 * 3. **纯函数、不碰数据库、不 import 任何 `@/` 模块** —— 这样仓库外的脚本可以直接拿真实
 *    分镜表当夹具回归（见 docs/tools/verify-shots.cjs）。
 */

// ============================================================
// 类型
// ============================================================

export type ParsedShot = {
  /** 片段内的镜序（表里的「序号」列），1 起 */
  index: number;
  duration: number;
  shotSize: string;
  camera: string;
  light: string;
  action: string;
  dialogue: string;
  sfx: string;
  /** 镜级资产 ID（表里有该列时才有内容；否则用片段的） */
  assetIds: number[];
  /** 该行原始 markdown（videoDesc 的「行原文」就是它） */
  raw: string;
  line: number;
};

export type ParsedSegment = {
  /** 全片连续片段序号，1 起 —— 也是「生成单位」的口径 */
  segmentIndex: number;
  /** 场内的片段序号，1 起 */
  sceneSegmentIndex: number;
  /** 片段名（片段一 / 片段二…），仅用于展示与报错定位 */
  label: string;
  /** 片段头里声明的秒数（`### 片段一（约12s）`），没有则为 null */
  declaredSec: number | null;
  /** 场级 */
  sceneIndex: number;
  sceneTitle: string;
  sceneCast: string[];
  /** 片段级引用资产（技能要求写在片段头下面两行） */
  assetIds: number[];
  assetNames: string[];
  shots: ParsedShot[];
  line: number;
};

export type ParsedScene = {
  index: number;
  title: string;
  cast: string[];
  segments: ParsedSegment[];
  line: number;
};

export type ParsedStoryboard = {
  scenes: ParsedScene[];
  /** 扁平化后的全部片段（顺序即写入顺序） */
  segments: ParsedSegment[];
  /** 扁平化后的全部镜 */
  shots: ParsedShot[];
  warnings: string[];
  /** 结构级错误（无法进入校验阶段的那些） */
  errors: ValidateIssue[];
};

export type ValidateOptions = {
  /** 单镜时长上限（技能铁律2：8s） */
  maxShotSec?: number;
  /** 片段累计时长上限（技能铁律2：15s） */
  maxSegmentSec?: number;
  /** 允许的时长误差（浮点/模型取整），默认 0.01 */
  tolerance?: number;
  /** 资产库现有的合法 ID 集合；给了就校验「引用了不存在的资产」 */
  validAssetIds?: Set<number>;
  /** 剧本正文；给了就校验台词是否能在原文里逐字命中 */
  scriptContent?: string;
  /** 是否强制校验台词来源（默认：有 scriptContent 且 brief.dialogueSource === "script-original" 时开启） */
  requireDialogueFromScript?: boolean;
  /** 严格模式：把 warnings 也当失败 */
  strict?: boolean;
};

export type ValidateIssue = {
  level: "error" | "warning";
  /** 定位：场X / 片段Y / 镜Z（能给到哪一级就给到哪一级） */
  where: string;
  rule: string;
  message: string;
};

export type ValidateResult = { ok: boolean; issues: ValidateIssue[]; errors: ValidateIssue[]; warnings: ValidateIssue[] };

// ============================================================
// 小工具
// ============================================================

/** 全角 → 半角（只处理解析关心的符号），并把连续空白折叠 */
function normalizeLine(line: string): string {
  return line
    .replace(/［/g, "[")
    .replace(/］/g, "]")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/，/g, ",")
    .replace(/\u3000/g, " ")
    .replace(/\t/g, " ");
}

/** 站内列名 → 规范字段名。容忍空格、大小写、全角冒号 */
const HEADER_ALIAS: Record<string, keyof ParsedShot | "assetIds" | "assetNames" | "_ignore"> = {
  序号: "index",
  镜号: "index",
  index: "index",
  画面描述: "action",
  描述: "action",
  画面: "action",
  时长: "duration",
  时间: "duration",
  景别: "shotSize",
  运镜: "camera",
  镜头运动: "camera",
  光影氛围: "light",
  光影: "light",
  台词: "dialogue",
  对白: "dialogue",
  音效: "sfx",
  声音: "sfx",
  引用资产id: "assetIds",
  资产id: "assetIds",
  引用资产名称: "assetNames",
  资产名称: "assetNames",
};

function headerKey(cell: string): keyof ParsedShot | "assetIds" | "assetNames" | "_ignore" {
  const k = normalizeLine(cell).replace(/\*+/g, "").replace(/\s+/g, "").toLowerCase();
  return HEADER_ALIAS[k] ?? "_ignore";
}

function num(text: string): number {
  const m = normalizeLine(text).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function splitCells(line: string): string[] {
  const t = line.trim();
  const inner = t.startsWith("|") ? t.slice(1) : t;
  const body = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return body.split("|").map((c) => c.trim());
}

const isSeparatorRow = (line: string) => /^\s*\|?[\s:\-|]+\|?\s*$/.test(line) && line.includes("-");
const isTableRow = (line: string) => line.trim().startsWith("|");

// ============================================================
// 解析
// ============================================================

const SCENE_RE = /^\s*##\s*场\s*(\d+)\s*[：:]\s*(.+?)\s*$/;
const SEGMENT_RE = /^\s*###\s*(片段\s*[^\s（(]*)\s*(?:[（(]\s*约?\s*([\d.]+)\s*s?\s*[)）])?/;
const ASSET_NAME_RE = /^\s*\*{0,2}引用资产名称\*{0,2}\s*[：:]\s*(.+?)\s*$/;
const ASSET_ID_RE = /^\s*\*{0,2}引用资产ID\*{0,2}\s*[：:]\s*(.+?)\s*$/i;

/** 场头里 `｜ 参演角色：A、B` 的抽取 */
function splitSceneHeader(raw: string): { title: string; cast: string[] } {
  const parts = normalizeLine(raw).split(/\s*[｜|]\s*/);
  let title = parts[0] ?? "";
  let cast: string[] = [];
  for (const p of parts.slice(1)) {
    const m = p.match(/参演角色\s*[：:]\s*(.*)$/);
    if (m) cast = m[1].split(/[、,]/).map((s) => s.trim()).filter(Boolean);
  }
  return { title: title.trim(), cast };
}

function parseAssetLine(body: string): string[] {
  const t = body.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  return t.split(/[、,]/).map((s) => s.trim()).filter((s) => s && s !== "无");
}

export function parseStoryboardTable(text: string | null | undefined): ParsedStoryboard {
  const out: ParsedStoryboard = { scenes: [], segments: [], shots: [], warnings: [], errors: [] };
  if (!text || !text.trim()) {
    out.errors.push({ level: "error", where: "全文", rule: "非空", message: "分镜表文本为空" });
    return out;
  }

  const lines = text.split(/\r?\n/);
  let scene: ParsedScene | null = null;
  let segment: ParsedSegment | null = null;
  let nextSegmentIndex = 1;
  let sceneSegCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = normalizeLine(raw);
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ---- 场头 ----
    const sm = trimmed.match(SCENE_RE);
    if (sm) {
      const { title, cast } = splitSceneHeader(sm[2]);
      scene = { index: Number(sm[1]), title, cast, segments: [], line: i + 1 };
      out.scenes.push(scene);
      segment = null;
      sceneSegCounter = 0;
      continue;
    }

    // ---- 片段头 ----
    const gm = trimmed.match(SEGMENT_RE);
    if (gm) {
      if (!scene) {
        out.warnings.push(`第 ${i + 1} 行出现「### 片段」但还没有「## 场」标题，已按虚拟场1归入`);
        scene = { index: 1, title: "", cast: [], segments: [], line: i + 1 };
        out.scenes.push(scene);
      }
      sceneSegCounter += 1;
      segment = {
        segmentIndex: nextSegmentIndex++,
        sceneSegmentIndex: sceneSegCounter,
        label: gm[1].replace(/\s+/g, ""),
        declaredSec: gm[2] != null ? Number(gm[2]) : null,
        sceneIndex: scene.index,
        sceneTitle: scene.title,
        sceneCast: scene.cast,
        assetIds: [],
        assetNames: [],
        shots: [],
        line: i + 1,
      };
      scene.segments.push(segment);
      out.segments.push(segment);
      continue;
    }

    // ---- 引用资产两行 ----
    const an = trimmed.match(ASSET_NAME_RE);
    if (an && segment) {
      segment.assetNames = parseAssetLine(an[1]);
      continue;
    }
    const ai = trimmed.match(ASSET_ID_RE);
    if (ai && segment) {
      segment.assetIds = parseAssetLine(ai[1])
        .map((s) => Number(s.replace(/[^\d-]/g, "")))
        .filter((n) => !Number.isNaN(n));
      continue;
    }

    // ---- 表格 ----
    if (isTableRow(line) && segment) {
      if (isSeparatorRow(line)) continue;
      const headerCells = splitCells(line);
      const mapped = headerCells.map(headerKey);
      const isHeader = mapped.filter((m) => m !== "_ignore").length >= 3;
      if (isHeader) {
        // 表头后的数据行：按列名映射，直到不再是表格行
        let j = i + 1;
        let rowNo = 0;
        for (; j < lines.length; j++) {
          const rowLine = normalizeLine(lines[j]);
          if (!isTableRow(rowLine)) break;
          if (isSeparatorRow(rowLine)) continue;
          rowNo += 1;
          const cells = splitCells(rowLine);
          const shot: ParsedShot = {
            index: rowNo,
            duration: NaN,
            shotSize: "",
            camera: "",
            light: "",
            action: "",
            dialogue: "",
            sfx: "",
            assetIds: [],
            raw: lines[j].trim(),
            line: j + 1,
          };
          let surplus = "";
          for (let c = 0; c < cells.length; c++) {
            const key = mapped[c] ?? "_ignore";
            const value = cells[c] ?? "";
            if (c >= headerCells.length - 1 && cells.length > headerCells.length) surplus = cells.slice(headerCells.length - 1).join(" | ");
            switch (key) {
              case "index": {
                const n = num(value);
                if (!Number.isNaN(n)) shot.index = n;
                break;
              }
              case "action":
                shot.action = value;
                break;
              case "duration":
                shot.duration = num(value);
                break;
              case "shotSize":
                shot.shotSize = value;
                break;
              case "camera":
                shot.camera = value;
                break;
              case "light":
                shot.light = value;
                break;
              case "dialogue":
                shot.dialogue = value;
                break;
              case "sfx":
                shot.sfx = value;
                break;
              case "assetIds":
                shot.assetIds = parseAssetLine(value)
                  .map((s) => Number(s.replace(/[^\d-]/g, "")))
                  .filter((n) => !Number.isNaN(n));
                break;
              case "assetNames":
                break;
              default:
                break;
            }
          }
          if (surplus) {
            // 单元格里混进了裸 `|`（例如台词里带了竖线）：把多出来的拼回最后一列，并记一条警告
            shot.sfx = surplus;
            out.warnings.push(`第 ${j + 1} 行（${segment.label}）第 ${rowNo} 镜的列数多于表头，已把多余内容并入最后一列`);
          }
          if (!shot.assetIds.length && segment.assetIds.length) shot.assetIds = [...segment.assetIds];
          segment.shots.push(shot);
          out.shots.push(shot);
        }
        i = j - 1;
        continue;
      }
      out.warnings.push(`第 ${i + 1} 行看起来是表格行，但既不是表头也不是数据行（已忽略）`);
      continue;
    }

    // 表格数据行在没有表头时会落到这里 —— 记为警告，避免静默丢数据
    if (isTableRow(line) && !segment) {
      out.warnings.push(`第 ${i + 1} 行是表格行，但还没有「### 片段」标题（已忽略）`);
    }
  }

  if (!out.segments.length) out.errors.push({ level: "error", where: "全文", rule: "结构", message: "没有解析出任何「### 片段」" });
  if (!out.shots.length) out.errors.push({ level: "error", where: "全文", rule: "结构", message: "没有解析出任何镜头行" });
  return out;
}

// ============================================================
// 校验（确定性规则，全部由代码判定）
// ============================================================

/** 台词比对用的归一化：去掉换行/多余空白与引号样式差异 */
function normalizeDialogue(s: string): string {
  return s
    .replace(/[\u201c\u201d\u2018\u2019"'「」『』]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 从剧本正文里抽出全部引号内内容，用于「台词是否来自剧本原文」的比对 */
export function extractScriptLines(content: string): string[] {
  const out: string[] = [];
  const re = /[\u201c\u201d"「」『』]([^\u201c\u201d"「」『』]{1,200})[\u201c\u201d"「」『』]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

export function validateShots(parsed: ParsedStoryboard, opts: ValidateOptions = {}): ValidateResult {
  const maxShot = opts.maxShotSec ?? 8;
  const maxSeg = opts.maxSegmentSec ?? 15;
  const tol = opts.tolerance ?? 0.01;
  const issues: ValidateIssue[] = [];

  const sceneSeen = new Set<number>();
  let expectScene = 1;

  const scriptLines = opts.scriptContent ? extractScriptLines(opts.scriptContent).map(normalizeDialogue) : [];
  const requireDialogue = opts.requireDialogueFromScript ?? false;

  for (const scene of parsed.scenes) {
    if (sceneSeen.has(scene.index)) issues.push({ level: "error", where: `场${scene.index}`, rule: "场号唯一", message: `场号 ${scene.index} 重复` });
    sceneSeen.add(scene.index);
    if (scene.index !== expectScene) {
      issues.push({ level: "warning", where: `场${scene.index}`, rule: "场号连续", message: `场号从 ${expectScene} 跳到 ${scene.index}` });
      expectScene = scene.index;
    }
    expectScene += 1;

    for (const seg of scene.segments) {
      const where = `场${seg.sceneIndex}/${seg.label}`;
      if (!seg.shots.length) issues.push({ level: "error", where, rule: "片段至少一镜", message: "该片段没有任何镜头行" });
      if (!seg.assetIds.length) {
        issues.push({ level: "error", where, rule: "资产绑定非空", message: "片段没有「引用资产ID」（写入端会得到空绑定）" });
      }
      if (opts.validAssetIds) {
        const bad = seg.assetIds.filter((id) => !opts.validAssetIds!.has(id));
        if (bad.length) issues.push({ level: "error", where, rule: "资产必须存在", message: `引用了不存在的资产 ID：${bad.join(", ")}` });
      }

      let segSum = 0;
      let prevShotIndex: number | null = null;
      for (const shot of seg.shots) {
        const shotWhere = `${where}/镜${shot.index}`;
        // 表里的「序号」只要求**递增**（真实分镜表常用全片连续编号 1..镜总数，
        // 也有模型每片段从 1 开始 —— 都合法）；落库时由代码归一化成"片段内 1..N"。
        if (prevShotIndex != null && shot.index <= prevShotIndex) {
          issues.push({ level: "warning", where: shotWhere, rule: "镜号递增", message: `镜号没有递增（上一镜 ${prevShotIndex} → 本镜 ${shot.index}）` });
        }
        prevShotIndex = shot.index;

        if (Number.isNaN(shot.duration) || shot.duration <= 0) {
          issues.push({ level: "error", where: shotWhere, rule: "时长必须是正数", message: `时长解析为「${shot.raw.slice(0, 30)}…」里的空值` });
        } else {
          segSum += shot.duration;
          if (shot.duration > maxShot + tol)
            issues.push({ level: "error", where: shotWhere, rule: `单镜≤${maxShot}s`, message: `该镜 ${shot.duration}s 超上限` });
        }

        if (!shot.action.trim()) issues.push({ level: "error", where: shotWhere, rule: "画面描述非空", message: "画面描述为空" });
        if (!shot.shotSize.trim()) issues.push({ level: "warning", where: shotWhere, rule: "景别必填", message: "景别为空" });
        if (!shot.camera.trim()) issues.push({ level: "warning", where: shotWhere, rule: "运镜必填", message: "运镜为空" });
        if (!shot.light.trim()) issues.push({ level: "warning", where: shotWhere, rule: "光影氛围必填", message: "光影氛围为空" });

        if (opts.validAssetIds && shot.assetIds.length && shot.assetIds !== seg.assetIds) {
          const bad = shot.assetIds.filter((id) => !opts.validAssetIds!.has(id));
          if (bad.length) issues.push({ level: "error", where: shotWhere, rule: "资产必须存在", message: `镜级引用了不存在的资产 ID：${bad.join(", ")}` });
        }

        if (requireDialogue && shot.dialogue.trim() && scriptLines.length) {
          const d = normalizeDialogue(shot.dialogue);
          const hit = scriptLines.some((l) => d.includes(l) || l.includes(d));
          if (!hit)
            issues.push({
              level: "warning",
              where: shotWhere,
              rule: "台词须来自剧本原文",
              message: `台词「${shot.dialogue.slice(0, 40)}…」在剧本正文里找不到对应句子`,
            });
        }
      }

      if (segSum > maxSeg + tol) {
        issues.push({ level: "error", where, rule: `片段累计≤${maxSeg}s`, message: `该片段合计 ${segSum}s 超上限（${seg.shots.length} 镜）` });
      }
      if (seg.declaredSec != null && Math.abs(seg.declaredSec - segSum) > 1 + tol) {
        issues.push({
          level: "warning",
          where,
          rule: "片段头声明秒数=镜头之和",
          message: `片段头写「约${seg.declaredSec}s」，镜头之和 ${segSum}s（差 ${Math.abs(seg.declaredSec - segSum)}s）`,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const ok = errors.length === 0 && (!opts.strict || warnings.length === 0);
  return { ok, issues, errors, warnings };
}

// ============================================================
// videoDesc（多参模式的「承接句 + 行原文」由代码拼，不再让 agent 逐条写）
// ============================================================

/** 把一行镜头的画面描述压成承接句用的短摘要（取首句，最长 40 字） */
function brief(text: string, max = 40): string {
  const first = text.split(/[。；;！!？?]/)[0] ?? "";
  const t = first.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * 生成一条片段的 `videoDesc`（多参模式口径：承接句 + 该片段的行原文）。
 *
 * 为什么由代码拼：阶段5 原本让 agent 一条条调 `add_flowData_storyboard` 写这段文本，
 * 于是「条数/顺序/承接句」全靠模型自觉 —— 现在它是对解析结果的确定性投影。
 */
export function buildSegmentVideoDesc(parsed: ParsedStoryboard, segment: ParsedSegment): string {
  const prevSegments = parsed.segments.filter((s) => s.segmentIndex < segment.segmentIndex);
  const prev = prevSegments[prevSegments.length - 1];
  const total = segment.shots.reduce((sum, s) => sum + (Number.isNaN(s.duration) ? 0 : s.duration), 0);

  let head: string;
  if (prev && prev.shots.length) {
    const lastShot = prev.shots[prev.shots.length - 1];
    head = `承接上镜：上镜定格于「${brief(lastShot.action)}」——本片段由${segment.shots[0]?.shotSize || "镜头"}${segment.shots[0]?.camera ? "·" + segment.shots[0].camera : ""}延续，共 ${segment.shots.length} 镜、合计约 ${total}s。`;
  } else {
    head = `本片段为开场，共 ${segment.shots.length} 镜、合计约 ${total}s。`;
  }

  const rows = segment.shots
    .map((s) => `| ${s.index} | ${s.action} | ${s.duration} | ${s.shotSize} | ${s.camera} | ${s.light} | ${s.dialogue} | ${s.sfx} |`)
    .join("\n");

  return `${head}\n${rows}`;
}

/** 把解析结果渲染回一整张 markdown 表（用于影子期给画布/审计一份可读文本） */
export function renderStoryboardTable(parsed: ParsedStoryboard): string {
  const out: string[] = [];
  for (const scene of parsed.scenes) {
    out.push(`## 场${scene.index}：${scene.title}${scene.cast.length ? ` ｜ 参演角色：${scene.cast.join("、")}` : ""}`);
    out.push("");
    for (const seg of scene.segments) {
      out.push(`### ${seg.label}${seg.declaredSec != null ? `（约${seg.declaredSec}s）` : ""}`);
      if (seg.assetNames.length) out.push(`**引用资产名称**：[${seg.assetNames.join(", ")}]`);
      if (seg.assetIds.length) out.push(`**引用资产ID**：[${seg.assetIds.join(", ")}]`);
      out.push("| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |");
      out.push("|------|------|------|------|------|------|------|------|");
      for (const s of seg.shots) {
        out.push(`| ${s.index} | ${s.action} | ${s.duration} | ${s.shotSize} | ${s.camera} | ${s.light} | ${s.dialogue} | ${s.sfx} |`);
      }
      out.push("  ");
    }
  }
  return out.join("\n");
}
