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
import { migrationStatus, runMigrations } from "@/db/migrations";

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
  // ⚠ 连接建立超时（毫秒）。**必须显式给**：mysql2 的默认值是 10s，而"主机不可达/端口被丢包"
  //    （prod 网络抖动、防火墙静默丢包）时那个默认值会让**启动**挂满 10s × 池内每条连接，
  //    表现成"服务像是起不来"。5s 是"足够局域网建连、又不至于让启动像挂死"的取值。
  //    断言：`tests/db-boot-order.test.ts` 的「connect() 连不上时给出可操作的报错」用例。
  connectTimeout: 5000,
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

/**
 * 启动期初始化：连接 → 跑迁移 → 返回。
 *
 * ⚠ 这是 Phase 1a 唯一"启动时改库"的合法位置（spec §5.2 的迁移纪律：发布流程 = 备份 → 迁移 → 起服务）。
 *    它替换掉的是 `utils/db.ts` 原来那个"**未被 await** 的 IIFE 里跑 initDB + fixDB"：
 *    旧写法既没有 await（建表没完成就开始接请求），又是**无条件**的 DDL/DML 副作用。
 *
 * 幂等：`migrate.latest()` 对已执行的迁移是 no-op（靠 `knex_migrations` 跳过）。
 *
 * ⚠ **不要**在别处再调一次它：真正的启动接线在 `utils/db.ts` 的 `dbReady`（唯一消费者是 `app.ts` 起监听之前）。
 *    本函数可以被脚本（`db:migrate` / `db:repair-stuck` 之类）显式复用，但"每次进程启动都跑"只有一条路径。
 */
export async function connect(c: MiwoConfig = config): Promise<{ db: Knex; applied: string[]; batch: number }> {
  const db = createKnex(c);
  try {
    // 探活：让"连不上"在迁移之前就以清晰的错误暴露，而不是让 migrate 抛一个 tarn 超时
    await db.raw("select 1");
  } catch (err) {
    await db.destroy().catch(() => {});
    throw new Error(
      `[db] 无法连接 ${describeTarget(c)}：${(err as Error).message}\n` +
        `  本地开发：先按 README.md「迁移纪律」一节把本机 MySQL 起起来，或用 db:migrate 在一次性库上先试。\n` +
        `  或者设 MIWO_DB_DRIVER=sqlite 用 sqlite 分支（回归网与 verify-phase0 走的就是它）。`,
    );
  }
  const [batch, applied] = await runMigrations(db);
  return { db, applied, batch };
}

/** 诊断：打印当前迁移状态（**不跑迁移**）。用完自己 destroy，不留常驻连接。 */
export async function statusOf(c: MiwoConfig = config): Promise<Array<{ name: string; state: "done" | "pending" }>> {
  const db = createKnex(c);
  try {
    return (await migrationStatus(db)).map((r) => ({ name: r.name, state: r.state }));
  } finally {
    await db.destroy();
  }
}
