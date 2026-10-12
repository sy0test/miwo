/**
 * **静态** MySQL DDL 断言 —— 本机没有 MySQL 服务端，用它兜住"编译出来的 DDL 是不是 mysql 合法"。
 *
 * 这些断言不是 happy path 的装饰：它们精确覆盖 spec §5.3 里那些**只在 MySQL 才会炸**的点：
 *   - 26 张表主键必须 auto_increment（否则 `Field 'id' doesn't have a default value`）
 *   - 文本主键必须 varchar（TEXT 主键 → ERROR 1170）
 *   - 布尔默认值不能是裸 true/false
 *   - o_agentWorkData 的唯一键必须真的出现在 DDL 里
 *
 * 第一组（`dialect 的 mysql 分支`）是 **Task 3 开工第一件事**：Task 1 交付的 `types()` mysql 分支
 * 此前**没有任何断言**（sqlite 侧被 tests/db-driver.test.ts 覆盖，mysql 侧只测了连接对象，
 * 没测它编译出来的类型）。把它钉住之后才动 001_schema.ts —— 否则"27 张表的 DDL 正确"是踩在
 * 一份未被锁定的方言装配上。
 *
 * ⚠ 它**不能**替代"真连一次 MySQL"（Task 8 才做那个）。它能证明的是"SQL 串对"，不是"服务端接受"。
 */
import { describe, expect, it } from "vitest";
import knexFactory from "knex";
import { types } from "@/db/dialect";
import schema from "@/db/migrations/001_schema";

const mysql = knexFactory({ client: "mysql2", connection: { host: "127.0.0.1", user: "x", database: "miwo" } });

/** 用 mysql2 方言把一段 schema builder 回调编译成 SQL 串（不发起任何连接）。 */
function ddlOf(build: (t: any) => void): string {
  return mysql.schema.createTable("probe", (t) => build(t)).toSQL().map((s) => s.sql).join("\n");
}

async function ddlFor(table: string): Promise<string> {
  // 用一个只收 DDL 的假 knex：schema 构建器会把每条 createTable/alterTable 的 SQL 收集起来
  const stmts: string[] = [];
  const collector: any = {
    client: mysql.client,
    schema: {
      createTable: (name: string, cb: any) => {
        for (const s of mysql.schema.createTable(name, cb).toSQL()) stmts.push(s.sql);
        return Promise.resolve();
      },
      dropTableIfExists: () => Promise.resolve(),
    },
  };
  const real = schema as any;
  await real.up({
    ...collector,
    raw: () => Promise.resolve(),
  });
  const filtered = stmts.filter((s) => s.includes(`\`${table}\``));
  if (!filtered.length) throw new Error(`没有为 ${table} 生成 DDL（表名拼错？）`);
  return filtered.join("\n");
}

describe("dialect 的 mysql 分支（Task 1 遗留的未锁定代码）", () => {
  it("pk() 生成 bigint unsigned auto_increment 主键", () => {
    const ddl = ddlOf((t) => types(mysql).pk(t));
    expect(ddl).toContain("`id` bigint unsigned not null auto_increment primary key");
  });

  it("u64() 生成 bigint unsigned（userId 这类列）", () => {
    const ddl = ddlOf((t) => { types(mysql).u64(t, "userId"); });
    expect(ddl).toContain("`userId` bigint unsigned");
  });

  it("u32() 生成 int（现状的 projectId/scriptId 语义不变）", () => {
    const ddl = ddlOf((t) => { types(mysql).u32(t, "projectId"); });
    expect(ddl).toContain("`projectId` int");
  });

  it("text() 生成 longtext（TEXT 的 64 KB 会被 o_prompt.data 顶穿）", () => {
    const ddl = ddlOf((t) => { types(mysql).text(t, "data"); });
    expect(ddl).toContain("`data` longtext");
  });

  it("vstr() 生成 varchar(191)（可作主键/索引）", () => {
    const ddl = ddlOf((t) => { types(mysql).vstr(t, "key"); });
    expect(ddl).toContain("`key` varchar(191)");
  });

  it("boolCol() 生成 tinyint（不是 boolean/裸 true）", () => {
    const ddl = ddlOf((t) => { types(mysql).boolCol(t, "disabled").defaultTo(0); });
    expect(ddl).toContain("`disabled` tinyint default '0'");
  });

  it("floatCol() 生成 float", () => {
    const ddl = ddlOf((t) => { types(mysql).floatCol(t, "duration"); });
    expect(ddl).toContain("`duration` float");
  });
});

