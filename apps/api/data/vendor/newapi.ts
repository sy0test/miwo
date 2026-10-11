/**
 * Toonflow AI供应商模板 - 统一中转站（New API）
 * @version 2.0
 *
 * 一个入口接两类模型，都打你自己的 New API：
 * 1) 文本 / 图片：OpenAI 线
 *    - 文本：createOpenAI({ baseURL, apiKey }).chat(model)
 *    - 图片：POST {base}/images/generations；带参考图走 POST {base}/images/edits（multipart）
 * 2) 视频：New API 统一任务接口
 *    - 创建任务：POST {base}/v1/videos
 *    - 查询任务：GET  {base}/v1/videos/{task_id}
 *    - 取产物：状态成功时优先读响应里的地址；读不到再 GET {base}/v1/videos/{task_id}/content
 *    上游是 New API 的「豆包(Doubao)」渠道（指向 metoken 桥），模型：seedance-2-0 / seedance-2-5-nsfw。
 *
 * 视频要点：
 * - 参考素材按 referenceList 顺序放进 metadata.content（image_url / video_url / audio_url），顺序即锚点编号；
 * - prompt 里的 Toonflow 引用（@图片N / @图N / @视频N / @音频N）按上传序号翻译成
 *   BytePlus 官方锚点 [Image N] / [Video N] / [Audio N]（按类型分别编号）；已是官方锚点的原样保留；
 * - 时长 seconds、分辨率 metadata.resolution、画幅 metadata.ratio、音频 metadata.generate_audio。
 *
 * ⚠️ 更新与排障（都是踩过的坑，改代码前先看这段）
 * 1) 运行时读的是【用户数据目录】下的这份代码：
 *      Electron：%APPDATA%\<应用名>\data\vendor\newapi.ts
 *      node data/serve/app.js：<程序根>/data/vendor/newapi.ts
 *    安装目录里的 resources/data/vendor/ 只是首次建库的种子，改它**不生效**。
 * 2) 换代码最稳的方式：设置 → 供应商 → 编辑代码 → 全选粘贴保存（后端会跑 VM+zod 校验，
 *    并同时把 models 写进 DB、覆盖代码文件）；或删掉该供应商再重新导入。
 * 3) 模型下拉是「代码里的 models + DB 里的 o_vendorConfig.models」合并的 ——
 *    所以代码是旧的、只要界面上手工加过模型，照样能选到 Seedance，容易被误导。
 * 4) 怎么判断当前生效的是哪版：代码里应该能搜到 `[newapi 视频] 提交` 这行日志。
 *    如果测试"秒成功"、控制台没有 【VM】 日志、new-api/桥侧也没有任务记录，
 *    那就是跑到了旧版空桩（videoRequest 直接 return ""），空结果被当成成功写了个空文件。
 * 5) seconds 必须是**字符串**（new-api 的 Go DTO 是 `seconds string`）；
 *    上游创建任务必须回 HTTP 200（否则 new-api 报 fail_to_fetch_task）；
 *    generate_audio 默认关（metoken 默认 true 会触发 BytePlus 音频内容审核导致整单失败）。
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

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const FormData: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
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
  id: "newapi",
  version: "2.0",
  author: "custom",
  name: "专用中转站",
  description:
    "一个入口接你自己的 New API 中转站：\n\n- 文本 / 图片（GPT-Image 2 等）走 OpenAI 线；\n- 视频（Seedance 2.0 / 2.5）走统一任务接口 `/v1/videos`，上游是 New API 的豆包渠道。\n\n只需要填中转站地址和令牌。视频模型填 `seedance-2-0` / `seedance-2-5-nsfw`。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "中转站的令牌（sk-...）" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://your-newapi.example.com/v1（带不带 /v1 都行）" },
  ],
  inputValues: { apiKey: "", baseUrl: "" },
  models: [
    { name: "GPT-Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "singleImage", "multiReference"] },
    { name: "GPT-Image 2.5 Sunburst", modelName: "gpt-image-2.5-sunburst", type: "image", mode: ["text", "singleImage", "multiReference"] },
    { name: "GPT-5.5", modelName: "gpt-5.5", type: "text", think: false },
    {
      name: "Seedance 2.0",
      modelName: "seedance-2-0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      // ⚠ 这里此前写死 false（并把理由写成「前端对 optional 会默认打开开关」）——
      // 代价是**音频开关在这条渠道上彻底失效**：model.audio === false 时下面的 audioOn 恒为 false，
      // 用户怎么点都发不出 true（1.5.10 实测就是这个现象）。
      // 现改为 "optional"：开关可用，默认值由前端按模型声明给（optional → 默认开），
      // 用户可以在出片面板显式关掉。**风险仍在**：BytePlus 会审核「生成的音频」，
      // 敏感内容（OutputAudioSensitiveContentDetected）或版权（output audio ... copyright）
      // 命中即整单失败（会退款，但要白等几分钟）——遇到这种片子，把开关关掉重跑。
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      name: "Seedance 2.5",
      modelName: "seedance-2-5-nsfw",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional", // 同上：开关可用、默认开、可显式关；注意 BytePlus 的音频内容/版权审核风险
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p"] }],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 中转站根地址：去掉尾斜杠与结尾的 /v1（后面我们自己拼 /v1、/images/...） */
function apiRoot(): string {
  const raw = (vendor.inputValues.baseUrl || "").trim().replace(/\/+$/, "");
  return raw.replace(/\/v1$/i, "").replace(/\/+$/, "");
}

