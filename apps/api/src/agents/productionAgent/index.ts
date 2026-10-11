import { Socket } from "socket.io";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { createSkillTools, parseFrontmatter, scanSkills } from "@/utils/agent/skillsTools";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import { readProductionStage, persistProductionStage } from "@/utils/pipelineStage";
import { buildBriefBlock, loadBrief, mergeBrief, saveBrief } from "@/utils/shots/episodeBrief";
import { runShotsShadow } from "@/utils/shots/shadowJob";
import { buildIssuesInstruction, parseIssueList, locateAll } from "@/utils/shots/supervisionIssues";
import { readShotsForScript } from "@/utils/shots/readShots";

/**
 * 各层的**数据工具白名单**（`useTools` 的 toolsNames）。
 *
 * ⚠ 分层契约原来**只写在提示词里**：`useTools()` 不传 `toolsNames` 会返回全部 6 个数据工具，
 * 于是
 *   · 决策层（技能明令「不读工作区、不直接操作资产/分镜」）手上握着 `get_flowData` /
 *     `add_flowData_storyboard` / `add_deriveAsset` / `generate_*` —— 模型一不守规矩就绕过执行层写数据；
 *   · 监督层（技能明令「只提问题，不做任何修改」）同样握着全部写工具。
 * 提示词约束不住模型，但**工具集能**：不给就不会调。这些常量就是那道闸门。
 *
 * 注意：决策层的白名单是**空集**，所以它在 `runDecisionAI` 里直接不挂任何数据工具
 * （没有 `useTools(...)` 可传），这里不为它定义常量，避免"定义了却没人用"的误导。
 */

/** 监督层：只允许读。审核靠读工作区出报告，绝不允许改数据 */
const OPS_READONLY_TOOLS = ["get_flowData"];
/** 各阶段子 Agent 的数据工具白名单：只给**它真正需要**的那几个 */
const SCRIPTS_AGENT_TOOLS = ["get_flowData"]; // 阶段4：只读剧本/资产/拍摄计划
const DERIVE_ASSETS_TOOLS = ["get_flowData", "add_deriveAsset"]; // 阶段2：读 + 写衍生资产
const GENERATE_ASSETS_TOOLS = ["get_flowData", "generate_deriveAsset"]; // 阶段3：读 + 发起资产出图
const STORYBOARD_PANEL_TOOLS = ["get_flowData", "add_flowData_storyboard"]; // 阶段5：读 + 写面板
const STORYBOARD_GEN_TOOLS = ["get_flowData", "generate_storyboard"]; // 阶段6：读 + 发起分镜出图

