import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { opsDisabledMessage, opsEnabled } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";
import { isExportableTable } from "@/lib/tableWhitelist";

const router = express.Router();

/**
 * 清空指定表。
 *
 * ⚠ Phase 1c Task 4 的四处收紧（原实现：`requireAdmin` + 只校验"表存在"）：
 *   1. **默认关闭**：`opsEnabled("allowDbAdminOps")`；
 *   2. **表名白名单**（`@/lib/tableWhitelist`，单一来源 = policies.ts 的业务表 − 基础设施表）——
 *      "表存在"不等于"允许被清"：`knex_migrations` 也是"存在的表"；
 *   3. **SQL 收紧**：`DELETE FROM "${t}"`（表名插值）改成 knex 的 `.del()` —— 表名经白名单后
 *      仍由 knex 转义，不再是手写 SQL（spec §7.3 对 `clearTable` 的点名要求）；
 *   4. **审计**：成功与失败都落一条。
 *
 * ⚠ 已知未修（如实登记）：旧实现读 `sqlite_master` 判"表是否存在"是 **sqlite 方言**；
 *   本版用 `db.schema.hasTable()`（knex 跨方言 API）替代，所以这一条**已不再依赖方言**。
 */
export default router.post("/", requireAdmin, async (req, res) => {
  const ctx = actorFromCtx(req.ip);
  try {
    // 闸二：默认关闭
    if (!(await opsEnabled("allowDbAdminOps"))) {
      await audit(ctx, AUDIT_ACTIONS.DB_CLEAR_TABLE, "rejected:ops-disabled", { tableName: req.body?.tableName ?? null });
      return res.status(403).send(error(opsDisabledMessage()));
    }

    const { tableName } = req.body;
    if (!tableName || typeof tableName !== "string") {
      return res.status(400).send(error("请提供有效的表名"));
    }

    // ①（新增）表名白名单：不在名单里直接拒绝，**不再**先问"表存在吗"
    if (!isExportableTable(tableName)) {
      await audit(ctx, AUDIT_ACTIONS.DB_CLEAR_TABLE, "rejected:table-not-allowed", { tableName });
      return res.status(400).send(error(`表 ${tableName} 不在允许清空的名单里`));
    }

    // ② 表必须真实存在（跨方言 API，不再读 sqlite_master）
    if (!(await db.schema.hasTable(tableName))) {
      await audit(ctx, AUDIT_ACTIONS.DB_CLEAR_TABLE, "rejected:no-such-table", { tableName });
      return res.status(400).send(error("表不存在"));
    }

    // ③ 用 knex 的 .del()（表名由 knex 转义），不再手写 `DELETE FROM "..."` 插值
    const deleted = await db(tableName).del();

    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR_TABLE, tableName, { deletedRows: Number(deleted ?? 0) });
    res.status(200).send(success(`表 ${tableName} 已清空`));
  } catch (err: any) {
    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR_TABLE, String(req.body?.tableName ?? "unknown"), {
      message: String(err?.message ?? err),
    });
    res.status(500).send(error(err?.message || "清空表失败"));
  }
});
