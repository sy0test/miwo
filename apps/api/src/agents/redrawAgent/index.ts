/**
 * 转绘认账会话 agent（M2-T7 / spec §7.1）。
 *
 * 一个 **executor 型** agent：系统提示写死「剧本 → 资产 → 时长」三步纪律，工具全部走
 * `redraw/assets.ts` 等模块（不直写 SQL）。它不做决策树/子 agent —— 认账是**用户拍板**的流程，
 * 模型只负责"问清楚 + 调对应的工具落库"。
 *
 * ── 记忆 ──
 * 复用 `memories` 表，`agentType = "redrawAgent"`，isolationKey 含 projectId + scriptId
 * （由 socket 层 `buildIsolationKey` 推导）。重连不清空：记忆是**跨消息**的，而页面刷新只是换个 socket。
 */
import type { Socket } from "socket.io";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { createRedrawTools } from "@/agents/redrawAgent/tools";
import ResTool from "@/socket/resTool";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  projectId: number;
  scriptId: number;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

/** 会话纪律（系统提示）。措辞是产品口径：三步、每步要用户点头、不许自造资产。 */
export const RECONCILE_SYSTEM_PROMPT = [
  "你是「转绘助手」，负责带用户把一集源片的解析结果认账成可生成的目标国资产。",
  "流程固定三步，**按顺序**推进，每一步结束都要告诉用户「现在到哪一步了」：",
  "① 剧本：读/改本集剧本正文（用户想改台词/剧情时）。不改也可以直接进入下一步。",
  "② 资产：解析出的资产草稿要逐条处理 —— 复用项目已有资产（redraw_bindDraft）、或按草稿新建（redraw_createAsset）、",
  "   或改名/改性别/改出图提示词（redraw_updateAsset）。**资产名不许自己编**：只能用草稿名或用户明确给的名字。",
  "   全部处理完、用户确认后调 redraw_confirmAssets。",
  "③ 时长：向用户报告每段时长与项目单段上限（redraw_listAssetDrafts 里有 segments 与 segmentCap），",
  "   用户同意后调 redraw_confirmSegmentCap。若用户要把上限改成别的值，**必须先说明「已有分镜需要重跑解析」**，",
  "   拿到明确同意后才传 force:true。",
  "",
  "工具使用规则：",
  "- 每次要动数据之前先读（redraw_listAssetDrafts / redraw_getScript），不要凭记忆写。",
  "- 工具返回的事实是唯一真相；不要编造资产 id、段时长、上限。",
  "- redraw_confirmAssets 失败（例如「还有草稿没处理」）时，如实告诉用户缺哪几条，不要假装确认成功。",
  "- 用户问「现在什么状态」时，以工具结果为准，不要复述很久之前的记忆。",
  "回答用简体中文，简洁；一次只推进一件事。",
].join("\n");

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  const parts: string[] = [];
  const quotes = (mem as any).userQuotes ?? [];
  if (quotes.length) parts.push("[用户原话（逐字保留，优先级最高）]\n" + quotes.map((m: any, i: number) => i + 1 + ". " + m.content).join("\n"));
  if (mem.rag.length) parts.push("[相关记忆]\n" + mem.rag.map((r) => r.content).join("\n"));
  if (mem.summaries.length) parts.push("[历史摘要]\n" + mem.summaries.map((s, i) => i + 1 + ". " + s.content).join("\n"));
  if (mem.shortTerm.length) parts.push("[近期对话]\n" + mem.shortTerm.map((m) => m.role + ": " + m.content).join("\n"));
  return parts.length ? "## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n" + parts.join("\n\n") : "";
}

/** 项目/本集的事实上下文（模型不需要再查库就能说清"这是哪一集、什么状态"） */
async function buildFactContext(projectId: number, scriptId: number): Promise<string> {
  const project = await u.db("o_project").where("id", projectId).first();
  const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
  const segment = await u.db("o_segment").where({ projectId, scriptId }).count({ n: "*" }).first();
  const linked = await u.db("o_scriptAssets").where({ scriptId }).count({ n: "*" }).first();
  return [
    "## 当前集",
    "- 项目：" + (project?.name ?? "未知") + "（目标国家：" + (project?.targetCountry ?? "未设置") + "）",
    "- 本集：" + (script?.name ?? "未知") + "（scriptId=" + scriptId + "）",
    "- 单段上限：" + (Number(project?.redrawMaxSegmentSec) || 15) + "s",
    "- 已有片段数：" + Number(segment?.n ?? 0) + "；已确认资产数：" + Number(linked?.n ?? 0),
    "- 转绘状态：redrawState=" + (script?.redrawState ?? 0) + "，extractState=" + (script?.extractState ?? 0),
  ].join("\n");
}

/** 流式消费（与 scriptAgent 同一套 message 协议：text-delta / reasoning-* / error）。 */
async function consumeFullStream(fullStream: AsyncIterable<any>, initialMsg: ReturnType<ResTool["newMessage"]>): Promise<string> {
  let msg = initialMsg;
  const text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkStart = 0;
  let fullResponse = "";
  try {
    for await (const chunk of fullStream) {
      if (chunk.type === "reasoning-start") {
        thinkStart = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinking?.updateTitle("思考完毕（" + ((Date.now() - thinkStart) / 1000).toFixed(1) + " 秒）");
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
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
  return String(text ?? "")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "")
    .replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "")
    .trim();
}

/** 一轮对话。抛错 = 本轮失败（socket 层把错误写进这条消息的状态）。 */
export async function runReconcileAI(ctx: AgentContext): Promise<void> {
  const { isolationKey, text, userMessageTime, abortSignal, resTool, projectId, scriptId } = ctx;
  const memory = new Memory("redrawAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const [mem, facts] = await Promise.all([memory.get(text), buildFactContext(projectId, scriptId)]);
  const memPrompt = buildMemPrompt(mem);

  const tools = createRedrawTools({
    db: u.db as any,
    projectId,
    scriptId,
    notify: (kind) => {
      // 前端靠这个事件刷新（getEpisodeState / getAssetDrafts）
      ctx.socket.emit("redraw:updated", { scriptId, kind });
    },
  });

  const { fullStream } = await u.Ai.Text(
    "redrawAgent:reconcileAgent",
    currentAiBillingContext(),
    ctx.thinkConfig.think,
    ctx.thinkConfig.thinlLevel,
  ).stream({
    messages: [
      { role: "system", content: RECONCILE_SYSTEM_PROMPT + "\n\n" + facts },
      ...(memPrompt ? [{ role: "assistant" as const, content: memPrompt }] : []),
      { role: "user" as const, content: text },
    ],
    abortSignal,
    tools: { ...tools, ...memory.getTools() },
    onFinish: async (completion) => {
      await memory.add("assistant:reconcile", removeAllXmlTags(completion.text));
    },
  });

  await consumeFullStream(fullStream, ctx.msg);
}