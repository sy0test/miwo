import fs from "fs";
import path from "path";
import u from "@/utils";
import { error } from "@/lib/responseFormat";
import { checkRedrawOutput, extractBlock, parseAssetSheet, parseStoryboardTable, renderDialogueMap, writeRedraw } from "@/utils/redraw";
import type { RedrawAssetSheet } from "@/utils/redraw";
import {
  REDRAW_STAGE_KEY as REDRAW_STAGE_KEY_LOCAL,
  REDRAW_STAGES,
  persistStage as persistStageShared,
  readStage as readStageShared,
} from "@/utils/pipelineStage";

/**
 * 出海转绘 · 第 4 步的内核：把预处理产物喂给 redraw-analysis-skill，
 * 拿回 `<assetSheet>` + `<storyboardTable>` 并落库。
 *
 * 单独抽出来是因为有**两个入口**：
 *   1. `POST /api/redraw/analyzeVideo` —— 调用方自己指 `assetDir`（外部脚本产物，
 *      开发期用，也是第 4 步首验时跑的那条）
 *   2. `POST /api/redraw/analyzeSource` —— 源片来自 `o_script.sourceVideo`，
 *      由路由先跑预处理再进来（界面上的「开始分析」按钮）
 * 两边的拼 prompt / 调模型 / 解析 / 落库必须一模一样 —— 抄一份的话，
 * 迟早只有一边被修。
 *
 * 走的是**文本模型 + 图片内容块**，不是「把视频交给模型」：
 * 中继（真 OpenAI）不吃视频，而图片可以进、多图也收得到、还能准确读出烧进拼贴图的时间码。
 * 写法照 `src/routes/artStyle/extractStylePrompt.ts`，那是本仓库「文本模型收图」的现成先例。
 */

const SKILL_DIR = ["skills", "feicai", "redraw-analysis-skill"];
/** 技能正文 + 它引用的两个单点文档 */
const SKILL_FILES = ["SKILL.md", "localization-guide.md", "speech-rate.md"];
/** 技能部署 key。必须在 `ai.ts` 的 `AiTypeValues` 里，否则不走部署表（见 ai.ts:47 的白名单闸门）*/
const AGENT_KEY = "redrawAgent:analysisAgent";

/** 带 HTTP 状态码的错误。路由直接把 status 透出去，不再靠字符串匹配猜是哪一类 */
export class RedrawError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const fail = (status: number, message: string): never => {
  throw new RedrawError(status, message);
};

// ============================================================
// 解析产物的落库
// ============================================================

/**
 * `o_agentWorkData` 的一行 upsert。键法与读法照 `routes/production/getFlowData.ts:18-21`：
 * where 用 String()、insert 用数字；`key` 是区分同一集里不同产物的唯一开关
 * （基座把 `<scriptPlan>` 存进同一张表，key 用 "productionAgent"）。
 */
