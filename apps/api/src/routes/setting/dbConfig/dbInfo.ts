import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）

const router = express.Router();

// ⚠ Phase 1b Task 7：挂 `requireAdmin`（收权前任意登录用户能拿到全库表名 + 每张表的**总行数**——
//   回填之后这些行数已经能对应到具体租户规模，属于结构性元数据外泄）。
// ⚠ 这是 6 个接口里**唯一保留价值**的只读接口（附录 B.1）；若将来要按租户展示行数，必须走包装层带 userId 的计数。
// ⚠ Phase 1c：第 9 行 `sqlite_master` 是 sqlite 方言，MySQL 下无效。
export default router.get("/", requireAdmin, async (req, res) => {
  try {
    const tables: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`,
    );

    const tableInfo = [];
    for (const table of tables) {
      const countResult = await db.raw(`SELECT COUNT(*) as count FROM "${table.name}"`);
      tableInfo.push({
        name: table.name,
        rowCount: countResult[0]?.count ?? 0,
      });
    }

    res.status(200).send(success(tableInfo));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "获取数据库信息失败"));
  }
});
