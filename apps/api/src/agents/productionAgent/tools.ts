import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

/**
 * 串行队列：确保 socket 操作排队执行，避免并发过高导致假死
 * @param delayMs 每个操作之间的最小间隔(ms)
 */
function createSocketQueue(delayMs = 800) {
  let lastPromise: Promise<any> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // 先吃掉上一次的失败：否则一次 reject 会让后续每一次 .then 都跳过 fn（队列被毒化，
    // 表现为「某一条分镜失败后，剩下的分镜全部静默写不进去」）。
    lastPromise = lastPromise.catch(() => {}).then(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => fn().then(resolve, reject), delayMs);
        }),
    );
    return lastPromise;
  };
}

/**
 * 等一小会儿，看「发起即返回」类工具是不是**当场就失败了**。
 *
 * 背景：`generate_deriveAsset` / `generate_storyboard` 走的是异步任务池，发起后可能跑几分钟，
 * 工具不该阻塞等待（会把 agent 轮次拖死）；但 ack 里如果已经带了失败（额度不足、参数错、
 * 后端 500），原来照样返回「开始生成…」→ 用户以为在生成、等很久什么都没有。
 *
 * 折中：等最多 `ms` 毫秒。期间若观察到失败，返回原因字符串；否则视为「已成功发起」返回 null。
 * 注意 `pending` 必须已被调用方接上 `.catch`，否则未处理的 rejection 会冒到全局。
 */
async function waitForFailure(pending: Promise<any>, ms = 8000): Promise<string | null> {
  const probe = pending.then((res) => {
    if (!res) return null;
    if (res.error) return String(res.error);
    if (res.success === false) return String(res.message ?? res.error ?? "未知原因");
    return null;
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([probe, timeout]);
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const socketQueue = createSocketQueue(800);
  const workMap: Record<any, any> = {};
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);

        // ⚠ 必须有超时：这是 socket 往返，前端不回（页面刷新/被切走/socket 断）时
        // Promise 永远不 resolve → 决策层的 stream 永不结束 → 整条产线挂死，只能刷新页面。
        // 写工具 add_flowData_storyboard 早就加了 30s 兜底，读工具此前没有，是漏的。
        //
        // 超时**不 throw**，而是返回一句具名失败文案：工具抛错在 AI SDK 里不一定变成
        // stream 的 error chunk（consumeFullStream 只认 text-delta/reasoning/error/finish），
        // 抛出去有被静默吞掉的风险；返回字符串则一定会作为工具结果进模型上下文，
        // 模型可以据此改口或停下，而不是把整条链挂死。
        let flowData: FlowData;
        try {
          flowData = await new Promise<FlowData>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("前端未响应（读取工作区超时）")), 30000);
            socket.emit("getFlowData", { key }, (res: any) => {
              clearTimeout(timer);
              resolve(res);
            });
          });
        } catch (e: any) {
          thinking.updateTitle(`获取${flowDataKeyLabels[key]}失败`);
          thinking.complete();
          return `读取工作区失败：${e?.message ?? e}。不要重试读取，改用已有上下文继续；若确实拿不到数据，直接告诉用户「工作区读取超时，请刷新页面后重试」。`;
        }
        thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(flowData[key], null, 2));
        const unchanged = workMap[key] !== undefined && JSON.stringify(workMap[key]) === JSON.stringify(flowData[key]);
        workMap[key] = flowData[key];
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成${unchanged ? "（与上次相同）" : ""}`);
        thinking.complete();
        // 始终返回数据本身。此前命中缓存时返回字符串「XX数据未变化，无需更新」，
        // 导致同一次运行内第二次调用拿不到数据 → 下层据此误判「工作区不可写入」。
        return flowData[key];
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };

        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type").first();
        if (!parentAssets) return "关联的资产不存在";

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        const pending = new Promise<any>((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
            return res;
          })
          .catch((e) => {
            const failure = { error: u.error(e).message };
            thinking.appendText("衍生资产生成失败:\n" + failure.error);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
            return failure;
          });

        // 失败必须说给模型听：原来无条件返回「开始生成衍生资产」，ack 里带 error 也照样报成功，
        // 决策层据此往下推进，用户等了很久什么都没有。
        // 用 waitForFailure 而不是 await pending：正常路径下出图是异步任务池、可能跑几分钟，
        // 阻塞住会把 agent 轮次拖死；只在**当场失败**时才改成失败文案。
        const failure = await waitForFailure(pending);
        if (failure) return `衍生资产生成失败：${failure}。不要重复重试，先告诉用户失败原因。`;
        return "衍生资产生成已发起（异步，稍后在资产页查看结果）";
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        const pending = socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("generateStoryboard", { ids }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                if (res?.success === false) return reject(new Error(res.message ?? "未知原因"));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
            thinking.updateTitle("分镜生成完成");
            thinking.complete();
            return res;
          })
          .catch((e) => {
            const failure = { error: u.error(e).message };
            thinking.appendText("分镜生成失败:\n" + failure.error);
            thinking.updateTitle("分镜生成失败");
            thinking.complete();
            return failure;
          });

        // 同 generate_deriveAsset：当场失败要如实回报，否则决策层以为图在生成、直接收尾。
        const failure = await waitForFailure(pending);
        if (failure) return `分镜图生成失败：${failure}。不要重复重试，先告诉用户失败原因。`;
        return "分镜图生成已发起（异步，稍后在工作台查看结果）";
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增分镜面板到工作区",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
      }>(
        z
          .object({
            videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
            prompt: z.string().nullable().describe("分镜图片提示词"),
            track: z.string().describe("分组"),
            duration: z.number().describe("视频推荐时间"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const thinking = msg.thinking("正在新增 分镜面板 数据...");
        const data = {
          videoDesc: raw.videoDesc,
          prompt: raw.prompt,
          track: raw.track,
          duration: raw.duration,
          associateAssetsIds: raw.associateAssetsIds ?? [],
          shouldGenerateImage: raw.shouldGenerateImage,
        };
        try {
          await socketQueue(
            () =>
              new Promise((resolve, reject) => {
                // 前端漏回 ack 时不能让队列永久卡死，否则后面所有分镜都写不进去
                const timer = setTimeout(() => reject(new Error("前端未响应（写入超时）")), 30000);
                socket.emit("addStoryboard", { ...data }, (res: any) => {
                  clearTimeout(timer);
                  if (res?.error) return reject(new Error(res.error));
                  resolve(res);
                });
              }),
          );
          thinking.appendText("新增的分镜数据:\n" + JSON.stringify(data, null, 2));
          thinking.updateTitle("新增分镜成功");
          thinking.complete();
          return `分镜已写入（track=${data.track}）`;
        } catch (e: any) {
          thinking.appendText("新增的分镜数据:\n" + JSON.stringify(data, null, 2));
          thinking.updateTitle("新增分镜失败");
          thinking.complete();
          // 必须回报失败：旧实现无论成败都 return true，执行层会以为全部写成，
          // 结果是「工作台少了几张卡片」而没有任何人知道。
          return `分镜写入失败（track=${data.track}）：${e?.message ?? e}。不要重复重试这一条，继续写后面的分镜，全部写完后在回复里列出失败条目。`;
        }
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
