/**
 * 版本化迁移的运行时（spec §5.2）。
 *
 * **为什么用内存 MigrationSource 而不是 `apps/api/migrations/*.ts|js` 目录：**
 *   prod 的产物是 esbuild 打出的**单个** `data/serve/app.js`（`apps/api/scripts/build.ts:44`）。
 *   若迁移是磁盘文件，prod 就必须额外把 `migrations/` 拷到 `data/serve/` 旁边，
 *   否则 `migrate.latest({directory})` 在容器里 ENOENT —— 那就是一个只在 prod 才炸的路径。
 *   改成内存源后，dev（tsx）与 prod（bundle）跑的是**同一份代码**，没有"要记得拷目录"这件事。
 *
 * **`up` 拿到的 `trx` 必须用，不能用外面那个 `db`：**
 *   knex 默认把一条迁移包在事务里（`config.migrations.disableTransactions` 为假）。
 *   实测（本计划编写时的探针）：在 `up` 里用外层 `db` 执行 DDL，会与迁移事务争抢同一个连接 / 库锁
 *   → 迁移失败（`database is locked` / `Knex: Timeout acquiring a connection`）。所以下面把 `trx` 传下去。
 */
import type { Knex } from "knex";
import schema from "@/db/migrations/001_schema";
import platformSeed from "@/db/migrations/002_platform_seed";

export interface Migration {
  /** 稳定且唯一的名字，会写进 `knex_migrations.name`；改名等于重跑 */
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

/** 迁移清单（**顺序即执行顺序**；已执行的靠 `knex_migrations` 表跳过，跑过的条目不要删，只许追加）。 */
export const MIGRATIONS: Migration[] = [
  // Task 3 产出 001_schema（建 27 张表 + 删 o_skillList/o_skillAttribution）
  schema,
  // Task 5 产出 002_platform_seed（平台种子：只插不改；o_prompt / o_agentDeploy /
  // o_setting 平台键 / o_vendorConfig 8 个空模板；**不 seed tokenKey**）
  platformSeed,
  // Task 6 会在这里追加 003_legacy_vendor_merge（仅在需要把旧供应商行合并进 miwo 时）
];

/**
 * 内存迁移源。
 *
 * ⚠ 类型参数是**名字**（`string`）而不是 `Migration`：knex 的 `MigrationSource<T>` 里 T 是
 * "条目"的类型 —— `getMigrations()` 返回 T[]、`getMigrationName(T)` 取名字、`getMigration(T)` 取实现。
 * 本实现刻意让条目就是**名字**（与 knex 自带的 fs 源同形：它也用文件名作条目），这样清单与
 * `knex_migrations.name` 天生一致、不会出现"对象与名字两份真相"。
 */
export function makeMigrationSource(list: Migration[] = MIGRATIONS): Knex.MigrationSource<string> {
  return {
    getMigrations: async () => list.map((m) => m.name),
    getMigrationName: (name) => name,
    getMigration: async (name) => {
      const m = list.find((x) => x.name === name);
      if (!m) throw new Error(`[migrate] 找不到迁移 "${name}"：清单里有 ${list.map((x) => x.name).join(", ") || "（空）"}`);
      return {
        up: async (knex: Knex) => m.up(knex),
        down: async (knex: Knex) => m.down(knex),
      };
    },
  };
}

/** 跑到最新；返回 `[batchNo, 本次执行过的名字[]]`（没有新迁移时 `[]`，`batchNo` 是当前 max(batch)）。 */
export async function runMigrations(db: Knex): Promise<[number, string[]]> {
  return (await db.migrate.latest({ migrationSource: makeMigrationSource() })) as [number, string[]];
}

/**
 * 回滚；`all=true` 时回滚**全部**已执行批次。
 *
 * ⚠ 只调用**一次** `migrate.rollback(config, all)`：knex 的 `rollback(config, true)` 自己就是
 * "把所有已执行的按倒序回滚"，再补一次不带 all 的 rollback 只会多得到一次空回滚
 * （返回 `[0, []]`），把真正回滚掉的名字覆盖掉。
 */
export async function rollbackMigrations(db: Knex, all = false): Promise<[number, string[]]> {
  return (await db.migrate.rollback({ migrationSource: makeMigrationSource() }, all)) as [number, string[]];
}

/** `knex_migrations` 的表名：默认就是它，但允许 knex 配置覆盖（不重复硬编码一份真相）。 */
function migrationsTableName(db: Knex): string {
  const cfg = (db.client.config as { migrations?: { tableName?: string } }).migrations;
  const t = cfg?.tableName;
  return typeof t === "string" && t ? t : "knex_migrations";
}

/**
 * 每条迁移的状态。`batch` 来自 `knex_migrations` 表（没执行过就是 `null`）。
 *
 * ⚠ 不能拿 `migrate.list()` 的 completed 去取 batch：knex 的 `listCompleted()` 只
 * `select('name')`（见 knex/lib/migrations/migrate/migration-list-resolver.js:14-18），
 * 那批行里**没有 batch 列**。`migrate.list()` 在这里只用来触发 `ensureTable`
 * （首次 status 也要能建出 `knex_migrations`，不能因为表还没建就报错）。
 */
export async function migrationStatus(db: Knex): Promise<Array<{ name: string; batch: number | null; state: "done" | "pending" }>> {
  await db.migrate.list({ migrationSource: makeMigrationSource() });
  const rows = (await db(migrationsTableName(db)).select("name", "batch")) as Array<{ name: string; batch: number | null }>;
  const done = new Map<string, number>();
  for (const row of rows) done.set(String(row.name), Number(row.batch ?? 0));
  return MIGRATIONS.map((m) => {
    const batch = done.get(m.name);
    return { name: m.name, batch: batch ?? null, state: batch === undefined ? ("pending" as const) : ("done" as const) };
  });
}
