import u from "@/utils";
import { getVendorModule } from "@/vendors";

/**
 * 供应商适配器的取用面（Phase 1c Task 8）。
 *
 * ── 改前 ──
 * 三个导出都是"读 `data/vendor/<id>.ts` 的源码 → `sucrase` 转译 → `u.vm(jsCode)` 在 vm2 沙箱里
 * 执行 → 拿 `exports`"。也就是说：**每次调一次模型，就把一个 .ts 文件当代码执行一遍**。
 *
 * ── 改后 ──
 * 一律走**编译期内置**的注册表（`src/vendors/index.ts`）。这里不再有 `fs` / `sucrase` / `vm`。
 *
 * ── 本文件被删掉的两个导出（连同它们的调用点，Tier 0 #2）──
 *   · `getCode(id)`   —— 把适配器源码整份读出来当字符串回传（`getVendorList` 曾把它回给前端）；
 *   · `writeCode(id, tsCode)` —— **把请求体里的字符串写成磁盘上的 .ts**，随后被当代码执行。
 * 这两个与 `addVendor` / `updateCode` / `getCodeByLink` 三个路由一起删除：
 * "提交并执行代码"的接口在 Task 9 之后**不存在**（不是被禁用）。
 */

export async function getModelList(id: string): Promise<Array<any>> {
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  const vendorData = getVendorModule(id);
  if (!vendorData || !vendorData.vendor || !vendorData.vendor.models) return [];
  const combined = [...JSON.parse(JSON.stringify(vendorData.vendor.models)), ...JSON.parse(models?.models ?? "[]")];
  const map = new Map<string, any>();
  for (const m of combined) {
    map.set(m.modelName, m);
  }
  return [...map.values()];
}

/**
 * 取某个供应商的 `vendor` 配置对象。
 *
 * ⚠ 返回的是**注册表里那个模块级对象本身**（单例）。调用方若直接
 * `Object.assign(vendor.inputValues, …)` 会**改到所有调用方共享的那份**（跨用户串密钥）。
 * 需要覆盖 `inputValues` 的地方请用 `getVendorConfigFor(id, cfg)`（浅拷贝），
 * 或自己做浅拷贝。这与改前的语义**不同**：旧路径每次调用都重新执行一遍适配器代码，
 * 天然是一份新的对象。
 */
export function getVendor(id: string) {
  return getVendorModule(id)?.vendor;
}

/**
 * 取"用 DB 里的配置覆盖过 `inputValues` 的**副本**"（Phase 1c Task 8 的语义回归修复点）。
 *
 * 旧路径（`runCode`）每次调用都重新执行适配器代码 ⇒ 拿到的是**新对象**，`Object.assign` 改它
 * 不影响任何人。内置化之后模块是**单例**，直接 `Object.assign(mod.vendor.inputValues, …)`
 * 会把 A 用户的 key 留在模块级对象上，B 用户下次取到 A 的 key。
 *
 * 这里做**两层浅拷贝**：外层 `{ ...mod.vendor }`（不动模块对象），内层
 * `inputValues: { ...defaults, ...overrides }`（不动模块的 inputValues）。
 * `models` 等其余字段按调用方需要再覆盖（本函数只负责 inputValues，保持单一职责）。
 */
export function getVendorConfigFor(id: string, inputValuesOverride?: Record<string, any> | null): any | undefined {
  const mod = getVendorModule(id);
  if (!mod || !mod.vendor) return undefined;
  const defaults = mod.vendor.inputValues;
  const merged = { ...(defaults && typeof defaults === "object" ? defaults : {}) };
  if (inputValuesOverride && typeof inputValuesOverride === "object") {
    for (const [k, v] of Object.entries(inputValuesOverride)) merged[k] = v;
  }
  return { ...mod.vendor, inputValues: merged };
}
