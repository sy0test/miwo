import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import initDB from "@/lib/initDB";
import { opsDisabledMessage, opsEnabled } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";
import { isExportableTable } from "@/lib/tableWhitelist";

const router = express.Router();

/**
 * 整库导入 / 恢复（**只能来自本接口自己导出的文件**）。
 *
 * ⚠ Phase 1c Task 4 的四处收紧（原实现：任意登录用户一条 POST 就能先 drop 全库再灌任意数据）：
 *   1. **收权**：`requireAdmin`（1b 已做）；
 *   2. **默认关闭**：`opsEnabled("allowDbAdminOps")`（spec §7.3 的"默认关闭"落点，
 *      用平台键而不是新 `MIWO_*` 环境变量，理由见 `src/utils/opsSwitch.ts`）；
 *   3. **表名/列白名单**：请求体里的表名必须在 `tableWhitelist.ts` 的名单里，
 *      且导入的列必须是目标表**真实存在**的列（多出来的列直接拒绝，不静默丢弃）；
 *   4. **审计**：无论成败都落一条（含被拒绝的尝试）。
 *
 * ⚠ 它**不做租户过滤**（整库恢复语义 ⇒ 租户条件无法限定），所以只能靠"收权 + 双闸 + 白名单"兜住。
 * ⚠ `sqlite_master` 与 PRAGMA 是 **sqlite 方言**，MySQL 下无效（Phase 1c 未重写这一层，如实登记）。
 */
export default router.post("/", requireAdmin, async (req, res) => {
  const ctx = actorFromCtx(req.ip);
  try {
    // 闸二：默认关闭
    if (!(await opsEnabled("allowDbAdminOps"))) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:ops-disabled", { ok: false });
      return res.status(403).send(error(opsDisabledMessage()));
    }

    const { tables: importTables } = req.body;
    if (!importTables || typeof importTables !== "object" || Array.isArray(importTables)) {
      return res.status(400).send(error("无效的导入数据格式"));
    }

    // ① 表名白名单：**先全量校验再动手**（不能"边删边发现表名非法"——那时库已经没了）
    const requested = Object.keys(importTables);
    const notAllowed = requested.filter((t) => !isExportableTable(t));
    if (notAllowed.length) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:table-not-allowed", { notAllowed: notAllowed.slice(0, 20) });
      return res.status(400).send(error(`导入包含不在白名单里的表：${notAllowed.slice(0, 10).join(", ")}`));
    }

    // ② 列白名单：逐表比对**目标表真实列**（多出来的列一律拒绝，不静默丢）
    const badColumns: Array<{ table: string; columns: string[] }> = [];
    for (const [tableName, rows] of Object.entries(importTables as Record<string, unknown>)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const hasTable = await db.schema.hasTable(tableName);
      if (!hasTable) continue; // 表不存在 ⇒ 后面会跳过（与旧行为一致）
      const info = await db(tableName).columnInfo();
      const known = new Set(Object.keys(info ?? {}));
      const sample = rows.find((r) => r && typeof r === "object") as Record<string, unknown> | undefined;
      const extra = sample ? Object.keys(sample).filter((c) => !known.has(c)) : [];
      if (extra.length) badColumns.push({ table: tableName, columns: extra });
    }
    if (badColumns.length) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:unknown-columns", { badColumns });
      return res.status(400).send(
        error(`导入包含目标表里不存在的列：${badColumns.map((b) => `${b.table}(${b.columns.join("/")})`).join("、")}`),
      );
    }

    // 删除所有现有表
    const existingTables: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`,
    );

    await db.raw("PRAGMA foreign_keys = OFF");
    for (const table of existingTables) {
      await db.schema.dropTableIfExists(table.name);
    }
    await db.raw("PRAGMA foreign_keys = ON");

    // 重新初始化表结构
    await initDB(db as any);

    // 导入数据
    await db.raw("PRAGMA foreign_keys = OFF");
    const imported: Record<string, number> = {};
    for (const [tableName, rows] of Object.entries(importTables as Record<string, any[]>)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      if (!(await db.schema.hasTable(tableName))) continue;

      // 清空表数据后插入导入数据
      await db.raw(`DELETE FROM "${tableName}"`);
      // 分批插入，每批100条
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        await db(tableName).insert(batch);
      }
      imported[tableName] = rows.length;
    }
    await db.raw("PRAGMA foreign_keys = ON");

    await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "all-tables", {
      tables: Object.keys(imported).length,
      rows: Object.values(imported).reduce((a, b) => a + b, 0),
      imported,
    });
    res.status(200).send(success("数据库导入成功"));
  } catch (err: any) {
    await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "failed", { message: String(err?.message ?? err) });
    res.status(500).send(error(err?.message || "导入失败"));
  }
});
