/**
 * `o_job` / `o_gate` 两条迁移的回归网（spec §9.2 / §9.3）。
 *
 * 这个文件守四件事：
 *  1. **sqlite 上真建出两张表**：列、唯一约束、4 个索引真的存在（不是"DDL 串里有"）；
 *  2. **`dedupeActive` 的"可空唯一"语义**：多个 NULL 可共存、同键第二条被拒
 *     —— 幂等锁的**全部**正确性都建立在这一条上（终态置 NULL ⇒ 同键可重投）；
 *  3. **MySQL 静态 DDL**（`createKnex({client:"mysql2"})` + `toSQL()`，**不连任何服务端**）：
 *     主键是 `bigint unsigned auto_increment`、`payload` 是 `longtext`、
 *     每个毫秒列都是 `bigint unsigned`（`int` 装不下 `Date.now()`）；
 *  4. **毫秒列宽度的机械守卫**（本文件最重要的一条）：列清单**从 `001_schema.ts` 的源码推**，
 *     不手写第二份清单 —— 本仓库反复吃过"手写清单必漂"的亏（见 `migration-ddl-mysql.test.ts`
 *     文件头与 `migration-column-fit.test.ts` 的 修复轮 2）。任何人把某个 `t.ms(...)` 改回
 *     `T.integer(...)`，本用例当场红。
 *
 * ⚠ **为什么没有第三条 `00N+2_time_ms_bigint` 迁移**（对 brief 的有意偏离，理由见组报告）：
 *    brief 的前提"`001_schema.ts` 用 `T.integer` 建毫秒时间列"**在 BASE HEAD 上已不成立** ——
 *    Phase 1a 的修复轮 1 已把全部 15 个毫秒列改成 `t.ms()`（本文件第 4 组的断言就是它的机械证据）。
 *    再补一条 `alter ... modify ... bigint unsigned` 有两个具体危害：
 *      ① 它**必须知道每列的 not null**，否则 `MODIFY` 会把 `memories.createTime` 的
 *         `not null` 悄悄去掉（实测编译出 `alter table \`memories\` modify \`createTime\` bigint unsigned`
 *         —— 没有任何 `not null`）；brief 的 `TIME_MS_COLUMNS` 只有 `{table, column}`，正是这个形状。
 *      ② 它会成为"毫秒列清单"的**第二份真相**（第一份是 `001_schema.ts`），与门禁的单一来源原则相悖。
 *    所以本组把这条要求落成 (a) 新表的毫秒列一律 `t.ms()`（下面第 3/4 组断言）与
 *    (b) 这条从源码机械推导的守卫，而不是一条空转且会掉 `not null` 的迁移。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { sqldialect } from "@/db/dialect";
import { MIGRATIONS, migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";
import { jobTableSpec } from "@/db/migrations/007_job_queue";
import { gateTableSpec } from "@/db/migrations/008_vendor_gate";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-mig-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function cfgSqlite(): MiwoConfig {
  seq += 1;
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `jobs${seq}.sqlite`) },
  } as MiwoConfig;
}
function cfgMysql(): MiwoConfig {
  return {
    ...cfgSqlite(),
    db: { driver: "mysql", host: "127.0.0.1", port: 3307, user: "miwo", password: "", name: "miwo_test", poolMin: 1, poolMax: 4 },
  } as MiwoConfig;
}
function fresh(): Knex {
  return createKnex(cfgSqlite());
}

/** 不连服务端的 mysql knex：只用它的方言编译能力（`toSQL()`）。 */
const mysql: Knex = createKnex(cfgMysql());
afterAll(async () => {
  await mysql.destroy();
});

/** 用 mysql 方言把一个 `createTable` 编译成 SQL 串（多语句：create + add index / add unique）。 */
function compileMysql(table: string, spec: (T: Knex.CreateTableBuilder) => void): string {
  return mysql.schema
    .createTable(table, spec)
    .toSQL()
    .map((s) => s.sql)
    .join("\n");
}

