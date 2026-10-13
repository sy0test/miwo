import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { clientConfig, connectionConfig, createKnex, describeTarget, dialectOfConfig, MYSQL_SESSION_SETUP, applyMysqlSessionSettings, mysqlAfterCreate } from "@/db/connect";
import { sqldialect, types } from "@/db/dialect";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-db-driver-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfgSqlite(file = path.join(TMP, "a.sqlite")): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  };
}
function cfgMysql(): MiwoConfig {
  return {
    ...cfgSqlite(), db: { driver: "mysql", host: "127.0.0.1", port: 3307, user: "miwo", password: "", name: "miwo_test", poolMin: 3, poolMax: 7 },
  };
}

describe("驱动装配（spec §5.1）", () => {
  it("driverOf / clientConfig / dialectOfConfig 对两个分支都给对", () => {
    expect(clientConfig(cfgSqlite())).toBe("better-sqlite3");
    expect(clientConfig(cfgMysql())).toBe("mysql2");
    expect(dialectOfConfig(cfgSqlite())).toBe("sqlite");
    expect(dialectOfConfig(cfgMysql())).toBe("mysql");
  });

  it("mysql 的连接对象携带 charset/timezone/bigNumber 策略，且不含 sqlite 的 filename", () => {
    const c = connectionConfig(cfgMysql());
    expect(c).toMatchObject({ host: "127.0.0.1", port: 3307, user: "miwo", database: "miwo_test", charset: "utf8mb4", timezone: "+08:00", supportBigNumbers: true, bigNumberStrings: false });
    expect(c).not.toHaveProperty("filename");
  });

  it("sqlite 的连接对象只有 filename，不携带 mysql 专有键", () => {
    const c = connectionConfig(cfgSqlite());
    expect(Object.keys(c)).toEqual(["filename"]);
  });

  it("连接池：mysql 分支用 config.db 的 min/max，sqlite 分支不把 mysql 的池配置带过去", () => {
    const sqlite = createKnex(cfgSqlite());
    // sqlite 分支不显式给 pool → 用的是 knex 自己对 better-sqlite3 的默认池，**实测真值是 min 1 / max 1**
    // （`sqlite.client.pool` → {min:1,max:1,acquireTimeoutMillis:60000}；不是 min 2 / max 10，也不是 3/7）。
    // ⚠ 不用可选链：`pool?.min` 会把"pool 缺失"的 undefined 也放过（弱断言）。
    expect(sqlite.client.pool.min).toBe(1);
    expect(sqlite.client.pool.max).toBe(1);
    const mysql = createKnex(cfgMysql());
    // 这两条断言的才是**我们显式传入的配置值**（config.db.poolMin/poolMax = 3/7）；
    // 比断言 knex 的内部默认更稳 —— 默认值会随版本变。
    expect(mysql.client.pool.min).toBe(3);
    expect(mysql.client.pool.max).toBe(7);
    expect(mysql.client.config.client).toBe("mysql2");
    void sqlite.destroy(); void mysql.destroy();
  });

  it("createKnex 对 mysql 分支不注入 useNullAsDefault（它只对 sqlite 有效）", () => {
    const mysql = createKnex(cfgMysql());
    expect((mysql.client.config as any).useNullAsDefault).toBeUndefined();
    const sqlite = createKnex(cfgSqlite());
    expect((sqlite.client.config as any).useNullAsDefault).toBe(true);
    void mysql.destroy(); void sqlite.destroy();
  });

  it("describeTarget 不泄露口令", () => {
    const c = cfgMysql();
    if (c.db.driver === "mysql") c.db.password = "SUPER-SECRET";
    const s = describeTarget(c);
    expect(s).not.toContain("SUPER-SECRET");
    expect(s).toContain("miwo_test");
  });
});

describe("sqldialect", () => {
  it("从 knex 实例与裸 client 名都能判定", () => {
    const s = createKnex(cfgSqlite());
    expect(sqldialect(s)).toBe("sqlite");
    expect(sqldialect(s.client)).toBe("sqlite");
    const m = createKnex(cfgMysql());
    expect(sqldialect(m)).toBe("mysql");
    expect(sqldialect(m.client)).toBe("mysql");
    void s.destroy(); void m.destroy();
  });

  it("未知 client 必须抛错，而不是静默当 sqlite", () => {
    expect(() => sqldialect({ client: { dialect: "oracledb" } })).toThrow(/无法判定方言/);
    expect(() => sqldialect(undefined)).toThrow(/无法判定方言/);
  });
});