/** `stageResults` 里存「本轮监督层审核报告」的键（不是阶段名，用于去重） */
const SUPERVISION_DONE_KEY = "__supervision__";
import * as fs from "fs";
import path from "path";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  // 阶段3：用户原话单独置顶、逐字保留 —— 口头硬约束（"台词只保留英文题词口播"这类）
  // 只存在于原句里，一旦被摘要化就再也回不来。
  const userQuotes = (mem as any).userQuotes ?? [];
  if (userQuotes.length) {
    memoryContext += `[用户原话（逐字保留，优先级最高，不得违反）]\n${userQuotes.map((m: any, i: number) => `${i + 1}. ${m.content}`).join("\n")}`;
  }
  if (mem.rag.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text);

  const skill = path.join(u.getPath("skills"), "production_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  // const isRef = findData.mode.every((i: any) => Array.isArray(i));

  // 模型信息 + 项目配置（视觉风格 / 画面比例）：后者与资产链、视频提示词链同一份来源，
  // 缺它则子 Agent 上下文里没有视觉风格，分镜提示词与分镜图的画风无从锚定。
  const modelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n多参：${isRef ? "是" : "否"}\n\n${u.feicai.buildProjectConfig(projectInfo)}`;
  // 本集约定（用户明确提的硬约束，存 o_script.brief）：**由代码注入**，不靠模型从记忆里复述。
  // 拼进 modelInfo 是有意的 —— 决策层、每个执行层、监督层本来就会收到 modelInfo，
  // 这样一处改动就让四层都看得到（此前只有决策层记得，执行层/监督层根本读不到）。
  const briefBlock = ctx.resTool.data.scriptId != null ? buildBriefBlock(await loadBrief(u.db, Number(ctx.resTool.data.scriptId))) : "";
  const modelCtx = modelInfo + (briefBlock ? `\n\n${briefBlock}` : "");

  const mem = buildMemPrompt(await memory.get(text));

  /**
   * 口头硬约束**落成集级数据**（`o_script.brief`）。
   *
   * 为什么必须有这个工具：用户的原话会被压缩成摘要、执行层更是完全不读记忆 ——
   * 所以「台词只保留英文题词口播」这种要求原来只能靠决策层在派发文案里转述（≤100 字，还会丢）。
   * 落库之后由代码在每次派发时注入**决策层/执行层/监督层**三层，不再依赖模型记性。
   */
  const setEpisodeBrief = tool({
    description:
      "记录/更新本集约定（用户明确提出的硬约束：台词语言、必须/禁止项、格式要求等）。用户提出或修改这类要求时**立即调用**；记录后所有阶段（含监督层）都会收到。",
    inputSchema: jsonSchema<{ constraints?: string[]; dialogueLanguage?: string; dialogueSource?: "script-original" | "free"; notes?: string }>(
      z
        .object({
          constraints: z.array(z.string()).optional().describe("用户明确的硬约束，逐条写原话（如「台词只保留英文题词口播」）"),
          dialogueLanguage: z.string().optional().describe("台词语言：zh=中文 / en=英文 / 其它；不确定就别传"),
          dialogueSource: z
            .enum(["script-original", "free"])
            .optional()
            .describe("台词来源：script-original=必须逐字来自剧本原文（不得改写或翻译）；free=允许自由撰写"),
          notes: z.string().optional().describe("其它补充说明（可选）"),
        })
        .toJSONSchema(),
    ),
    execute: async (patch) => {
      const scriptId = ctx.resTool.data.scriptId;
      if (scriptId == null) return "当前没有指定集（scriptId 为空），无法记录本集约定；请先让用户选定剧集。";
      const prev = await loadBrief(u.db, Number(scriptId));
      const next = mergeBrief(prev, patch ?? {});
      await saveBrief(u.db, Number(scriptId), next);
      console.log(
        `[productionAgent][本集约定] ep=${scriptId} 已更新：约定 ${next.constraints.length} 条；台词语言=${next.dialogueLanguage ?? "-"}；台词来源=${next.dialogueSource ?? "-"}`,
      );
      return `已记录本集约定（决策层/执行层/监督层同时生效）：\n${buildBriefBlock(next)}`;
    },
  });

  // 制作进度：确定性状态，从 o_agentWorkData 读，不靠记忆。
  // 记忆会被换集/清记忆/摘要策略改写，一旦丢了决策层就无从判断当前在第几阶段，
  // 表现为「把跑完的阶段重跑一遍」或跳错阶段。读不到就如实说未知。
  const stage = ctx.resTool.data.scriptId != null ? await readProductionStage(Number(ctx.resTool.data.projectId), Number(ctx.resTool.data.scriptId)) : null;  const stageInfo = `\n\n## 制作进度\n当前进度：${stage ?? "未知（库里没有进度记录，可能是新会话或还没跑过任何阶段）"}`;

  const { fullStream } = await u.Ai.Text("productionAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: mem + "\n" + modelCtx + stageInfo },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      // 口头硬约束落库（阶段3）：不挂这个工具，用户的要求就只能靠决策层转述 → 到执行层就丢
      set_episode_brief: setEpisodeBrief,
      // ⚠ 这里**故意不挂任何数据工具**（原来 `useTools({resTool,msg})` 不传 toolsNames = 给全部 6 个）。
      // 技能 `production_agent_decision.md` 的红线是「不读取工作区数据（不调用 get_flowData）、
      // 不直接操作任何资产或分镜数据」——原来这条只写在提示词里，代码却把 6 个写工具全给了它，
      // 模型一不守规矩就绕过执行层写数据。现在由工具集本身保证：不给就不会调。
      ...(await createSubAgent(ctx)),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  let currentMsg = ctx.msg;
  await consumeFullStream(fullStream, currentMsg, () => {
    if (ctx.msg === currentMsg) return currentMsg;
    currentMsg.complete();
    currentMsg = ctx.msg;
    return currentMsg;
  });
}

async function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
  /**
   * 本轮各阶段的产出摘要（阶段名 → 一句话结果）。
   * 用途：派监督层时作为上下文交给它 —— 监督层原本只拿到决策层那句百字派发文案，
   * 没有可比对的产出，很容易「空审核给 A」。
   */
  const stageResults = new Map<string, string>();
  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    toolsNames,
    stage,
    messages,
  }: {
    key: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    /** 数据工具白名单：不传则不给任何数据工具（原来不传等于给全部 6 个） */
    toolsNames?: string[];
    /** 阶段名。传了就把产出摘要记进 stageResults，供监督层做上下文 */
    stage?: string;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);

    const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
      system,
      messages: messages ?? [{ role: "user", content: prompt }],
      abortSignal,
      // toolsNames 必须显式传：不传时 useTools 会返回**全部**数据工具，
      // 各阶段的「只读/只写自己那一类」约束就形同虚设。
      tools: { ...extraTools, ...useTools({ resTool, msg: subMsg, toolsNames }) },
    });

    const fullResponse = await consumeFullStream(fullStream, subMsg);

    // 记一句产出摘要（截断），派监督层时作为上下文 —— 否则监督层无物可审
    if (stage && fullResponse.trim()) stageResults.set(stage, fullResponse.trim().slice(0, 300));

    // 把「最远已完成到哪个阶段」落库。
    // ⚠ 此前只有转绘在写进度，生产六阶段从不写：决策层每次读到 null，就说
    // 「当前制作进度显示为"未知"，且没有检索到可确认的阶段记录」—— 用户刚跑完阶段1，
    // 决策层却不知道，于是反复要求确认、甚至重跑已完成的阶段。
    // 落在工作区（o_agentWorkData）而不是记忆里：记忆会被压缩/清空，进度是确定性状态。
    if (stage && fullResponse.trim() && parentCtx.resTool.data.scriptId != null) {
      try {
        await persistProductionStage(Number(parentCtx.resTool.data.projectId), Number(parentCtx.resTool.data.scriptId), stage);
      } catch (e) {
        // 进度写失败不该让整个阶段判失败：产出一旦生成就有价值，最多是下次仍显示"未知"
        console.error("[productionAgent] 写入制作进度失败：", u.error(e).message);
      }
    }

    if (fullResponse.trim()) {
      // 阶段3：**执行层产出不再进记忆池**。
      // 理由：① 权威副本在数据库/工作区（阶段进度 `o_agentWorkData`、结构化表 o_segment/o_shot）；
      //       ② 六阶段的大段文本会挤占决策层上下文，还会被向量召回顶掉真正有用的对话；
      //       ③ 决策层要"知道发生过什么"，靠 persistProductionStage 的阶段进度 + 本轮工具返回值就够；
      //          要看正文就读工作区（get_flow_data / 新表），不要靠记忆。
      console.log(
        `[productionAgent] 执行层产出未入记忆池：阶段=${stage ?? "-"} 名称=${name ?? "-"} 长度=${fullResponse.length}（权威副本在数据库/工作区）`,
      );
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    return fullResponse;
  }

  /**
   * 跑监督层审核（只读）。
   *
   * 抽成独立函数是为了让**阶段4 完成后能直接调它**，而不是靠决策层"记得"派发 ——
   * 技能 `production_agent_decision.md` 写的是「阶段4 执行完毕后紧接着**自动调用**监督层」，
   * 但原来这纯属提示词约定：`run_sub_agent_storyboard_table` 的 execute 只是
   * `return runAgent(...)`，模型漏了这一步，**整道质量门就没人跑**，用户要到后面阶段返工才发现。
   *
   * 失败不抛出：审核跑不起来不该把阶段4 的产出一起判失败（产出已经落库了）。
   */
  async function runSupervisionAgent(prompt: string): Promise<string> {
    const skill = path.join(u.getPath("skills"), "production_agent_supervision.md");
    const systemPrompt = await fs.promises.readFile(skill, "utf-8");
    // 给足上下文：原来只把决策层那句百字派发文案丢给它（连 modelInfo 都没有），
    // 监督层「只查违规词表」时其实没有可比对的东西 —— 很容易给一个 A 就收尾，质量门形同虚设。
    const stageContext =
      `## 项目配置\n${modelInfo}\n\n## 本轮各阶段产出摘要\n` +
      (stageResults.size
        ? [...stageResults.entries()].map(([stage, summary]) => `- ${stage}：${summary}`).join("\n")
        : "（本轮尚未产生任何阶段产出——若你是被派来审核某个产出，说明它还没跑，请如实说明这一点，不要凭空给通过）");
    const report = await runAgent({
      key: "productionAgent:supervisionAgent",
      prompt: prompt + "\n\n" + buildIssuesInstruction(),
      system: systemPrompt,
      name: "监制",
      memoryKey: "assistant:supervision",
      // 监督层只读：技能明令「只提出问题和建议，不做任何修改决策」
      toolsNames: OPS_READONLY_TOOLS,
      messages: [
        { role: "assistant", content: stageContext },
        { role: "user", content: prompt + "\n\n" + buildIssuesInstruction() },
      ],
    });

    // ---- 阶段1 补强：把自由文本里的问题**结构化 + 定位到行** ----
    // 旧链路：报告是散文，决策层只能转述 → 丢项、无审计、修复定位不到行。
    // 现在：解析 `<issues>` → 映射到 o_segment/o_shot 行 id → 写工作区（productionIssues）。
    try {
      const parsedIssues = parseIssueList(report);
      if (parsedIssues.ok) {
        const rows = resTool.data.scriptId != null ? await readShotsForScript(u.db, Number(resTool.data.scriptId)) : { segments: [], shots: [] };
        const { located, matched, unmatched } = locateAll(parsedIssues.issues, rows);
        const summary = `[代码解析结果] 结构化问题 ${located.length} 条；已定位 ${matched} 条；未定位 ${unmatched} 条`;
        console.log(
          `[productionAgent][监督层结构化] ep=${resTool.data.scriptId} ${summary}` +
            (located.length ? `｜明细：${located.map((i) => `${i.where}${i.shotId ? `(#${i.shotId})` : i.segmentId ? `(seg#${i.segmentId})` : "(未定位)"}`).join(" / ")}` : ""),
        );
        // 写工作区（审计 + 下游可读）：与 saveFlowData 同一张表、同一 (projectId, episodesId, key) 口径
        if (resTool.data.scriptId != null && resTool.data.projectId != null) {
          const payload = JSON.stringify({ scriptId: Number(resTool.data.scriptId), issues: located, summary: summary, time: Date.now() });
          const now = Date.now();
          const exist = await u
            .db("o_agentWorkData")
            .where("projectId", String(resTool.data.projectId))
            .andWhere("episodesId", String(resTool.data.scriptId))
            .andWhere("key", "productionIssues")
            .first();
          if (exist) {
            await u
              .db("o_agentWorkData")
              .where("projectId", String(resTool.data.projectId))
              .andWhere("episodesId", String(resTool.data.scriptId))
              .andWhere("key", "productionIssues")
              .update({ data: payload, updateTime: now });
          } else {
            // createTime/updateTime 一起写：否则审计行的时间是空的（真机上看到的 1970 就是这个原因）
            await u.db("o_agentWorkData").insert({ projectId: Number(resTool.data.projectId), episodesId: Number(resTool.data.scriptId), key: "productionIssues", data: payload, createTime: now, updateTime: now });
          }
        }
        // 把机器可读结论附在报告末尾回给决策层（它不用再"猜"问题在哪一行）
        return `${report}\n\n${summary}` + (located.length ? `\n- 结构化明细已写入工作区（key=productionIssues），可按 镜ID 定位到行。` : "");
      }
      console.warn("[productionAgent][监督层结构化] 报告里没有 <issues> 块（按旧口径处理，不影响流程）");
    } catch (e: any) {
      console.error("[productionAgent][监督层结构化] 解析/落库异常（不影响审核结论）：", u.error(e).message);
    }
    return report;
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
    })
    .toJSONSchema();

  const projectInfo = await u.db("o_project").where("id", resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  const artSkills = await createArtSkills();

  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  //
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;

  // 模型信息 + 项目配置（视觉风格 / 画面比例）：后者与资产链、视频提示词链同一份来源，
  // 缺它则子 Agent 上下文里没有视觉风格，分镜提示词与分镜图的画风无从锚定。
  const baseModelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n多参：${isRef ? "是" : "否"}\n\n${u.feicai.buildProjectConfig(projectInfo)}`;
  // 同 runDecisionAI：把「本集约定」拼进 modelInfo，于是**每个执行层 + 监督层**都自动带上
  // （各阶段的 messages 里注入的都是这个变量），不用逐个改。
  const layerBriefBlock = resTool.data.scriptId != null ? buildBriefBlock(await loadBrief(u.db, Number(resTool.data.scriptId))) : "";
  const modelInfo = baseModelInfo + (layerBriefBlock ? `\n\n${layerBriefBlock}` : "");

  // const run_sub_agent_execution = tool({
  //   description: "执行层子Agent，负责衍生资产、",
  //   inputSchema: promptInput,
  //   execute: async ({ prompt }) => {
  //     const skill = path.join(u.getPath("skills"), "production_agent_execution.md");
  //     const systemPrompt = await fs.promises.readFile(skill, "utf-8");
  //     const addPrompt =
  //       "\n" +
  //       [
  //         "你必须使用如下XML格式写入工作区：\n```",
  //         "拍摄计划：<scriptPlan>内容</scriptPlan>",
  //         "分镜表：<storyboardTable>内容</storyboardTable>",
  //         "分镜面板：<storyboardItem videoDesc='视频描述' prompt=提示词内容 track='分组' duration='视频推荐时间' associateAssetsIds='[该分镜所需的资产ID列表]'></storyboardItem>",
  //         "```",
  //       ].join("\n");

  //     return runAgent({
  //       prompt,
  //       system: systemPrompt + addPrompt,
  //       name: "执行导演",
  //       memoryKey: "assistant:execution",
  //       messages: [
  //         { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
  //         { role: "user", content: prompt + addPrompt },
  //       ],
  //       tools: { ...artSkills.tools },
  //     });
  //   },
  // });

  //衍生资产分析与信息写入
  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_derive_assets.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      return runAgent({
        key: "productionAgent:deriveAssetsAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: DERIVE_ASSETS_TOOLS,
        stage: "阶段2 衍生资产分析",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  //衍生资产图片生成
  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_generate_assets.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      return runAgent({
        key: "productionAgent:generateAssetsAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: GENERATE_ASSETS_TOOLS,
        stage: "阶段3 衍生资产生成",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  //拍摄计划
  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_director_plan.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt = "\n你必须使用如下XML格式写入工作区：\n```\n<scriptPlan>内容</scriptPlan>\n```";

      return runAgent({
        key: "productionAgent:directorPlanAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: SCRIPTS_AGENT_TOOLS,
        stage: "阶段1 导演规划",
        // 阶段1 正文（production_execution_director_plan.md）三处声明「不激活、不加载任何
        // 技法 / skill」，因此这里不注入任何技能工具箱——否则模型会同时拿到「不许加载技法」
        // 与一份可激活的技法清单，服化道规则会被带进拍摄计划。
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt + addPrompt },
        ],
      });
    },
  });

  //分镜图生成
  const run_sub_agent_storyboard_gen = tool({
    description: "运行执行subAgent来完成分镜图生成相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_gen.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      return runAgent({
        key: "productionAgent:storyboardGenAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: STORYBOARD_GEN_TOOLS,
        stage: "阶段6 分镜图生成",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  // const mainSkills: { path: string; name: string; description: string }[] = [];
  // for (const skill of mainSkill) {
  //   const skillPath = path.join(rootDir, skill + ".md");
  //   if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
  //   if (!isPathInside(skillPath, normalizedRootDir)) throw new Error(`技能名称无效：检测到路径穿越。${skillPath}`);
  //   const content = await fs.promises.readFile(skillPath, "utf-8");
  //   const parsed = parseFrontmatter(content);
  //   mainSkills.push({ path: skillPath, ...parsed });
  // }

  const productionSkills = await useProductionSkills();

  //分镜面板写入
  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      // ---- 引擎开关闸门：切到结构化分镜（o_setting.shotsEngine = "v2"）后，面板由代码从 o_segment 生成 ----
      // 阶段5 必须停：否则它会往 o_storyboard/o_videoTrack 再写一份（两套真身 + 又要对账/孤儿清理）。
      // 返回一句明确说明，让决策层不要重试、也不要以为任务失败。
      try {
        const engineRow = await u.db("o_setting").where("key", "shotsEngine").first();
        if (engineRow?.value === "v2") {
          return (
            "本集已切换为结构化分镜（o_segment / o_shot）：分镜面板与视频卡片由代码直接生成，" +
            "**无需执行阶段5**，也不要调用任何面板写入工具。请直接告诉用户「面板已由新链路生成」，进入下一步。"
          );
        }
      } catch (e: any) {
        console.error("[productionAgent] 读取 shotsEngine 失败（按旧流程继续）：", u.error(e).message);
      }

      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_panel.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt =
        "\n你必须使用如下XML格式写入工作区：\n```\n<storyboardItem videoDesc='视频描述' prompt=提示词内容 track='分组' shouldGenerateImage='true/false' duration='视频推荐时间' associateAssetsIds='[该分镜所需的资产ID列表]'></storyboardItem>\n```";

      return runAgent({
        key: "productionAgent:storyboardPanelAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: STORYBOARD_PANEL_TOOLS,
        stage: "阶段5 分镜面板写入",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + addPrompt },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
    },
  });

  //分镜表写入
  const run_sub_agent_storyboard_table = tool({
    description: "运行执行subAgent来完成分镜表构建相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_table.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt = "\n你必须使用如下XML格式写入工作区：\n```\n<storyboardTable>内容</storyboardTable>\n```";

      const result = await runAgent({
        key: "productionAgent:storyboardTableAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        toolsNames: SCRIPTS_AGENT_TOOLS,
        stage: "阶段4 构建分镜表",
        // 阶段4 正文（production_execution_storyboard_table.md）两处声明「不激活任何技法 /
        // skill」。此前这里注入的技能箱里装的正是**给阶段5 用的**提示词技法
        // （storyboard_prompt_techniques：解析映射 / 景别词库 / 输出格式），与本阶段的分镜表
        // 字段口径无关，只会让模型同时拿到两套口径。故不再注入。
        messages: [
          { role: "assistant", content: modelInfo },
          { role: "user", content: prompt + addPrompt },
        ],
      });

      // ---- 阶段4 影子落库：解析这张分镜表 → 校验 → 写 o_segment/o_shot/o_shotAssets ----
      // 只写不读：失败只记日志，绝不影响阶段4 的返回值与用户看到的结果。
      // 是否顺带做「按片段局部修复」由设置 shotsAutoRepair 控制（默认关，只出计划+日志）。
      let coverageHint = "";
      try {
        const autoRepair = (await u.db("o_setting").where("key", "shotsAutoRepair").first())?.value === "1";
        // 拍摄计划（scriptPlan）当权威清单：核对分镜表是否"只写了一小段"（真机出现过只写场1片段一）
        let planText: string | null = null;
        try {
          const wdPlan = await u
            .db("o_agentWorkData")
            .where("projectId", String(resTool.data.projectId))
            .andWhere("episodesId", String(resTool.data.scriptId))
            .andWhere("key", "productionAgent")
            .select("data")
            .first();
          const planVal = wdPlan?.data ? JSON.parse(wdPlan.data)?.scriptPlan : "";
          planText = typeof planVal === "string" ? planVal : null;
        } catch (e: any) {
          console.error("[productionAgent] 读取拍摄计划失败（覆盖度校验跳过）：", u.error(e).message);
        }
        const shadow = await runShotsShadow({
          db: u.db,
          projectId: Number(resTool.data.projectId),
          scriptId: Number(resTool.data.scriptId),
          replyText: result,
          planText,
          autoRepair,
          callModel: autoRepair
            ? async (prompt: string) => {
                // 用阶段4 自己的技能正文当 system，只让它重写被点名的那一个片段
                const skillPath = path.join(u.getPath("skills"), "production_execution_storyboard_table.md");
                const skillText = await fs.promises.readFile(skillPath, "utf-8");
                const { text } = await u.Ai.Text("productionAgent:storyboardTableAgent").invoke({
                  system: skillText,
                  messages: [{ role: "user", content: prompt }],
                });
                return text;
              }
            : undefined,
        });
        console.log(
          `[productionAgent][影子落库] ep=${resTool.data.scriptId} ok=${shadow.ok} ${shadow.note}` +
            (shadow.warnings.length ? `｜warning 摘要：${shadow.warnings.slice(0, 3).map((w) => w.where + " " + w.message).join(" / ")}` : ""),
        );
        // 覆盖度不完整时，明确回给决策层 —— 它据此**重派阶段4 补全**，而不是只告诉用户"未完成"
        if (!shadow.coverage.complete) {
          coverageHint =
            `\n⚠ 代码校验发现：本次分镜表只覆盖 ${shadow.coverage.tableScenes}/${shadow.coverage.plannedScenes} 场` +
            `（拍摄计划里的分镜汇总表为准；技能要求一次性输出完整表）。**请立即重新派发阶段4**，` +
            `并在指令中明确要求"必须完整覆盖拍摄计划里的全部场次、不得只写第一段"，补全后再回复用户；不要只告知用户未完成。`;
        }
      } catch (e: any) {
        console.error("[productionAgent][影子落库] 异常：", u.error(e).message);
      }

      // ---- 阶段4 完成后**强制**跑监督层（把提示词约定落成代码）----
      // 前置条件检查：监督层是「读工作区里的 <storyboardTable> 来审」的，
      // 若前端没把标签内容回写（正常不该发生），审出来的就是空表 —— 那不是审核结论，
      // 明确说出来，别让用户以为「审过了、没问题」。
      // 判据用工作区那一行（o_agentWorkData, key=productionAgent），而不是 o_script 行是否存在
      // —— 后者只能说明这一集存在，跟分镜表到没到无关。
      let tableArrived = false;
      try {
        const wd = await u
          .db("o_agentWorkData")
          .where("projectId", String(resTool.data.projectId))
          .andWhere("episodesId", String(resTool.data.scriptId))
          .andWhere("key", "productionAgent")
          .select("data")
          .first();
        const table = wd?.data ? JSON.parse(wd.data)?.storyboardTable : "";
        tableArrived = typeof table === "string" && table.includes("画面描述");
      } catch (e) {
        console.error("[productionAgent] 阶段4 监督前置检查失败：", u.error(e).message);
      }

      let report = "";
      try {
        report = await runSupervisionAgent(
          "请审核分镜表的违规词表：配乐越位 / 光影笼统 / 固有外观越位 / 抽象笼统词。用 get_flowData(\"storyboardTable\") 读表作为唯一依据。",
        );
      } catch (e: any) {
        const reason = u.error(e).message;
        console.error("[productionAgent] 阶段4 后的监督层审核失败：", reason);
        report = `（监督层审核未能完成：${reason}。请如实告知用户「本次未审核」，不要声称审核通过。）`;
      }

      // 审核报告直接回给决策层：它已经跑过了，不要再自行派发一次
      stageResults.set(SUPERVISION_DONE_KEY, report);
      return `${result}\n\n---\n【监督层审核报告（已自动执行，无需再次派发）】\n${report}\n\n请把这份审核报告展示给用户，等待用户反馈；不要再次调用监督层。${
        tableArrived ? "" : "\n⚠ 注意：本次未能确认分镜表已写入工作区，若审核结果为空，请如实说明「未拿到分镜表、审核无效」。"
      }${coverageHint}`;
    },
  });

  /**
   * 监督层入口（决策层可直接派发）。
   *
   * ⚠ 阶段4 执行完已经**自动**审过一次（见 run_sub_agent_storyboard_table）。
   * 这里对同一阶段做**去重**：如果本轮已经审过阶段4，再派一次不但浪费一次模型调用，
   * 还会给用户看两份报告。用 stageResults 里的标记判断。
   */
  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果（阶段4 的审核已自动执行，通常不需要再派）",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      if (stageResults.has(SUPERVISION_DONE_KEY)) {
        return `监督层本轮已审核过阶段4，报告如下（不要重复派发）：\n${stageResults.get(SUPERVISION_DONE_KEY)}`;
      }
      return runSupervisionAgent(prompt);
    },
  });

  return {
    run_sub_agent_derive_assets,
    run_sub_agent_generate_assets,
    run_sub_agent_director_plan,
    run_sub_agent_storyboard_gen,
    run_sub_agent_storyboard_panel,
    run_sub_agent_storyboard_table,
    run_sub_agent_supervision,
  };
}

