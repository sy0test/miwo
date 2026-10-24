import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import type { Knex } from "knex";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { prepareProviderUsage, recordProviderUsage, type ProviderUsageInput } from "@/billing/usage";
import { resolveTextPricingUnit, videoPricingUnit } from "@/billing/prices";
import u from "@/utils";
import { getVendorModule } from "@/vendors";
import { currentAiBillingContext, trackAiBillingTask, type AiBillingContext } from "@/billing/context";

type AiType =
  | "scriptAgent"
  | "productionAgent"
  | "universalAi"
  | "scriptAgent:decisionAgent"
  | "scriptAgent:supervisionAgent"
  | "scriptAgent:storySkeletonAgent"
  | "scriptAgent:adaptationStrategyAgent"
  | "scriptAgent:scriptAgent"
  | "productionAgent:decisionAgent"
  | "productionAgent:supervisionAgent"
  | "productionAgent:deriveAssetsAgent"
  | "productionAgent:generateAssetsAgent"
  | "productionAgent:directorPlanAgent"
  | "productionAgent:storyboardGenAgent"
  | "productionAgent:storyboardPanelAgent"
  | "productionAgent:storyboardTableAgent"
  | "redrawAgent"
  | "redrawAgent:analysisAgent"
  | "redrawAgent:reconcileAgent"
  | "redrawAgent:storyboardAgent";

type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: AiType[] = [
  "scriptAgent",
  "productionAgent",
  "universalAi",
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
  "universalAi",
  "redrawAgent",
  "redrawAgent:analysisAgent",
  "redrawAgent:reconcileAgent",
  "redrawAgent:storyboardAgent",
];
export async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();

    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData?.modelName as `${number}:${string}`;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData?.modelName as `${number}:${string}`;
    }

    //未查到agentUseModeVal 维持原判断
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    let modelName = null;

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      modelName = mainlyData.modelName;
    }
    modelName = agentDeployData?.modelName || modelName;
    return modelName as `${number}:${string}`;
  }
  return value as `${number}:${string}`;
}

