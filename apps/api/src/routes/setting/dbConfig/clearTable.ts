import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）

const router = express.Router();

// ⚠ Phase 1b Task 7：挂 `requireAdmin`（收权前任意登录用户就能清空任意一张表——判据是"表存在"，与租户无关）。
// ⚠ Phase 1c：第 23 行 `DELETE FROM "${tableName}"` 是**表名插值**（仅白名单校验过表名，值没有参数化），
//   且 `sqlite_master` 是 sqlite 方言；本任务只收权，不改这两点。
export default router.post("/", requireAdmin, async (req, res) => {
  try {
    const { tableName } = req.body;
    if (!tableName || typeof tableName !== "string") {
      return res.status(400).send(error("请提供有效的表名"));
    }

    // 验证表名存在（防止SQL注入）
    const tableExists: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName],
    );
    if (tableExists.length === 0) {
      return res.status(400).send(error("表不存在"));
    }

    await db.raw(`DELETE FROM "${tableName}"`);

    res.status(200).send(success(`表 ${tableName} 已清空`));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清空表失败"));
  }
});
