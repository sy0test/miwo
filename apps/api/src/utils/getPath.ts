import path from "path";
import isPathInside from "is-path-inside";
import { config } from "@/config";

/**
 * 解析数据目录下的路径（spec §4.3）。
 *
 * Phase 0 变更：基准目录由 `process.cwd()/data` 改为 `config.dataDir`（MIWO_DATA_DIR）。
 * 路径逃逸防护（is-path-inside）保持不变。
 * Electron 的数据根分支已在 Task 8 整块删除（不再有 `require("electron")` + `app.getPath("userData")`）：
 * 打包态同样走 MIWO_DATA_DIR，只剩下面的 `isEletron()` 判定供调用方区分打包/纯 Node 行为，
 * 导出名 `isEletron` 保持不变以免破坏既有 import。
 */
export default (fileName?: string[] | string) => {
  const basePath = config.dataDir;

  if (fileName) {
    const dbPath = Array.isArray(fileName) ? path.resolve(basePath, ...fileName) : path.resolve(basePath, fileName);
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isEletron() {
  return typeof process.versions?.electron !== "undefined";
}