/**
 * feicai 生产链技能。取代原 art_skills / story_skills 的按项目目录扫描。
 *
 * 只保留 art-design-skill（服化道），且只发给资产链（阶段2 衍生资产分析 / 阶段3 资产生图）。
 * 原 director-skill 已摘除，不再发给任何子 Agent。该目录**未纳入 git**（删掉不可恢复），
 * 因此文件仍留在磁盘上备用；它产自另一条 seedance_flow
 * 流水线（剧情点 P01 = 一次 Seedance 2.0 生成），产出物是「导演讲戏本」，与 toonflow 的
 * 「场次 + 分场汇总表」拍摄计划不同源，字段口径也不对应。
 * ⚠️ 本注释历史上把理由写成「与……禁光影契约互斥」——该理由已于 2026-10-02 作废：光影政策
 * 反转为「光影入列」（全链唯一出处是分镜表的「光影氛围」列）。摘除理由与光影无关。
 * （另：toonflow 阶段1 的技能自身红线是「不激活、不加载任何技法 / skill」，而旧代码仍把
 *  art-design-skill 技能箱塞给它，自相矛盾——2026-10-07 已收口，见 run_sub_agent_director_plan。）
 */
const FEICAI_ART_SKILLS = ["art-design-skill"];
/**
 * 阶段4（构建分镜表）/ 阶段5（分镜面板写入）注入的 feicai 技能。
 *
 * 为空：阶段4 自我声明「不激活任何技法 / skill」，阶段5 只按需激活通用技法
 * `storyboard_prompt_techniques`（见 PRODUCTION_TECHNIQUES）。art-design-skill（服化道）
 * 与 seedance-storyboard-skill（Seedance @引用）与本阶段产出格式无关：前者仍在资产链路使用，
 * 后者是孤儿技能（不在任何名单中，磁盘上仍留有文件）。
 */
