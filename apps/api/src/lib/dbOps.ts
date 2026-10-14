/**
 * 实例级运维的**跨方言**原语（Phase 1c Task 6；裁定 §2.5）。
 *
 * ── 它修的是什么（真实症状，不是"理论上"）──
 * Phase 1c Task 4 把 6 个运维接口收权 + 加了白名单与审计，但**只在本机 sqlite 上验过**。
 * 那批实现里有三处 **sqlite 专属**写法，迁到 MySQL 上会让整片运维面**直接死**：
 *   · `dbInfo` / `exportData` —— `SELECT name FROM sqlite_master`：MySQL **没有 sqlite_master**
 *     ⇒ `ER_NO_SUCH_TABLE`（500），运维在出事时**看不到任何结构信息、也导不出备份**；
 *   · `clearData` / `importData` —— `PRAGMA foreign_keys = OFF/ON`：MySQL 的语法是
 *     `SET FOREIGN_KEY_CHECKS = 0/1`，PRAGMA 直接**语法错**；
 *   · `clearData` / `importData` 重建表靠 `initDB`（Task 5 已删）⇒ 迁移未跑 = 库被清空后**没有表**。
 *
 * ── 为什么"读 `information_schema`"不是可选项 ──
 * knex **没有**"列出所有表名"的跨方言 API：它的 `schema.hasTable(t)` / `columnInfo()` 都要求
 * **先知道表名**。而 `dbInfo` / `exportData` / `clearData` 的语义恰恰是"遍历**全部**表"，
 * 所以只能落到方言元数据表上。这里按 client 分两条 SQL，**不用**"sqlite 先试、失败再试 mysql"
 * 那种猜测式回退（失败回退会把真实的连接/权限错误也吞成"换一条试试"）。
 *
 * ── 只读、只依赖 knex（不 import `@/utils` / `@/config`）──
 * 本文件是**纯工具**：入参是调用方给的裸 knex 句柄，所以 `db/dialect.ts`、迁移与运维路由都能用，
 * 也不会被拖进"启动链"。
 *
 * ⚠ **MySQL 未实测**（本机 3307 独占、不起 MySQL）：本文件的 mysql 分支只有
 *   `createKnex({client:"mysql2"})` + `toSQL()` 的**离线形态证明**（见 `tests/http-hardening.test.ts`
 *   的「跨方言运维接口」一组与 Task 5+6 报告），**没有**在真 MySQL 上报过一条 SQL。
 */
import type { Knex } from "knex";

/** knex 实例用的 client 名（`better-sqlite3` / `sqlite3` / `mysql2` …）。读不到就抛（fail-closed）。 */
export function clientNameOf(db: Knex): string {
  const client = (db.client?.config as { client?: unknown } | undefined)?.client;
  if (typeof client === "string" && client) return client;
  throw new Error("[dbOps] 取不到 knex 的 client 名：无法判定方言，拒绝猜测（fail-closed）");
}

/** 该 knex 实例是不是 sqlite 家族（`better-sqlite3` / `sqlite3`）。 */
export function isSqlite(db: Knex): boolean {
  return /sqlite/i.test(clientNameOf(db));
}

/**
 * "列出全部业务表"的 SQL 文本（**按方言分支**）。
 *
 * sqlite：`sqlite_master` + `type='table'`，排除 `sqlite_%` 内部表；
 * mysql ：`information_schema.tables`（**必须限定 `table_schema = DATABASE()`** —— 不限定会把
 *         整个实例里其它库的表一起列出来，然后去本库里 count/drop 它们 → 全片失败）。
 *
 * ⚠ 两边的排除规则**刻意不同**，这是有意的：
 *   · sqlite 没有 `knex_%` 之外的基础设施表，留 `knex_%` 排除只为与旧行为逐字一致；
 *   · mysql 的 `information_schema` 本来就只给 `BASE TABLE`，用 `table_type` 再挡一次。
 *   `knex_migrations` / `knex_migrations_lock` 两条在 sqlite 侧被 `knex_%` 排除 —— 与 Task 4
 *   之前的实现完全一致（迁移记账表不该被"清库"接口顺手删掉）。
 */
