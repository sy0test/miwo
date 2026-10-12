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
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import knexFactory from "knex";
import { types } from "@/db/dialect";
import schema from "@/db/migrations/001_schema";

const mysql = knexFactory({ client: "mysql2", connection: { host: "127.0.0.1", user: "x", database: "miwo" } });

/** 老库逐列实测值域（`scripts/gen-legacy-column-stats.cjs` 只读记录；老库本身不入库）。 */
const LEGACY_STATS = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "fixtures", "legacy-column-stats.json"), "utf8")
) as { stats: Record<string, Record<string, { max: number | null }>> };

/** MySQL 有符号 `int` 的上界（毫秒值一定超它）。 */
const MYSQL_INT_MAX = 2147483647;

/**
 * **机械清单**（修复轮 2）：迁移真正建出来的表里，哪些列的**老库实测最大值**超过 mysql `int` 上界。
 *
 * 为什么必须机械：修复轮 1 用的是手写的 10 列外键清单 → `o_segment.projectId` / `o_shot.projectId`
 * 不在清单里就永远不被检查（真 MySQL 上这两张表 191 行全写不进去，非严格模式还会静默夹断）。
 * 现在清单从"老库实测值域"推出来，加表/加外键列时不需要人工维护。
 */
async function columnsWiderThanInt(): Promise<Array<[string, string]>> {
  const created = new Set<string>();
  const collector: any = {
    client: mysql.client,
    schema: {
      createTable: (name: string) => { created.add(name); return Promise.resolve(); },
      dropTableIfExists: () => Promise.resolve(),
    },
    raw: () => Promise.resolve(),
  };
  await (schema as any).up(collector);
  const out: Array<[string, string]> = [];
  for (const [table, cols] of Object.entries(LEGACY_STATS.stats)) {
    if (!created.has(table)) continue; // 退役表（o_skillList / o_skillAttribution）不在迁移里
    for (const [col, s] of Object.entries(cols)) {
      if (s.max !== null && s.max > MYSQL_INT_MAX) out.push([table, col]);
    }
  }
  return out.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
}