function apiKey(): string {
  const key = (vendor.inputValues.apiKey || "").replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new Error("缺少API密钥");
  return key;
}

function authHeaders(extra: Record<string, string> = {}) {
  return Object.assign({ Authorization: `Bearer ${apiKey()}` }, extra);
}

function extractFirstImageFromMd(content: string) {
  const regex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+|\/\/[^\s)]+|[^\s)]+)\)/;
  const match = content.match(regex);
  if (!match) return null;
  const raw = match[2].trim();
  const url = raw.startsWith("data:") ? raw : raw.split(/\s+/)[0];
  return { alt: match[1], url, type: url.startsWith("data:image") ? "base64" : "url" };
}

/**
 * 把 Toonflow 的 referenceList 组装成 New API（豆包线）的 metadata.content。
 *
 * 顺序即契约：锚点按类型分别编号，编号顺序 = 素材在数组里的出现顺序。
 * 返回 { content, anchorByIndex }，anchorByIndex[上传序号(1-based)] = 官方锚点。
 */
function buildVideoContent(config: VideoConfig) {
  const refs = config.referenceList ?? [];
  const content: any[] = [];
  const anchorByIndex: Record<number, string> = {};
  let imageSeen = 0;
  let videoSeen = 0;
  let audioSeen = 0;

  // 首尾帧语义：Toonflow 传进来的 mode 通常是「只含一个模式名的数组」，也兼容直接传字符串
  const modeList: any[] = Array.isArray(config.mode) ? config.mode : config.mode ? [config.mode] : [];
  const frameMode = modeList.find((m) => m === "singleImage" || m === "startEndRequired" || m === "endFrameOptional" || m === "startFrameOptional") || "";

  refs.forEach((ref, index) => {
    const order = index + 1;
    if (ref.type === "image") {
      imageSeen += 1;
      anchorByIndex[order] = `[Image ${imageSeen}]`;
      let role = "reference_image";
      if (frameMode === "singleImage") role = "first_frame";
      else if (frameMode === "startFrameOptional" || frameMode === "endFrameOptional" || frameMode === "startEndRequired") {
        role = imageSeen === 1 ? "first_frame" : imageSeen === 2 ? "last_frame" : "reference_image";
      }
      content.push({ type: "image_url", image_url: { url: ref.base64 }, role });
    } else if (ref.type === "video") {
      videoSeen += 1;
      anchorByIndex[order] = `[Video ${videoSeen}]`;
      content.push({ type: "video_url", video_url: { url: ref.base64 }, role: "reference_video" });
    } else if (ref.type === "audio") {
      audioSeen += 1;
      anchorByIndex[order] = `[Audio ${audioSeen}]`;
      content.push({ type: "audio_url", audio_url: { url: ref.base64 }, role: "reference_audio" });
    }
  });

  return { content, anchorByIndex };
}