/** 从 DDL 文本里抠出某列的**完整类型段**（不含列名与 not null / default 这类后缀）。 */
function colType(ddl: string, col: string): string {
  const m = new RegExp("`" + col + "`\\s+([^,()]+(?:\\([^)]*\\))?(?:\\s+unsigned)?)").exec(ddl);
  if (!m) throw new Error(`DDL 里找不到列 \`${col}\`：${ddl}`);
  let ty = m[1].trim();
  for (const suffix of [" not null", " null", " auto_increment", " primary key", " default"]) {
    const i = ty.indexOf(suffix);
    if (i >= 0) ty = ty.slice(0, i);
  }
  return ty.trim();
}

/** `o_job` / `o_gate` 里所有毫秒语义的列（新表自己的清单；**不是** 001_schema 那份的副本）。 */
const JOB_MS_COLUMNS = ["leaseUntil", "heartbeatAt", "createdAt", "startedAt", "finishedAt", "nextAttemptAt", "updatedAt"];
const GATE_MS_COLUMNS = ["acquiredAt", "leaseUntil", "updatedAt"];

describe("o_job / o_gate 迁移（spec §9.2 / §9.3）", () => {
  it("sqlite 下真建出两张表，含可空唯一列与 o_job 的 4 个索引", async () => {
    const db = fresh();
    await runMigrations(db);
    const tables = (await db("sqlite_master").where("type", "table").select("name")).map((r: any) => r.name);
    expect(tables).toContain("o_job");
    expect(tables).toContain("o_gate");
    const idx = (await db("sqlite_master").where("type", "index").andWhere("tbl_name", "o_job").select("name")).map((r: any) => r.name);
    for (const name of ["o_job_claim_index", "o_job_lease_index", "o_job_user_index", "o_job_type_index"]) {
      expect(idx).toContain(name);
    }
    const gateIdx = (await db("sqlite_master").where("type", "index").andWhere("tbl_name", "o_gate").select("name")).map((r: any) => r.name);
    expect(gateIdx).toContain("o_gate_pool_index");
    expect(gateIdx).toContain("o_gate_holder_index");
    // 唯一索引也要真的存在（`dedupeActive` 的幂等锁靠它）
    expect(idx).toContain("o_job_dedupe_active_unique");
    await db.destroy();
  });

  it("dedupeActive 是'可空唯一'：多个 NULL 可以共存，同键第二条被拒", async () => {
    const db = fresh();
    await runMigrations(db);
    const now = Date.now();
    const base = { userId: 1, type: "selftest.sleep", payload: "{}", state: "queued", attempts: 0, maxAttempts: 1, priority: 100, progress: 0, createdAt: now, updatedAt: now };
    await db("o_job").insert({ ...base, dedupeKey: "a", dedupeActive: null }); // 终态行：dedupeActive 为 NULL
    await db("o_job").insert({ ...base, dedupeKey: "b", dedupeActive: null }); // 第二个 NULL
    await db("o_job").insert({ ...base, dedupeKey: "k", dedupeActive: "k" });
    await expect(db("o_job").insert({ ...base, dedupeKey: "k", dedupeActive: "k" })).rejects.toThrow(/UNIQUE/i);
    expect(Number((await db("o_job").count({ n: "*" }).first())!.n)).toBe(3);
    await db.destroy();
  });

  it("毫秒时间列能原样存取 Date.now()（13 位；sqlite 是 64 位 integer）", async () => {
    const db = fresh();
    await runMigrations(db);
    const ts = Date.now();
    expect(String(ts)).toHaveLength(13); // 前提自证：Date.now() 就是 13 位
    const [id] = await db("o_job").insert({ userId: 2, type: "selftest.sleep", payload: "{}", state: "queued", attempts: 0, maxAttempts: 1, priority: 1, progress: 0, createdAt: ts, updatedAt: ts, leaseUntil: ts + 60_000 });
    const row: any = await db("o_job").where("id", id).first();
    expect(row.createdAt).toBe(ts);
    expect(row.leaseUntil).toBe(ts + 60_000);
    const [gateId] = await db("o_gate").insert({ name: "vendor:selftest", holderId: "w1", acquiredAt: ts, leaseUntil: ts + 1, updatedAt: ts });
    const gate: any = await db("o_gate").where("id", gateId).first();
    expect(gate.leaseUntil).toBe(ts + 1);
    await db.destroy();
  });

  it("down 精确撤掉两张表（其余表不受影响）", async () => {
    const db = fresh();
    await runMigrations(db);
    const before = (await db("sqlite_master").where("type", "table").select("name")).map((r: any) => r.name);
    await rollbackMigrations(db, true);
    const tables = (await db("sqlite_master").where("type", "table").select("name")).map((r: any) => r.name);
    expect(tables).not.toContain("o_job");
    expect(tables).not.toContain("o_gate");
    // 回滚前确实有 39 张业务表（不然"撤掉了"这条断言可能只是因为压根没建出来）
    expect(before.filter((t: string) => t.startsWith("o_") || t === "memories").length).toBeGreaterThanOrEqual(39);
    const status = await migrationStatus(db);
    expect(status.every((r) => r.state === "pending")).toBe(true);
    await db.destroy();
  });

  it("迁移跑两遍是幂等的（第二次 0 条新迁移）", async () => {
    const db = fresh();
    const [b1, n1] = await runMigrations(db);
    expect(n1.length).toBe(MIGRATIONS.length);
    expect(n1).toContain("007_job_queue");
    expect(n1).toContain("008_vendor_gate");
    const [b2, n2] = await runMigrations(db);
    expect(n2).toEqual([]);
    expect(b2).toBe(b1);
    await db.destroy();
  });
});