/**
 * 从一段 `create table ...` / `alter table ...` 文本里抠出**某个列的完整类型定义**（不含列名，
 * 也不含 `not null` / `default` 这些后缀）。
 * ⚠ **不要**用 `toContain("\`createTime\` bigint unsigned")` 当唯一的判别手段：`int` 是
 * `bigint unsigned` 的**子串**，而 `toContain("\`createTime\` int")` 又会被 `bigint` 里的 `int` 命中 ——
 * 用 `toContain` 判"不是 int"是假的。抠出类型段后整段比对才是真判别。
 */
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

  it("ms() 生成 bigint unsigned（毫秒时间戳列；int 装不下 Date.now()）", () => {
    const ddl = ddlOf((t) => { types(mysql).ms(t, "createTime"); });
    expect(ddl).toContain("`createTime` bigint unsigned");
    // ⚠ 判别力所在：`int` **是** `bigint unsigned` 的子串，所以必须把类型段抠出来整段比对，
    //    否则"改成 int"这个回归会被这条断言放过（修复轮 1 的红绿实验就依赖它变红）。
    expect(colType(ddl, "createTime")).toBe("bigint unsigned");
    expect(colType(ddl, "createTime")).not.toMatch(/^int/);
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
  it("o_project 主键是 bigint unsigned、且**不带自增**（值由代码给 Date.now()，见下一组用例）", async () => {
    const ddl = await ddlFor("o_project");
    expect(ddl).toMatch(/`id` bigint unsigned/);
    expect(ddl).toMatch(/primary key \(`id`\)/);
    // ⚠ 修复轮 1 前这里断言的是 `auto_increment`（t.pk(T)）。改成"不自增"是因为
    //   `routes/project/addProject.ts:29` 一直显式给 `id: Date.now()`（实测值 1791385147125）——
    //   带着 auto_increment 也**不会报错**（MySQL 允许显式给值），但会把这个事实藏起来，
    //   于是下一个人很容易顺手把 id 列改回 `int`（那才是真的炸）。显式断言"不自增"把语义钉死。
    expect(ddl.split("\n")[0]).not.toContain("auto_increment");
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

  it("毫秒时间戳列全部编译成 bigint unsigned（12 张表 / 15 列，逐列抠类型段）", async () => {
    // ⚠ 为什么这组断言必须是"逐列 + 整段类型"而不是 `toContain`：
    //   `int` 是 `bigint unsigned` 的子串 → `toContain("`createTime` int")` 会被 `bigint` 命中，
    //   于是"被改回 int"这个**真回归**不会被发现。`colType()` 抠出类型段后整段比才判得动。
    // 实据：现状库/种子里这些列存的是 `Date.now()` 毫秒值（种子 1774447310118，dev 库最大 1791741159298），
    //       MySQL `int`（有符号上限 2147483647）直接装不下 —— 属"只在真 MySQL 才暴露"。
    const MS_COLUMNS: Array<[string, string]> = [
      ["o_project", "createTime"],
      ["o_tasks", "startTime"],
      ["o_novel", "createTime"],
      ["o_event", "createTime"],
      ["o_script", "createTime"],
      ["o_assets", "startTime"],
      ["o_storyboard", "createTime"],
      ["o_agentWorkData", "createTime"],
      ["o_agentWorkData", "updateTime"],
      ["o_video", "time"],
      ["o_segment", "createTime"],
      ["o_segment", "updateTime"],
      ["o_shot", "createTime"],
      ["o_shot", "updateTime"],
      ["memories", "createTime"],
    ];
    expect(MS_COLUMNS.length).toBe(15);
    expect(new Set(MS_COLUMNS.map(([t]) => t)).size).toBe(12);
    const seen = new Set<string>();
    for (const [table, col] of MS_COLUMNS) {
      const ddl = await ddlFor(table);
      const type = colType(ddl, col);
      expect(type, `${table}.${col} 必须是 bigint unsigned`).toBe("bigint unsigned");
      expect(type, `${table}.${col} 不得退化成 int`).not.toMatch(/^int/);
      expect(ddl, `${table}.${col}`).toContain("`" + col + "` bigint unsigned");
      seen.add(table + "." + col);
    }
    expect(seen.size).toBe(15);
    // 反向判别力：口径是"这 15 列"，别再出现 `T.integer` 的同名列（例如两张表同名 createTime 只改了一张）
    for (const table of new Set(MS_COLUMNS.map(([t]) => t))) {
      const ddl = await ddlFor(table);
      expect(ddl, `${table} 里不得再有 int 型的 createTime/updateTime/time`).not.toMatch(/`(createTime|updateTime|time)` int\b/);
    }
  });

  it("o_modelPrompt.fileName / path 编译成 text（长路径不得被 varchar(255) 截断）", async () => {
    const ddl = await ddlFor("o_modelPrompt");
    // 现状库这两列是 TEXT（initDB.ts:411-412 用 table.text 建表；PRAGMA 实测 TEXT）。
    // 收窄成 varchar(255) → MySQL 严格模式下超长路径 `Data too long for column`。
    expect(colType(ddl, "fileName")).toBe("longtext");
    expect(colType(ddl, "path")).toBe("longtext");
    // ⚠ 判别力所在：不能用 `not.toMatch(/varchar/)` 当主判别 —— DDL 同一行里 vendorId/model
    //    本来就是 varchar(255)，那会**假红**；必须按列抠。
    expect(colType(ddl, "fileName"), "fileName 不得是 varchar").not.toMatch(/^varchar/);
    expect(colType(ddl, "path"), "path 不得是 varchar").not.toMatch(/^varchar/);
    expect(ddl).toContain("`fileName` longtext");
    expect(ddl).toContain("`path` longtext");
  });

  it("id / 外键列也是 Date.now()：o_project.id + o_videoTrack.id + **机械扫出的全部超 int 列** → bigint unsigned", async () => {
    // 同一根因的第二组：`o_project.id` 与 `o_videoTrack.id` **由代码用 `Date.now()` 显式给**
    //   （routes/project/addProject.ts:29 `id: Date.now()`；utils/redraw.ts:711 `trackId = Date.now() + seq++`），
    //   所以它们**不是**"自增小整数"，而是毫秒值（实测 dev 库 `o_project.id` = 1791385147125 > int 上限）。
    //   装它们的 projectId / trackId / videoTrackId 列因此必须一起 64 位，否则全库外键全部写不进去。
    // ⚠ `o_project.id` **不带 auto_increment**：值由代码给；带自增也不会错，但会掩盖"代码显式给 id"这件事，
    //   所以这里显式断言它没有 —— 与 `o_user.id` 的处理同源（Phase 1c 才重建）。
    const project = await ddlFor("o_project");
    expect(colType(project, "id")).toBe("bigint unsigned");
    expect(project.split("\n")[0]).toContain("primary key");
    expect(project.split("\n")[0], "o_project.id 不该由 DDL 自增（值由代码给）").not.toContain("auto_increment");

    const track = await ddlFor("o_videoTrack");
    expect(colType(track, "id")).toBe("bigint unsigned");
    expect(track).toContain("`id` bigint unsigned not null auto_increment");

    // ⚠⚠ 修复轮 2：这里原来是**手写的 10 列外键清单**，而 `o_segment.projectId` / `o_shot.projectId`
    //   不在清单里 → 漏了一整批（每张表 191 行都写不进真 MySQL）。手写清单是根因，所以换成**机械扫描**：
    //   列清单从"老库实测值域"里筛（`tests/fixtures/legacy-column-stats.json`，由
    //   `scripts/gen-legacy-column-stats.cjs` 只读记录），条件是"实测最大值 > mysql int 上界 2147483647"，
    //   再与迁移真正建出来的表取交集。加新表/新外键列时**不需要**再维护这张清单。
    //   同一套判据的完整版（含 varchar 超长、活库真实行复核）在 `tests/migration-column-fit.test.ts`。
    const mechanicallyDerived = await columnsWiderThanInt();
    // 27 列（老库实测）− `o_skillList` 的 2 列（退役表，不建）= 25 列
    expect(mechanicallyDerived.length, "机械清单长度变了：fixture 或 DDL 解析失效了？").toBe(25);
    for (const [table, col] of mechanicallyDerived) {
      const ddl = await ddlFor(table);
      const type = colType(ddl, col);
      expect(type, `${table}.${col} 必须 bigint unsigned`).toBe("bigint unsigned");
      expect(type, `${table}.${col} 不得退化成 int`).not.toMatch(/^int/);
      expect(ddl, `${table}.${col}`).toContain("`" + col + "` bigint unsigned");
    }
    // 反向：机械清单里的列名在**任何**表里都不得再是 `int`（同名整数列宽度必须一致）。
    // ⚠ 只对"该表这一列确实是整数族"的表判 —— `id` 这个名字在 `memories` 里是 varchar(191) 主键
    //   （TEXT 主键 → ERROR 1170 的既有限制），拿它比 bigint 是**假红**。
    const derivedNames = [...new Set(mechanicallyDerived.map(([, c]) => c))];
    for (const table of new Set(mechanicallyDerived.map(([t]) => t))) {
      const ddl = await ddlFor(table);
      for (const col of derivedNames) {
        if (!ddl.includes("`" + col + "`")) continue;
        const type = colType(ddl, col);
        if (!/^(tinyint|smallint|mediumint|int|integer|bigint)\b/.test(type)) continue;
        expect(type, `${table}.${col} 不得是 int`).toBe("bigint unsigned");
      }
    }
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
