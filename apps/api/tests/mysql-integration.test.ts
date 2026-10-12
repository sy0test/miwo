/**
 * 真实 MySQL 的集成测试（spec §12.2 T5/T6 的 MySQL 侧）。
 *
 * **门控**：只有 `MIWO_TEST_MYSQL=1` 时才跑。本机没有 MySQL 时（默认）整个文件 skip ——
 * 这是 spec 要求的"没有 MySQL 时测试仍可跑"。
 * CI 的 mysql job 会设 `MIWO_TEST_MYSQL=1`（Task 9），所以这条路径**在 CI 里真的会被跑到**。
 *
 * ⚠ 它会 DROP 掉目标库里 001/002 建的东西（用 down 往返），所以**必须**指向一个专用测试库
 *    （`MIWO_DB_NAME`，默认 miwo_test），绝不能指向生产库。
 *
 * 本机怎么跑（Task 7 实测过的完整流程）：
 * ```powershell
 * cd apps\api
 * powershell -ExecutionPolicy Bypass -File scripts\mysql-local.ps1 -Action start
 * powershell -ExecutionPolicy Bypass -File scripts\mysql-local.ps1 -Action createdb
 * $env:MIWO_TEST_MYSQL="1"; $env:MIWO_DB_HOST="127.0.0.1"; $env:MIWO_DB_PORT="3307"
 * $env:MIWO_DB_USER="miwo"; $env:MIWO_DB_PASSWORD="miwo"; $env:MIWO_DB_NAME="miwo_test"
 * pnpm.cmd exec vitest run tests/mysql-integration.test.ts --reporter=verbose
 * ```
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/config";
import { createKnex, describeTarget } from "@/db/connect";
import { migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";

const ENABLED = process.env.MIWO_TEST_MYSQL === "1";
const d = ENABLED ? describe : describe.skip;

d("真实 MySQL 集成（MIWO_TEST_MYSQL=1）", () => {
  it("配置确实指向 mysql（防止误把 sqlite 当 mysql 测）", () => {
    expect(config.db.driver).toBe("mysql");
    expect(describeTarget()).toMatch(/^mysql:\/\//);
  });

  it("up → down(全部) → up 往返，且幂等", async () => {
    const db = createKnex();
    try {
      // 从干净状态开始（用 runner 里的同一个内存 MigrationSource，别自己再拼一份）
      await rollbackMigrations(db, true);
      const [b1, n1] = await runMigrations(db);
      expect(n1.length).toBeGreaterThan(0);
      const [b2, n2] = await runMigrations(db);
      expect(n2).toEqual([]);
      void b1; void b2;
      const [rb, rn] = await rollbackMigrations(db, true);
      expect(rn.length).toBe(n1.length);
      void rb;
      const st = await migrationStatus(db);
      expect(st.map((r) => r.name)).toEqual(n1);
      expect(st.every((r) => r.state === "pending")).toBe(true);
      const [b3, n3] = await runMigrations(db);
      expect(n3.length).toBe(n1.length);
      expect(b3).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("有自增主键的表都是 bigint unsigned，且清单恰好等于「最终期望清单」", async () => {
    const db = createKnex();
    try {
      await runMigrations(db);
      const raw = (await db.raw(
        `select table_name as n, column_type as t from information_schema.columns
         where table_schema = database() and column_name = 'id' and extra like '%auto_increment%'`,
      )) as any;
      const all = (Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw) as Array<{ n: string; t: string }>;
      // ⚠ knex 自己的基础设施表也被 `information_schema` 扫到：`knex_migrations.id` 是
      //    **`int unsigned` auto_increment**（knex 内部实现，不属我们的 schema，也不归 §5.3 管）。
      //    本机实测（Task 7）：整个 `miwo_test` 库里有自增 `id` 的 `knex_*` 表**恰好只有它一张**。
      //    所以这里不是"随手过滤掉一堆东西"，而是把被排除的那一条**钉死**：
      //    将来若多出一张 knex_* 自增表、或它的类型变了，这条断言会红。
      const isInfra = (n: string): boolean => n.toLowerCase().startsWith("knex_");
      expect(all.filter((r) => isInfra(r.n)).map((r) => `${r.n.toLowerCase()}:${r.t.toLowerCase()}`)).toEqual([
        "knex_migrations:int unsigned",
      ]);
      const list = all.filter((r) => !isInfra(r.n));
      const types = new Set(list.map((r) => r.t.toLowerCase()));
      expect(types).toEqual(new Set(["bigint unsigned"]));
      expect(list.length).toBeGreaterThan(15); // 防"过滤把业务表一起滤掉"→ 空集合假绿

      // ⚠ 清单**不是**在这里手写的，而是从 `001_schema` 的源码机械抽取：
      //    凡是用了 `t.pk(T)` 的表就是自增主键表。这样"加了表但忘了改断言"不可能发生。
      const schemaSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "db", "migrations", "001_schema.ts"), "utf8");
      // ⚠ **必须先剥注释**：brief 的原始正则直接在表体里找 `t.pk(T)`，而 `o_project` 的表体里有一句
      //    注释写着「⚠ **不能**用 `t.pk(T)`：现状 `id` 由代码显式给 `Date.now()`…」——
      //    于是 `o_project` 被**误判**成自增主键表（实测：期望清单 19 项 vs 真库 18 项，
      //    差异恰好是 `o_project`）。注释里提到一个 API 名字，不等于调用了它。
      const stripComments = (s: string): string =>
        s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const expected = [...schemaSrc.matchAll(/createTable\("([^"]+)",\s*\(T\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/g)]
        .filter((m) => /\bt\.pk\(T\b/.test(stripComments(m[2])))
        .map((m) => m[1])
        .sort();
      expect(expected.length).toBeGreaterThan(15);                 // 防止正则失效导致"空清单 vs 空清单"的假绿
      // ⚠ 地板值为什么是 15 而不是 brief 写的 20：**实测**（Task 7，本机真 MySQL）
      //    27 张表里用 `t.pk(T)` 的**恰好 18 张**（其余 9 张：o_user / o_project 显式给 id、
      //    memories / o_setting / o_vendorConfig 是 varchar 主键、4 张复合主键关联表）。
      //    brief 的 20 会让这条断言**恒红**——它是未经实跑的估计值。
      // ⚠ 比较**大小写归一后**的名字：Windows 上的 MySQL `@@lower_case_table_names=1`
      //    （本机实测 = 1）把表名按小写存储，`information_schema` 回读的永远是
      //    `o_agentworkdata`，而源码抽出来的是 `o_agentWorkData`。Linux 的 CI 上是 0，
      //    回读与源码同名。`toLowerCase()` 两边都做，于是两个平台都能跑；
      //    判别力不受影响（表的增删仍会立刻红）。
      expect(list.map((r) => r.n.toLowerCase()).sort()).toEqual(expected.map((n) => n.toLowerCase()).sort());
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("批量 insert 的 insertId 是**首行**（与 sqlite 的末行不同 —— spec §5.3 的差异被钉住）", async () => {
    const db = createKnex();
    try {
      // ⚠ 这条用例的前提是 `o_artStyle` 是**刚建出来的空表**：MySQL 的 AUTO_INCREMENT 计数器
      //    不会因为 DELETE 归零，所以必须先让迁移把它重建一次（本文件的第 2 条用例刚做过往返），
      //    再用 `ALTER TABLE ... AUTO_INCREMENT = 1` 显式归零 —— 否则单行 insert 的 id 不是 1。
      await runMigrations(db);
      await db.raw("ALTER TABLE o_artStyle AUTO_INCREMENT = 1");
      await db("o_artStyle").del();
      const single = await db("o_artStyle").insert({ name: "a" });
      expect(single[0]).toBe(1);
      const multi = await db("o_artStyle").insert([{ name: "b" }, { name: "c" }]);
      expect(multi[multi.length - 1]).toBe(2);     // mysql：首行 insertId = 2（sqlite 会是 3）
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("knex_migrations / knex_migrations_lock 存在（Phase 1b 的 policies.ts 必须声明它们）", async () => {
    const db = createKnex();
    try {
      await runMigrations(db);
      expect(await db.schema.hasTable("knex_migrations")).toBe(true);
      expect(await db.schema.hasTable("knex_migrations_lock")).toBe(true);
    } finally {
      await db.destroy();
    }
  }, 120000);
});
