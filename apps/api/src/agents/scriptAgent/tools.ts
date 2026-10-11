import { tool, jsonSchema, Tool } from "ai";
import u from "@/utils";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";

export const ScriptSchema = z.object({
  name: z.string().describe("剧本名称"),
  content: z.string().describe("剧本内容"),
});
export const planData = z.object({
  storySkeleton: z.string().describe("故事骨架"),
  adaptationStrategy: z.string().describe("改编策略"),
  script: z.string().describe("剧本内容"),
});

export type planData = z.infer<typeof planData>;

const keySchema = z.enum(Object.keys(planData.shape) as [keyof planData, ...Array<keyof planData>]);
const planDataKeyLabels = Object.fromEntries(
  Object.entries(planData.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof planData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const tools: Record<string, Tool> = {
    get_novel_events: tool({
      description: "获取章节事件",
      // ⚠ 参数名必须叫 `ids`：技能正文（script_execution_*.md、script_agent_supervision.md）
      // 一律写 `get_novel_events(ids:number[])`。原名是 `chapterIndexs`，与技能不一致 ——
      // 而 jsonSchema 生成的 JSON Schema **不要求 required**，所以模型传 `ids` 时
      // 参数为 undefined，工具照样执行、返回空串，**不报错**：三个执行阶段都在读空事件上
      // 写骨架/改编/剧本，产出失真且无人知道。改名对齐技能，是这次契约修复的落点。
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("章节编号列表（对应小说章节的 chapterIndex）"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const chapterIndexs = Array.isArray(ids) ? ids : [];
        console.log("[tools] get_novel_events", chapterIndexs);
        const thinking = msg.thinking("正在查询章节事件...");
        const data = await u
          .db("o_novel")
          .where("projectId", resTool.data.projectId)
          .select("id", "chapterIndex as index", "reel", "chapter", "chapterData", "event", "eventState")
          .whereIn("chapterIndex", chapterIndexs);
        thinking.appendText("正在查询章节编号: " + chapterIndexs.join(","));
        const eventString = data.map((i: any) => [`第${i.index}章，标题:${i.chapter}，事件:${i.event}`].join("\n")).join("\n");
        thinking.appendText("查询结果:\n" + eventString);
        thinking.updateTitle("查询章节事件完成");
        thinking.complete();
        // 空结果要明说：只返回 "" 的话模型会当成「这段剧情没有事件」，直接开始编。
        if (!eventString.trim()) return `第 ${chapterIndexs.join("、")} 章查不到事件（可能未做事件分析，或章节编号不存在）。请如实告诉用户，不要凭想象补写事件。`;
        return eventString;
      },
    }),
    get_planData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof planData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        console.log("[tools] get_planData", key);
        const thinking = msg.thinking(`正在获取${planDataKeyLabels[key]}工作区数据...`);
        // ⚠ 必须有超时：这是 socket 往返，前端不回（页面刷新/被切走/socket 断）时 Promise
        // 永远不 resolve → 整轮 agent 挂死、前端输入框一直禁用，用户只能重开页面。
        // 与生产侧 get_flowData 同一个坑，那边已修，这里一并补上。
        // 超时**不 throw** 而是返回具名文案（抛错可能被 SDK 吞成 tool-error）。
        let planData: planData;
        try {
          planData = await new Promise<planData>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("前端未响应（读取工作区超时）")), 30000);
            socket.emit("getPlanData", { key }, (res: any) => {
              clearTimeout(timer);
              resolve(res);
            });
          });
        } catch (e: any) {
          const reason = e?.message ?? String(e);
          thinking.updateTitle(`获取${planDataKeyLabels[key]}失败`);
          thinking.complete();
          return `读取工作区失败：${reason}。不要重试读取，改用已有上下文继续；若确实拿不到数据，直接告诉用户「工作区读取超时，请刷新页面后重试」。`;
        }
        thinking.appendText(`获取到${planDataKeyLabels[key]}:\n` + planData[key]);
        thinking.updateTitle(`获取${planDataKeyLabels[key]}完成`);
        thinking.complete();
        return planData[key] ?? "无数据";
      },
    }),
    get_novel_text: tool({
      description: "获取小说章节原始文本内容",
      // ⚠ 同时接受数字与字符串：技能正文从不写这个参数名与类型（只写「调用 get_novel_text」），
      // 而 `o_novel.chapterIndex` 是 INTEGER 列。原来 schema 只收 string：
      // 模型传数字 → 校验失败；传「第3章」→ where 不中 → 返回空串，**静默拿到空原文**，
      // 于是剧本与原著对不上还查不出原因。这里两种都收并归一化。
      inputSchema: jsonSchema<{ chapterIndex: number | string }>(
        z
          .object({
            chapterIndex: z.union([z.number(), z.string()]).describe("章节编号（数字，或纯数字字符串）"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ chapterIndex }) => {
        console.log("[tools] get_novel_text", chapterIndex);
        const thinking = msg.thinking(`正在获取小说章节原文...`);
        const raw = String(chapterIndex ?? "").trim();
        // 归一化：全角数字 → 半角，并剥掉「第…章」外壳，只留数字
        const normalized = raw
          .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
          .replace(/[^0-9]/g, "");
        const chapter = Number(normalized);
        const data = Number.isFinite(chapter) && normalized
          ? await u.db("o_novel").where("projectId", resTool.data.projectId).where({ chapterIndex: chapter }).select("chapterData").first()
          : undefined;
        const text = data?.chapterData ?? "";
        thinking.appendText(`获取到原文:\n` + text);
        thinking.updateTitle(`获取小说章节原文完成`);
        thinking.complete();
        // 空结果必须明说：`text ?? "无数据"` 对空串不生效（"" 不是 nullish），
        // 模型会拿到一个空串当成「这章没内容」然后直接编。
        if (!text.trim()) return `第 ${raw || "?"} 章查不到原文（章节编号可能不存在）。请如实告诉用户，不要凭想象补写剧情。`;
        return text;
      },
    }),
    get_script_content: tool({
      description: "获取剧本本内容",
      // 收数字与字符串两种：这一个的参数名 `ids` 与技能一致，但技能没写类型，
      // 而 o_script.id 是整数。只收 string[] 时模型传数字会被拒。
      inputSchema: jsonSchema<{ ids: (number | string)[] }>(
        z
          .object({
            ids: z.array(z.union([z.number(), z.string()])).describe("剧本 id 列表"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        console.log("[tools] get_script_content", ids);
        const thinking = msg.thinking(`正在获取脚本内容...`);
        const idList = (Array.isArray(ids) ? ids : []).map((v) => Number(v)).filter((n) => Number.isFinite(n));
        if (!idList.length) {
          thinking.updateTitle("获取脚本内容失败");
          thinking.complete();
          return "没有可用的剧本 id（参数 ids 必须是非空数字数组）。";
        }
        const data = await u.db("o_script").whereIn("id", idList).select("content", "name");
        if (!data.length) {
          thinking.updateTitle("获取脚本内容失败");
          thinking.complete();
          return `按 id ${idList.join("、")} 查不到剧本。`;
        }
        const text = data.map((d) => `<scriptItem name="${d.name}">${d.content}</scriptItem>`).join("\n");
        thinking.appendText(`获取到脚本内容:\n` + JSON.stringify(data, null, 2));
        thinking.updateTitle(`获取脚本内容完成`);
        thinking.complete();
        return text;
      },
    }),
  };
  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