describe("MySQL 静态 DDL（离线编译，不需要 MySQL 服务端）", () => {
  it("o_job：bigint unsigned AI 主键 / 可空唯一 dedupeActive / 4 个索引 / payload 是 longtext / 时间列是 bigint", () => {
    expect(sqldialect(mysql)).toBe("mysql");
    const all = compileMysql("o_job", jobTableSpec(mysql));
    expect(all).toContain("`id` bigint unsigned not null auto_increment primary key");
    expect(all).toContain("`dedupeActive` varchar(191)");
    expect(all).toContain("add unique `o_job_dedupe_active_unique`(`dedupeActive`)");
    for (const ix of ["o_job_claim_index", "o_job_lease_index", "o_job_user_index", "o_job_type_index"]) expect(all).toContain(ix);
    expect(all).toContain("`payload` longtext");
    // 毫秒时间列必须是 bigint（int 装不下 Date.now()）；这条断言是"列宽缺陷"的守卫
    for (const col of JOB_MS_COLUMNS) {
      expect(colType(all, col), `o_job.${col}`).toBe("bigint unsigned");
    }
    // 反向：整串里不得出现 int 型的毫秒列（用逐列类型段判，不用 toContain 判 —— 见 colType 注释）
    for (const col of JOB_MS_COLUMNS) {
      expect(colType(all, col), `o_job.${col} 不得退化成 int`).not.toMatch(/^int/);
    }
  });

  it("o_gate：池名 + 持有者 + 租约，且有 (name, leaseUntil) / (holderId) 索引", () => {
    const all = compileMysql("o_gate", gateTableSpec(mysql));
    expect(all).toContain("`name` varchar(64)");
    expect(all).toContain("`holderId` varchar(128)");
    expect(all).toContain("o_gate_pool_index");
    expect(all).toContain("o_gate_holder_index");
    for (const col of GATE_MS_COLUMNS) {
      expect(colType(all, col), `o_gate.${col}`).toBe("bigint unsigned");
    }
    // 池槽位不该有 payload/state 这类任务语义（混进 o_job 会让统计口径被污染）
    expect(all).not.toContain("`payload`");
    expect(all).not.toContain("`state`");
  });
});

/**
 * ★ 毫秒列宽度的**机械守卫**。
 *
 * 列清单**从 `001_schema.ts` 源码推**（唯一真相），因此：
 *   · 有人新增一个毫秒列但用了 `T.integer` ⇒ 本用例红（新列也进了清单）；
 *   · 有人把某个 `t.ms(...)` 改回 `T.integer(...)` ⇒ 本用例红；
 *   · 有人删/改毫秒列 ⇒ 15 / 12 的覆盖护栏先红（"没扫到所以没意见"是不允许的）。
 */
