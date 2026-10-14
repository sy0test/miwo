import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { listTables, tableRowCount } from "@/lib/dbOps";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";

const router = express.Router();

/**
 * 库结构概览（**只回表名 + 总行数**，不回任何列内容）。
 *
 * ⚠ 这是 6 个运维接口里**唯一保留价值**的只读接口（附录 B.1）。Phase 1c Task 4 的处置：
 *   `requireAdmin`（1b 已做）+ **审计**（读的是全库元数据，谁看的要有痕）。
 *   ⚠ **刻意不加** `allowDbAdminOps` 闸：那条闸是给"破坏性/凭据面"的接口用的；
 *     dbInfo 只回 `{name,rowCount}`，把它一起关掉会让运维在出事时**看不到任何结构信息**
 *     （代价大于收益）。这条取舍写进报告。
 *   ⚠ 本接口**未做脱敏**（本来就只回表名与行数）；但行数本身能反映租户规模 ⇒ 仍收权到 admin。
 *
 * ⚠ **Phase 1c Task 5+6（裁定 §2.5）已修掉"sqlite 专属"**：表清单与行数改走 `@/lib/dbOps`
 *   （sqlite → `sqlite_master`；mysql → `information_schema.tables`，两边都用 `count({n:"*"})`）。
 *   旧写法 `SELECT name FROM sqlite_master` 在 MySQL 上 `ER_NO_SUCH_TABLE` ⇒ 运维在出事时
 *   **看不到任何结构信息**。⚠ mysql 分支**未实测**（本机不起 MySQL），只有 `toSQL()` 形态证明。
 */
export default router.get("/", requireAdmin, async (req, res) => {
  const ctx = actorFromCtx(req.ip);
  try {
    const tables = await listTables(db);

    const tableInfo = [];
    for (const table of tables) {
      tableInfo.push({ name: table, rowCount: await tableRowCount(db, table) });
    }

    await audit(ctx, AUDIT_ACTIONS.DB_INFO, "all-tables", { tables: tableInfo.length });
    res.status(200).send(success(tableInfo));
  } catch (err: any) {
    await audit(ctx, AUDIT_ACTIONS.DB_INFO, "failed", { message: String(err?.message ?? err) });
    res.status(500).send(error(err?.message || "获取数据库信息失败"));
  }
});
