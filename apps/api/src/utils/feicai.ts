import fs from "fs";
import getPath from "@/utils/getPath";

/**
 * feicai 技能读取器。
 *
 * 取代原 `getArtPrompt`（按 art_skills/<风格目录>/<分节>.md 取手册）。
 * 现在技能来源固定，项目字段（artStyle/videoRatio）只作为变量拼进「## 项目配置」。
 *
 * 目录约定：
 *   data/skills/feicai/<skill-name>/SKILL.md   —— 参与 activate_skill 的技能（批量模式）
 *   data/skills/feicai/<skill-name>/<资源>.md  —— 技能资源，按需读取
 *   data/skills/feicai/style-guide.md          —— 风格约束块（非技能，直接注入）
 */

const SKILL_ROOT = ["skills", "feicai"];

/** 读取 feicai 目录下的文件，缺失时返回空串 */
function read(...segments: string[]): string {
  const file = getPath([...SKILL_ROOT, ...segments]);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** 技能目录下的资源路径（供 activate_skill 的 read_skill_file 使用） */
export function feicaiSkillDir(skillName: string): string {
  return getPath([...SKILL_ROOT, skillName]);
}

export type AssetKind = "role" | "scene" | "tool";

const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  role: "角色",
  scene: "场景",
  tool: "道具",
};

/** 资产类型对应的示例文件（道具暂无示例） */
const ASSET_EXAMPLE_FILE: Record<AssetKind, string> = {
  role: "character-prompt-examples.md",
  scene: "scene-prompt-examples.md",
  tool: "",
};

type ProjectConfigSource = {
  artStyle?: string | null;
  videoRatio?: string | null;
  /** 出海转绘专用。留空则不输出该行（非转绘流程不受影响） */
  targetCountry?: string | null;
};

/**
 * 资产参考图固定出图比例。
 *
 * 项目「画面比例」是**成片**比例，与资产参考图无关——资产图一律 16:9 横构图，
 * 不随项目画面比例变化（9:16 的竖屏项目也出 16:9 的资产图）。
 * 注意：gpt-image 系中继不看 size 参数、成图比例由提示词文字决定，故必须写死进配置段。
 */
export const ASSET_ASPECT_RATIO = "16:9";

/**
 * 白底资产（角色 / 道具）的「不透明纯白画布」硬性后缀。
 *
 * 文生图模型常把「白色干净背景」理解成抠图底，输出带 alpha 的透明 PNG（前端显示为棋盘格）。
 * 中继的 gpt-image 系不看 size 参数、成图完全由提示词文字决定，故必须在提示词里显式声明画布不透明。
 */
export const OPAQUE_WHITE_CANVAS_CLAUSE =
  "输出为完整的16:9不透明画布，整张画布从边缘到边缘均填充纯白色（#FFFFFF）。背景必须是实心白色像素，不得透明、不得有 alpha 通道，不得出现棋盘格。";

/** 适用白底画布声明的资产类型：仅角色与道具。场景是完整环境呈现，严禁追加 */
const WHITE_CANVAS_KINDS: AssetKind[] = ["role", "tool"];

/** 幂等标记：提示词里已含该声明（skill 已写入或上一次已追加）时不重复追加 */
const OPAQUE_WHITE_CANVAS_MARK = "不透明画布";

/**
 * 给角色 / 道具的提示词追加不透明白底画布声明，保证送进文生图模型的是白底方图。
 *
 * 场景以及未知类型（如 storyboard）原样返回；提示词为空时返回空串。
 * 已含声明时不重复追加——skill 正文与代码兜底两条路都走，必须幂等。
 */
export function withOpaqueWhiteCanvas(prompt: string | null | undefined, kind?: string | null): string {
  const text = (prompt ?? "").trim();
  if (!text) return "";
  if (!WHITE_CANVAS_KINDS.includes(kind as AssetKind)) return text;
  if (text.includes(OPAQUE_WHITE_CANVAS_MARK)) return text;
  return `${text}\n${OPAQUE_WHITE_CANVAS_CLAUSE}`;
}

/** 项目级配置段：feicai 技能据此锚定 visualStyle / aspectRatio / 目标国家 */
export function buildProjectConfig(project?: ProjectConfigSource | null, opts?: { aspectRatio?: string }): string {
  const visualStyle = project?.artStyle?.trim() || "未指定";
  const aspectRatio = opts?.aspectRatio?.trim() || project?.videoRatio?.trim() || "16:9";
  const lines = ["## 项目配置", `- 视觉风格: ${visualStyle}`, `- 画面比例: ${aspectRatio}`];
  const targetCountry = project?.targetCountry?.trim();
  if (targetCountry) lines.push(`- 目标国家: ${targetCountry}`);
  return lines.join("\n");
}

/**
 * 资产提示词的 system prompt（服化道 · 单资产模式）。
 *
 * 取代 polishesPrompt / batchPolishAssetsPrompt / batchGenerateAssetsImage 里
 * `getArtPrompt(artStyle, "art_skills", "art_character")` 这类按手册目录取文件的做法。
 *
 * @param parentDescribe 衍生资产时父级资产的描述，用于保证造型延续性
 */
export function buildAssetPromptSystem(opts: {
  project?: { artStyle?: string | null; videoRatio?: string | null } | null;
  kind: AssetKind;
  parentDescribe?: string | null;
}): string {
  const { project, kind, parentDescribe } = opts;
  const blocks: string[] = [];

  const base = read("art-design-skill", "single-asset.md");
  if (base) blocks.push(base);

  const exampleFile = ASSET_EXAMPLE_FILE[kind];
  if (exampleFile) {
    const example = read("art-design-skill", "examples", exampleFile);
    if (example) blocks.push(`## ${ASSET_KIND_LABEL[kind]}提示词示例\n${example}`);
  }

  if (parentDescribe?.trim()) {
    blocks.push(
      [
        "[衍生资产模式]",
        "    本资产是已有资产的衍生版本（换装 / 造型变化 / 状态变化），不是全新资产。",
        "    - 必须与父级资产的核心识别特征保持一致：脸型、五官、发型基本形态、体型、气质",
        "    - 只改变本次描述中指定的部分，其余保持延续",
        "    - 出图布局与父级资产保持一致",
        "    - 在提示词中体现与父级资产的关联，但不要引用父级资产的提示词原文",
      ].join("\n"),
    );
  }

  // 资产图比例与成片比例解耦：一律 16:9（见 ASSET_ASPECT_RATIO 注释）
  blocks.push(buildProjectConfig(project, { aspectRatio: ASSET_ASPECT_RATIO }));
  return blocks.join("\n\n---\n\n");
}

/**
 * 分镜 / 视频提示词的风格约束块。
 *
 * 取代 `getArtPrompt(artStyle, "art_skills", "art_storyboard_video")`
 * —— 原实现是按画风硬编码的英文标签表，只有少数画风目录存在。
 */
export function buildStyleGuide(project?: { artStyle?: string | null; videoRatio?: string | null } | null): string {
  const guide = read("style-guide.md");
  return [guide, buildProjectConfig(project)].filter(Boolean).join("\n\n---\n\n");
}
