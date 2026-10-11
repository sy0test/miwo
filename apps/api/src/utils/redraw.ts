/**
 * 出海转绘：解析 redraw-analysis-skill 的两块产出。
 *
 * 技能的输出契约见 data/skills/feicai/redraw-analysis-skill/SKILL.md 的 [输出格式]：
 *   <assetSheet>      角色 / 场景 / 道具 三段 markdown，每项一个 ### 标题 + 字段 bullet
 *   <storyboardTable> 场 → 片段 → 镜 的 markdown 表
 *
 * 这里只做「文本 → 结构化 + 体检」，**不碰数据库** ——
 * 落库（o_assets / 分镜表）是调用方的事，列的形状属于基座。
 *
 * 为什么不复用基座解析：基座没有 markdown 表解析器，它的分镜来自模型直出的
 * `<storyboardItem>` XML。转绘这条路是「模型出 markdown 表 → 我们转成基座形状」，
 * 所以解析器是新写的。
 */

export type RedrawAssetType = "role" | "scene" | "tool";

export type RedrawAsset = {
  type: RedrawAssetType;
  /** 目标国名 / 出图用名（技能里的 `### 名字（源片：原名）` 前半） */
  name: string;
  /** 源片原名，只用于核对，不落库 */
  sourceName: string;
  /** 资产的视觉化说明。落到 `o_assets.describe`（基座契约里是 30~80 字） */
  describe: string;
  /** 出图提示词 */
  prompt: string;
};

export type RedrawShot = {
  /** 全场连续的镜号，从 1 开始 */
  index: number;
  /** 片段内的表内序号 */
  seq: number;
  /** 所属场名 */
  sceneName: string;
  /** 该场参演角色（技能在场标题里给的） */
  sceneCast: string[];
  /** 片段名，如「片段一」。同名片段出现第二次时会带 `(2)` 后缀 */
  segmentLabel: string;
  /**
   * 片段序号，**每见一个 `### ` 标题就 +1**，与名字无关。
   * 分组必须用它，不能用名字 —— 「同一场里片段名不重复」这点没有任何东西保证，
   * 模型把两个片段都命名成「片段五」时，按名字分组会把两段合成一段，
   * 于是体检拿第一段的表头秒数去比两段的时长之和，报出一个**根本不存在的**算术错。
   */
  segmentId: number;
  /** 片段头声明的秒数，如 `### 片段一（10s）` 的 10 */
  declaredSec: number;
  /** 本镜时长（表里的「时长」列） */
  durationSec: number;
  /** 源片区间，已解析成 [起, 止] 秒对；多段合并时有多个 */
  ranges: [number, number][];
  /** 源片区间的原始文本，便于报错时回显 */
  rawRange: string;
  /** 画面描述 */
  desc: string;
  /** 景别 */
  shotSize: string;
  /** 运镜 */
  camera: string;
  /** 角色动作。技能漏给时为空串（占位仍在，不会让 videoDesc 错位） */
  action: string;
  /** 情绪。同上 */
  emotion: string;
  /** 光影氛围。同上 */
  lighting: string;
  /** 台词。格式 `目标语言译文（中文回译）` —— 回译是给人对照用的，见 originDialogue */
  dialogue: string;
  /**
   * 原台词：转写稿校订过的**原文**，一镜一句，**照录不译**
   * （产品语境下原片是国产剧，所以它就是中文；源片本身不是中文时保留原语言，
   * 否则对照表两边都是中文，看不出译文有没有走样）。
   * 只进 `o_storyboard.originDialogue` 这一列，**不进 videoDesc** ——
   * 那一串的 12 个槽位是给视频提示词 agent 按位置读的，多一个就整体错位。
   * 它的用处是跟 `dialogue` 并排，让人核「原片说的什么 → 转绘后说的什么」。
   */
  originDialogue: string;
  /** 音效 */
  sfx: string;
  /** 本片段引用的资产名称（技能在表外一行给出） */
  assetNames: string[];
};

export type RedrawAssetSheet = { assets: RedrawAsset[] };

export type RedrawStoryboard = {
  /** 视频总时长（秒）。用于区间越界体检，未提供则跳过该项 */
  videoSec?: number;
  shots: RedrawShot[];
  /** 表里没有表头行，列是按固定布局「猜」出来的。位置猜错不会报错，只会静默串位 */
  headerMissing?: boolean;
  /** 有表头，但这些列名对不上（技能把列名写岔了）。这些列会被静默留空 */
  headerUnknownCols?: string[];
};