describe("types() 的 sqlite 行为（可在本机真跑）", () => {
  it("pk() 生成 integer primary key autoincrement", async () => {
    const db = createKnex(cfgSqlite());
    const sql = db.schema.createTable("t", (t) => types(db).pk(t)).toSQL()[0].sql;
    expect(sql).toContain("integer not null primary key autoincrement");
    await db.destroy();
  });

  it("vstr() 生成 varchar(191)", async () => {
    const db = createKnex(cfgSqlite());
    const sql = db.schema.createTable("t", (t) => { types(db).vstr(t, "id"); }).toSQL()[0].sql;
    expect(sql).toContain("varchar(191)");
    await db.destroy();
  });

  it("boolCol() 生成 tinyint", async () => {
    const db = createKnex(cfgSqlite());
    const sql = db.schema.createTable("t", (t) => { types(db).boolCol(t, "disabled"); }).toSQL()[0].sql;
    expect(sql).toContain("tinyint");
    await db.destroy();
  });

  it("u64() 在 sqlite 下退化为 integer（sqlite 没有无符号 64 位整型）", async () => {
    const db = createKnex(cfgSqlite());
    const sql = db.schema.createTable("t", (t) => { types(db).u64(t, "userId"); }).toSQL()[0].sql;
    expect(sql).toContain("integer");
    expect(sql).not.toContain("unsigned");
    await db.destroy();
  });

  it("26 张表的主键用 pk() 后真的能自动分配 id 且不复用", async () => {
    const db = createKnex(cfgSqlite());
    await db.schema.createTable("t_seg", (t) => types(db).pk(t));
    const [a] = await db("t_seg").insert({});
    const [b] = await db("t_seg").insert({});
    expect([a, b]).toEqual([1, 2]);
    await db("t_seg").where("id", 2).delete();
    const [c] = await db("t_seg").insert({});
    // AUTOINCREMENT 语义：不复用被删掉的 id（这是上游 o_segment 注释里点名的既有不变式）
    expect(c).toBe(3);
    await db.destroy();
  });
});

/**
 * `u.db` 的成员白名单（Phase 1a / Task 12 Step 6；历史**真机** bug：`db.transaction is not a function`）。
 *
 * ⚠ 这里 import 的是**真模块** `../src/utils/db` —— 它在求值时就会 `connect()` + `migrate.latest()`
 *   （`dbReady`）。**这是有意的**：它顺带验证"模块加载 = 迁移完成"，而这条路径正是旧黑名单 hack
 *   会把整个模块初始化搞崩的地方（严格模式下读 `caller` 直接抛）。
 *   数据目录是 `vitest.config.ts` 的 `MIWO_DATA_DIR`（`D:\tmp\miwo-test-data`，**仓库外**的一次性目录）；
 *   **不碰** `apps/api/data/db2.sqlite`（那是本阶段的硬约束，sha256 冻结）。
 *
 * ⚠ 与计划文本的一处**实测差异**：计划写的是"9 个成员 `typeof` 全是 `function`"。实测（knex 3.x）
 *   `fn` / `schema` / `client` / `migrate` / `seed` 是**对象** —— 照抄那条用例会红。
 *   这里改成**逐成员断言真实形状**：比"全是函数"更强，它同时把"函数要 `bind(db)`、对象不能 `bind`"
 *   钉住了（`schema.createTable` / `migrate.latest` 的存在性断言就是"不是空对象占位"的证据）。
 */
