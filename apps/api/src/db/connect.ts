/**
 * knex 连接的**唯一**装配点（spec §5.1）。
 *
 * 设计要点：
 *  - `client` 由 `config.db.driver` 决定：`sqlite` → `better-sqlite3`，`mysql` → `mysql2`
 *  - 连接池 min/max 走 `config.db.poolMin/poolMax`（config.ts 已做 fail-fast 校验）
 *  - `useNullAsDefault` **只在 sqlite 分支**加：它不是 mysql 的合法/需要项，但**传了也不报错**
 *    （实测 knex 只是把 `valueForUndefined` 由 `'DEFAULT'` 改成 `null`）—— 所以"mysql 侧没有它"
 *    是一条**由本文件的装配方式保证、并由测试断言**的不变式，而不是靠"传了会抛"来兜（见 dialect.ts
 *    的详细注释与 `tests/db-driver.test.ts` 的对应用例）
 *  - 驱动实例不从 `config` 里取，而由 `driverOf(cfg)` 判定 → 这样测试可以传"假 config"
 *    直接断言 mysql 分支的连接对象，**不需要真的装 mysql2 服务端**（Task 1 Step 8 就是这么做的）
 */
import knexFactory, { type Knex } from "knex";
import { config, type MiwoConfig } from "@/config";
import { sqldialect } from "@/db/dialect";

const SQLITE_CLIENT = "better-sqlite3";
const MYSQL_CLIENT = "mysql2";

/** 由配置判定驱动（与 `config.db.driver` 同义，但允许测试构造一个非全局 config 的对象）。 */
export function driverOf(c: Pick<MiwoConfig, "db">): "sqlite" | "mysql" {
  return c.db.driver;
}

/**
 * 连接级不变式（spec §5.3 的"字符集/时区"两行）。
 * 这些是**项目策略**、不是运维旋钮，所以写死在这里，也不新增 MIWO_* 变量
 * （新增变量会牵动 deploy/.env.example、apps/api/.env.example 与
 *  tools/check-deploy-config.cjs 的 COMPOSE_ONLY 白名单三处，收益为零）。
 */
export const DBCONFIG = {
  charset: "utf8mb4",
  // 8.4 的默认排序规则就是 utf8mb4_0900_ai_ci（spec §5.3 指定）；不在连接里重复指定，
  // 因为 mysql2 的 `charset` 只影响 SET NAMES，collation 由服务端/库级默认提供。
  timezone: "+08:00",
  // ⚠ BIGINT UNSIGNED id 的 JS 类型：取 false（返回 number）更快，前提是 id ≤ 2^53-1。
  //    本项目 id 来自 Date.now()（~1.7e12）或自增，远小于 2^53；导入脚本（Task 6）会断言这一点。
  supportBigNumbers: true,
  bigNumberStrings: false,
} as const;

export function clientConfig(c: MiwoConfig = config): string {
  return driverOf(c) === "mysql" ? MYSQL_CLIENT : SQLITE_CLIENT;
}

export function connectionConfig(c: MiwoConfig = config): Record<string, unknown> {
  if (c.db.driver === "mysql") {
    return {
      host: c.db.host,
      port: c.db.port,
      user: c.db.user,
      password: c.db.password,
      database: c.db.name,
      ...DBCONFIG,
    };
  }
  return { filename: c.db.file };
}

/** 建一个 knex 实例（不发起连接；knex 是惰性连接）。 */
export function createKnex(c: MiwoConfig = config): Knex {
  if (c.db.driver === "mysql") {
    return knexFactory({
      client: MYSQL_CLIENT,
      connection: connectionConfig(c),
      pool: { min: c.db.poolMin, max: c.db.poolMax },
    });
  }
  return knexFactory({
    client: SQLITE_CLIENT,
    connection: connectionConfig(c),
    useNullAsDefault: true,
  });
}

/** 供诊断/日志用：一句话描述当前连接目标（**不打印口令**）。 */
export function describeTarget(c: MiwoConfig = config): string {
  if (c.db.driver === "mysql") {
    return `mysql://${c.db.user}@${c.db.host}:${c.db.port}/${c.db.name} (pool ${c.db.poolMin}-${c.db.poolMax})`;
  }
  return `sqlite:${c.db.file}`;
}

/** 让 `sqldialect` 也认识"还没建实例"的配置（迁移 runner 会用到）。 */
export function dialectOfConfig(c: MiwoConfig = config): ReturnType<typeof sqldialect> {
  return driverOf(c);
}
