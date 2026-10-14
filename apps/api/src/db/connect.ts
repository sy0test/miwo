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
// ⚠ 【裁定 A / ★Ruling 131·156】数据库**目标护栏**——与 4 个 `db:*` CLI 脚本**同一套判定**。
//    见下面 `assertTargetAllowed()` 的注释：本文件是"启动路径也过护栏"的唯一落点。
//    类型来自同目录的 `db-target-guard.d.cts`（`export =` + esModuleInterop），与
//    `scripts/db-migrate.ts` 的用法一致。
import guard from "../../scripts/db-target-guard.cjs";

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

/**
 * MySQL **连接级**会话设置（Task 7 / spec §5.3 的 `GROUP_CONCAT` 口径）。
 *
 * `GROUP_CONCAT` 的默认 `group_concat_max_len` 只有 **1024 字节**：`routes/novel/event/getEvent.ts`
 * 用 `GROUP_CONCAT(n.chapterIndex)` 把一章的章节号聚成一列，章节一多就会被**静默截断**
 * （返回的章节列表少几项、不报错——比报错更难查）。它是**会话变量**，所以必须对池里**每条**连接各设一次。
 *
 * ⚠ 值取 1 MiB：真实项目一章最多几十个章节号（每个几字节），1 MiB 是"远远够用且不会撑爆内存"的量级。
 * ⚠ 与 `DBCONFIG` 同性质：**项目策略**而不是运维旋钮 ⇒ 写死，不新增 `MIWO_*` 变量。
 */
export const MYSQL_SESSION_SETUP: readonly string[] = Object.freeze(["SET SESSION group_concat_max_len = 1048576"]);

/**
 * 逐条执行会话设置（失败即抛出，由 `mysqlAfterCreate` 交给连接池的 `done(err)`）。
 *
 * ⚠⚠ **必须优先走 `conn.promise()`**（审查 P0）：knex 用的是 **mysql2 的 callback API**
 *   （`knex/lib/client.js` 的 `_driver()` → `require("mysql2")`），它的 `query()` 返回的是
 *   **非 Promise 的 `Query`** 对象；对那个对象 `await` 会抛
 *     `You have tried to call .then()/.catch()/await on the result of query that is not a promise…`
 *   ⇒ `mysqlAfterCreate` 会立刻 `done(err)` ⇒ tarn 的 `propagateCreateError = true` 让**每条新连接都拿不到**
 *   ⇒ **MySQL 全路径不可用**。本机 sqlite 分支**不接** `afterCreate`，所以本地怎么跑都测不到这一点；
 *   本文件用"照抄 mysql2 形状"的假连接钉住（`tests/db-driver.test.ts`），**最终作证靠 CI 的 mysql job**。
 *   回退分支（`conn` 自身就是 promise 形状）只服务于测试/诊断里的简单替身。
 */
export async function applyMysqlSessionSettings(conn: unknown): Promise<void> {
  const c = conn as {
    query: (sql: string) => unknown;
    promise?: () => { query: (sql: string) => Promise<unknown> };
  };
  const q = typeof c.promise === "function" ? c.promise() : c;
  for (const sql of MYSQL_SESSION_SETUP) await q.query(sql);
}

/**
 * knex `pool.afterCreate` 钩子（mysql2）：新连接建好后先把会话设置设上。
 *
 * `done(null, conn)` / `done(err)` 两条路径都必须回调 —— 不回调连接池会**永久挂起**
 * （表现成"服务起来了但任何查询都超时"）。所以 `.catch` 里**不能**吞掉错误。
 */