describe("u.db 的成员白名单", () => {
  it("白名单成员按真实形状可用，且 u.transaction / u.raw 真的能跑", async () => {
    // 先清掉上一次跑留下的一次性库，让这次 import 真的走"建库 + 迁移"（而不是复用旧文件）。
    const dataDir = process.env.MIWO_DATA_DIR || TMP;
    fs.rmSync(path.join(dataDir, "db2.sqlite"), { force: true });
    const mod = await import("../src/utils/db");
    const u = mod.default as any;
    expect(typeof u).toBe("function"); // db("表") 的调用形态不变
    for (const m of ["transaction", "raw", "ref", "destroy"]) expect(typeof u[m], m).toBe("function");
    for (const m of ["fn", "schema", "client", "migrate", "seed"]) expect(typeof u[m], m).toBe("object");
    // "对象"不等于"空对象占位"：逐个点名它们的关键成员
    expect(typeof u.schema.createTable, "schema.createTable").toBe("function");
    expect(typeof u.migrate.latest, "migrate.latest").toBe("function");
    expect(typeof u.seed.run, "seed.run").toBe("function");
    expect(typeof u.fn.now, "fn.now").toBe("function");
    expect(u.client, "client 是 knex 的 Client 实例").toBeTruthy();

    // `u.transaction` 绑的是**模块自己的** knex（不是本文件里那些一次性库）：
    // 原 bug 下它是 undefined → 这里会 `TypeError: u.transaction is not a function`。
    const inTx = await u.transaction(async (trx: any) => trx.raw("select 1 as one"));
    expect(inTx).toBeTruthy();
    expect(await u.raw("select 1 as one")).toBeTruthy();

    // 真实的 transaction 往返（这就是 persistShots 那条链路的前提）
    const db = createKnex(cfgSqlite());
    await db.schema.createTable("t", (T) => { T.increments("id"); T.string("v"); });
    await db.transaction(async (trx) => { await trx("t").insert({ v: "a" }); });
    expect((await db("t").select("v")).map((r: any) => r.v)).toEqual(["a"]);
    await db.destroy();
  });

  it("判别力：毒药属性既不会在初始化时被读到，也不会被挂上（黑名单 → 白名单）", async () => {
    const mod = await import("../src/utils/db");
    const u = mod.default as any;
    // 白名单是"只读这些名字"，`caller` / `arguments` 在结构上就不可能被读到；
    // 它们也**不是**包装函数的自有属性（旧黑名单 hack 曾把这两位当作要处理的常规键）。
    expect(Object.prototype.hasOwnProperty.call(u, "caller")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(u, "arguments")).toBe(false);
    // 而旧 hack 的遍历空间（实测 `Object.getPrototypeOf(knex) === Function.prototype`）里**有**它们：
    // 黑名单必须先知道要跳哪些，而"要跳的名单"只能靠猜 —— 这就是换白名单的理由。
    const probe = createKnex(cfgSqlite(path.join(TMP, "fproto.sqlite")));
    expect(Object.getPrototypeOf(probe)).toBe(Function.prototype);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(probe))).toEqual(
      expect.arrayContaining(["caller", "arguments"]),
    );
    void probe.destroy();
    // 严格模式函数上读它们**直接抛** —— 包装函数本身（定义在 ESM 模块里）就是严格函数，
    // 所以"读一下再跳过"的写法在 esbuild 产物里必然炸；本用例跑得完 = 白名单没读它们。
    expect(() => (u as any).caller).toThrow(/caller|arguments/);
    expect(() => (u as any).arguments).toThrow(/caller|arguments/);
  });
});

/**
 * Task 3 的**接线**判据：`u.db` 必须是租户守卫（fail-closed），且绕过口只有显式导出这一个。
 *
 * ⚠ 这三条真的 import 整个 `utils/db`（含启动迁移），走 `vitest.config.ts` 的
 *   `MIWO_DATA_DIR=D:\tmp\miwo-test-data`（仓库外一次性目录），**不碰** `apps/api/data/db2.sqlite`。
 */
describe("u.db 已接上租户守卫（Task 3）", () => {
  it("没有 ctx 访问租户表 → 抛 TenantContextError（fail-closed，含 Task 4 依赖的 code/httpStatus）", async () => {
    const mod = await import("../src/utils/db");
    const u = mod.default as any;
    expect(() => u("o_assets")).toThrow(/fail-closed|没有租户上下文/);
    try {
      u("o_assets");
      expect.unreachable("无 ctx 访问租户表必须抛");
    } catch (err: any) {
      // 这两个字符串是 Task 4 的错误中间件（403/500 映射）唯一的分支依据，这里在**接线层**再钉一次
      expect(err.name).toBe("TenantContextError");
      expect(err.code).toBe("TENANT_NO_CONTEXT");
      expect(err.httpStatus).toBe(500);
    }
    // 平台表读**无 ctx 也放行**（登录前要取 `o_setting.tokenKey`，`src/middleware/tenant.ts` 的
    // bootstrap 就读它，所以它**不需要**走 systemDb 那个绕过口）
    expect(() => u("o_setting")).not.toThrow();
  });

  it("有 ctx 时：租户表自动带租户条件，平台表不受影响", async () => {
    const mod = await import("../src/utils/db");
    const { runWithTenant } = await import("../src/db/tenant-context");
    const u = mod.default as any;
    runWithTenant({ userId: 7, role: "user", requestId: "t", source: "system" }, () => {
      const sql = u("o_assets").select("id").toSQL();
      expect(sql.sql).toContain("userId");
      expect(sql.bindings).toContain(7);
      // 平台表：读路径不加租户条件（它没有"属于谁"的概念）
      expect(u("o_setting").select("key").toSQL().sql).not.toContain("userId");
    });
  });

  it("绕过口是显式导出：只有 systemDb 可用；`systemTable` 已删（**移除也要有判别力**）；裸 `db` 命名导出已删", async () => {
    const mod: any = await import("../src/utils/db");
    expect(typeof mod.systemDb).toBe("function");
    // Task 4 / Ruling 204：`systemTable` 是**第二个无守卫出口**（0 使用者、门禁与 bypass 测试双盲），
    // 已删除。这条**反向**断言让"删除"本身被钉住 —— 谁想加回来就必须先改这里。
    expect(typeof mod.systemTable).toBe("undefined");
    expect(mod.db).toBeUndefined(); // spec 附录 B.1 的 7 个绕过文件拿到的那个命名导出，已被删除
    // 裸 knex：没有 ctx 也能建出 builder（实例级运维接口的前提）
    expect(mod.systemDb("o_setting")).toBeTruthy();
    // 两个出口必须是**不同**对象：默认导出是守卫，systemDb 是裸 knex
    expect(mod.systemDb).not.toBe(mod.default);
    expect(() => mod.systemDb("o_assets")).not.toThrow();
  });
});