// ============================================================
// 通用
// ============================================================

/** 从模型回复里抠出某个 XML 块的内容；没找到返回 null */
export function extractBlock(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1] : null;
}

/**
 * 剥掉 HTML 注释。
 * 模型正常不会输出注释，但夹具会，而且注释里的示例行（`### 片段一（9s）`）
 * 会被当成真数据读进来。
 */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/** 标题匹配。`(?!#)` 不能省：否则 `##` 会把 `###` 整行吃掉，`###` 分支永不触发 */
const headingRe = (level: number, rest: string) => new RegExp(`^#{${level}}(?!#)\\s*${rest}\\s*$`);

/** 全角/半角冒号都吃 */
function splitField(line: string): [string, string] | null {
  const m = /^\s*[-*]\s*([^:：]+)[:：]\s*([\s\S]*)$/.exec(line);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

// ============================================================
// 块一：<assetSheet>
// ============================================================

const SECTION_TYPES: Record<string, RedrawAssetType> = {
  角色: "role",
  场景: "scene",
  道具: "tool",
};

/**
 * 解析 `<assetSheet>`。
 *
 * 容错点：技能的「出图提示词」是叙事长句，常常折行；这里把不构成新标题/新 bullet
 * 的行续接到上一个字段上，避免长提示词被截断成半句。
 */
export function parseAssetSheet(text: string): RedrawAssetSheet {
  const assets: RedrawAsset[] = [];
  let type: RedrawAssetType | null = null;
  let cur: RedrawAsset | null = null;
  let lastField: "describe" | "prompt" | null = null;

  for (const raw of stripComments(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const section = headingRe(2, "(.+?)").exec(line);
    if (section) {
      const key = section[1].replace(/[:：].*$/, "").trim();
      type = SECTION_TYPES[key] ?? null; // 不认识的段落整段跳过，不让它污染资产表
      cur = null;
      lastField = null;
      continue;
    }

    const heading = headingRe(3, "(.+?)").exec(line);
    if (heading) {
      if (!type) continue;
      // `名字（源片：原名）`；括号可缺失，缺失时 sourceName 留空
      const body = heading[1];
      const m = /^(.+?)\s*[（(]\s*源片\s*[:：]\s*(.*?)\s*[)）]\s*$/.exec(body);
      cur = {
        type,
        name: (m ? m[1] : body).trim(),
        sourceName: m ? m[2].trim() : "",
        describe: "",
        prompt: "",
      };
      assets.push(cur);
      lastField = null;
      continue;
    }

    if (!cur) continue;

    const field = splitField(line);
    if (field) {
      const [k, v] = field;
      if (/提示词/.test(k)) {
        cur.prompt = v;
        lastField = "prompt";
      } else {
        // 除提示词外的 bullet 一律当说明收着 —— 技能那行的字面标签（身份 / 说明 / 描述）
        // 不写死，改标签不会让这里静默丢字段。
        cur.describe = cur.describe ? `${cur.describe} ${v}` : v;
        lastField = "describe";
      }
      continue;
    }

    // 续行：长提示词折行
    if (lastField) cur[lastField] = `${cur[lastField]} ${line.trim()}`.trim();
  }

  return { assets };
}

// ============================================================
// 块二：<storyboardTable>
// ============================================================

/**
 * 解析 `起-止` 或 `起-止 + 起-止 + …`。
 * 技能被要求写死三位小数，但这里仍容忍整数和多余空格。
 * 解析不出（含「约」「≈」等模糊写法）返回 null，由体检报出来。
 */
export function parseRanges(cell: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of cell.split("+")) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) return null;
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out.length ? out : null;
}

/** 去掉 markdown 表格行的首尾竖线后按 `|` 切开 */
function cells(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

const isSeparatorRow = (cs: string[]) => cs.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));

/** 分镜表列名 → RedrawShot 字段。缺的列留空，不报错（但会记在 headerMissingCols 里让体检报） */
const COLUMN_FIELDS: Record<string, keyof RedrawShot> = {
  序号: "seq",
  源片区间: "rawRange",
  画面描述: "desc",
  时长: "durationSec",
  景别: "shotSize",
  运镜: "camera",
  角色动作: "action",
  情绪: "emotion",
  光影氛围: "lighting",
  原台词: "originDialogue",
  台词: "dialogue",
  音效: "sfx",
};

