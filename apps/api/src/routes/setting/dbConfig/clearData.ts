import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import initDB from "@/lib/initDB";

const router = express.Router();

// ⚠ Phase 1b Task 7：挂 `requireAdmin`（收权前任意登录用户 GET 一次就 drop 全库 + 重建）。
// ⚠ Phase 1c：第 11 行的 `sqlite_master` 与 PRAGMA 是 **sqlite 方言**，MySQL 下无效（本任务不动）。
export default router.get("/", requireAdmin, async (req, res) => {
  try {
    // 获取所有表名
    const tables: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`,
    );

    // 禁用外键约束，逐一删除所有表
    await db.raw("PRAGMA foreign_keys = OFF");
    for (const table of tables) {
      await db.schema.dropTableIfExists(table.name);
    }
    await db.raw("PRAGMA foreign_keys = ON");

    // 重新初始化数据库
    await initDB(db as any);

    res.status(200).send(success("数据库已清空并重新初始化"));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清除失败"));
  }
});