/**
 * Task 7：MySQL 连接级会话设置（spec §5.3 的 `GROUP_CONCAT` 口径）。
 *
 * 为什么非做不可：`GROUP_CONCAT` 的默认 `group_concat_max_len` 是 **1024 字节** ⇒ `getEvent` 把
 * 一章的 `chapterIndex` 聚合成一列时，章节一多就**静默截断**（列表少几项、不报错）。
 * 它是**会话变量** ⇒ 必须对池里**每条**连接设一次 ⇒ 挂在 knex 的 `pool.afterCreate`。
 *
 * ⚠ 本机 3307 独占、不启动 MySQL ⇒ **行为未实测**（只测函数语义与接线）；真机验证归 CI 的 mysql job。
 */
describe("MySQL 连接级会话设置（Task 7）", () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("MYSQL_SESSION_SETUP 设置 group_concat_max_len，且明显大于默认的 1024", () => {
    expect(MYSQL_SESSION_SETUP.length).toBeGreaterThan(0);
    const joined = MYSQL_SESSION_SETUP.join("; ");
    expect(joined).toMatch(/SET\s+SESSION\s+group_concat_max_len\s*=/i);
    const value = Number(/group_concat_max_len\s*=\s*(\d+)/i.exec(joined)?.[1]);
    expect(Number.isFinite(value), `取不到数值：${joined}`).toBe(true);
    expect(value).toBeGreaterThan(1024);
  });

  it("applyMysqlSessionSettings 逐条执行（顺序与常量一致）", async () => {
    const ran: string[] = [];
    await applyMysqlSessionSettings({ query: async (sql: string) => { ran.push(sql); } });
    expect(ran).toEqual([...MYSQL_SESSION_SETUP]);
  });

  it("mysqlAfterCreate：成功路径回传连接；失败路径回传 error（不许吞）", async () => {
    let ok: { err: unknown; conn: unknown } | null = null;
    const conn = { query: async () => undefined };
    mysqlAfterCreate(conn, (err, c) => { ok = { err, conn: c }; });
    await settle();
    expect(ok, "成功路径必须回调（否则池永远拿不到连接）").not.toBeNull();
    expect(ok!.err).toBeNull();
    expect(ok!.conn).toBe(conn);

    let failed: { err: unknown } | null = null;
    const bad = { query: async () => { throw new Error("boom-session-setup"); } };
    mysqlAfterCreate(bad, (err) => { failed = { err }; });
    await settle();
    expect(failed, "失败路径必须回调").not.toBeNull();
    expect(String((failed!.err as Error).message)).toMatch(/boom-session-setup/);
  });

  it("接线：createKnex 的 mysql 分支把 afterCreate 接进池；sqlite 分支不带它", () => {
    const mysql = createKnex(cfgMysql());
    const sqlite = createKnex(cfgSqlite());
    try {
      // ⚠ 先断言"确实是 mysql 分支"（否则下面可能整块静默跳过 —— Task 7 前踩过的假绿形状）
      expect(mysql.client.config.client).toBe("mysql2");
      expect(typeof (mysql.client.config.pool as any)?.afterCreate).toBe("function");
      expect((sqlite.client.config as any)?.pool?.afterCreate).toBeUndefined();
    } finally {
      void mysql.destroy();
      void sqlite.destroy();
    }
  });
});
