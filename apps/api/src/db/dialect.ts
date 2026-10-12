/**
 * 方言判定与 MySQL 侧的类型工具（spec §5.1 / §5.3）。
 *
 * 为什么需要这一层：迁移代码要在 **sqlite（本机与回归网）** 与 **mysql（目标）** 两个方言下
 * 逐字跑同一份 up/down。两边的差异集中在四处：
 *   1. 26 张表的主键：sqlite 的 `t.increments()` 已同时表达"自增 + 主键"，
 *      而 mysql 必须是 `bigint unsigned auto_increment`（spec §5.3 要求 BIGINT UNSIGNED）；
 *      `t.bigIncrements()` 恰好两边都对 —— 实测 sqlite 生成
 *      `integer not null primary key autoincrement`，mysql 生成
 *      `bigint unsigned not null auto_increment primary key`
 *      （断言：`apps/api/tests/migration-ddl-mysql.test.ts` 的「dialect 的 mysql 分支」组 +
 *        `apps/api/tests/db-driver.test.ts` 的「types() 的 sqlite 行为」组）。
 *   2. 文本主键 / 被索引的文本列：sqlite 用 TEXT 可以作主键，**MySQL 会报 ERROR 1170**
 *      （BLOB/TEXT column used in key specification without a key length）→ 必须 varchar。
 *   3. 普通大文本：mysql 的 TEXT 只有 64 KB（`o_prompt.data` 单行就有 20982 字符，
 *      `o_project.intro` / `o_script.content` 都可能超），用 LONGTEXT。
 *   4. 布尔：两个方言都不能直接吃 JS boolean 作 DDL 默认值，统一用 0/1 的 tinyint。
 *
 * ⚠ `useNullAsDefault` **只对 sqlite 有意义**（sqlite 的 insert 缺列时它才是最省事的默认值策略，
 *    上游行为如此）；mysql 侧不该有它 —— **实测传了不会报错**（knex 只是把 `valueForUndefined`
 *    由 `'DEFAULT'` 改成 `null`），但它会引入无意义的缺省语义差异，spec §5.1 要求删除。
 *    见 src/db/connect.ts（`useNullAsDefault` 只在 sqlite 分支）与
 *    `tests/db-driver.test.ts` 的「createKnex 对 mysql 分支不注入 useNullAsDefault」。
 */
import type { Knex } from "knex";

export type Dialect = "sqlite" | "mysql";

/** 从 knex 实例或 `knex.client` 判定方言。两类取值都可能：`sqlite3` / `better-sqlite3` / `mysql2` / `mysql`。 */
export function sqldialect(knexOrClient: unknown): Dialect {
  const anyObj = knexOrClient as any;
  let raw: unknown = anyObj?.client?.dialect ?? anyObj?.dialect;
  if (!raw) {
    const client = anyObj?.client;
    raw = typeof client === "string" ? client : client?.config?.client;
  }
  if (!raw && anyObj?.config?.client) raw = anyObj.config.client;
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("sqlite")) return "sqlite";
  if (s.includes("mysql") || s.includes("maria")) return "mysql";
  throw new Error(`[db] 无法判定方言，client=${JSON.stringify(raw)}。本项目的迁移只支持 sqlite 与 mysql（spec §5.1）`);
}

export interface MysqlTypes {
  /** 26 张表的主键。sqlite 与 mysql 都生成"自增 + 主键"，但类型是 integer vs bigint unsigned。 */
  pk(t: Knex.CreateTableBuilder, name?: string): void;
  /**
   * 会被索引或作主键的文本列 → MySQL `varchar(len)`。
   * `o_skillList.id` / `o_skillAttribution.{skillId,attribution}` / `memories.id` / `o_setting.key`
   * 都必须走它（TEXT 主键在 MySQL 报 ERROR 1170）。
   */
  vstr(t: Knex.CreateTableBuilder, name: string, len?: number): Knex.ColumnBuilder;
  /** 普通大文本 → MySQL `longtext`（TEXT 的 64 KB 上限会被 o_prompt.data 之类直接顶穿）。 */
  text(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  /** 32 位整数，列名与现状一致（projectId / scriptId / assetsId / …）。 */
  u32(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  /**
   * 64 位无符号整数（`userId` 这类将来指向 `o_user.id` 的列，避免 §5.3 的窄类型隐患）。
   *
   * ⚠ **凡是会装 `o_project.id` / `o_videoTrack.id` 的列也必须走它**（不是 `u32`）：
   *    这两个 id 由代码用 `Date.now()` 显式给（`routes/project/addProject.ts:29`、
   *    `utils/redraw.ts:711`），**本身就是毫秒值**（实测 dev 库最大 1791385147125），
   *    MySQL 的 `int` 装不下 —— 于是 `o_task.projectId` / `o_assets.startTime` 之类的
   *    外键列会先于时间列炸。实测清单见 `tests/migration-ddl-mysql.test.ts` 的
   *    「id / 外键列也是 Date.now()」用例。
   */
  u64(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  /**
   * 毫秒时间戳列（`createTime` / `updateTime` / `startTime` / `o_video.time`）。
   *
   * ⚠ **不能是 `integer` / `u32`**：全库时间戳口径是 `Date.now()` 的毫秒值（现状如此，
   *    spec §5.3「时区」一行明确保持不变），而 MySQL 的 `int` 上限是 2147483647 ——
   *    毫秒值在 **1970-01-25** 就顶穿了。现状种子/数据里这类值形如 `1774447310118`
   *    （`apps/api/src/lib/initDB.ts` 的 `memories` 种子、以及本机 dev 库里每张表的
   *    `createTime`），**只在真 MySQL 才暴露**（sqlite 的 INTEGER 是 64 位，看不出问题）。
   *    类型是同 `u64` 的 `bigint unsigned`（sqlite 侧退化为 `bigint`，仍是 INTEGER 亲和，
   *    实测毫秒值原样读回 number）。
   */
  ms(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  floatCol(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  boolCol(t: Knex.CreateTableBuilder, name: string): Knex.ColumnBuilder;
  /** 全库统一毫秒时间戳（现状如此，spec §5.3「时区」一行明确保持不变）。 */
  nowMs(): number;
}

export function types(knexOrClient: unknown): MysqlTypes {
  const d = sqldialect(knexOrClient);
  const isMysql = d === "mysql";
  return {
    pk(t, name = "id") {
      // 两边都用 bigIncrements：sqlite → integer primary key autoincrement；
      // mysql → bigint unsigned not null auto_increment primary key。
      t.bigIncrements(name);
    },
    vstr(t, name, len = 191) {
      // 191 是 utf8mb4 下 767 字节索引前缀限制的历史安全值；本项目的键都很短。
      return t.string(name, len);
    },
    text(t, name) {
      return isMysql ? t.text(name, "longtext") : t.text(name);
    },
    u32(t, name) {
      return t.integer(name);
    },
    u64(t, name) {
      return isMysql ? t.bigInteger(name).unsigned() : t.integer(name);
    },
    ms(t, name) {
      // mysql → `bigint unsigned`（毫秒值必然超 int）；sqlite → `bigint`（INTEGER 亲和，64 位）。
      // 断言见 `tests/migration-ddl-mysql.test.ts`（mysql 静态编译）与
      // `tests/migration-schema.test.ts`（sqlite 真跑：毫秒值原样读回）。
      return isMysql ? t.bigInteger(name).unsigned() : t.bigInteger(name);
    },
    floatCol(t, name) {
      return t.float(name);
    },
    boolCol(t, name) {
      return t.tinyint(name);
    },
    nowMs() {
      return Date.now();
    },
  };
}
