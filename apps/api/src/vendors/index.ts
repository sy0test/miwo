/**
 * 供应商适配器注册表（Phase 1c Task 8；spec §10.1）。
 *
 * ── 这张表就是"编译期内置"本身 ──
 * 13 个适配器在这里被**静态 import** —— 于是 esbuild 打包时会把它们真的打进 `data/serve/app.js`
 * （`pnpm run build` 的成功就是这条的判据）。与之相反的做法（`fs.readdirSync("data/vendor")` +
 * 运行期读文件 + 转译 + `vm2` 执行）是 Tier 0 #1：**用户提交的代码在服务进程里被执行**。
 * 那张能力在 Task 8 已被**整段删除**，不是"加了校验"。
 *
 * ⚠ 不要改成动态发现（`fs.readdirSync` / `require(variable)` / `await import(id)`）：
 *   ① 打包器看不穿它，"编译期内置"当场退化成"运行期发现"；
 *   ② 仓库里 `check-mysql-dialect` 之外还有一条更朴素的门禁 —— 全仓 grep 必须 0 命中
 *      `vm2` / `sucrase` / `u.vm(`（见 `apps/api/tests/vendors-registry.test.ts`）。
 *
 * ⚠ `null` 是**保留字**：`import * as null from "…"` 是语法错误。必须像下面这样起个别名
 *   （`nullVendor`）再以 `null:` 入表 —— 这是"照抄转换脚本输出"最容易踩的一步。
 */
import * as atlascloud from "@/vendors/atlascloud";
import * as deepseek from "@/vendors/deepseek";
import * as grsai from "@/vendors/grsai";
import * as klingai from "@/vendors/klingai";
import * as metoken from "@/vendors/metoken";
import * as minimax from "@/vendors/minimax";
import * as miwo from "@/vendors/miwo";
import * as newapi from "@/vendors/newapi";
import * as nullVendor from "@/vendors/null";
import * as openai from "@/vendors/openai";
import * as vidu from "@/vendors/vidu";
import * as volcengine from "@/vendors/volcengine";
import * as volcengineSd2 from "@/vendors/volcengineSd2";

/**
 * 一个适配器模块对外暴露的成员。
 *
 * 与旧沙箱的 `exports` 对象**同形**（`exports.vendor = vendor` 那几行），但现在是真导出：
 * 缺哪个成员在**编译期**就能看见（旧形态要等运行期 `undefined` 才知道）。
 * `klingai` / `vidu` **没有** `checkForUpdates` / `updateVendor`（实测：5 个 / 4 个导出），
 * 所以这两个字段是可选 —— 与旧 `runCode` 的 `exports` 语义一致（缺了就是 `undefined`）。
 */
export interface VendorExports {
  vendor: any;
  textRequest?: any;
  imageRequest?: any;
  videoRequest?: any;
  ttsRequest?: any;
  uploadReference?: any;
  checkForUpdates?: any;
  updateVendor?: any;
}

/** 单一看守：注册表是 `Record<string, VendorExports>`，`Object.prototype.hasOwnProperty` 防原型链。 */
const REGISTRY: Record<string, VendorExports> = {
  atlascloud,
  deepseek,
  grsai,
  klingai,
  metoken,
  minimax,
  miwo,
  newapi,
  null: nullVendor,
  openai,
  vidu,
  volcengine,
  volcengineSd2,
};

/** 取适配器模块；未知 id 返回 `null`（**不抛**——调用方要能区分"不存在"与"加载失败"）。 */
export function getVendorModule(id: string): VendorExports | null {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id] : null;
}

/** 全部内置 id（与 `apps/api/data/vendor/` 的历史 13 个清单一逐一对应）。 */
export function listVendorIds(): string[] {
  return Object.keys(REGISTRY);
}
