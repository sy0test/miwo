import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import initDB from "@/lib/initDB";
import { opsDisabledMessage, opsEnabled } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";

const router = express.Router();

/**
 * 清空整库并重新初始化。
 *
 * ⚠ Phase 1c Task 4：在 1b 的 `requireAdmin` 之上再加 **默认关闭**（`allowDbAdminOps`）+ **审计**。
 *   spec §7.3 对破坏性运维接口的要求就是这三件套；`clearData` 是其中破坏面最大的一个
 *   （drop 全库 + 重建 ⇒ 所有租户数据一次性消失）。
 *
 * ⚠ 已知未修（如实登记）：`sqlite_master` 与 PRAGMA 是 **sqlite 方言**，MySQL 下无效；
 *   本任务不重写这一层（归 Phase 2 的跨方言运维工具）。
 */
export default router.get("/", requireAdmin, async (req, res) => {
  const ctx = actorFromCtx(req.ip);
  try {
    // 闸二：默认关闭
    if (!(await opsEnabled("allowDbAdminOps"))) {
      await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "rejected:ops-disabled", { ok: false });
      return res.status(403).send(error(opsDisabledMessage()));
    }

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

    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "all-tables", { droppedTables: tables.length });
    res.status(200).send(success("数据库已清空并重新初始化"));
  } catch (err: any) {
    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "failed", { message: String(err?.message ?? err) });
    res.status(500).send(error(err?.message || "清除失败"));
  }
});
