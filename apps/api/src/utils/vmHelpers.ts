import axios from "axios";
import sharp from "sharp";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "vercel-minimax-ai-provider";
import FormData from "form-data";
import jsonwebtoken from "jsonwebtoken";
import crypto from "node:crypto";
import u from "@/utils";

/**
 * 供应商适配器的**纯函数辅助**（Phase 1c Task 8）。
 *
 * ── 这个文件曾经是"代码执行通道" ──
 * 本文件原名 `utils/vm.ts`，它同时干两件事：
 *   ① 导出 `runCode(code, vendor?)` —— 用 **vm2** 起沙箱、`vm.run(code)` 执行**用户提交的**
 *      供应商脚本（spec Tier 0 #1 的最高危能力）；
 *   ② 导出 `zipImage` / `zipImageResolution` / `urlToBase64` / `mergeImages` / `pollTask` / `logger`
 *      这批纯函数，供适配器在沙箱里当全局用。
 *
 * Task 8 把 ① **整段删除**（`import { VM } from "vm2"` / `runCode` / `export default`），并把 13 个
 * 适配器改成**编译期内置**（`src/vendors/*.ts`，静态 import 进注册表）⇒ 运行期不再有任何
 * `require`/`eval`/`new Function`/`vm`/`vm2` 路径。能力**不存在**，不是"加了校验"。
 *
 * ── 留下的这批函数为什么要留着 ──
 * 它们被适配器本体与别处都用（`zipImage(...)` 等），且**与代码执行无关**：
 * 全部是"拿 base64/URL，走 sharp/axios 处理"的普通异步函数。名字与旧沙箱逐一对应，
 * 于是 `src/vendors/runtime.ts` 能逐名 re-export 给适配器用。上面的 import 头是**照抄**旧
 * `vm.ts` 的（那些 create* 工厂原本是沙箱对象里的条目，现在同理只被 `runtime.ts` 转出去）。
 *
 * ⚠ `logger` 内部调用的是 `console.log`，与 `src/logger.ts` 的应用日志**不是一回事** ——
 *   所以这里以 `vmLogger` 为正式名导出，并保留 `logger` 别名（适配器源码里裸写 `logger(...)`，
 *   `runtime.ts` 仍以 `logger` 这个名字转出去）。改名不是为了更漂亮，是为了下一个人不会
 *   把"适配器调试打印"和"应用日志"接错线。
 */

/** 适配器里的 `logger(...)`：前缀 `【VM】` 是历史痕迹（沙箱已删），保留以免改变对外可见的输出形状。 */
export function vmLogger(logstring: any) {
  console.log("【VM】" + JSON.stringify(logstring));
}

/** 适配器源码里裸写的名字。新代码请用 `vmLogger`（避免与 `src/logger.ts` 混淆）。 */
export const logger = vmLogger;

/**
 * 压缩图片，目标字节数不高于 size
 */
export async function zipImage(completeBase64: string, size: number): Promise<string> {
  let quality = 80;
  let buffer = Buffer.from(completeBase64.split(",")[1], "base64");
  let output = await sharp(buffer).jpeg({ quality }).toBuffer();
  while (output.length > size && quality > 10) {
    quality -= 10;
    output = await sharp(buffer).jpeg({ quality }).toBuffer();
  }
  return "data:image/jpeg;base64," + output.toString("base64");
}

export async function zipImageResolution(completeBase64: string, width: number, height: number): Promise<string> {
  const buffer = Buffer.from(completeBase64.split(",")[1], "base64");
  const out = await sharp(buffer).resize(width, height).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

//url转Base64
export async function urlToBase64(url: string): Promise<string> {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const mime = res.headers["content-type"] || "image/jpeg";
  const b64 = Buffer.from(res.data).toString("base64");
  return `data:${mime};base64,${b64}`;
}

export async function pollTask(
  fn: () => Promise<{ completed: boolean; data?: string; error?: string }>,
  interval = 3000,
  timeout = 3000000,
): Promise<{ completed: boolean; data?: string; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result.completed) return result;
      if (result?.error) return result;
    } catch (e: any) {
      return { completed: false, error: u.error(e).message || "poll error" };
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  return { completed: false, error: "timeout" };
}

/**
 * 将多张图片横向拼接为一张，并确保输出大小不超过指定限制
 * @param imageBase64List - base64编码的图片数组
 * @param maxSize - 最大输出大小，支持格式如 "10mb", "5MB", "1024kb" 等
 * @returns 拼接后的图片base64字符串
 */
export async function mergeImages(imageBase64List: string[], maxSize = "10mb"): Promise<string> {
  if (imageBase64List.length === 0) {
    throw new Error("图片列表不能为空");
  }

  const maxBytes = parseSize(maxSize);
  const imageBuffers = imageBase64List.map(base64ToBuffer);
  const imageMetadatas = await Promise.all(imageBuffers.map((buffer) => sharp(buffer).metadata()));
  const maxHeight = Math.max(...imageMetadatas.map((m) => m.height || 0));

  // 计算各图片调整后的宽度
  const imageWidths = imageMetadatas.map((metadata) => {
    const aspectRatio = (metadata.width || 1) / (metadata.height || 1);
    return Math.round(maxHeight * aspectRatio);
  });
  const totalWidth = imageWidths.reduce((sum, w) => sum + w, 0);

  // 拼接图片
  const resizedImages = await Promise.all(
    imageBuffers.map(async (buffer, index) => {
      return sharp(buffer).resize(imageWidths[index], maxHeight, { fit: "cover" }).toBuffer();
    }),
  );

  let currentX = 0;
  const compositeInputs = resizedImages.map((buffer, index) => {
    const input = { input: buffer, left: currentX, top: 0 };
    currentX += imageWidths[index];
    return input;
  });

  const mergedBuffer = await sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(compositeInputs)
    .jpeg({ quality: 90 })
    .toBuffer();

  // 复用压缩逻辑
  const resultBuffer = await compressToSize(mergedBuffer, maxBytes, totalWidth, maxHeight);
  return resultBuffer.toString("base64");
}

/**
 * 解析大小字符串为字节数
 */
function parseSize(size: string): number {
  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/);
  if (!match) {
    throw new Error(`无效的大小格式: ${size}`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2] || "b";
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  return Math.floor(value * multipliers[unit]);
}

/**
 * 将base64字符串转换为Buffer
 */
function base64ToBuffer(base64: string): Buffer {
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64Data, "base64");
}

/**
 * 压缩Buffer到指定大小以内
 */
async function compressToSize(imageBuffer: Buffer, maxBytes: number, originalWidth: number, originalHeight: number): Promise<Buffer> {
  let quality = 90;
  let scale = 1;

  while (true) {
    const targetWidth = Math.round(originalWidth * scale);
    const targetHeight = Math.round(originalHeight * scale);

    const resultBuffer = await sharp(imageBuffer).resize(targetWidth, targetHeight, { fit: "fill" }).jpeg({ quality }).toBuffer();

    if (resultBuffer.length <= maxBytes) {
      return resultBuffer;
    }

    if (quality > 10) {
      quality -= 10;
    } else {
      quality = 90;
      scale *= 0.8;
    }
  }
}