/** 表头里出现过的列名（反查用）。表头认出来了但列名写岔，这一列会静默留空 */
const COLUMN_NAMES = new Map(Object.entries(COLUMN_FIELDS).map(([name, f]) => [f as string, name]));

/**
 * 技能有时在单元格里重复写一遍列名（如「音效：手机震动声」）。
 * 列头已经说明了这是什么，这层前缀留着会一路带进 videoDesc。
 */
const stripLabel = (s: string) =>
  s.replace(/^(序号|源片区间|画面描述|时长|景别|运镜|角色动作|情绪|光影氛围|原台词|台词|音效)\s*[:：]\s*/, "").trim();

export function parseStoryboardTable(text: string, videoSec?: number): RedrawStoryboard {
  const shots: RedrawShot[] = [];
  let sceneName = "";
  let sceneCast: string[] = [];
  let segmentLabel = "";
  let segmentId = 0;
  let declaredSec = 0;
  /** 本场内每个片段名出现过几次。重名时给第二次之后加后缀，免得界面上两条一模一样的 track */
  let labelCount = new Map<string, number>();
  let assetNames: string[] = [];
  let index = 0;
  /** 表头行建立的「字段 → 列下标」映射；没表头时为 null，退回按固定布局取 */
  let colMap: Record<string, number> | null = null;
  let headerMissing = false;
  /** 表头认出来了，但这些列名对不上（技能把列名写岔了）。这些列会被静默留空 */
  let headerUnknownCols: string[] = [];

  for (const raw of stripComments(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // 场：`## 场1：场景名 ｜ 参演角色：A、B`
    const scene = headingRe(2, "(.+?)").exec(line);
    if (scene) {
      const parts = scene[1].split(/[｜|]/);
      sceneName = parts[0].replace(/^场\s*\d*\s*[:：]\s*/, "").trim();
      sceneCast = (parts[1] ?? "")
        .replace(/^\s*参演角色\s*[:：]\s*/, "")
        .split(/[、,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      segmentLabel = "";
      assetNames = [];
      labelCount = new Map();
      continue;
    }

    // 片段：`### 片段一（10s）`
    const seg = headingRe(3, "(.+?)").exec(line);
    if (seg) {
      const m = /^(.+?)\s*[（(]\s*(\d+(?:\.\d+)?)\s*s\s*[)）]\s*$/.exec(seg[1]);
      const rawLabel = (m ? m[1] : seg[1]).trim();
      const n = (labelCount.get(rawLabel) ?? 0) + 1;
      labelCount.set(rawLabel, n);
      segmentLabel = n > 1 ? `${rawLabel}(${n})` : rawLabel;
      segmentId++;
      declaredSec = m ? Number(m[2]) : 0;
      assetNames = [];
      continue;
    }

    // 片段级引用资产：`**引用资产名称**：[A, B, C]`
    const ref = /^\*\*\s*引用资产名称\s*\*\*\s*[:：]\s*\[([^\]]*)\]/.exec(line);
    if (ref) {
      assetNames = ref[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      continue;
    }

    if (!line.startsWith("|")) continue;
    const c = cells(line);
    if (isSeparatorRow(c)) continue;

    // 表头行：按**列名**建映射。不按列序，因为「画面描述」自身可能含 `|`，
    // 而且技能加列（角色动作/情绪/光影氛围）时这里不用改。
    if (!colMap) {
      // 只有真的像表头才当表头认；否则认为技能没输出表头，
      // 置空映射退回固定布局 —— 不能在这里 continue，否则会吃掉第一行数据。
      if (c.includes("源片区间")) {
        const byName: Record<string, number> = {};
        c.forEach((name, i) => {
          const f = COLUMN_FIELDS[name];
          if (f) byName[f] = i;
        });
        colMap = byName;
        // 该有的列一个都不该缺。缺了就记下来 —— 有表头时 getRaw 会直接给空，
        // 不留声的话「技能改了列名」看起来和「技能忘了填」一模一样。
        headerUnknownCols = [...COLUMN_NAMES.keys()].filter((f) => !(f in byName)).map((f) => COLUMN_NAMES.get(f)!);
        continue;
      }
      colMap = {};
      headerMissing = true;
    }

    // 取列。有表头按表头；没表头退回 SKILL.md [输出格式] 的固定布局：
    //   序号 源片区间 画面描述 时长 景别 运镜 角色动作 情绪 光影氛围 [原台词] 台词 音效
    // 「画面描述」= 夹在源片区间和**尾部 N 列**之间的全部内容。
    //
    // 尾部列从后往前数是**固定**的（时长 景别 运镜 角色动作 情绪 光影氛围 台词 音效），
    // 但「原台词」插在台词**前面**，所以 12 列时尾部是 9 列、起点要往前挪一格。
    // 只按 `c.length - 8` 算会把「景别」当「时长」，一路错到底。
    const hasOrigin = c.length >= 12;
    const tailStart = c.length - 8 - (hasOrigin ? 1 : 0);
    const getRaw = (f: keyof RedrawShot): string => {
      const i = colMap?.[f];
      if (i !== undefined) return (c[i] ?? "").trim();
      // 有表头却没这一列 —— 技能少给了这列。此时按位置猜只会把别的列顶上来，
      // 宁可为空让体检报出来，也不要静默串位。
      if (!headerMissing) return "";
      // 无表头：按固定布局猜。列数对不上就整个不猜 —— 猜下去等于把「时长」当「角色动作」。
      // 少列会让 rawRange 为空，体检立刻报错，比错位好。
      if (c.length < 11) return f === "seq" ? (c[0] ?? "").trim() : "";
      switch (f) {
        case "seq":
          return (c[0] ?? "").trim();
        case "rawRange":
          return (c[1] ?? "").trim();
        case "desc":
          return c.slice(2, tailStart).join(" | ").trim();
        case "durationSec":
          return (c[tailStart] ?? "").trim();
        case "shotSize":
          return (c[tailStart + 1] ?? "").trim();
        case "camera":
          return (c[tailStart + 2] ?? "").trim();
        case "action":
          return (c[tailStart + 3] ?? "").trim();
        case "emotion":
          return (c[tailStart + 4] ?? "").trim();
        case "lighting":
          return (c[tailStart + 5] ?? "").trim();
        case "originDialogue":
          return hasOrigin ? (c[tailStart + 6] ?? "").trim() : "";
        case "dialogue":
          return (c[tailStart + (hasOrigin ? 7 : 6)] ?? "").trim();
        case "sfx":
          return (c[tailStart + (hasOrigin ? 8 : 7)] ?? "").trim();
        default:
          return "";
      }
    };
    const get = (f: keyof RedrawShot) => stripLabel(getRaw(f));

    const seq = Number(get("seq"));
    if (!Number.isFinite(seq)) continue;
    const rawRange = get("rawRange");
    const ranges = parseRanges(rawRange);

    shots.push({
      index: ++index,
      seq,
      sceneName,
      sceneCast: [...sceneCast],
      segmentLabel,
      segmentId,
      declaredSec,
      durationSec: Number(get("durationSec")),
      ranges: ranges ?? [],
      rawRange,
      desc: get("desc"),
      shotSize: get("shotSize"),
      camera: get("camera"),
      action: get("action"),
      emotion: get("emotion"),
      lighting: get("lighting"),
      dialogue: get("dialogue"),
      originDialogue: get("originDialogue"),
      sfx: get("sfx"),
      assetNames: [...assetNames],
    });
  }

  return { videoSec, shots, headerMissing, headerUnknownCols };
}

// ============================================================
// 源片文件名 → 排序序号
// ============================================================

/**
 * 出海转绘的源片是多集的，客户上传前会重命名（「第一集」「2-xxx」）。
 * 界面按 `o_script.sortIndex` 排，**不按上传先后** —— 重传某一集就乱了。
 *
 * 放在这个文件（而不是 uploadSource 路由里）是为了能单测：这里零副作用，
 * 路由文件一 import 就会拉起 express 和 u.db。验收脚本见
 * `scratch-redraw-sortindex.ts`。
 */
const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字转阿拉伯数字，支持到千位（「十二」「二十三」「一百零五」）。转不出返回 null */
export function cnToNumber(s: string): number | null {
  if (!s) return null;
  if (/^[零〇一二两三四五六七八九]+$/.test(s)) {
    // 纯数位串：「一〇二」这种年份写法
    const digits = [...s].map((c) => CN_DIGIT[c]);
    return digits.every((d) => d !== undefined) ? Number(digits.join("")) : null;
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let section = 0;
  let last = 0;
  let matched = false;
  for (const c of s) {
    if (CN_DIGIT[c] !== undefined) {
      last = CN_DIGIT[c];
      matched = true;
      continue;
    }
    const u2 = units[c];
    if (u2 === undefined) return null;
    matched = true;
    // 「十二」= 十位省略了 1
    section += (last || 1) * u2;
    last = 0;
  }
  const total = section + last;
  return matched && total > 0 ? total : null;
}

/**
 * 从集名里解排序序号。认这几种写法（客户实际用的命名习惯）：
 *   「第一集」「第十二话」「第十期」   → 中文数字
 *   「12-xxx」「12 xxx」「012_xxx」     → 开头就是数字
 *   「第2集」「第 02 话」              → 第 + 数字
 * 解不出来返回 null，由调用方退回上传顺序。
 */
export function parseSortIndex(name: string): number | null {
  // 第 + 数字/中文数字（带可选单位后缀）
  const di = /第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千]{1,6})\s*[集话期回部季]?/.exec(name);
  if (di) {
    const raw = di[1];
    const n = /^[0-9]+$/.test(raw) ? Number(raw) : cnToNumber(raw);
    if (n) return n;
  }
  // 开头的阿拉伯数字。`(?![0-9])` 不能省：否则「12345」会被当成 1
  const ar = /^[\s([【]*([0-9]{1,4})(?![0-9])/.exec(name);
  if (ar) return Number(ar[1]);
  // 开头的中文数字
  const cn = /^[\s([【]*([零〇一二两三四五六七八九十百千]{1,6})/.exec(name);
  if (cn) {
    const n = cnToNumber(cn[1]);
    if (n) return n;
  }
  return null;
}

// ============================================================
// 转成基座形状
// ============================================================

/**
 * 字段内部的顿号会把外层分隔符冲掉。
 * 基座是**按顿号切**这个串的，字段里混进一个顿号就整体错位，
 * 而中文描述里「黑色长发、鹅蛋脸」这种顿号列举太常见，必须换掉。
 * 只换顿号，不动括号 —— 台词里带括号是正常的，剥了反而改坏内容。
 */
const flattenField = (s: string) => s.replace(/、/g, "，").trim();

/**
 * 把一镜拼成基座 `o_storyboard.videoDesc` 的形状。
 *
 * 基座的视频提示词 skill 是**按顿号位置**解析这个串的
 * （见 `initDB.ts` 内建 videoPromptGeneration 的「videoDesc 解析规则」表），
 * 所以 12 个字段必须**一个不少、顺序不变**，缺的也要留空占位 —— 少一个，后面全部错位。
 *
 * 「角色动作 / 情绪 / 光影氛围」由技能直接产出（源视频是 AI 生成的，这三项没法从
 * 切点表推，只能看图说话）。技能漏给就是空串，占位仍在、位置不错位。
 *
 * @param assetIds 该片段引用资产在 `o_assets` 里的 id，顺序与 assetNames 对齐
 */
export function composeVideoDesc(shot: RedrawShot, assetIds: number[]): string {
  const fields = [
    shot.desc,
    shot.sceneName,
    shot.assetNames.join("/"),
    `${shot.durationSec}s`,
    shot.shotSize,
    shot.camera,
    shot.action,
    shot.emotion,
    shot.lighting,
    shot.dialogue || "无台词",
    shot.sfx,
    assetIds.join("/"),
  ];
  return `（${fields.map(flattenField).join("、")}）`;
}

/**
 * 台词对照表：`原台词（原文，不译）` ↔ `转绘台词（目标语言 + 回译）` 逐镜并排。
 *
 * 为什么单独一份、不塞进 `videoDesc`、也不塞进分镜表：
 *   1. `videoDesc` 的槽位是给视频提示词 agent 按位置读的，多一个就整体错位；
 *   2. 这是一份**给人核对**的东西，跟喂给模型的东西是两条路。
 * 落成产物目录里的一份 md，零模型成本 —— 材料（分镜表）本来就在手上。
 */
export function renderDialogueMap(
  shots: RedrawShot[],
  meta: { projectName?: string; targetCountry?: string; scriptName?: string },
): string {
  // 单元格里的 `|` 会把表格撑破；换行在 markdown 表格里也不合法
  const esc = (s: string) => (s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const rows = shots.map((s) =>
    [s.index, esc(s.rawRange), `${esc(s.sceneName)}／${esc(s.segmentLabel)}`, esc(s.originDialogue) || "—", esc(s.dialogue) || "—"]
      .join(" | ")
      .replace(/^/, "| ")
      .concat(" |"),
  );
  return [
    "# 台词对照表",
    "",
    `- 项目：${meta.projectName || "-"}`,
    `- 本集：${meta.scriptName || "-"}`,
    `- 目标国家：${meta.targetCountry || "-"}`,
    `- 镜数：${shots.length}`,
    "",
    "> 左列是原片台词（转写稿校订后的**原文**，照录不译），右列是转绘后的台词。",
    "> 右列格式为 `目标语言译文（回译中文）` —— 括号里是回译，给人核「意思有没有走样」，不参与配音与语速配额。",
    "",
    "| 镜 | 源片区间 | 场景／片段 | 原台词（原文，不译） | 转绘台词（目标语言 + 回译） |",
    "|----|---------|-----------|---------------|---------------------------|",
    ...rows,
    "",
  ].join("\n");
}

// ============================================================
// 落库
// ============================================================

export type RedrawWriteResult = {
  /** 名称 → o_assets.id，已建的与复用的都在里面 */
  assetIds: Record<string, number>;
  storyboardIds: number[];
  /** 分镜引用了、但资产清单里没有的名字。这些引用被跳过，`videoDesc` 里也就少一个 id */
  missingAssetNames: string[];
};

/**
 * 把技能产出写进基座的表。
 *
 * 表形状照 `src/routes/production/storyboard/batchAddStoryboardInfo.ts` 抄：
 *   - 资产 → `o_assets`（描述列叫 `describe`，图片靠 `imageId` 外键，此处留空等批量生成）
 *   - 分镜 → `o_storyboard`（台词/景别/运镜等**没有独立列**，全在 `videoDesc` 里）
 *   - 关联 → 中间表 `o_assets2Storyboard`（不是 JSON 数组）
 *   - 分组 → `o_videoTrack` + `o_storyboard.trackId`
 *
 * **db 由调用方注入**（传 `u.db` 即可），这样这个模块不依赖应用初始化，能单独测。
 *
 * 重跑语义：`o_assets` 按「projectId + name + type」复用，不会翻倍；
 * 但 `o_storyboard` 是**先删后建**，必须显式传 `replace: true` ——
 * 否则一旦在界面上改过分镜，重跑分析会把改动无声抹掉。
 */
export async function writeRedraw(
  db: any,
  opts: {
    projectId: number;
    scriptId: number;
    sheet: RedrawAssetSheet;
    board: RedrawStoryboard;
    /** 允许覆盖该 scriptId 下已有的分镜。默认 false，已有分镜时直接报错 */
    replace?: boolean;
    /**
     * 不建 `o_assets` 行，只写分镜。解析层用 —— 资产要先经关联层跟用户认账，
     * 此时落库等于绕过用户。源片分镜表的资产槽留空（12 槽不错位），绑定等转绘层补。
     */
    skipAssets?: boolean;
  },
): Promise<RedrawWriteResult> {
  const { projectId, scriptId, sheet, board, replace = false, skipAssets = false } = opts;

  const existing = await db("o_storyboard").where("scriptId", scriptId).first();
  if (existing && !replace) {
    throw new Error(`scriptId=${scriptId} 下已有分镜。重跑会覆盖（含界面上改过的内容），需显式传 replace: true`);
  }

  // ---- 1. 资产：同名同类型复用 ----
  const assetIds: Record<string, number> = {};
  // skipAssets 时喂空表进去 —— 比在外面包一层 if 少改 30 行缩进，行为一样
  for (const a of skipAssets ? [] : sheet.assets) {
    const hit = await db("o_assets").where({ projectId, name: a.name, type: a.type }).first();
    if (hit) {
      assetIds[a.name] = hit.id;
      // 复用不等于什么都不做，两件事必须补：
      //   一、**只补空、不覆盖** —— 老行 describe 为空是上一版技能没产出说明留下的
      //      （真跑遇到过：有个道具因为重名被复用，describe 一直是 0 字）。
      //      非空的一律不动：那可能是界面上手改过的。
      //   二、**关联到剧本**。重名资产可能来自别的剧本或 cornerScape，此时这一条
      //      链接还不存在（getScrptApi 读这张表），漏了它在界面上就看不到这个资产。
      const patch: Record<string, string> = {};
      if (!hit.describe && a.describe) patch.describe = a.describe;
      if (!hit.prompt && a.prompt) patch.prompt = a.prompt;
      if (Object.keys(patch).length) await db("o_assets").where("id", hit.id).update(patch);
      const reusedLink = await db("o_scriptAssets").where({ scriptId, assetId: hit.id }).first();
      if (!reusedLink) await db("o_scriptAssets").insert({ scriptId, assetId: hit.id });
      continue;
    }
    const [id] = await db("o_assets").insert({
      name: a.name,
      type: a.type,
      describe: a.describe,
      prompt: a.prompt,
      projectId,
      startTime: Date.now(),
    });
    assetIds[a.name] = id;
    // 与基座一致：资产同时挂到剧本上（cornerScape 不读这张表，但 getScrptApi 读）
    const linked = await db("o_scriptAssets").where({ scriptId, assetId: id }).first();
    if (!linked) await db("o_scriptAssets").insert({ scriptId, assetId: id });
  }

  // ---- 2. 分镜：先清旧的，再逐镜写 ----
  if (existing) {
    const oldIds = (await db("o_storyboard").where("scriptId", scriptId).select("id")).map((r: any) => r.id);
    if (oldIds.length) {
      await db("o_assets2Storyboard").whereIn("storyboardId", oldIds).del();
      await db("o_storyboard").whereIn("id", oldIds).del();
    }
    await db("o_videoTrack").where("scriptId", scriptId).del();
  }

  const missing = new Set<string>();
  const storyboardIds: number[] = [];
  for (const s of board.shots) {
    const ids: number[] = [];
    for (const n of s.assetNames) {
      const id = assetIds[n];
      // skipAssets 下 assetIds 本来就是空的 —— 「缺资产」是这一步的本意，不是要报的错
      if (id === undefined) {
        if (!skipAssets) missing.add(n);
      } else ids.push(id);
    }
    const [id] = await db("o_storyboard").insert({
      prompt: "", // 分镜图提示词由工作台那套生成，这里不预设
      duration: String(s.durationSec), // 基座这列是 text
      state: "未生成",
      scriptId,
      projectId,
      // 一个片段 = 一条提示词 = 一次生成，所以按「场/片段」分组，而不是按场
      track: `${s.sceneName}/${s.segmentLabel}`,
      videoDesc: composeVideoDesc(s, ids),
      // 第 7 步切原片参考片段要用它。单独一列是因为 videoDesc 那 12 个字段
      // 是按顿号位置解析的，多塞一个会让下游整体错位（详见 fixDB 里同名的注释）。
      sourceRange: s.rawRange,
      // 原台词单独一列，只给「台词对照表」用 —— 不进 videoDesc，理由同上。
      originDialogue: s.originDialogue || null,
      shouldGenerateImage: 1,
      createTime: Date.now(),
      index: s.index,
    });
    if (ids.length) {
      await db("o_assets2Storyboard").insert(ids.map((assetId) => ({ assetId, storyboardId: id })));
    }
    storyboardIds.push(id);
  }

  // ---- 3. 按 track 分配 trackId（照 batchAddStoryboardInfo.ts:52-91）----
  // 基座用 Date.now() 当 o_videoTrack.id，一个循环里连建多个会同毫秒撞 id；
  // 转绘一次就是十几个片段，必须自己错开。
  let seq = 0;
  for (const track of [...new Set(board.shots.map((s) => `${s.sceneName}/${s.segmentLabel}`))]) {
    const rows = await db("o_storyboard").where({ scriptId, track });
    const duration = rows.reduce((n: number, r: any) => n + Number(r.duration), 0);
    const hit = await db("o_storyboard").where({ scriptId, track }).whereNotNull("trackId").first();
    let trackId: number;
    if (hit?.trackId) {
      trackId = hit.trackId;
      await db("o_videoTrack").where("id", trackId).update({ duration });
    } else {
      trackId = Date.now() + seq++;
      await db("o_videoTrack").insert({ id: trackId, scriptId, projectId, duration });
    }
    await db("o_storyboard").where({ scriptId, track }).update({ trackId });
  }

  return { assetIds, storyboardIds, missingAssetNames: [...missing] };
}

// ============================================================
// 体检
// ============================================================

export type RedrawIssue = { level: "error" | "warn"; shotIndex?: number; message: string };

/**
 * 体检。**不是**「模型行不行」的探针，而是「这份产出能不能进下游」的闸门。
 * 返回的 issues 里 level=error 的必须人工处理，warn 的可带病往下走。
 */
export function checkRedrawOutput(sheet: RedrawAssetSheet, board: RedrawStoryboard): RedrawIssue[] {
  const issues: RedrawIssue[] = [];
  const err = (message: string, shotIndex?: number) => issues.push({ level: "error", shotIndex, message });
  const warn = (message: string, shotIndex?: number) => issues.push({ level: "warn", shotIndex, message });

  if (!sheet.assets.length) err("assetSheet 没解析出任何资产");
  const seen = new Set<string>();
  for (const a of sheet.assets) {
    if (!a.name) err("有资产的标题里没解析出名字");
    if (!a.prompt) err(`资产「${a.name}」没有出图提示词`);
    for (const t of [a.name, `${a.type}:${a.name}`]) {
      if (seen.has(t)) warn(`资产「${a.name}」重复出现`);
      seen.add(t);
    }
  }
  if (!board.shots.length) err("storyboardTable 没解析出任何镜头");
  if (board.headerMissing)
    warn("分镜表没有表头行，列是按固定布局猜的（序号/源片区间/画面描述/时长/景别/运镜/角色动作/情绪/光影氛围/台词/音效）。列数对不上就会静默串位，人工抽查一行");
  if (board.headerUnknownCols?.length)
    warn(`分镜表表头里认不出这些列：${board.headerUnknownCols.join("、")}。它们对应的内容会是空的，核对一下技能是不是改了列名`);

  // 区间：可解析 / 不越界
  for (const s of board.shots) {
    if (!s.ranges.length) err(`第 ${s.index} 镜的源片区间解析不出来：「${s.rawRange}」`, s.index);
    for (const [a, b] of s.ranges) {
      if (b <= a) err(`第 ${s.index} 镜的区间 ${a}-${b} 终点不大于起点`, s.index);
      if (board.videoSec && b > board.videoSec + 0.05)
        err(`第 ${s.index} 镜的区间超出源片时长（${b} > ${board.videoSec}）`, s.index);
    }
  }

  // 片段内算术关系：片段头秒数 == 镜时长之和
  // **按 segmentId 分组，不按名字** —— 重名片段会被名字合并，这个错误会伪装成
  // 「模型算错了」（详见 RedrawShot.segmentId 的注释）。
  const bySegment = new Map<number, RedrawShot[]>();
  for (const s of board.shots) {
    if (!bySegment.has(s.segmentId)) bySegment.set(s.segmentId, []);
    bySegment.get(s.segmentId)!.push(s);
  }
  for (const seg of bySegment.values()) {
    const label = `${seg[0].sceneName} / ${seg[0].segmentLabel}`;
    const sum = seg.reduce((n, s) => n + s.durationSec, 0);
    const declared = seg[0].declaredSec;
    if (!declared) warn(`片段「${label}」的标题里没写秒数，无法核对`);
    else if (Math.abs(sum - declared) > 0.05)
      err(`片段「${label}」头写 ${declared}s，但镜时长之和是 ${sum}s`);
    // Seedance 平台单条提示词的视频文件上限是 3 个
    if (seg.length > 3) warn(`片段「${label}」含 ${seg.length} 个镜，超过 Seedance「视频 ≤3 个/条」`);
  }

  // 时间轴覆盖：把区间排序后找缺口和重叠
  const flat = board.shots
    .flatMap((s) => s.ranges.map(([a, b]) => ({ a, b, index: s.index })))
    .sort((x, y) => x.a - y.a);
  if (flat.length) {
    const gaps: string[] = [];
    const overlaps: string[] = [];
    let cursor = flat[0].a;
    for (const r of flat) {
      if (r.a - cursor > 0.05) gaps.push(`${cursor.toFixed(3)}-${r.a.toFixed(3)}`);
      else if (cursor - r.a > 0.05) overlaps.push(`${r.a.toFixed(3)}-${Math.min(cursor, r.b).toFixed(3)}`);
      cursor = Math.max(cursor, r.b);
    }
    if (gaps.length) err(`时间轴有 ${gaps.length} 处缺口：${gaps.slice(0, 5).join("、")}${gaps.length > 5 ? " …" : ""}`);
    if (overlaps.length) warn(`时间轴有 ${overlaps.length} 处区间重叠：${overlaps.slice(0, 5).join("、")}`);
    if (board.videoSec && cursor < board.videoSec - 0.05)
      err(`时间轴在 ${cursor.toFixed(3)}s 就结束了，源片长 ${board.videoSec}s，尾部有内容没被覆盖`);
  }

  return issues;
}
