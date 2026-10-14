// ⚠ 本文件由 `apps/api/scripts/vendor-to-module.cjs` 从 `apps/api/data/vendor/` 转换而来（Phase 1c Task 8）。
//   沙箱执行通道已删除：适配器现在是**编译期内置**的普通 ES 模块，运行期不加载/不执行任何外部代码。
import { createOpenAI, createDeepSeek, createZhipu, createQwen, createAnthropic, createOpenAICompatible, createXai, createMinimax, createGoogleGenerativeAI, zipImage, zipImageResolution, urlToBase64, mergeImages, pollTask, logger, jsonwebtoken, crypto, FormData, axios } from "@/vendors/runtime";
/**
 * Toonflow AI供应商模板 - DeepSeek
 * @version 2.1
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

interface ImageConfig {
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  imageBase64?: string[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "deepseek",
  version: "2.1",
  author: "Toonflow",
  name: "DeepSeek",
  description:
    "DeepSeek 官方接口适配，支持 V4 系列模型与思考模式（思维链输出）。\n\n[前往平台](https://platform.deepseek.com/)",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.deepseek.com" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
  },
  models: [
    { name: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", type: "text", think: true },
    { name: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash", type: "text", think: true },
  ],
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");

  // DeepSeek 思考强度仅支持 high / max（low、medium 会被映射为 high，xhigh 会被映射为 max）
  // thinkLevel: 0/1/2 → high, 3 → max
  const effortMap: Record<0 | 1 | 2 | 3, "high" | "max"> = {
    0: "high",
    1: "high",
    2: "high",
    3: "max",
  };

  const enableThinking = model.think && think;
  const extraBody: Record<string, any> = {
    thinking: { type: enableThinking ? "enabled" : "disabled" },
  };
  if (enableThinking) {
    extraBody.reasoning_effort = effortMap[thinkLevel];
  }

  return createOpenAICompatible({
    baseURL: vendor.inputValues.baseUrl,
    apiKey,
    fetch: async (url: string, options?: RequestInit) => {
      const rawBody = JSON.parse((options?.body as string) ?? "{}");
      const modifiedBody = {
        ...rawBody,
        ...extraBody
      };
      return await fetch(url, {
        ...options,
        body: JSON.stringify(modifiedBody),
      });
    },
    // ⚠ Task 8 人工补的类型断言（重跑 vendor-to-module.cjs --force 会覆盖掉）：`fetch` 覆写签名比
    //   全局 fetch 窄 ⇒ 真实 import 下 tsc 报 TS2322。见 atlascloud.ts 同一处的完整说明。
  } as any).chatModel(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.0", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================



export { vendor, textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
