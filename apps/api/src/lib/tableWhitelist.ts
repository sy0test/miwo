/**
 * 运维接口的**表名白名单**（Phase 1c Task 4；spec §7.3「表名/列名白名单」）。
 *
 * ⚠ 位置刻意放在 `src/lib/`：`src/router.ts` 是 `scripts/generate-router.ts` 按
 *   `src/routes/**\/*.ts` **逐文件**生成的挂载表 —— 把纯工具文件放进 `src/routes/` 会被
 *   挂成一条不存在的路由（`app.use("/api/setting/dbConfig/tableWhitelist", …)`），
 *   `tests/router-generation.test.ts` 的"挂载数 == 路由文件数"也会随之变成假绿。
 *
 * ── 为什么需要它 ──
 * `clearTable` / `importData` 都按**请求体里的表名**做动态操作（`DELETE FROM "${t}"`、
 * `db(t).insert(...)`）。旧实现只校验"表存在"——而"存在"和"允许被清"是两件事：
 *   · `knex_migrations` / `knex_migrations_lock` 是**迁移器的基础设施**，清掉它 = 迁移状态错乱；
 *   · `sqlite_*` / `_*` 之类内部表根本不该被 HTTP 碰到。
 *
 * ── 口径（单一来源：`src/db/policies.ts` 的业务表清单）──
 * 允许的表 = `TABLE_POLICIES` 的业务表（`INFRA_TABLES` 显式排除）。
 * ⚠ **不手写第二份清单**：`policies.ts` 已经是"在库表"的唯一真相（由
 *   `tools/check-tenant-policies.cjs` 与迁移建表清单逐项相等断言）。这里只做"排除基础设施表"。
 */
import { INFRA_TABLES, TABLE_POLICIES } from "@/db/policies";

/** 允许被运维接口（清表/导入）操作的表名集合。 */
export const EXPORTABLE_TABLES: ReadonlySet<string> = new Set(
  Object.keys(TABLE_POLICIES).filter((t) => !INFRA_TABLES.has(t)),
);

/**
 * 该表名是否允许被运维接口操作。
 *
 * ⚠ `EXPORTABLE_TABLES` 是 Set ⇒ 不受 `Object.prototype` 继承键影响（`policies.ts` 里
 *   `policyOfIn` 用 `hasOwnProperty` 防的正是那一类绕过）；另外挡掉 `sqlite_*` / `_*` 前缀。
 */
export function isExportableTable(table: unknown): boolean {
  if (typeof table !== "string" || !table) return false;
  if (table.startsWith("sqlite_") || table.startsWith("_")) return false;
  return EXPORTABLE_TABLES.has(table);
}
