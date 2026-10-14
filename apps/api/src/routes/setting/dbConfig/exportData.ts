import express from "express";
import { error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { opsEnabled, opsDisabledMessage } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";

const router = express.Router();

/**
 * 导出时**必须剔除**的行 —— 最高价值凭据。
 *
 * `o_setting.tokenKey` 是 JWT 签名密钥：一条 GET 就能把它连同所有租户数据一起下载走
 * （拿到它就能**伪造任意用户（含 admin）的 token**）。剔除它**不破坏往返**：importer
 * （`src/db/legacy/import.ts` 的 SEED 名单）本来就把 tokenKey 列为"绝不导回"。
 *
 * ⚠ `005_accounts` 已把该行从库里删掉（密钥改由 `MIWO_JWT_SECRET` 提供），这条留着**防回退**
 *   （若哪天又有人把 tokenKey 写回 `o_setting`，它仍然不会被导出）。
 */
export const EXCLUDED_EXPORT_ROWS: ReadonlyArray<{ table: string; column: string; value: string }> = [
  { table: "o_setting", column: "key", value: "tokenKey" },
];

/** 脱敏占位符：**保留键名**，让运维看得出"这里有一列被剔除了"，而不是"这张表没这列"。 */
export const REDACTED_PLACEHOLDER = "***REDACTED***";

/**
 * **脱敏模式**（`?redact=1`）下按表剔除的列（Phase 1c Task 4；spec §7.3 的字段清单）。
 *
 * ⚠ 为什么是**显式参数**而不是默认行为：这三列是"恢复备份后还能不能登录 / 供应商配置还灵不灵"
 *   所依赖的。把默认导出改残 = 功能回归（"恢复备份后登录不上"），所以：
 *     · `GET /exportData`                 → **完整备份**（可恢复；原行为不变）；
 *     · `GET /exportData?redact=1`        → 脱敏导出（给运维排障/提交工单用，明确**不可用于恢复**）。
 *   ⚠ 两种模式都仍然受 `requireAdmin` + `opsEnabled("allowDbAdminOps")` 双闸。
 *
 * ⚠ `o_invite.code` 也脱敏：邀请码 = 开通权限，导出它等于把"注册权限"抄一份到文件里。
 *   `o_setting.tokenKey` 是**迁移后应已不存在**的列，留着防回退（见上）。
 */
export const REDACT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  o_user: ["passwordHash"],
  o_vendorConfig: ["inputValues"], // 含厂商 key 明文
  o_setting: ["tokenKey"], // 迁移后应已不存在；留着防回退
  o_invite: ["code"], // 邀请码等于开通权限
});

/** 一张表在脱敏模式下实际要剔的列（表不在清单里 ⇒ 空数组）。 */
export function redactColumnsFor(table: string, existingColumns: readonly string[]): string[] {
  const wanted = REDACT_COLUMNS[table] ?? [];
  return wanted.filter((c) => existingColumns.includes(c));
}

/** 对一行做脱敏（**保留键名**，值换成占位符；未命中的行原样返回）。 */
export function redactRow(row: any, columns: readonly string[]): any {
  if (!columns.length) return row;
  const out: any = { ...row };
  for (const c of columns) {
    if (out[c] !== undefined && out[c] !== null) out[c] = REDACTED_PLACEHOLDER;
  }
  return out;
}

/** 批量行的列名（空数组 = 表里没有行，脱敏无事可做）。 */
function columnsOf(rows: any[]): string[] {
  return rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]) : [];
}

// ⚠ Phase 1b Task 7：挂 `requireAdmin`（收权前任意登录用户 GET 一次就下载整库，含上面那条密钥）。
// ⚠ Phase 1c Task 4：再加 `opsEnabled("allowDbAdminOps")` 闸 + `?redact=1` 脱敏模式 + 审计。
// ⚠ 第 `sqlite_master` 是 **sqlite 方言**，MySQL 下无效（Phase 1c 未重写这一层，如实登记）。
export default router.get("/", requireAdmin, async (req, res) => {
  try {
    // 闸二：运维接口**默认关闭**（spec §7.3）。关闭时连"能不能导出"都不该被探测到内容 ⇒ 只回文案。
    if (!(await opsEnabled("allowDbAdminOps"))) {
      return res.status(403).send(error(opsDisabledMessage()));
    }

    const redact = String(req.query?.redact ?? "") === "1";

    const tables: { name: string }[] = await db.raw(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`,
    );

    const data: Record<string, any[]> = {};
    const redactedSummary: Record<string, string[]> = {};
    for (const table of tables) {
      const rows: any[] = await db.raw(`SELECT * FROM "${table.name}"`);
      // 逐行剔除（表名/列名/值都来自本文件的常量，不含用户输入 ⇒ 无注入面）
      const kept = rows.filter(
        (row) => !EXCLUDED_EXPORT_ROWS.some((x) => x.table === table.name && row?.[x.column] === x.value),
      );
      if (!redact) {
        data[table.name] = kept;
        continue;
      }
      const cols = redactColumnsFor(table.name, columnsOf(kept));
      if (cols.length) redactedSummary[table.name] = cols;
      data[table.name] = kept.map((row) => redactRow(row, cols));
    }

    const exportData = {
      exportTime: Date.now(),
      // 让接收方自己知道"这份文件能不能用来恢复"（脱敏导出明确不可恢复）
      redacted: redact,
      ...(redact ? { redactedColumns: redactedSummary } : {}),
      tables: data,
    };

    await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.DB_EXPORT, "all-tables", {
      tables: tables.length,
      redacted: redact,
      redactedColumns: redactedSummary,
    });

    res.setHeader("Content-Type", "application/json");
    // ⚠ Phase 1c Task 4：备份文件名前缀品牌收口（Phase 0 ledger 的 1c 项，旧前缀已从本文件删除）。
    //   前端 `apps/web/src/components/setting/components/dbConfig.vue:199` 仍写死旧前缀 ——
    //   它只影响浏览器"另存为"的默认文件名（不解析响应头），所以不是功能回归；
    //   前端那一行归 **Task 11**（本任务硬约束禁改 `apps/web/**`）。
    //   ⚠ 这段注释**刻意不写出旧前缀的字面量**：`tools/check-brand.cjs` 按 token 命中计数，
    //     写出来就会让本文件继续"含有旧品牌 token"（本条走的是"已收口 ⇒ 旧豁免条目删除"）。
    res.setHeader("Content-Disposition", `attachment; filename=miwo-backup-${Date.now()}.json`);
    res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导出失败"));
  }
});