async function upsertWorkData(projectId: number, episodesId: number, key: string, value: unknown): Promise<void> {
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

/** 导演计划的工作区 key */
export const DIRECTOR_PLAN_KEY = "redrawDirectorPlan";
/** 资产清单草稿的工作区 key —— 解析层不落 o_assets，草稿先存这儿等关联层认账 */
export const ASSET_DRAFT_KEY = "redrawAssetDraft";
/**
 * 制作进度的工作区 key。
 *
 * 为什么需要它：决策层判断「当前在第几阶段」此前**只能靠 deepRetrieve 读记忆**，
 * 而记忆会被压缩/清空（换集、清记忆、摘要策略都会动它）——一清就失忆，于是把跑完的
 * 阶段重跑一遍、或跳错阶段。进度是**确定性状态**，不该存在会漂移的地方。
 *
 * 值形状：`{ stage: string, at: number }`。`stage` 取值沿用流水线阶段名，
 * 例：`"analysis"`（解析层完成，待对账）/ `"stage5"`（分镜面板写入完成）等。
 * 只记「最远已完成到哪」，不做阶段间回滚。
 */
export { REDRAW_STAGE_KEY } from "@/utils/pipelineStage";

/** 把制作进度写进工作区，供决策层在上下文里读取。顺序表见 pipelineStage 的 REDRAW_STAGES */
export async function persistStage(projectId: number, episodesId: number, stage: string): Promise<void> {
  await persistStageShared(projectId, episodesId, REDRAW_STAGE_KEY_LOCAL, stage, [...REDRAW_STAGES]);
}

/**
 * 读制作进度，供决策层上下文注入（`runDecisionAI` 调用）。
 * 读不到就返回 null —— 调用方据此把「进度未知」如实说出来，而不是当成某个默认阶段。
 */
export async function readStage(projectId: number, episodesId: number): Promise<string | null> {
  return readStageShared(projectId, episodesId, REDRAW_STAGE_KEY_LOCAL);
}

/** 把剧本写进 o_script.content —— 剧本页与生产页读的就是这一列 */
export async function persistScriptBody(scriptId: number, body: string): Promise<void> {
  await u.db("o_script").where("id", scriptId).update({ content: body.trim() });
}

/** 导演计划落工作区 */
export async function persistDirectorPlan(projectId: number, episodesId: number, plan: string): Promise<void> {
  await upsertWorkData(projectId, episodesId, DIRECTOR_PLAN_KEY, { plan: plan.trim() });
}

/**
 * 资产清单草稿落工作区 —— **不进 `o_assets`**。
 * 资产要等关联层跟用户认完账才落库，此处落库等于绕过用户。关联层从这一行读草稿。
 */
export async function persistAssetDraft(projectId: number, episodesId: number, sheet: RedrawAssetSheet): Promise<void> {
  await upsertWorkData(projectId, episodesId, ASSET_DRAFT_KEY, { assets: sheet.assets });
}

function loadSkill(): string {
  return SKILL_FILES.map((f) => fs.readFileSync(u.getPath([...SKILL_DIR, f]), "utf8")).join("\n\n---\n\n");
}

/** 转写稿压成紧凑词表 —— 原始 JSON 几十 KB，整份塞进去得不偿失 */
function formatTranscript(file: string): string {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  const lines: string[] = [];
  t.passages.forEach((p: any, i: number) => {
    lines.push(`### 段${i + 1}  ${p.start_seconds.toFixed(3)} - ${p.end_seconds.toFixed(3)}s`);
    lines.push(p.words.map((w: any) => `${w.text}[${w.start_seconds.toFixed(3)}-${w.end_seconds.toFixed(3)}]`).join(" "));
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * 切点表要进模型，把头部的内部实现注释（工具名、聚类参数）去掉。
 * 这些是给我们看的，模型只需要时间点和镜表。
 */
function sanitizeCuts(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^#\s*(来源|采样)/.test(l.trim()))
    .join("\n")
    .trim();
}

function readIf(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/** 分镜和 track 都挂在 scriptId 上，转绘项目至少要有「一集」 */
export async function resolveScriptId(projectId: number, given?: number): Promise<number> {
  if (given) return given;
  const hit = await u.db("o_script").where("projectId", projectId).first();
  if (hit?.id) return hit.id;
  const [id] = await u.db("o_script").insert({ name: "转绘源片", projectId, createTime: Date.now() });
  return id as number;
}

export type RedrawAnalyzeResult = {
  scriptId: number;
  assets: number;
  storyboards: number;
  missingAssetNames: string[];
  issues: ReturnType<typeof checkRedrawOutput>;
  /** 模型原文落盘位置（无条件落盘，见下面的注释） */
  outputPath: string;
  /** 台词对照表落盘位置（原台词 ↔ 转绘台词+回译）。写失败时为 undefined，不影响入库 */
  dialogueMapPath?: string;
  /** dryRun 时的 prompt 落盘位置 */
  promptPath?: string;
  /** 本次喂进去的素材规模，便于核对「是不是这批材料」 */
  grids: number;
  promptChars: number;
  systemChars: number;
  /** 剧本正文字符数（只回长度，不回正文 —— 正文在 o_script.content） */
  scriptBodyChars: number;
  /** 导演计划字符数（同上，正文在 o_agentWorkData） */
  directorPlanChars: number;
};

export type RedrawAnalyzeOpts = {
  projectId: number;
  /** 预处理产物目录（含 grid/ + cuts.txt + transcript.json + MANIFEST.md） */
  assetDir: string;
  scriptId?: number;
  /** 允许覆盖已有分镜。默认 false —— 重跑会抹掉界面上改过的内容 */
  replace?: boolean;
  /** 只拼 prompt、不调模型。零成本核对技能与材料装得对不对 */
  dryRun?: boolean;
};

export async function analyzeRedrawAssets(opts: RedrawAnalyzeOpts): Promise<RedrawAnalyzeResult> {
  const { projectId, assetDir, scriptId: given, replace, dryRun } = opts;

  const project = await u.db("o_project").where("id", projectId).first();
  // `return fail(...)` 而不是 `fail(...)`：fail 的返回类型是 never，
  // 但 TS 只在「return 一个 never 调用」时才把控制流判成终止，写裸调用后面对 project 的
  // 解引用会报「possibly undefined」。
  if (!project) return fail(400, `项目不存在：${projectId}`);

  // 目标国家是这条流程的定义性输入：技能靠它决定译成什么语言、换成哪国的文化符号。
  // 缺了它模型不会报错，只会自由发挥 —— 那就是烧一次调用换一堆错语言的产物。
  if (!project.targetCountry?.trim()) {
    return fail(400, `项目未设置「目标国家」，无法转绘：${project.name ?? projectId}`);
  }

  // ---- 材料 ----
  const gridDir = path.join(assetDir, "grid");
  if (!fs.existsSync(gridDir)) fail(400, `预处理产物不完整，缺 grid/：${assetDir}`);
  const grids = fs
    .readdirSync(gridDir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort()
    .map((f) => path.join(gridDir, f));
  if (!grids.length) fail(400, `grid/ 里没有图片：${gridDir}`);

  const manifest = readIf(path.join(assetDir, "MANIFEST.md"));
  const cuts = sanitizeCuts(readIf(path.join(assetDir, "cuts.txt")));
  const transcriptFile = path.join(assetDir, "transcript.json");
  if (!fs.existsSync(transcriptFile)) fail(400, `缺 transcript.json：${assetDir}`);
  const transcript = formatTranscript(transcriptFile);

  // 采样密度从 MANIFEST 里抠 —— 它是唯一权威，别在这儿重算。
  // `**` 必须可选：MANIFEST 里「采样密度」带粗体、「时长」不带，写死一个就静默退化。
  const density = (manifest.match(/(?:\*\*)?采样密度：(\d+(?:\.\d+)?)s\/格/) || [, "1"])[1];
  // 源片时长用于区间越界体检；抠不到就退化成不做这项体检（不是 0）
  const videoSec = Number((manifest.match(/(?:\*\*)?时长：([\d.]+)s/) || [])[1]) || undefined;

  // ---- 拼 prompt ----
  // 项目配置段与基座其它技能同构，技能据此锚定 {视觉风格} / {画面比例} / {目标国家}
  const text = [
    "## 项目配置",
    `- 视觉风格: ${project.artStyle?.trim() || "未指定"}`,
    `- 画面比例: ${project.videoRatio?.trim() || "16:9"}`,
    // 上面已经拦过空值，这里可以直接用
    `- 目标国家: ${project.targetCountry.trim()}`,
    "",
    "## 已有资产",
    "（无）",
    "",
    "---",
    "",
    "## 材料一 · 拼贴图",
    "",
    `共 ${grids.length} 张，见附图。**采样密度 ${density}s/格**，第 n 格的时刻 = (n-1) × ${density} 秒。`,
    "",
    "## 材料二 · 切点表",
    "",
    "```",
    cuts,
    "```",
    "",
    "## 材料三 · 转写稿（词级时间戳，`词[起-止]`）",
    "",
    transcript,
    "",
    "---",
    "",
    "按 [输出格式] 输出 `<scriptBody>`、`<directorPlan>`、`<assetSheet>` 与 `<storyboardTable>` 四个块。",
  ].join("\n");

  const system = loadSkill();

  // 带 .app 后缀是为了不覆盖 run-skill.cjs 的产物 —— 两边要能并排看，不能相互抹掉
  if (dryRun) {
    const dump = path.join(assetDir, "skill-prompt.app.txt");
    fs.writeFileSync(dump, text, "utf8");
    return {
      scriptId: given ?? (await resolveScriptId(projectId)),
      assets: 0,
      storyboards: 0,
      missingAssetNames: [],
      issues: [],
      outputPath: "",
      promptPath: dump,
      grids: grids.length,
      promptChars: text.length,
      systemChars: system.length,
      // dryRun 不调模型，两个新块自然没有
      scriptBodyChars: 0,
      directorPlanChars: 0,
    };
  }

  // 不传 maxOutputTokens：全站部署行的这一列都是 0，即所有 Agent 都吃供应商默认值。
  // 这里硬写一个数会让本路由成为唯一例外 —— 若该模型要的是 max_completion_tokens，
  // 就是一次必然的 400。截断风险由 checkRedrawOutput 兜底，会响得很清楚。
  const out = await u.Ai.Text(AGENT_KEY).invoke({
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text" as const, text },
          ...grids.map((f) => ({
            type: "image" as const,
            image: fs.readFileSync(f).toString("base64"),
          })),
        ],
      },
    ],
  });

  const reply = out.text ?? "";
  // **无条件落盘**：只在失败时存，会让「跑通了但体检报错」变成没法复盘的盲区
  // （第一次遇到「头写 12s、镜时长之和 22s」就是这样，原文没存，只能靠猜）。
  // 带 .app 后缀是为了不覆盖 run-skill.cjs 的产物。
  const dump = path.join(assetDir, "skill-output.app.md");
  fs.writeFileSync(dump, reply, "utf8");

  const scriptBlock = extractBlock(reply, "scriptBody");
  const planBlock = extractBlock(reply, "directorPlan");
  const sheetBlock = extractBlock(reply, "assetSheet");
  const boardBlock = extractBlock(reply, "storyboardTable");
  if (!scriptBlock || !planBlock || !sheetBlock || !boardBlock) {
    const miss = [
      !scriptBlock && "<scriptBody>",
      !planBlock && "<directorPlan>",
      !sheetBlock && "<assetSheet>",
      !boardBlock && "<storyboardTable>",
    ]
      .filter(Boolean)
      .join(" ");
    fail(422, `模型回复里缺块：${miss}。回复 ${reply.length} 字符，原文已存 ${dump}`);
  }

  const sheet = parseAssetSheet(sheetBlock!);
  const board = parseStoryboardTable(boardBlock!, videoSec);
  const issues = checkRedrawOutput(sheet, board);

  const sid = await resolveScriptId(projectId, given);
  // 解析层只写分镜、不建资产：资产要等关联层跟用户认完账（skipAssets 见 redraw.ts）。
  const written = await writeRedraw(u.db, { projectId, scriptId: sid, sheet, board, replace, skipAssets: true });

  // 剧本、导演计划、资产清单草稿 —— 三个新产物，和分镜表同一次调用产出。
  // 都放在 writeRedraw 之后：它负责建/复用 o_script 行。
  await persistScriptBody(sid, scriptBlock!);
  await persistDirectorPlan(projectId, sid, planBlock!);
  await persistAssetDraft(projectId, sid, sheet);

  // 台词对照表：原台词（中文）↔ 转绘台词（目标语言 + 回译）。给人核对的，落产物目录。
  // **失败不能拖垮这一轮** —— 分镜已经入库了，写不出这份 md 只是少一份参考，
  // 不能让「分析成功」变成失败。
  const script = await u.db("o_script").where("id", sid).first();
  const mapPath = path.join(assetDir, "dialogue-map.md");
  let dialogueMapPath: string | undefined;
  try {
    fs.writeFileSync(
      mapPath,
      renderDialogueMap(board.shots, {
        // 库里这几列可空，`meta` 收 string | undefined —— `?? undefined` 把 null 归一掉
        projectName: project.name ?? undefined,
        targetCountry: project.targetCountry ?? undefined,
        scriptName: script?.name ?? undefined,
      }),
      "utf8",
    );
    dialogueMapPath = mapPath;
  } catch (e: any) {
    console.log(`[redraw/analyze] 台词对照表没写成（不影响入库）：${e?.message ?? e}`);
  }

  return {
    scriptId: sid,
    assets: Object.keys(written.assetIds).length,
    storyboards: written.storyboardIds.length,
    missingAssetNames: written.missingAssetNames,
    issues,
    outputPath: dump,
    dialogueMapPath,
    grids: grids.length,
    promptChars: text.length,
    systemChars: system.length,
    scriptBodyChars: scriptBlock!.trim().length,
    directorPlanChars: planBlock!.trim().length,
  };
}

/** 路由里统一把异常翻成响应。RedrawError 带自己的状态码，其余一律 500 */
export function sendRedrawError(res: any, e: any): void {
  const status = e instanceof RedrawError ? e.status : 500;
  // 中继的报错正文在 responseBody 上（AI SDK 抛的是 APICallError，不是 axios 形状），
  // normalizeError 只取得到 message，那往往就剩一句 "Bad Request"。
  const body = typeof e?.responseBody === "string" ? ` | ${e.responseBody.slice(0, 400)}` : "";
  res.status(status).send(error(`${u.error(e).message}${body}`));
}