/**
 * 把 prompt 里的 Toonflow 引用翻译成 BytePlus 官方锚点。
 * N = 素材的上传序号（referenceList 下标 + 1）；找不到对应素材时保留原文。
 */
function translatePrompt(prompt: string, anchorByIndex: Record<number, string>): string {
  return String(prompt || "").replace(/@(?:图片|圖片|图|圖|视频|視頻|音频|音頻)\s*(\d+)/g, (match, numStr) => {
    const anchor = anchorByIndex[parseInt(numStr, 10)];
    return anchor || match;
  });
}

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKeyValue = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return createOpenAI({ baseURL: vendor.inputValues.baseUrl, apiKey: apiKeyValue }).chat(model.modelName);
};

/** 判断 OpenAI 排队或超时消息（可重试的临时性错误） */
function isRetryableError(text: string): boolean {
  return /processing image|we'll notify you|notify you|lots of people|超时|upstream_error|timeout/i.test(text);
}

/** 走 /images 系列端点的图片模型（其余旧图片模型仍走 /chat/completions 多模态） */
const IMAGES_ENDPOINT_MODELS = new Set(["gpt-image-2", "gpt-image-2.5-sunburst"]);

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  // TODO(临时排查): 确认参考图是否送达 vendor，验证通过后删除
  logger(
    `[newapi] imageRequest model=${model.modelName} refs=${config.referenceList?.length ?? 0} imageBase64=${(config as any).imageBase64?.length ?? 0}`,
  );
  if (!vendor.inputValues.apiKey) throw new Error("缺少APIKey");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");
  const apiKeyValue = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");

  // 图片模型（gpt-image-2 / gpt-image-2.5-sunburst）：文生图走 /images/generations；带参考图必须走 /images/edits（multipart 文件）
  if (IMAGES_ENDPOINT_MODELS.has(model.modelName)) {
    const sizeValue = config.size === "1K" ? "1024x1024" : config.size === "2K" ? "1792x1024" : "1024x1792";
    const imageRefs = (config.referenceList ?? []).map((r) => r.base64);

    // 图生图：该端点只认 multipart 文件块，JSON body 里塞 image 字段会被静默忽略
    if (imageRefs.length > 0) {
      const form = new FormData();
      form.append("model", model.modelName);
      form.append("prompt", config.prompt);
      form.append("n", "1");
      if (config.size) form.append("size", sizeValue);
      imageRefs.forEach((b64: string, i: number) => {
        const mime = b64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] ?? "image/png";
        const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
        form.append("image", Buffer.from(b64.replace(/^data:[^;]+;base64,/, ""), "base64"), {
          filename: `ref${i}.${ext}`,
          contentType: mime,
        });
      });
      logger(`[newapi] 走 /images/edits 图生图，参考图 ${imageRefs.length} 张`);
      let editResponse;
      try {
        editResponse = await axios.post(`${baseUrl}/images/edits`, form, {
          headers: Object.assign({ Authorization: `Bearer ${apiKeyValue}` }, form.getHeaders()),
        });
      } catch (e: any) {
        const detail = e?.response?.data ? JSON.stringify(e.response.data) : e?.message;
        throw new Error(`图片编辑失败: ${e?.response?.status ?? ""}, ${detail}`);
      }
      const editResult = editResponse.data?.data?.[0];
      if (!editResult) throw new Error("图片生成返回为空");
      if (editResult.b64_json) return `data:image/png;base64,${editResult.b64_json}`;
      if (editResult.url) return await urlToBase64(editResult.url);
      throw new Error("不支持的图片响应格式");
    }

    const body: Record<string, any> = {
      model: model.modelName,
      prompt: config.prompt,
      n: 1,
    };
    if (config.size) body.size = sizeValue;

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKeyValue}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`图片生成失败: ${response.status}, ${await response.text()}`);
    const data = await response.json();
    const result = data.data?.[0];
    if (!result) throw new Error("图片生成返回为空");
    if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
    if (result.url) return await urlToBase64(result.url);
    throw new Error("不支持的图片响应格式");
  }

  // GPT-Image 1.5 等旧模型使用 /chat/completions 多模态
  const body: Record<string, any> = {
    model: model.modelName,
    messages: [{ role: "user", content: config.prompt }],
    n: 1,
  };
  const refs = config.referenceList ?? [];
  if (refs.length > 0) {
    body.messages = [
      {
        role: "user",
        content: [
          ...refs.map((r: any) => ({ type: "image_url", image_url: { url: r.base64 } })),
          { type: "text", text: config.prompt },
        ],
      },
    ];
  }

  const MAX_RETRIES = 6;
  const RETRY_DELAY = 30000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKeyValue}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // 502 → 重试（临时性服务器错误）
      if (response.status === 502) {
        const errText = await response.text();
        logger(`[newapi] 服务暂不可用 (${attempt}/${MAX_RETRIES})，${RETRY_DELAY / 1000}s 后重试`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY); continue; }
        throw new Error(`请求失败: ${response.status}, ${errText}`);
      }

      if (!response.ok) {
        throw new Error(`请求失败: ${response.status}, ${await response.text()}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";

      // 响应内容也是排队消息 → 重试
      if (isRetryableError(content)) {
        logger(`[newapi] 排队中 (${attempt}/${MAX_RETRIES})，${RETRY_DELAY / 1000}s 后重试`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY); continue; }
        throw new Error("OpenAI 多次排队后仍未生成图片");
      }

      // 尝试提取图片：markdown → b64_json → 纯URL
      const imageResult = extractFirstImageFromMd(content);
      if (imageResult) {
        return imageResult.type === "base64" ? imageResult.url : await urlToBase64(imageResult.url);
      }

      const firstChoice = data.choices?.[0];
      if (firstChoice?.message?.b64_json) {
        return `data:image/png;base64,${firstChoice.message.b64_json}`;
      }

      if (content && /^https?:\/\//.test(content.trim())) {
        return await urlToBase64(content.trim());
      }

      throw new Error("未能从响应中提取图片");
    } catch (e: any) {
      // 非排队相关错误直接抛出
      if (attempt >= MAX_RETRIES || !isRetryableError(e.message || "")) throw e;
      logger(`[newapi] 异常 (${attempt}/${MAX_RETRIES}): ${e.message}，${RETRY_DELAY / 1000}s 后重试`);
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error("所有重试均已耗尽");
};

// ============================================================
// 视频（New API 统一任务接口 /v1/videos）
// ============================================================

/** 在响应体的常见位置里找视频地址（不同 New API 版本放置位置不同） */
function pickVideoUrl(data: any): string {
  if (!data || typeof data !== "object") return "";
  const candidates = [
    data?.metadata?.url,
    data?.metadata?.video_url,
    data?.content?.video_url,
    data?.video_url,
    data?.output_url,
    data?.url,
    data?.data?.url,
    data?.data?.video_url,
    data?.data?.[0]?.url,
    data?.result?.url,
    data?.result?.video_url,
    data?.output?.[0]?.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return "";
}

/** 在响应体的常见位置里找任务状态与错误信息 */
function pickStatus(data: any): string {
  const raw = data?.status ?? data?.state ?? data?.data?.status ?? data?.task?.status ?? "";
  return String(raw || "").toLowerCase();
}

function pickTaskId(data: any): string {
  const candidates = [data?.id, data?.task_id, data?.taskId, data?.data?.id, data?.data?.task_id, data?.task?.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function pickErrorMessage(data: any): string {
  const candidates = [
    data?.error?.message,
    data?.error,
    data?.message,
    data?.msg,
    data?.data?.error?.message,
    data?.failure_reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object" && typeof candidate.message === "string") return candidate.message;
  }
  return "";
}

const VIDEO_OK = new Set(["succeeded", "success", "completed", "complete", "done"]);
const VIDEO_FAIL = new Set(["failed", "failure", "error", "cancelled", "canceled", "expired", "rejected"]);

// 超时都必须显式给：axios 默认 timeout=0 表示**永不超时**。轮询请求卡住会让整个轮询循环一起卡死，
// 表现就是「上游早就出片了，本地一直等待生成」——而且没有任何日志。
const SUBMIT_TIMEOUT_MS = 180000; // 提交（含 base64 素材上传）
const QUERY_TIMEOUT_MS = 30000; // 单次轮询
const DOWNLOAD_TIMEOUT_MS = 600000; // 产物下载：给足 10 分钟，但必须有上限

/** 下载产物并转成 data URL：自己控制超时与日志（内核拿到 http 链接也会下载，但没有超时、没有日志） */
async function downloadArtifact(url: string): Promise<string> {
  const started = Date.now();
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: Infinity,
    headers: authHeaders(),
  });
  const mime = (response.headers && response.headers["content-type"]) || "video/mp4";
  const bytes = Buffer.from(response.data);
  logger(`[newapi 视频] 产物已下载: ${(bytes.length / 1048576).toFixed(2)} MB, 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API密钥");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");

  const root = apiRoot();
  const headers = authHeaders({ "Content-Type": "application/json" });

  // 1) 素材与锚点
  const { content, anchorByIndex } = buildVideoContent(config);
  const prompt = translatePrompt(config.prompt || "", anchorByIndex);

  // 2) 组装请求体：New API 的豆包线把视频参数放在 metadata 里
  const metadata: Record<string, any> = {};
  if (config.resolution) metadata.resolution = config.resolution;
  if (config.aspectRatio) metadata.ratio = config.aspectRatio;
  if (content.length) metadata.content = content;
  // 音频：必须「显式」给出布尔值。metoken 侧 generate_audio 默认 true，而 BytePlus 会对生成的音频
  // 做内容审核 —— 实测不关音频会整个任务失败：OutputAudioSensitiveContentDetected.PolicyViolation
  // （已退款）。所以只有用户在界面明确开启（config.audio === true）或模型强制有声时才打开。
  const audioOn = model.audio === true || (model.audio === "optional" && config.audio === true);
  metadata.generate_audio = audioOn;

  const body: Record<string, any> = {
    model: model.modelName,
    prompt,
    metadata,
  };
  // seconds 必须是【字符串】：new-api 的统一视频接口 Go DTO 是 `seconds string`，
  // 传数字会 400：json: cannot unmarshal number into Go struct field .Alias.seconds of type string
  const seconds = Number(config.duration);
  if (Number.isFinite(seconds) && seconds > 0) body.seconds = String(seconds);

  logger(
    `[newapi 视频] 提交: model=${model.modelName} duration=${body.seconds ?? "-"} resolution=${metadata.resolution ?? "-"} ratio=${metadata.ratio ?? "-"} media=${content.length}(图${content.filter((c) => c.type === "image_url").length}/视${content.filter((c) => c.type === "video_url").length}/音${content.filter((c) => c.type === "audio_url").length}) audio=${!!metadata.generate_audio}`,
  );
  logger(`[newapi 视频] 翻译后 prompt: ${prompt.slice(0, 160)}`);

  let createResp: any;
  try {
    createResp = await axios.post(`${root}/v1/videos`, body, { headers, timeout: SUBMIT_TIMEOUT_MS, maxBodyLength: Infinity, maxContentLength: Infinity });
  } catch (e: any) {
    const detail = e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e);
    logger(`[newapi 视频] 提交失败完整响应: ${detail}`);
    throw new Error(`视频任务提交失败: ${detail.slice(0, 800)}`);
  }

  const createData = createResp.data;
  const taskId = pickTaskId(createData);
  const immediateUrl = pickVideoUrl(createData);
  if (!taskId && !immediateUrl) {
    throw new Error(`视频任务创建失败：未返回任务ID。原始响应：${JSON.stringify(createData).slice(0, 300)}`);
  }
  logger(`[newapi 视频] 任务已创建, ID: ${taskId || "(同步返回结果)"}`);

  // 有些部署会同步返回结果（无需轮询）
  if (!taskId && immediateUrl) {
    logger(`[newapi 视频] 同步返回结果地址: ${immediateUrl}`);
    try {
      return await downloadArtifact(immediateUrl);
    } catch (e: any) {
      logger(`[newapi 视频] 产物下载失败（${e?.message || e}），退回原始 URL`);
      return immediateUrl;
    }
  }

  // 3) 轮询任务
  const pollStarted = Date.now();
  const pollResult = await pollTask(
    async (): Promise<PollResult> => {
      let queryResp: any;
      try {
        queryResp = await axios.get(`${root}/v1/videos/${encodeURIComponent(taskId)}`, { headers, timeout: QUERY_TIMEOUT_MS });
      } catch (e: any) {
        const status = e?.response?.status;
        logger(`[newapi 视频] 轮询请求异常 status=${status ?? "-"} ${e?.message || ""}, 继续重试`);
        return { completed: false };
      }
      const task = queryResp.data;
      const status = pickStatus(task);

      if (VIDEO_OK.has(status)) {
        const elapsed = ((Date.now() - pollStarted) / 1000).toFixed(1);
        const url = pickVideoUrl(task);
        if (url) {
          // 自己下载：有超时、有大小/耗时日志；失败则退回原始 URL 交上层处理
          try {
            const dataUrl = await downloadArtifact(url);
            logger(`[newapi 视频] 成功: id=${taskId} 轮询用时=${elapsed}s`);
            return { completed: true, data: dataUrl };
          } catch (e: any) {
            logger(`[newapi 视频] 产物下载失败（${e?.message || e}），退回原始 URL`);
            return { completed: true, data: url };
          }
        }
        // 响应里没有地址：去内容端点取字节（该端点通常需要令牌）
        const fetched = await fetchVideoBytes(`${root}/v1/videos/${encodeURIComponent(taskId)}/content`);
        logger(`[newapi 视频] 成功: id=${taskId} 轮询用时=${elapsed}s${fetched ? "（经 content 端点取回）" : ""}`);
        if (fetched) return { completed: true, data: fetched };
        return { completed: true, error: "任务成功但未取到视频地址或内容" };
      }
      if (VIDEO_FAIL.has(status)) {
        return { completed: true, error: pickErrorMessage(task) || `视频生成失败（${status}）` };
      }
      logger(`[newapi 视频] 任务状态: ${status || "(空)"}（已等待 ${((Date.now() - pollStarted) / 1000).toFixed(0)}s）`);
      return { completed: false };
    },
    10000,
    1800000, // 30 分钟
  );

  if (pollResult.error) throw new Error(pollResult.error);
  if (!pollResult.data) throw new Error("视频生成失败：轮询未返回数据");
  return pollResult.data;
};

/** 取产物字节并转成 data URL（内容端点一般要带令牌，不能把裸链接交给下游下载） */
async function fetchVideoBytes(url: string): Promise<string> {
  const started = Date.now();
  try {
    const resp = await axios.get(url, { headers: authHeaders(), responseType: "arraybuffer", timeout: DOWNLOAD_TIMEOUT_MS, maxContentLength: Infinity });
    const mime = resp.headers?.["content-type"] || "video/mp4";
    const bytes = Buffer.from(resp.data);
    logger(`[newapi 视频] content 端点取回产物: ${(bytes.length / 1048576).toFixed(2)} MB, 用时 ${((Date.now() - started) / 1000).toFixed(1)}s (${mime})`);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch (e: any) {
    logger(`[newapi 视频] content 端点取产物失败: ${e?.message || String(e)}`);
    return "";
  }
}

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

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