describe("★ 毫秒时间戳列宽度（机械推导自 001_schema.ts 源码；本组不许退化成 int）", () => {
  /** 与各门禁同口径的剥注释（保持行号无关，这里只求"不把注释里的示例当成代码"）。 */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
  }

  const SCHEMA_SRC = stripComments(
    fs.readFileSync(path.resolve(__dirname, "..", "src", "db", "migrations", "001_schema.ts"), "utf8"),
  );

  /** 按 `createTable("t")` 分段，取每段里的 `t.ms(T, "col")` 调用。 */
  function msColumnsFromSchemaSource(src: string): Array<{ table: string; column: string }> {
    const out: Array<{ table: string; column: string }> = [];
    let table = "";
    for (const line of src.split(/\r?\n/)) {
      const created = /createTable\("([A-Za-z0-9_]+)"/.exec(line);
      if (created) table = created[1];
      for (const m of line.matchAll(/t\.ms\(\s*T\s*,\s*"([A-Za-z0-9_]+)"\s*\)/g)) out.push({ table, column: m[1] });
    }
    return out;
  }

  const MS = msColumnsFromSchemaSource(SCHEMA_SRC);

  it("机械清单是 15 列 / 12 表（数变了说明有人动了毫秒列，先核对再改这条断言）", () => {
    expect(MS).toHaveLength(15);
    expect(new Set(MS.map((c) => c.table)).size).toBe(12);
    // 清单里的表必须真的在迁移里被建出来（解析器失灵 ⇒ 表名为空串 / 退役表名，这条会红）
    expect(MS.every((c) => /^[A-Za-z0-9_]+$/.test(c.table) && c.table.length > 0)).toBe(true);
    console.log(`[ms-width] 从 001_schema.ts 机械推导到 ${MS.length} 个毫秒列（${new Set(MS.map((c) => c.table)).size} 张表）`);
  });

  it("每一个毫秒列在 MySQL 上都编译成 bigint unsigned（没有一个是 int / varchar）", async () => {
    const created: Record<string, string> = {};
    const collector: any = {
      client: mysql.client,
      schema: {
        createTable: (name: string, cb: any) => {
          for (const s of mysql.schema.createTable(name, cb).toSQL()) {
            if (/^create table /i.test(s.sql.trim())) created[name] = s.sql;
          }
          return Promise.resolve();
        },
        dropTableIfExists: () => Promise.resolve(),
        alterTable: () => Promise.resolve(),
      },
      raw: () => Promise.resolve(),
    };
    const schema = (await import("@/db/migrations/001_schema")).default;
    await (schema as any).up(collector);
    // 覆盖自证：解析器扫到的表必须都在 DDL 里出现过（否则是"没扫到所以没意见"）
    for (const { table } of MS) expect(created[table], `DDL 里没有 ${table}`).toBeTruthy();
    const bad: string[] = [];
    for (const { table, column } of MS) {
      const type = colType(created[table], column);
      if (type !== "bigint unsigned") bad.push(`${table}.${column} => ${type}`);
    }
    expect(bad, `毫秒列必须是 bigint unsigned（int 上限 2147483647 装不下 Date.now()）：\n${bad.join("\n")}`).toEqual([]);

    // ⚠ 上面那一轮只覆盖"源码里写着 `t.ms(...)` 的那些列"。如果**换了个 builder**（例如
    //   `t.u32(T, "createTime")` → MySQL `int`），那一列就从清单里消失了 —— 只剩"15 → 14"的
    //   粗粒度信号，而"新加一个毫秒列"也会让同一个信号变红（说不清是退化了还是扩了）。
    //   所以再补一轮**按列名**的全库扫描：毫秒列的**名字集合**（从 `t.ms(...)` 机械取）一旦在
    //   任何一张表的 DDL 里出现，它的类型就必须逐字是 `bigint unsigned`。这一轮能直接指出
    //   "哪张表的哪个毫秒列退化成了 int"，不依赖计数。
    const MS_NAMES = [...new Set(MS.map((c) => c.column))];
    const degraded: string[] = [];
    for (const [table, ddl] of Object.entries(created)) {
      for (const name of MS_NAMES) {
        if (!ddl.includes("`" + name + "`")) continue;
        const type = colType(ddl, name);
        if (type !== "bigint unsigned") degraded.push(`${table}.${name} => ${type}`);
      }
    }
    expect(
      degraded,
      `按列名扫出的退化毫秒列（毫秒列的 mysql 类型必须是 bigint unsigned）：\n${degraded.join("\n")}`,
    ).toEqual([]);
  });
});
