/**
 * 供应商适配器的**运行期依赖面**（Phase 1c Task 8）。
 *
 * ── 它替代了什么 ──
 * 旧 `utils/vm.ts` 的 `runCode()` 会为**每次调用**建一个 vm2 沙箱，并把下面这 20 个名字塞进
 * `sandbox` 对象；适配器源码里则用 `declare const xxx: any` 假装它们存在，靠 `exports.X = X`
 * 把结果吐回沙箱。Task 8 之后适配器是**普通 ES 模块**：文件顶部 `import { … } from "@/vendors/runtime"`
 * 一次拿全，末尾 `export { … }`——名字与本文件**逐一对应**，于是"转换"只是把沙箱换成了模块解析。
 *
 * ── 为什么必须是一次全量 import（而不是按需）──
 * 转换是**机械**的（`scripts/vendor-to-module.cjs`，13/13 文件同一套规则），逐文件挑"用到哪些"
 * 会让转换脚本需要做语义分析。tsconfig 没开 `noUnusedLocals`，多导入的名字无害。
 *
 * ⚠ 这里**只有** 20 个名字。不要往这个文件里加"顺便导出点什么" —— 它的大小就是
 *   "适配器能碰到什么"的清单（spec §10.1 的收口面）。
 */
export { createOpenAI } from "@ai-sdk/openai";
export { createDeepSeek } from "@ai-sdk/deepseek";
export { createZhipu } from "zhipu-ai-provider";
export { createQwen } from "qwen-ai-provider-v5";
export { createAnthropic } from "@ai-sdk/anthropic";
export { createOpenAICompatible } from "@ai-sdk/openai-compatible";
export { createXai } from "@ai-sdk/xai";
export { createMinimax } from "vercel-minimax-ai-provider";
export { createGoogleGenerativeAI } from "@ai-sdk/google";
export { zipImage, zipImageResolution, urlToBase64, mergeImages, pollTask, vmLogger as logger } from "@/utils/vmHelpers";
export { default as jsonwebtoken } from "jsonwebtoken";
export { default as crypto } from "node:crypto";
export { default as FormData } from "form-data";
export { default as axios } from "axios";
// `fetch` 是 Node 全局，无需 import/export —— 保留这行注释是为了让"20 个名字"数得清：
// 15（上面）+ 1（logger）+ 3（jsonwebtoken/crypto/FormData）+ 1（axios）= 20。

// ---------------------------------------------------------------------------
// 每请求的 vendor.inputValues 覆盖（Phase 1c Task 8 的语义回归修复）
//
// 适配器内置化后模块是单例：vendor.inputValues 是**编译期默认值**（apiKey 空）。
// 运行时凭据在 DB 里，ai.ts 会拿一份 getVendorConfigFor() 的拷贝传进来；
// 老适配器（除了 newapi）没有第三参、直接读模块单例 ⇒ 永远报“缺少API Key”。
//
// 这里用 AsyncLocalStorage 给每次模型调用挂一个“当前请求的 inputValues”，
// 适配器把 vendor.inputValues.x 换成 vendorInputs(vendor).x 即可读到 DB 值，
// 又不会把 A 用户的 key 写进全局单例。
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";

const vendorInputsStore = new AsyncLocalStorage<Record<string, any>>();

export function runWithVendorInputs<T>(inputs: Record<string, any> | null | undefined, fn: () => T): T {
  return vendorInputsStore.run(inputs && typeof inputs === "object" ? inputs : {}, fn);
}

export function vendorInputs<T = Record<string, any>>(vendor?: { inputValues?: Record<string, any> | null }): T {
  const base = (vendor?.inputValues && typeof vendor.inputValues === "object" ? vendor.inputValues : {}) as Record<string, any>;
  const runtime = vendorInputsStore.getStore();
  return (runtime ? { ...base, ...runtime } : base) as T;
}
