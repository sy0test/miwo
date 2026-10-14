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