const FEICAI_PRODUCTION_SKILLS: string[] = [];
/** 只用于单资产直接注入，不作为技能包暴露给 Agent */
const FEICAI_EXCLUDED_RESOURCES = ["SKILL.md", "single-asset.md"];

type SkillEntry = { path: string; name: string; description: string };

/**
 * 收集 feicai 技能文件与其资源清单。
 * 技能来源固定，不再随项目 artStyle / directorManual 变化。
 */
async function collectFeicaiSkillFiles(skillNames: string[]): Promise<{ mainSkills: SkillEntry[]; secondarySkills: string[] }> {
  const skillsRoot = u.getPath("skills");
  const mainSkills: SkillEntry[] = [];
  const secondarySkills: string[] = [];

  for (const skillName of skillNames) {
    const skillDir = u.getPath(["skills", "feicai", skillName]);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) throw new Error(`feicai 技能不存在: ${skillFile}`);
    const content = await fs.promises.readFile(skillFile, "utf-8");
    mainSkills.push({ path: skillFile, ...parseFrontmatter(content) });

    //把技能目录下的资源文件暴露给 read_skill_file（路径需相对 data/skills）
    const resources = await scanSkills(path.join(skillDir, "**", "*.md").split(path.sep).join("/"));
    for (const file of resources) {
      if (FEICAI_EXCLUDED_RESOURCES.includes(path.basename(file))) continue;
      secondarySkills.push(path.relative(skillsRoot, file).split(path.sep).join("/"));
    }
  }

  return { mainSkills, secondarySkills };
}

