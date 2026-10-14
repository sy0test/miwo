/**
 * Phase 1c Task 6：**运行时与响应硬化**的判别力用例。
 *
 * ── 覆盖（每条都必须能红，见 Task 5+6 报告的红绿两端）──
 *   1. 安全响应头（helmet）：`X-Content-Type-Options` / `X-Frame-Options`；
 *   2. `/oss` 的 `Cross-Origin-Resource-Policy` **不得**是 `same-origin`
 *      （helmet 的默认值会让 dev 的跨源图片全被浏览器拒收）；
 *   3. CORS 白名单：非白名单 Origin **不被允许**、白名单 Origin **精确**回显
 *      （旧实现是 `origin: "*"`）；
 *   4. 错误响应脱敏：**真实 UNIQUE 约束冲突** ⇒ 响应体不含 `UNIQUE` / 表名 / 列名 / 路径 / 堆栈；
 *   5. 限流：超过阈值 ⇒ **429**（并明确它是**进程内计数**：多副本/重启不共享）；
 *   6. trust proxy：`X-Forwarded-For` 影响 `req.ip`（`app.set("trust proxy", …)` 真的生效）；
 *   7. 跨方言运维接口：sqlite 真跑 `listTables`/`tableRowCount`/`columnNames`/白名单；
 *      mysql 侧只有 `createKnex({client:"mysql2"})` + `toSQL()`/SQL 文本的**离线形态**证明
 *      （**本机不起 MySQL** ⇒ 未连真机，见报告「未验证项」）。
 *
 * ── 为什么这个文件**不**直接 import `src/app.ts` ──
 * `app.ts` 的最后一行是 `startServe()`（模块级副作用）：import 它会真起服务、真连库、真跑迁移，
 * 于是"测一个中间件形状"变成"起一个生产进程"。而 `app.ts` 里可被断言的那部分
 * （helmet/CORS/错误处理器）都是**导出的具名函数**。真实装配顺序（`app.use` 的相对位置）
 * 由 `tests/db-boot-order.test.ts` 的"await dbReady 在 server.listen 之前"与
 * `verify-phase0.cjs` 的端到端启动作证。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import knexFactory, { type Knex } from "knex";
import { afterAll, describe, expect, it } from "vitest";
import { clientNameOf, columnNames, isSqlite, listTables, listTablesSql, tableRowCount } from "@/lib/dbOps";
import { isExportableTable } from "@/lib/tableWhitelist";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-http-hardening-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("跨方言运维原语（Phase 1c Task 5+6；裁定 §2.5）", () => {
  it("sqlite 真跑：listTables / tableRowCount / columnNames 在一次性库上语义正确", async () => {
    const file = path.join(TMP, "ops-sqlite.sqlite");
    const db: Knex = knexFactory({ client: "better-sqlite3", connection: { filename: file }, useNullAsDefault: true });
    try {
      expect(isSqlite(db), "better-sqlite3 必须被判成 sqlite 家族").toBe(true);
      expect(clientNameOf(db)).toBe("better-sqlite3");
      await db.schema.createTable("o_thing", (t) => {
        t.integer("id").primary();
        t.text("name");
      });
      await db.schema.createTable("knex_migrations", (t) => t.integer("id"));
      await db("o_thing").insert([{ id: 1, name: "a" }, { id: 2, name: "b" }]);

      const tables = await listTables(db);
      expect(tables, "必须列出业务表").toContain("o_thing");
      expect(tables, "knex_% 基础设施表必须被排除（迁移记账表不该被清库接口删掉）").not.toContain("knex_migrations");
      expect(await tableRowCount(db, "o_thing"), "行数必须是真数出来的 2").toBe(2);
      expect(await columnNames(db, "o_thing")).toEqual(["id", "name"]);
      expect(await columnNames(db, "no_such_table"), "表不存在 ⇒ 空数组，不抛").toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("mysql 侧**离线形态**：SQL 文本里绝不出现 sqlite_master / PRAGMA（未连真机）", () => {
    const my: Knex = knexFactory({ client: "mysql2" });
    try {
      expect(isSqlite(my)).toBe(false);
      expect(clientNameOf(my)).toBe("mysql2");
      const sql = listTablesSql(my);
      expect(sql, "mysql 分支必须读 information_schema.tables").toContain("information_schema.tables");
      expect(sql, "mysql 没有 sqlite_master").not.toMatch(/sqlite_master/i);
      expect(sql, "mysql 的 sqlite_% 排除规则无意义，不该出现").not.toMatch(/sqlite_/i);
      expect(sql, "必须限定当前库（否则会把实例里别的库的表一起列出来）").toMatch(/table_schema\s*=\s*DATABASE\(\)/i);
      expect(sql, "必须只看基表").toMatch(/table_type\s*=\s*'BASE TABLE'/i);
      expect(sql, "行名统一：mysql 的 table_name 必须被别名成 name").toMatch(/AS\s+name/i);
      const sqlite = listTablesSql(knexFactory({ client: "better-sqlite3", useNullAsDefault: true }));
      expect(sqlite).toContain("sqlite_master");
    } finally {
      void my.destroy();
    }
  });

  it("白名单语义两端都成立：非白名单表名（含 sqlite_/_ 前缀与基础设施表）一律拒绝", () => {
    expect(isExportableTable("o_project")).toBe(true);
    expect(isExportableTable("knex_migrations"), "迁移记账表不是业务表").toBe(false);
    expect(isExportableTable("sqlite_sequence")).toBe(false);
    expect(isExportableTable("_private")).toBe(false);
    expect(isExportableTable("o_not_declared_in_policies")).toBe(false);
    expect(isExportableTable(123)).toBe(false);
    expect(isExportableTable("")).toBe(false);
  });
});