describe("MySQL DDL 静态断言（spec §5.3）", () => {
  it("o_project 主键是 bigint unsigned auto_increment", async () => {
    const ddl = await ddlFor("o_project");
    expect(ddl).toMatch(/`id` bigint unsigned not null auto_increment/);
  });

  it("26 张表里凡是有自增主键的表都用 bigint unsigned（抽查 5 张）", async () => {
    for (const table of ["o_segment", "o_shot", "o_imageFlow", "o_video", "o_assets"]) {
      const ddl = await ddlFor(table);
      expect(ddl, table).toMatch(/`id` bigint unsigned not null auto_increment/);
    }
  });

  it("文本主键都是 varchar，绝不是 text（TEXT 主键 → ERROR 1170）", async () => {
    for (const [table, col] of [["o_setting", "key"], ["memories", "id"], ["o_vendorConfig", "id"]] as const) {
      const ddl = await ddlFor(table);
      const line = ddl.split("\n").find((l) => l.includes(`\`${col}\``))!;
      expect(line, `${table}.${col}`).toMatch(/varchar\(191\)/);
      expect(line, `${table}.${col} 不得是 text`).not.toMatch(/\btext\b/);
    }
  });

  it("memories.isolationKey 是 varchar（TEXT 不能建索引）", async () => {
    const ddl = await ddlFor("memories");
    const line = ddl.split("\n").find((l) => l.includes("`isolationKey`"))!;
    expect(line).toMatch(/varchar\(191\)/);
  });

  it("o_agentWorkData 的唯一键出现在 DDL 里", async () => {
    const ddl = await ddlFor("o_agentWorkData");
    expect(ddl).toMatch(/unique `o_agentworkdata_pid_epid_key_unique`\(`projectId`, `episodesId`, `key`\)/);
  });

  it("o_setting.key 的主键出现在 DDL 里", async () => {
    const ddl = await ddlFor("o_setting");
    expect(ddl).toMatch(/primary key \(`key`\)/);
  });

  it("disabled 列的默认值是 0，不是 false/true", async () => {
    const ddl = await ddlFor("o_agentDeploy");
    expect(ddl).toMatch(/`disabled` tinyint default '0'/);
  });

  it("o_user 的主键**不带** auto_increment（Phase 1c 才重建 id，spec §7.1 / 已知偏差 3）", async () => {
    const ddl = await ddlFor("o_user");
    const line = ddl.split("\n")[0];
    expect(line).toContain("`id` bigint unsigned");
    expect(line).not.toContain("auto_increment");
  });

  it("4 张复合主键关联表的 DDL 里有 primary key (...)，且都不是自增", async () => {
    for (const table of ["o_assets2Storyboard", "o_shotAssets", "o_scriptAssets", "o_assetsRole2Audio"]) {
      const ddl = await ddlFor(table);
      expect(ddl, table).toMatch(/primary key \(`/);
      expect(ddl, table).not.toContain("auto_increment");
    }
  });

  it("20 张带 userId 的表：列在，且有一条以 userId 起头的索引（§6.2 + §5.3 索引）", async () => {
    // 现状库只有 o_project.userId；本迁移为其余 19 张表新增 userId（**回填归 Phase 1b**）。
    // ⚠ brief 正文里的"18 张"与它自己的表清单差一：按表清单逐行数是 19 张新增 + o_project 已有 = 20 张。
    const tables = [
      "o_project", "o_tasks", "o_novel", "o_event", "o_eventChapter", "o_script", "o_assets", "o_image",
      "o_storyboard", "o_agentWorkData", "o_video", "o_videoTrack", "o_segment", "o_shot", "o_shotAssets",
      "o_assets2Storyboard", "o_scriptAssets", "o_assetsRole2Audio", "o_imageFlow", "memories",
    ];
    expect(tables.length).toBe(20);
    for (const table of tables) {
      const ddl = await ddlFor(table);
      expect(ddl, `${table} 缺 userId 列`).toContain("`userId`");
      expect(ddl, `${table} 的 userId 索引`).toMatch(/add (index|unique) `[^`]+`\(`userId`/);
    }
    // 抽查两张"现状完全没有归属列"的表，确认索引名就是迁移里写的那个
    expect(await ddlFor("o_event")).toContain("add index `o_event_userid_index`(`userId`)");
    expect(await ddlFor("o_shotAssets")).toContain("add index `o_shotassets_userid_shotid_index`(`userId`, `shotId`)");
  });

  it("o_skillList / o_skillAttribution 不被创建，但要被 dropTableIfExists（幂等清理老库）", async () => {
    const all: string[] = [];
    const stmts: string[] = [];
    const collector: any = {
      client: mysql.client,
      schema: {
        createTable: (name: string, cb: any) => { for (const s of mysql.schema.createTable(name, cb).toSQL()) stmts.push(s.sql); return Promise.resolve(); },
        dropTableIfExists: (name: string) => { stmts.push(`drop table if exists \`${name}\``); return Promise.resolve(); },
      },
      raw: () => Promise.resolve(),
    };
    await (schema as any).up(collector);
    all.push(...stmts);
    const joined = all.join("\n");
    expect(joined).not.toMatch(/create table `o_skillList`/);
    expect(joined).not.toMatch(/create table `o_skillAttribution`/);
    expect(joined).toMatch(/drop table if exists `o_skillAttribution`/);
    expect(joined).toMatch(/drop table if exists `o_skillList`/);
    // 顺序：先删从表（带 FK 引用），再删主表
    expect(joined.indexOf("drop table if exists `o_skillAttribution`")).toBeLessThan(joined.indexOf("drop table if exists `o_skillList`"));
  });

  it("迁移建出的表恰好 27 张（不多不少）", async () => {
    const created: string[] = [];
    const collector: any = {
      client: mysql.client,
      schema: {
        createTable: (name: string, cb: any) => { created.push(name); void cb; return Promise.resolve(); },
        dropTableIfExists: () => Promise.resolve(),
      },
      raw: () => Promise.resolve(),
    };
    await (schema as any).up(collector);
    expect(created.length).toBe(27);
    expect(new Set(created).size).toBe(27);
  });
});

void mysql.destroy();
