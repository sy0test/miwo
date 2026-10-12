import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { clientConfig, connectionConfig, createKnex, describeTarget, dialectOfConfig } from "@/db/connect";
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
