// ⚠ 本文件由 `apps/api/scripts/vendor-to-module.cjs` 从 `apps/api/data/vendor/` 转换而来（Phase 1c Task 8）。
//   沙箱执行通道已删除：适配器现在是**编译期内置**的普通 ES 模块，运行期不加载/不执行任何外部代码。
import { createOpenAI, createDeepSeek, createZhipu, createQwen, createAnthropic, createOpenAICompatible, createXai, createMinimax, createGoogleGenerativeAI, zipImage, zipImageResolution, urlToBase64, mergeImages, pollTask, logger, jsonwebtoken, crypto, FormData, axios, vendorInputs } from "@/vendors/runtime";
/**
 * Toonflow AI供应商模板 - MeToken AI
 * @version 1.0
 *
 * MeToken AI 是 BytePlus（火山引擎东南亚）中转平台。
 * 仅接入视频生成（Seedance 2.0 / 2.5）。
 *
 * 接口要点：
 * - 基地址: https://metoken.ai
 * - 认证: Authorization: Bearer <API_KEY>
 * - 创建任务: POST /api/v1/tasks（返回 202 + task_id）
 * - 查询任务: GET /api/v1/tasks/{task_id}（status: queued/processing/succeeded/failed/cancelled）
 * - 参考媒体: media 数组（multipart 提交本地文件，或公网 HTTPS URL）
 * - Prompt 锚点: [Image N] / [Video N] / [Audio N]（按类型分别编号，media 数组内顺序）
 * - 结果: output_url（24 小时有效）
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

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ⚠ Phase 1c Task 8 人工补的两个接口（重跑 vendor-to-module.cjs --force 会覆盖掉）：
//   本适配器只接视频生成（见文件头「仅接入视频生成」），它的 `declare const exports` 却引用了
//   `ImageConfig` / `TTSConfig`。沙箱形态下整个 `data/vendor/` 被 tsconfig 排除
//   （`"exclude": ["data/**/*.ts"]`）⇒ `tsc` 从来没看过这个文件，两处引用不上报（latent TS2304）。
//   搬进 `src/` 后变得可见，于是如实报红。选择"补类型定义"而不是"删掉声明里的引用"：
//   `o_vendorConfig.models` 的联合类型里本来就有 `TTSModel` / `ImageModel`，留着引用才与真实形状一致。
//   这两个接口**不被任何运行时分支使用**（`videoRequest` 是唯一的实现），只影响类型。
interface ImageConfig {
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TTSConfig {
  text: string;
  voice: string;
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
  id: "metoken",
  version: "1.0",
  author: "Toonflow",
  name: "MeToken AI",
  description:
    "MeToken AI 是 BytePlus（火山引擎东南亚）中转平台，提供 Seedance 视频生成能力。\n\n需要在 [MeToken AI](https://metoken.ai) 注册并获取 API Key。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "MeToken AI API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://metoken.ai" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://metoken.ai",
  },
  models: [
    {
      name: "Seedance 2.0",
      modelName: "seedance-2-0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      name: "Seedance 2.5",
      modelName: "seedance-2-5-nsfw",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p"] }],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getBaseUrl = () => vendorInputs(vendor).baseUrl.replace(/\/+$/, "");

const getHeaders = () => {
  if (!vendorInputs(vendor).apiKey) throw new Error("缺少 API Key");
  return {
    Authorization: `Bearer ${vendorInputs(vendor).apiKey.replace(/^Bearer\s+/i, "")}`,
  };
};

/** 从 base64 Data URL 或裸 base64 中解析出二进制 Buffer */
function base64ToBuffer(base64: string): Buffer {
  const data = base64.startsWith("data:") ? base64.split(",")[1] || "" : base64;
  return Buffer.from(data, "base64");
}

/**
 * 将 Toonflow 的 referenceList（base64 数组）转换为 MeToken 的 media 锚点映射。
 *
 * Toonflow 侧 `@图片N` / `@图N` 的编号 = referenceList 的上传顺序（用户按顺序上传）。
 * MeToken 侧 `[Image N]` / `[Video N]` / `[Audio N]` 按类型分别编号，media 数组内顺序。
 *
 * 返回：
 * - anchors: 每个 media 条目对应的 MeToken 锚点（如 ["[Image 1]", "[Video 1]", "[Image 2]"]）
 * - media: 按原顺序的 media 条目（含类型和 base64 Buffer）
 */
function buildMediaAnchors(referenceList: ReferenceList[]) {
  const imageCount = { used: 0 };
  const videoCount = { used: 0 };
  const audioCount = { used: 0 };

  const media: { type: string; buffer: Buffer; filename: string; anchor: string }[] = [];

  for (const ref of referenceList) {
    const buffer = base64ToBuffer(ref.base64);
    if (ref.type === "image") {
      imageCount.used += 1;
      media.push({ type: "image", buffer, filename: `image_${imageCount.used}.jpg`, anchor: `[Image ${imageCount.used}]` });
    } else if (ref.type === "video") {
      videoCount.used += 1;
      media.push({ type: "video", buffer, filename: `video_${videoCount.used}.mp4`, anchor: `[Video ${videoCount.used}]` });
    } else if (ref.type === "audio") {
      audioCount.used += 1;
      media.push({ type: "audio", buffer, filename: `audio_${audioCount.used}.mp3`, anchor: `[Audio ${audioCount.used}]` });
    }
  }

  return media;
}

/**
 * 将 prompt 中的 Toonflow 引用（`@图片N` / `@图N`）翻译成 MeToken 锚点（`[Image N]` / `[Video N]`）。
 *
 * 规则：
 * - `@图片N` / `@图N` / `@图片N` 统一识别，N 为 referenceList 中该条目的上传序号（从 1 开始）
 * - 根据该序号对应媒体类型，翻译成 `[Image N]` / `[Video N]` / `[Audio N]`
 * - 已存在的 `[Image N]` / `[Video N]` / `[Audio N]` 官方锚点原样保留
 */
function translatePrompt(prompt: string, media: { type: string; anchor: string }[]): string {
  // 为每个上传序号（1-based）建立锚点映射
  const anchorByIndex: Record<number, string> = {};
  media.forEach((m, i) => {
    anchorByIndex[i + 1] = m.anchor;
  });

  // 识别 `@图片N` / `@图N` / `@图片N`（N 为数字，支持简繁「图片」「圖」）
  return prompt.replace(/@(?:图片|圖片|图|圖)\s*(\d+)/g, (match, numStr) => {
    const index = parseInt(numStr, 10);
    const anchor = anchorByIndex[index];
    return anchor || match; // 找不到对应媒体时保留原文
  });
}

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (_model: TextModel, _think: boolean, _thinkLevel: 0 | 1 | 2 | 3) => {
  // MeToken 只接视频，文本不做
  return undefined;
};

const imageRequest = async (_config: any, _model: ImageModel): Promise<string> => {
  // MeToken 只接视频，图片不做
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const baseUrl = getBaseUrl();
  const headers = getHeaders();

  const referenceList = config.referenceList || [];
  const media = buildMediaAnchors(referenceList);

  // 翻译 prompt 锚点
  const translatedPrompt = translatePrompt(config.prompt || "", media);

  // 组装任务 JSON（不含 media，media 走 multipart 文件）
  const taskJson: any = {
    model: model.modelName,
    prompt: translatedPrompt,
  };

  if (config.duration) taskJson.duration = config.duration;
  if (config.resolution) taskJson.resolution = config.resolution;
  if (config.aspectRatio) taskJson.ratio = config.aspectRatio;

  // 音效开关：**true / false 都显式下发**。
  // 此前只在「开」的时候写 `generate_audio = true`，「关」的时候不发这个字段 ——
  // 而 MeToken 侧该字段默认是 true，于是用户在界面上点「关」其实关不掉（仍然有声）。
  // 现在：模型强制有声(true) 或 模型可选且用户明确开启(optional + audio===true) 才为 true，其余显式 false。
  const shouldGenerateAudio = model.audio === true || (model.audio === "optional" && config.audio === true);
  taskJson.generate_audio = shouldGenerateAudio;

  logger(
    `[MeToken 视频] 提交任务: ${model.modelName}, duration=${config.duration}, resolution=${config.resolution}, ratio=${config.aspectRatio}, media=${media.length}, audio=${shouldGenerateAudio}`,
  );
  logger(`[MeToken 视频] 翻译后 prompt: ${translatedPrompt.slice(0, 120)}`);

  // 创建任务：无参考媒体时走纯 JSON POST；有本地媒体时走 multipart
  let createResp: any;
  try {
    if (media.length === 0) {
      createResp = await axios.post(`${baseUrl}/api/v1/tasks`, taskJson, { headers });
    } else {
      const form = new FormData();
      form.append("request", JSON.stringify(taskJson));
      for (const m of media) {
        form.append("media", m.buffer, m.filename);
      }
      createResp = await axios.post(`${baseUrl}/api/v1/tasks`, form, {
        headers: { ...headers, ...(form.getHeaders ? form.getHeaders() : {}) },
      });
    }
  } catch (err: any) {
    // 打印完整错误响应，便于定位 400 原因
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
    logger(`[MeToken 视频] 提交失败完整响应: ${detail}`);
    throw new Error(`MeToken 任务提交失败: ${detail.slice(0, 800)}`);
  }
  const createData = createResp.data;
  const taskId = createData?.id;
  if (!taskId) {
    throw new Error(`MeToken 视频任务创建失败：未返回任务ID。原始响应：${JSON.stringify(createData).slice(0, 300)}`);
  }

  logger(`[MeToken 视频] 任务已创建, ID: ${taskId}`);

  // 轮询任务状态
  const pollResult = await pollTask(
    async (): Promise<PollResult> => {
      // 502/503 等是 metoken 上游(BytePlus)暂时性错误，继续重试而非判失败
      let queryResp: any;
      try {
        queryResp = await axios.get(`${baseUrl}/api/v1/tasks/${taskId}`, { headers });
      } catch (e: any) {
        const status = e?.response?.status;
        logger(`[MeToken 视频] 轮询请求异常 status=${status}, 继续重试`);
        return { completed: false }; // 网络/5xx 暂时错误 → 继续轮询
      }
      const task = queryResp.data;
      const status = task?.status || "";

      switch (status) {
        case "succeeded":
          if (task?.output_url) return { completed: true, data: task.output_url };
          return { completed: true, error: "任务成功但未返回 output_url" };
        case "failed":
          return { completed: true, error: task?.billing?.status === "refunded" ? "视频生成失败（已退款）" : `视频生成失败: ${task?.error?.message || task?.error || ""}` };
        case "cancelled":
          return { completed: true, error: "视频生成任务已取消" };
        default:
          // queued / processing / 其他 → 继续轮询
          logger(`[MeToken 视频] 任务状态: ${status}`);
          return { completed: false };
      }
    },
    10000,
    1800000, // 30 分钟超时
  );

  if (pollResult.error) throw new Error(pollResult.error);
  if (!pollResult.data) throw new Error("视频生成失败：轮询未返回数据");
  return pollResult.data; // output_url
};

const ttsRequest = async (_config: any, _model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================




export { vendor, textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