export function listTablesSql(db: Knex): string {
  if (isSqlite(db)) {
    return `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'`;
  }
  return (
    `SELECT table_name AS name FROM information_schema.tables ` +
    `WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'knex\\_%'`
  );
}

/** 表名行：两种方言统一用别名 `name`（mysql 侧 `table_name` → `AS name`）。 */
export interface TableNameRow {
  name: string;
}

/**
 * 列出库里全部业务表（**跨方言**）。
 *
 * ⚠ 结果一律**归一化**：`name` 可能是 `undefined`（方言/驱动差异）或带空白 ⇒ 过滤掉解析不出名字的
 *   行并 trim。归一化放在这里而不是各调用点，是为了让"表名"只有一个真相。
 */
export async function listTables(db: Knex): Promise<string[]> {
  const rows = (await db.raw(listTablesSql(db))) as TableNameRow[] | undefined;
  if (!Array.isArray(rows)) {
    throw new Error(`[dbOps] listTables 的返回不是数组（client=${clientNameOf(db)}）—— 方言分支可能写错了`);
  }
  return rows
    .map((r) => String(r?.name ?? "").trim())
    .filter((n) => n.length > 0)
    .sort();
}

/**
 * 关掉/打开外键约束检查（跨方言）。
 *
 * ⚠ 与旧的 `PRAGMA foreign_keys = OFF` 的**语义差异**（必须知道）：
 *   · sqlite 的 PRAGMA 是**连接级**的，而 knex 用的是连接**池** —— 旧实现只在"恰好拿到的那条连接"
 *     上关了外键，其余连接仍然开着（旧代码的隐藏缺陷，不是本文件引入的）；
 *   · MySQL 的 `FOREIGN_KEY_CHECKS` 是**会话变量**，同样只作用于池里的那一条。
 *   运维接口的调用量级（管理员手工点一次）让这个窗口可以接受；要真正安全应走停机窗口的脚本
 *   （`opsDisabledMessage()` 的文案已经这么写）。这里**如实登记**，不假装它是事务级的。
 */
export async function setForeignKeys(db: Knex, on: boolean): Promise<void> {
  if (isSqlite(db)) {
    await db.raw(`PRAGMA foreign_keys = ${on ? "ON" : "OFF"}`);
    return;
  }
  await db.raw(`SET FOREIGN_KEY_CHECKS = ${on ? 1 : 0}`);
}

/**
 * 逐表 `drop table if exists`（跨方言）。
 *
 * ⚠ 为什么不用 `db.schema.dropTableIfExists` 的**同一个 QueryBuilder 连续调用**：
 *   knex 每次调用返回新的 builder，必须逐个 `await`（漏掉 `await` 会让错误变成未处理拒绝，
 *   而那正是 Task 6 另一条改动要打断的东西）。这里显式 `await`。
 */
export async function dropAllTables(db: Knex, tables?: readonly string[]): Promise<string[]> {
  const list = [...(tables ?? (await listTables(db)))];
  for (const t of list) await db.schema.dropTableIfExists(t);
  return list;
}

/** 表的真实列名（跨方言；knex 的 `columnInfo()` 两种方言都实现）。表不存在 ⇒ 空数组。 */
export async function columnNames(db: Knex, table: string): Promise<string[]> {
  if (!(await db.schema.hasTable(table))) return [];
  const info = (await db(table).columnInfo()) as Record<string, unknown> | undefined;
  return Object.keys(info ?? {});
}

/** 一行行数（跨方言；`count({ n: "*" })` 是本仓既有写法，见 `db/legacy/import.ts:244`）。 */
export async function tableRowCount(db: Knex, table: string): Promise<number> {
  const row = (await db(table).count({ n: "*" }).first()) as { n?: number | string } | undefined;
  return Number(row?.n ?? 0);
}