export function resolveAiModelName(value: "universalAi"): Promise<`${string}:${string}`> {
  return resolveModelName(value);
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();
    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData;
    }

    //未查到 agentUseModelVal 维持原流程
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      return mainlyData;
    }
    return agentDeployData;
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  // Static adapter modules are singletons. Pass each call a copied config overlaid with DB values;
  // never write credentials into the shared module object.
  const mod = getVendorModule(id);
  if (!mod) throw new Error(`供应商适配器不存在：${id}（内置适配器见 src/vendors/index.ts）`);
  const storedInputs = typeof vendorConfigData.inputValues === "string"
    ? JSON.parse(vendorConfigData.inputValues || "{}")
    : vendorConfigData.inputValues;
  const requestVendor = u.vendor.getVendorConfigFor(id, storedInputs);
  if (!requestVendor) throw new Error(`供应商适配器配置不存在：${id}`);
  const fn = (mod as Record<string, any>)[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel, requestVendor);
    };
  else return <T>(input: T) => fn(input, selectedModel, requestVendor);
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName, false, 0);

    taskRecord(1);
    return result;
  } catch (e) {
    taskRecord(-1, u.error(e).message);
    throw new Error(u.error(e).message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
function assertBillingContext(context: AiBillingContext): void {
  const active = currentAiBillingContext();
  if (context.userId !== active.userId || context.requestId !== active.requestId || context.jobId !== active.jobId) {
    throw new Error("Explicit AI billing context does not match active context");
  }
}

interface ProviderCall {
  providerCallId: string;
  at: Date;
  agentKey?: string;
}

async function beginProviderCall(
  context: AiBillingContext,
  modelName: `${string}:${string}`,
  callType: string,
  usage: NonNullable<ProviderUsageInput["usage"]>,
  agentKey?: string,
  at = new Date(),
): Promise<ProviderCall> {
  const [vendorId, model] = modelName.split(/:(.+)/);
  const call: ProviderCall = { providerCallId: randomUUID(), at, agentKey };
  await prepareProviderUsage(u.db as unknown as Knex, context, {
    vendorId, model, callType, providerCallId: call.providerCallId, at: call.at,
    ...(agentKey !== undefined && { agentKey }),
    usageStatus: "estimated", usage,
  });
  return call;
}

async function finishProviderCall(
  context: AiBillingContext,
  modelName: `${string}:${string}`,
  callType: string,
  call: ProviderCall,
  usageStatus: ProviderUsageInput["usageStatus"],
  usage?: ProviderUsageInput["usage"],
): Promise<void> {
  const [vendorId, model] = modelName.split(/:(.+)/);
  await recordProviderUsage(u.db as unknown as Knex, context, {
    vendorId, model, callType, providerCallId: call.providerCallId, at: call.at,
    ...(call.agentKey !== undefined && { agentKey: call.agentKey }),
    usageStatus, usage,
  });
}

function tokenMeasure(usage: any): ProviderUsageInput["usage"] | undefined {
  const inTokens = usage?.inputTokens ?? usage?.promptTokens;
  const outTokens = usage?.outputTokens ?? usage?.completionTokens;
  if (!Number.isSafeInteger(inTokens) || !Number.isSafeInteger(outTokens)) return undefined;
  return { unit: "token", inTokens, outTokens };
}

export function estimateInputTokens(input: any): number {
  const source = { system: input.system, messages: input.messages, prompt: input.prompt };
  return Math.max(1, Math.ceil(JSON.stringify(source).length / 4));
}

export async function estimateTextInvocationTokens(input: any): Promise<number> {
  const config = await getModelConfig("universalAi");
  return estimateInputTokens(input) + (config?.maxOutputTokens ?? 4096);
}

function textUsageForMode(
  unit: "token" | "call",
  measured: ProviderUsageInput["usage"],
  estimate: { unit: "token"; inTokens: number; outTokens: number },
): NonNullable<ProviderUsageInput["usage"]> {
  if (unit === "token") return measured?.unit === "token" ? measured : estimate;
  const analytics = measured?.unit === "token" ? measured : estimate;
  return { unit: "call", inTokens: analytics.inTokens, outTokens: analytics.outTokens };
}

class AiText {
  private AiType: AiType | `${string}:${string}`;
  private context: AiBillingContext;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: AiType | `${string}:${string}`, context: AiBillingContext, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    assertBillingContext(context);
    this.AiType = AiType;
    this.context = context;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[], modelName?: `${string}:${string}`) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const resolvedModelName = modelName ?? await resolveModelName(this.AiType);
    const sdkFn = await getVendorTemplateFn("textRequest", resolvedModelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool?.value === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const modelName = await resolveModelName(this.AiType);
    const config = await getModelConfig(this.AiType);
    const model = await this.resolveModel(undefined, modelName);
    const tokenEstimate = {
      unit: "token" as const,
      inTokens: estimateInputTokens(input),
      outTokens: config?.maxOutputTokens ?? 4096,
    };
    const [vendorId, modelId] = modelName.split(/:(.+)/);
    const at = new Date();
    const pricingUnit = await resolveTextPricingUnit(u.db as unknown as Knex, vendorId, modelId, at);
    const estimate = pricingUnit === "call"
      ? { unit: "call" as const, inTokens: tokenEstimate.inTokens, outTokens: tokenEstimate.outTokens }
      : tokenEstimate;
    const call = await beginProviderCall(this.context, modelName, "text", estimate,
      AiTypeValues.includes(this.AiType as AiType) ? this.AiType : undefined, at);
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
        ...input,
        model,
        ...(config?.temperature && { temperature: config.temperature }),
        ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      } as Parameters<typeof generateText>[0]);
    } catch (error) {
      await finishProviderCall(this.context, modelName, "text", call, "uncertain", pricingUnit === "call" ? estimate : undefined).catch(() => undefined);
      throw error;
    }
    const measured = tokenMeasure(await result.usage);
    await finishProviderCall(this.context, modelName, "text", call, measured ? "success" : "estimated", textUsageForMode(pricingUnit, measured, tokenEstimate));
    return result;
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const modelName = await resolveModelName(this.AiType);
    const config = await getModelConfig(this.AiType);
    const model = await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" }), modelName);
    const tokenEstimate = {
      unit: "token" as const,
      inTokens: estimateInputTokens(input),
      outTokens: config?.maxOutputTokens ?? 4096,
    };
    const [vendorId, modelId] = modelName.split(/:(.+)/);
    const at = new Date();
    const pricingUnit = await resolveTextPricingUnit(u.db as unknown as Knex, vendorId, modelId, at);
    const estimate = pricingUnit === "call"
      ? { unit: "call" as const, inTokens: tokenEstimate.inTokens, outTokens: tokenEstimate.outTokens }
      : tokenEstimate;
    const call = await beginProviderCall(this.context, modelName, "text", estimate,
      AiTypeValues.includes(this.AiType as AiType) ? this.AiType : undefined, at);
    let result: Awaited<ReturnType<typeof streamText>>;
    try {
      result = streamText({
        ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
        ...input,
        model,
        ...(config?.temperature && { temperature: config.temperature }),
        ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      } as Parameters<typeof streamText>[0]);
    } catch (error) {
      await finishProviderCall(this.context, modelName, "text", call, "uncertain", pricingUnit === "call" ? estimate : undefined).catch(() => undefined);
      throw error;
    }
    const usageTask = Promise.resolve(result.usage).then(async (usage) => {
      const measured = tokenMeasure(usage);
      await finishProviderCall(this.context, modelName, "text", call, measured ? "success" : "estimated", textUsageForMode(pricingUnit, measured, tokenEstimate));
    }, async () => {
      await finishProviderCall(this.context, modelName, "text", call, "uncertain", pricingUnit === "call" ? estimate : undefined).catch(() => undefined);
    }).catch((error) => console.error("Failed to record streamed AI usage", error));
    trackAiBillingTask(this.context, usageTask);
    return result;
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string } | { type: "audio"; base64: string } | { type: "video"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

class AiImage {
  private key: `${string}:${string}`;
  private context: AiBillingContext;
  private result: string = "";
  constructor(key: `${string}:${string}`, context: AiBillingContext) {
    assertBillingContext(context);
    this.key = key;
    this.context = context;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("imageRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      const call = await beginProviderCall(this.context, mn, "image", { unit: "image", imageCount: 1 });
      try {
        this.result = await fn(input);
      } catch (error) {
        await finishProviderCall(this.context, mn, "image", call, "uncertain").catch(() => undefined);
        throw error;
      }
      await finishProviderCall(this.context, mn, "image", call, "success", { unit: "image", imageCount: 1 });
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
      return this;
    }
    await exec(modelName);
    return this;
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

class AiVideo {
  private key: `${string}:${string}`;
  private context: AiBillingContext;
  private result: string = "";
  constructor(key: `${string}:${string}`, context: AiBillingContext) {
    assertBillingContext(context);
    this.key = key;
    this.context = context;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    try {
      const exec = async (mn: `${string}:${string}`) => {
        const fn = await getVendorTemplateFn("videoRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
        const usage = { unit: videoPricingUnit(input.resolution), videoSeconds: String(input.duration) };
        const call = await beginProviderCall(this.context, mn, "video", usage);
        try {
          this.result = await fn(input);
        } catch (error) {
          await finishProviderCall(this.context, mn, "video", call, "uncertain").catch(() => undefined);
          throw error;
        }
        await finishProviderCall(this.context, mn, "video", call, "estimated", usage);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      };
      if (taskRecord) {
        await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
        return this;
      }
      await exec(modelName);
      return this;
    } catch (e) {
      throw e;
    }
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private context: AiBillingContext;
  private result: string = "";
  constructor(key: `${string}:${string}`, context: AiBillingContext) {
    assertBillingContext(context);
    this.key = key;
    this.context = context;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("ttsRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      const call = await beginProviderCall(this.context, mn, "audio", { unit: "character", text: input.prompt });
      try {
        this.result = await fn(input);
      } catch (error) {
        await finishProviderCall(this.context, mn, "audio", call, "uncertain").catch(() => undefined);
        throw error;
      }
      await finishProviderCall(this.context, mn, "audio", call, "estimated", { unit: "character", text: input.prompt });

      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, context: AiBillingContext, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, context, think, thinkLevel),
  Image: (key: `${string}:${string}`, context: AiBillingContext) => new AiImage(key, context),
  Video: (key: `${string}:${string}`, context: AiBillingContext) => new AiVideo(key, context),
  Audio: (key: `${string}:${string}`, context: AiBillingContext) => new AiAudio(key, context),
};