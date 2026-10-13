import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）

const router = express.Router();

/**
 * 导出时**必须剔除**的行 —— 最高价值凭据。
 *
 * `o_setting.tokenKey` 是 JWT 签名密钥：一条 GET 就能把它连同所有租户数据一起下载走
 * （拿到它就能**伪造任意用户（含 admin）的 token**）。剔除它**不破坏往返**：importer
 * （`src/db/legacy/import.ts` 的 SEED 名单）本来就把 tokenKey 列为"绝不导回"。
 *
 * ⚠ Phase 1c（spec §7.3 的脱敏字段清单）：`o_user.password`（密码哈希）与
 *   `o_vendorConfig.inputValues`（供应商明文 key）**尚未**脱敏 —— 掩掉它们会让"恢复备份后登录不上 /
 *   供应商配置失效"，属于功能取舍，需要单独拍板（已上报 Lead）；本任务只做**零往返损失**的那一条。
 */
export const EXCLUDED_EXPORT_ROWS: ReadonlyArray<{ table: string; column: string; value: string }> = [
  { table: "o_setting", column: "key", value: "tokenKey" },
];

// ⚠ Phase 1b Task 7：挂 `requireAdmin`（收权前任意登录用户 GET 一次就下载整库，含上面那条密钥）。
// ⚠ Phase 1c：第 9/15 行 `sqlite_master` 是 sqlite 方言，MySQL 下无效。
export default router.get("/", requireAdmin, async (req, res) => {
  try {
    const tables: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`,
    );

    const data: Record<string, any[]> = {};
    for (const table of tables) {
      const rows: any[] = await db.raw(`SELECT * FROM "${table.name}"`);
      // 逐行剔除（表名/列名/值都来自本文件的常量，不含用户输入 ⇒ 无注入面）
      data[table.name] = rows.filter(
        (row) => !EXCLUDED_EXPORT_ROWS.some((x) => x.table === table.name && row?.[x.column] === x.value),
      );
    }

    const exportData = {
      exportTime: Date.now(),
      tables: data,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=toonflow-backup-${Date.now()}.json`);
    res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导出失败"));
  }
});