/** 由技能文件构建子 Agent 的技能工具箱 */
function buildSkillToolbox(mainSkills: SkillEntry[], secondarySkills: string[]) {
  return {
    prompt: `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills, tertiarySkills: [] }),
  };
}

/** 资产 / 导演规划 / 分镜图链路使用的技能 */
async function createArtSkills() {
  const { mainSkills, secondarySkills } = await collectFeicaiSkillFiles(FEICAI_ART_SKILLS);
  return buildSkillToolbox(mainSkills, secondarySkills);
}
async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";

  try {
    for await (const chunk of fullStream) {
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      } else if (chunk.type == "finish") {
        break;
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    thinking?.complete();
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }

  return fullResponse;
}
function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

export function buildSkillPrompt(skills: { name: string; description: string }[]): string {
  const skillEntries = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
    .join("\n");
  return `
<available_skills>
${skillEntries}
</available_skills>`;
}

/**
 * production_skills/ 中**允许注入 subAgent** 的技法（白名单）。
 *
 * 用白名单而不是「扫目录 + 黑名单」：此前实现是扫 `production_skills/*.md` 全量注入、只靠
 * 名字挡掉 `storyboard_table_techniques`——往该目录丢任何新文件都会被静默注入阶段4 与阶段5，
 * 而两个阶段的技能正文对这种事没有任何声明。改白名单后，新技法必须在这里显式登记才会被
 * 任何子 Agent 看到。
 *
 * 现只有 `storyboard_prompt_techniques`（提示词技法：解析映射 / 景别词库 / 输出格式规范 /
 * 画质规范 / 图像资产标注 / 人物位置连贯性），只给**阶段5 分镜面板的流程 C** 使用。
 * 旧版 `storyboard_table_techniques.md`（含 角色动作 / 朝向 / 空间关系 独立列与
 * `associateAssetsNames`）与阶段4 现行分镜表格式互斥，已从磁盘删除（可从 git 取回）；
 * 白名单下它天然进不来。
 */
const PRODUCTION_TECHNIQUES = ["storyboard_prompt_techniques"];

/**
 * 技能工具箱：feicai 侧技能（本阶段为空）+ 白名单内的通用技法。
 * 只发给**阶段5 分镜面板**——阶段1（导演规划）与阶段4（分镜表）的正文都声明
 * 「不激活、不加载任何技法 / skill」，故这两处不注入技能箱。
 */
async function useProductionSkills() {
  const { mainSkills, secondarySkills } = await collectFeicaiSkillFiles(FEICAI_PRODUCTION_SKILLS);

  const productionPath = u.getPath(["skills", "production_skills"]);
  for (const name of PRODUCTION_TECHNIQUES) {
    const skillPath = path.join(productionPath, `${name}.md`);
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    mainSkills.push({ path: skillPath, ...parseFrontmatter(content) });
  }

  return buildSkillToolbox(mainSkills, secondarySkills);
}
