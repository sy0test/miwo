import db from "@/utils/db";
import oss from "@/utils/oss";
import getConfig from "./utils/getConfig";
import { v4 as uuid } from "uuid";
import error from "@/utils/error";
import cleanNovel from "./utils/cleanNovel";
import getPath from "@/utils/getPath";
import task from "@/utils/taskRecord";
import Ai from "@/utils/ai";
import { getPrompts } from "@/utils/getPrompts";
import * as feicai from "@/utils/feicai";
import replaceUrl from "@/utils/replaceUrl";
import writeVersion from "@/utils/writeVersion";
import * as vendor from "@/utils/vendor";

/**
 * 全局工具聚合（`u.xxx`）。
 *
 * ⚠ Phase 1c Task 8 起这里**不再有 `vm:`** —— 它曾指向 `utils/vm.ts` 的 `runCode()`
 *   （vm2 沙箱执行用户提交的供应商脚本，spec Tier 0 #1）。那整条通道已删除，
 *   适配器改为**编译期内置**（`src/vendors/*.ts` 静态注册表）。
 *   现在 `utils/vmHelpers.ts` 只导出纯函数辅助（`zipImage` 等），**不经 `u.` 暴露** ——
 *   它没有"运行任意代码"的语义，不该出现在通用出口上。
 */
export default {
  db,
  oss,
  getConfig,
  uuid,
  error,
  cleanNovel,
  getPath,
  Ai,
  task,
  getPrompts,
  feicai,
  replaceUrl,
  writeVersion,
  vendor,
};
