import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { columnNames, setForeignKeys } from "@/lib/dbOps";
import { opsDisabledMessage, opsEnabled } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";
import { isExportableTable } from "@/lib/tableWhitelist";

const router = express.Router();

/**
 * 凭据 / 平台配置的**表级拒绝清单**（Phase 1c Task 5+6 的收窄；brief Task 5 Step 2）。
 *
 * 为什么这三张表**不允许**经 HTTP 导回：
 *   · `o_user` —— 账号与口令哈希。整库恢复应当是 DBA 在停机窗口做的事，不是一条管理员 HTTP 请求；
 *     允许它 = "任何拿到 admin 令牌的人都能把全站账号替换成自己准备的一份"（含降级/接管）。
 *   · `o_vendorConfig` —— 供应商 API key 明文（`inputValues`）。导入 = 静默替换全平台出网凭据。
 *   · `o_setting` —— 平台级配置（含历史遗留的 `tokenKey`/`jwtSecret` 一类签名材料）。
 *
 * ⚠ 这是**收窄**，不是"删功能"：导出侧仍然照旧（完整备份还能导出，只是不能用 HTTP 灌回来），
 *   且**其它** platform 表（`o_artStyle` / `o_agentDeploy` / `o_prompt` / `o_modelPrompt`）**仍可导入**——
 *   它们是运营资产，恢复它们不涉及凭据面。
 */
export const EXCLUDED_IMPORT_TABLES: ReadonlySet<string> = new Set(["o_user", "o_vendorConfig", "o_setting"]);

/**
 * 整库导入 / 恢复（**只能来自本接口自己导出的文件**）。
 *
 * ⚠ Phase 1c Task 4 的四处收紧（原实现：任意登录用户一条 POST 就能先 drop 全库再灌任意数据）：
 *   1. **收权**：`requireAdmin`（1b 已做）；
 *   2. **默认关闭**：`opsEnabled("allowDbAdminOps")`（spec §7.3 的"默认关闭"落点）；
 *   3. **表名/列白名单**：请求体里的表名必须在 `tableWhitelist.ts` 的名单里，
 *      且导入的列必须是目标表**真实存在**的列（多出来的列直接拒绝，不静默丢弃）；
 *   4. **审计**：无论成败都落一条（含被拒绝的尝试）。
 *
 * ⚠ **Phase 1c Task 5+6 的三处重写**：
 *   1. **跨方言**：表存在性/列清单走 `@/lib/dbOps`（knex 的 `hasTable`/`columnInfo`，两种方言都实现），
 *      关/开外键走 `SET FOREIGN_KEY_CHECKS`（MySQL）或 `PRAGMA`（sqlite）。
 *      旧实现的 `sqlite_master` + `PRAGMA` 在 MySQL 上**整片不可用**；
 *   2. **不再 drop 全库**（原实现：drop 所有表 → `initDB` 重建 → 灌数据）。现在只对
 *      **导出文件里出现过的白名单表**做 `delete + insert`，其余表**一个字节都不动**——
 *      "恢复部分表"不会再顺手把没在文件里的租户数据抹掉；
 *   3. **表级拒绝清单**（见 `EXCLUDED_IMPORT_TABLES`）：凭据表/平台配置表拒绝导入。
 *
 * ⚠ 删除 + 插入包在**一个事务**里（Ruling 234：回调必须 `async` 且内部 `await`）：
 *   失败就整体回滚，不会留下"删干净了但一行没灌进去"的半残库。
 *   ⚠ 事务**不覆盖** DDL/会话变量：`hasTable`/`columnInfo` 的探测在事务**之外**先做完
 *     （"先全量校验再动手"，与 Task 4 的口径一致）。
 *
 * ⚠ 它**不做租户过滤**（整库恢复语义 ⇒ 租户条件无法限定），所以只能靠"收权 + 双闸 + 白名单"兜住。
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

    // ① 表名白名单：**先全量校验再动手**（不能"边删边发现表名非法"——那时数据已经没了）
    const requested = Object.keys(importTables);
    const notAllowed = requested.filter((t) => !isExportableTable(t));
    if (notAllowed.length) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:table-not-allowed", { notAllowed: notAllowed.slice(0, 20) });
      return res.status(400).send(error(`导入包含不在白名单里的表：${notAllowed.slice(0, 10).join(", ")}`));
    }

    // ①b 凭据表/平台配置表：**整体拒绝**（不是"跳过这几张表"——静默跳过会让调用方以为恢复成功了）
    const forbidden = requested.filter((t) => EXCLUDED_IMPORT_TABLES.has(t));
    if (forbidden.length) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:credentials-table", { forbidden });
      return res.status(400).send(
        error(`导入包含不允许恢复的凭据/平台配置表：${forbidden.join(", ")}（整库恢复请走停机窗口的运维脚本）`),
      );
    }

    // ② 列白名单：逐表比对**目标表真实列**（多出来的列一律拒绝，不静默丢）
    const badColumns: Array<{ table: string; columns: string[] }> = [];
    const targets: Array<{ table: string; rows: unknown[] }> = [];
    for (const [tableName, rows] of Object.entries(importTables as Record<string, unknown>)) {
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const known = await columnNames(db, tableName);
      if (!known.length) continue; // 表不存在 ⇒ 跳过（与旧行为一致）
      const sample = rows.find((r) => r && typeof r === "object") as Record<string, unknown> | undefined;
      const extra = sample ? Object.keys(sample).filter((c) => !known.includes(c)) : [];
      if (extra.length) badColumns.push({ table: tableName, columns: extra });
      else targets.push({ table: tableName, rows });
    }
    if (badColumns.length) {
      await audit(ctx, AUDIT_ACTIONS.DB_IMPORT, "rejected:unknown-columns", { badColumns });
      return res.status(400).send(
        error(`导入包含目标表里不存在的列：${badColumns.map((b) => `${b.table}(${b.columns.join("/")})`).join("、")}`),
      );
    }

    // ③ 只动**导出文件里出现过的表**：delete + 分批 insert，整体一个事务
    const imported: Record<string, number> = {};
    await setForeignKeys(db, false);
    try {
      await db.transaction(async (trx) => {
        for (const { table, rows } of targets) {
          await trx(table).del();
          for (let i = 0; i < rows.length; i += 100) {
            await trx(table).insert(rows.slice(i, i + 100) as never);
          }
          imported[table] = rows.length;
        }
      });
    } finally {
      await setForeignKeys(db, true);
    }

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
