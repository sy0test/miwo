/**
 * 任务类型注册表（spec §9.1 / §9.2）。
 *
 * 设计：`JOB_DEFINITIONS` 是一个**显式数组**（不是目录扫描）—— 与迁移清单同一思路：
 * 显式登记 + 有测试断言"当前登记集合"（`tests/job-types.test.ts` 的期望列表），
 * 避免"写了 handler 忘了注册"（那种任务的症状是：入队成功、永远没人执行）。
 *
 * ⚠ `get()` 对未知类型返回 `null`（**不抛**）：worker 可能被部署了旧 handler 而库里已有新类型的
 *   任务，或者运维手工插了脏数据 —— 这时应当把该 job 判失败（可诊断、可重投），
 *   而不是让**整个 worker 进程**崩掉（一条脏数据不该让所有租户的队列停摆）。
 */
import type { AnyJobDefinition } from "@/jobs/types";
import { selftestSleep } from "@/jobs/handlers/selftest";
import { videoBatchGenerate, videoGenerate } from "@/jobs/handlers/videoGenerate";
import { imageAssetsBatch } from "@/jobs/handlers/imageAssets";
import { imageStoryboardBatch } from "@/jobs/handlers/imageStoryboard";
import { imageProductionAssetsBatch } from "@/jobs/handlers/imageProductionAssets";
import { promptBatch } from "@/jobs/handlers/promptBatch";
import { redrawPrepare } from "@/jobs/handlers/redrawPrepare";
import { redrawStoryboard } from "@/jobs/handlers/redrawStoryboard";

export interface JobRegistry {
  /** 未知类型返回 null（见文件头；**不抛**）。 */
  get(type: string): AnyJobDefinition | null;
  /** 登记的全部定义（顺序 = 数组顺序）。 */
  all(): AnyJobDefinition[];
}

/** 用 definition 数组建注册表；**重复 type 直接抛**（否则后一个会静默覆盖前一个）。 */
export function createJobRegistry(defs: AnyJobDefinition[]): JobRegistry {
  const map = new Map<string, AnyJobDefinition>();
  for (const d of defs) {
    if (map.has(d.type)) throw new Error(`[job] 任务类型重复注册："${d.type}"`);
    map.set(d.type, d);
  }
  return {
    get: (type) => map.get(type) ?? null,
    all: () => [...map.values()],
  };
}

/**
 * 本阶段登记的任务类型（Phase 1d Task 7 落地：6 个业务 handler + selftest）。
 * 新增类型必须同时做两件事：
 *   ① 加进这个数组；② 在 `tests/job-registry.test.ts` 的期望集合里加一项
 *      （那条断言是"注册表 ↔ 实现"的机械守卫，故意要求人工过目）。
 */
export const JOB_DEFINITIONS: AnyJobDefinition[] = [
  videoGenerate,
  videoBatchGenerate,
  imageAssetsBatch,
  imageStoryboardBatch,
  imageProductionAssetsBatch,
  promptBatch,
  // 2026-10-24 转绘 M1：预处理 + 解析任务化（不调厂商 = 不扣费；解析那一步在整个任务内部）
  redrawPrepare,
  // 2026-10-24 转绘 M3：转绘分镜层（一次文本调用；计费在 handler 内部）
  redrawStoryboard,
  selftestSleep,
];

/** 全局注册表（api 与 worker 共用同一份定义）。 */
export const jobRegistry: JobRegistry = createJobRegistry(JOB_DEFINITIONS);