export function mysqlAfterCreate(conn: unknown, done: (err: Error | null, conn?: unknown) => void): void {
  applyMysqlSessionSettings(conn)
    .then(() => done(null, conn))
    .catch((err: unknown) => done(err instanceof Error ? err : new Error(String(err))));
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

/**
 * SQLite 的**连接级**设置（Phase 1c Task 4）。
 *
 * ⚠ 为什么必须显式给：`better-sqlite3` 的默认 `busy_timeout` 是 **0** ⇒ 只要另一条连接
 *   （另一个 knex 实例、或别的进程/测试 worker）正在写同一个库文件，本连接**立刻**抛
 *   `SQLITE_BUSY: database is locked`，而不是等一会儿重试。症状是本任务实测到的：审计写入
 *   让"认证路径的写"变多之后，`tests/authorization.test.ts` 的邀请码事务偶发地被锁红
 *   （`update o_invite set usedCount = 1 … - database is locked`）。
 * 5000 ms 与 MySQL 侧 `DBCONFIG.connectTimeout` 同量级：**够等一次短事务写完，又不会把
 * "真的有死锁"变成无限等待**（超时后仍然抛错，不是静默成功）。
 *
 * ⚠ 刻意**不开 WAL**：WAL 会改库文件的落盘形态并生成 `-wal`/`-shm` 边车文件 —— 那属于
 *   "改用户数据目录里的文件形状"的决定，不该夹在一个权限任务里顺手做（要做得单独拍板 + 验证）。
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** knex `pool.afterCreate` 钩子（sqlite）：给每条新连接设 busy_timeout。 */
export function sqliteAfterCreate(conn: unknown, done: (err: Error | null, conn?: unknown) => void): void {
  try {
    (conn as { pragma?: (sql: string) => unknown })?.pragma?.(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    done(null, conn);
  } catch (err) {
    done(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 建一个 knex 实例（不发起连接；knex 是惰性连接）。 */
export function createKnex(c: MiwoConfig = config): Knex {
  if (c.db.driver === "mysql") {
    return knexFactory({
      client: MYSQL_CLIENT,
      connection: connectionConfig(c),
      pool: { min: c.db.poolMin, max: c.db.poolMax, afterCreate: mysqlAfterCreate },
    });
  }
  return knexFactory({
    client: SQLITE_CLIENT,
    connection: connectionConfig(c),
    useNullAsDefault: true,
    pool: { afterCreate: sqliteAfterCreate },
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
 * 【裁定 A / ★Ruling 131·156】**启动路径也必须过同一套目标护栏**。
 *
 * ── 为什么必须在这里（已发生的漏网，不是假想）──
 * 本阶段把 `db-target-guard.cjs` 接到了 4 个 `db:*` CLI 脚本上，但 `grep apps/api/src/**` 是
 * **0 处**引用 —— 也就是说**默认配置下的应用启动路径完全没过护栏**。终审在 dev 库**副本**上实测：
 * `MIWO_DATA_DIR` 指向 29 表老库副本 → 跑启动路径（`import('@/utils/db')` → `await dbReady`）→
 * `table o_user already exists`，副本 sha256 从 `44716850…` 变成 `8C3C2F38…`（与 `--status`
 * 改坏 dev 库的哈希**逐字节相同**，同一处 `knex_migrations*` 副作用）。
 * 触发条件是**默认配置**：`apps/api/.env` 的 `MIWO_DATA_DIR=./data` ＋ 默认 `sqlite` 驱动
 * ⇒ 本机 `cd apps/api; pnpm dev` 就会走。CLI 侧的护栏对这条路径**一点用都没有**。
 *
 * ── 判定与 CLI **逐字同一套** ──
 * 复用 `scripts/db-target-guard.cjs` 的 `requireRepoDevDbAllowed()`（不是另写一份近似逻辑：
 * 两份判定迟早漂移，而漂移的那一份就是假绿）。它做的三件事与 CLI 完全一致：
 *   ① 解析目标文件（这里直接把 `config.db.file` 传进去，避免"配置解析出的文件"与
 *      "护栏推导出的文件"两份真相）；
 *   ② 目标 = `<仓库根>/apps/api/data/db2.sqlite` 且驱动是 sqlite 且没有显式放行 → **响亮失败**；
 *   ③ 有显式放行（`MIWO_ALLOW_REPO_DEV_DB=1`）时**仍然要求可恢复点**（仓库外一份 sha256
 *      相同的备份，或现备一份并校验拷贝）—— 建不出来照样拒绝（【Ruling 139】）。
 *
 * ── 两条出路（与 CLI 报错文案一致）──
 *   · `MIWO_DATA_DIR=<仓库外的目录>`（推荐：一次性目录）；
 *   · `MIWO_ALLOW_REPO_DEV_DB=1`（进程级开关，不是新的 `MIWO_*` 配置变量：`config.ts` 不读它）。
 *
 * ⚠ `argv` 显式传空数组：应用没有"命令行旗标"这个概念，只有环境变量这一条放行途径
 *   （`--allow-repo-dev-db` 是 CLI 的形式；若照抄 `process.argv`，nodemon 转发一个同名参数
 *   就能悄悄放行 —— 那等于给启动路径留了个后门）。
 *
 * ⚠ **mysql 分支不受影响**：护栏按驱动分流（`MIWO_DATA_DIR` 是 sqlite 分支才用的路径）。
 *   这条分流在 `db-target-guard.cjs` 里，此处不重复判定。
 */
export function assertTargetAllowed(c: MiwoConfig = config): void {
  if (c.db.driver !== "sqlite") return; // mysql 分支的护栏是 requireDriver，见 CLI 脚本
  guard.requireRepoDevDbAllowed({
    argv: [],
    driver: c.db.driver,
    file: c.db.file,
    what: "应用启动（dbReady → connect()）",
  });
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
  // ⚠⚠ 【裁定 A】护栏必须在 `createKnex()` **之前** —— `createKnex()` 在 sqlite 分支上
  //    就会把库文件建出来/打开（可写），"连上再检查"等于已经把目标打开了，那正是要避免的形态。
  assertTargetAllowed(c);
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
