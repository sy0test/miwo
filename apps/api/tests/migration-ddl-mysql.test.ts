/**
 * **静态** MySQL DDL 断言 —— 本机没有 MySQL 服务端，用它兜住"编译出来的 DDL 是不是 mysql 合法"。
 *
 * 这些断言不是 happy path 的装饰：它们精确覆盖 spec §5.3 里那些**只在 MySQL 才会炸**的点：
 *   - 表主键必须 auto_increment（否则 `Field 'id' doesn't have a default value`）
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
 *
 * ⚠⚠ **【Phase 1c Task 1】扫描范围从 `001_schema` 扩到"全部迁移"**：
 *   `005_accounts` / `006_quota_grants` 建的表与重建的 `o_user` 同样是"只在 MySQL 才暴露"的面
 *   （自增 bigint unsigned 主键、varchar 唯一键、复合主键、两个索引），只扫 001 等于对它们**盲**。
 *   于是下面的 `SCHEMA_ONLY` / `ALL_MIGRATIONS` 分成两条路径：
 *     · 形状/计数类断言（列属性主键 21 / 表级 11 / 复合 6 / 建表 33 张）走 `ALL_MIGRATIONS`；
 *     · "001 的 schema 本身没变"这类断言走 `SCHEMA_ONLY`（它们钉的是 1a 的产物）。
 *   假-knex 也要相应补齐 `dropTable` / `renameTable` / 查询构造器 —— 否则 005 的
 *   "建暂存表 → 迁数据 → 删旧表 → 改名"路径在收集阶段就抛错（`knex(...).insert is not a function`）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import knexFactory from "knex";
import { types } from "@/db/dialect";
import schema from "@/db/migrations/001_schema";
import accounts from "@/db/migrations/005_accounts";
import quotaGrants from "@/db/migrations/006_quota_grants";
import jobQueue from "@/db/migrations/007_job_queue";
import vendorGate from "@/db/migrations/008_vendor_gate";
import billing from "@/db/migrations/009_billing";
import quotaAdmission from "@/db/migrations/010_daily_quota_admission";
import usageAdmission from "@/db/migrations/011_usage_admission";
import accessGroups from "@/db/migrations/014_access_groups";

/**
 * `scripts/schema-limits.cjs` 是 **CJS**，这里用 `createRequire` 同步 require。
 * ⚠ 不能用 `import ... from "@/..."` 或相对 ESM import：那是 `.cjs`，
 *    而且它在 vitest 的模块图里必须与导出脚本运行时拿到的是**同一份实现**。
 * ⚠ 基准取 `process.cwd()`：vitest 会把测试文件打包到临时目录，
 *    `import.meta.url` 与 `__dirname` 都不再是指向 `apps/api` 的那一个；
 *    而本套件的运行前提本来就是"在 apps/api 下跑"（见 vitest.config.ts 的 `@` 别名同理）。
 */
const nodeRequire = createRequire(process.cwd() + "/vitest-probe.js");
const { deriveTargetLimits, MAX_LENGTH } = nodeRequire("./scripts/schema-limits.cjs") as {
  deriveTargetLimits: (o: {
    knexFactory: unknown;
    migrationPath?: string;
    schema?: { up: (k: unknown) => Promise<void> };
  }) => Promise<Record<string, number | symbol>>;
  MAX_LENGTH: symbol;
};

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

/** 一条被假-knex 收集到的语句（`kind` 用来区分 create / alter / drop / rename / raw）。 */
interface Collected {
  kind: "create" | "alter" | "drop" | "rename" | "raw";
  sql: string;
}

/**
 * 假 knex：把**迁移真正调用到的每一种**语句收集成 SQL 串，**不连任何服务端**。
 *
 * ⚠ 覆盖面必须跟着迁移走：`005_accounts` 的 up 用了 `dropTable` + `renameTable` +
 *   `knex("o_setting").insert(...).onConflict("key").ignore()`，down 还用了 `dropTableIfExists`。
 *   只补 `createTable` 的旧假-knex 会在这条路径上抛 `TypeError`（实测踩到）——
 *   于是"005/006 的 DDL 合法性"根本没有被检查，而文件看上去还有断言。
 */
function makeFakeKnex(stmts: Collected[]): any {
  const push = (kind: Collected["kind"], sql: string): void => {
    stmts.push({ kind, sql });
  };
  const schema = {
    createTable: (name: string, cb: any) => {
      for (const s of mysql.schema.createTable(name, cb).toSQL()) push("create", s.sql);
      return Promise.resolve();
    },
    alterTable: (name: string, cb: any) => {
      for (const s of mysql.schema.alterTable(name, cb).toSQL()) push("alter", s.sql);
      return Promise.resolve();
    },
    dropTableIfExists: (name: string) => {
      push("drop", `drop table if exists \`${name}\``);
      return Promise.resolve();
    },
    dropTable: (name: string) => {
      push("drop", `drop table \`${name}\``);
      return Promise.resolve();
    },
    renameTable: (from: string, to: string) => {
      push("rename", `rename table \`${from}\` to \`${to}\``);
      return Promise.resolve();
    },
    // ⚠ Phase 1d Task 1 起需要：`007_job_queue` / `008_vendor_gate` 的 up 用 `hasTable` 守卫幂等
    //   （Ruling 31：必须 await）。假 knex 返回 false ⇒ 走建表分支，正是本文件要收集的 DDL。
    hasTable: (name: string) => {
      void name;
      return Promise.resolve(false);
    },
  };
  /**
   * `knex("t")` 的查询构造器替身：迁移里对表的读写（`select` / `insert` / `delete` / `orderBy` /
   * `first`）在这里**只编译不执行** —— 本文件只关心 DDL 串，不关心数据走到了哪里。
   */
  const qb = (table: string): any => {
    void table;
    const b: any = {};
    b.select = () => b;
    b.where = () => b;
    b.whereNull = () => b;
    b.whereNotNull = () => b;
    b.whereIn = () => b;
    b.orderBy = () => b;
    b.insert = () => b;
    b.onConflict = () => b;
    b.update = () => b;
    // 终结操作：返回 thenable（await 之后是空结果）
    b.first = () => Promise.resolve(undefined);
    b.delete = () => Promise.resolve(0);
    b.ignore = () => Promise.resolve(undefined);
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
    return b;
  };
  return Object.assign(qb, {
    client: mysql.client,
    schema,
    raw: (sql: unknown) => {
      push("raw", String(sql));
      return Promise.resolve([]);
    },
  });
}

/** 只跑 `001_schema`（1a 的产物：形状断言与"001 没变"的断言走这条）。 */
async function schemaDdl(): Promise<Collected[]> {
  const stmts: Collected[] = [];
  await (schema as any).up(makeFakeKnex(stmts));
  return stmts;
}

/**
 * 跑**全部**迁移（`001` → `008`）：新建表的 DDL 合法性走这条。
 * ⚠ `005` 会 `drop table o_user` + `rename table o_user_new to o_user`，所以调用方对 `o_user`
 *   要看**最后一条**与它相关的语句（`lastDdlOf`）。
 * ⚠ Phase 1d Task 1：`007_job_queue` / `008_vendor_gate` 也在这里跑 —— 否则那两张表的 MySQL
 *   DDL 合法性（key 规格里的 text 列、毫秒列宽度…）**完全没有被检查**，而本文件的标题
 *   "迁移建出的表恰好 N 张"会变成一句对**子集**的陈述（陈旧断言）。
 */
async function allDdlCollected(): Promise<Collected[]> {
  const stmts: Collected[] = [];
  const fake = makeFakeKnex(stmts);
  await (schema as any).up(fake);
  await (accounts as any).up(fake);
  await (quotaGrants as any).up(fake);
  await (jobQueue as any).up(fake);
  await (vendorGate as any).up(fake);
  await (billing as any).up(fake);
  await (quotaAdmission as any).up(fake);
  await (usageAdmission as any).up(fake);
  await (accessGroups as any).up(fake);
  return stmts;
}

/**
 * 表名精确匹配的谓词（**不要**用 `sql.includes("`o_user`")` 这种子串判定：
 * `o_user_new` / `o_user_old` 是 `o_user` 的前缀扩展，子串判定会把暂存表的语句一并算进来）。
 */
function mentionsTable(sql: string, table: string): boolean {
  return new RegExp("`" + table + "`").test(sql);
}

/** 过滤掉暂存表（`o_user_new` / `o_user_old`）的**全部**语句（create 与 alter 都要排除）。 */
function deployedStatementsOf(stmts: string[]): string[] {
  const STAGING = new Set(["o_user_new", "o_user_old"]);
  return stmts.filter((s) => ![...STAGING].some((t) => mentionsTable(s, t)));
}

/**
 * 某张表的**全部**语句（create 本体 + 它的 alter 索引 + 重建路径），按执行顺序。
 * ⚠ 与 `createDdlFor` 同口径：把"被 rename 成它"的暂存表也带上 —— `o_user` 的两条
 *   `add unique (username)` / `(email)` 在 DDL 流里是挂在**暂存表名** `o_user_new` 上的。
 */
async function ddlFor(table: string): Promise<string> {
  const stmts = await allDdl();
  const names = await namesFor(table);
  const filtered = stmts.filter((s) => names.some((n) => mentionsTable(s, n)));
  if (!filtered.length) throw new Error(`没有为 ${table} 生成 DDL（表名拼错？）`);
  return filtered.join("\n");
}

/** 某张表的"在 DDL 流里可能出现的名字"：它自己 + 所有 `rename table X to <它>` 的 X（暂存表）。 */
async function namesFor(table: string): Promise<string[]> {
  const stmts = await allDdl();
  const staging = stmts
    .map((s) => new RegExp("^rename table `([^`]+)` to `" + table + "`$").exec(s))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
  return [table, ...staging];
}

async function createDdlFor(table: string): Promise<string> {
  const stmts = await allDdl();
  const names = await namesFor(table);
  const hits = stmts.filter((s) => names.some((n) => s.startsWith("create table `" + n + "` (")));
  if (!hits.length) throw new Error(`没有为 ${table} 生成 create table DDL（表名拼错？还是它被 renameTable 掉了？）`);
  return hits[hits.length - 1];
}

/** 最终落地结构的全部语句（排除暂存表 `*_new` / `*_old` 的 create 与 alter）。 */
async function deployedDdl(): Promise<string[]> {
  return deployedStatementsOf(await allDdl());
}

/** 最后一条与某张表相关的语句（`o_user` 在 005 里被 drop 后重命名，取它才看到**最终**形状）。 */
async function lastDdlOf(table: string): Promise<Collected | undefined> {
  const stmts = await allDdlCollected();
  const hits = stmts.filter((s) => s.kind !== "raw" && mentionsTable(s.sql, table));
  return hits[hits.length - 1];
}

/** **全部** DDL 语句（33 张 create table + 各表的 add index/unique + drop/rename），顺序即执行顺序。 */
async function allDdl(): Promise<string[]> {
  return (await allDdlCollected()).filter((s) => s.kind !== "raw").map((s) => s.sql);
}

/** MySQL 里**不给 key 前缀长度就不能进 key 规格**的类型（`text`/`blob` 家族）。 */
const KEY_UNSAFE_TYPE = /^(?:tiny|medium|long)?(?:text|blob)$/i;

interface KeyRef {
  table: string;
  index: string;
  col: string;
  /** `col`(N) 这种带 key 前缀长度的写法：MySQL 允许 text 这样建索引，不算违规。 */
  hasPrefix: boolean;
}

/**
 * 从编译出来的 DDL 里**机械**抽出所有 key 规格引用的列。
 *
 * 实现方式是**按深度 0 的逗号把 `create table` 的表体切成片段**，再逐段判别：每个片段
 * 要么是"表级约束"（`primary key (...)`），要么是"列定义"（`` `col` 类型 修饰... ``）。
 * 不用正则直接扫整段表体：`primary key` 在**列定义内部**也出现（形状 2），
 * 用正则回溯去区分这两种位置非常容易写出"把逗号一起吃掉再吐出一条假 ref"的坑
 * （修复轮 1 实测踩过一次）。括号内的逗号（`varchar(191)` 不会，但 `decimal(8,2)` 会）
 * 在括号深度里，不会被切开。
 *
 * ⚠ 覆盖面（修复轮 1 实测，**不是**估计值）——knex 3.3.0 实际产出的全部 3 种形状，
 *   缺任何一种都会让本文件的核心断言在**真 MySQL 上仍然报 1170** 的情况下假绿：
 *   1. **表级主键**：``,primary key (`id`)``（多列复合主键也是这个形状，
 *      例：`o_assets2Storyboard` 的 `primary key (`storyboardId`, `assetId`)`）。
 *   2. **列属性主键**：`` `id` bigint unsigned not null auto_increment primary key,``
 *      —— **没有括号**。`t.pk(T)`（`bigIncrements`）编译成这样；27 张 create 里 **18 张**是它。
 *      （合并审查修复 6：这里原来写"20 张是它（只有 3 张走表级主键、4 张走复合主键）"，
 *       与实现不符 —— 实测是 **18 张列属性 / 9 张表级**，其中表级里 4 张是复合主键。
 *       数字现在由本文件的「形状分布」断言机械复核，不再靠注释。）
 *      旧正则只认形状 1 → 实测 27 张 create 里 **只有 9 张**被抽到，
 *      `o_artStyle` / `o_agentDeploy` / `o_prompt` / `o_modelPrompt` **一条 key ref 都没有**。
 *   3. **alter 追加的索引**：``alter table `t` add index `n`(`c`)`` 与
 *      ``alter table `t` add unique `n`(`a`, `b`)`` —— 注意 `add unique` 后面**没有 `index` 这个词**。
 *      26 条 alter 里有 **2 条**是 `add unique`（`o_agentWorkData` 的
 *      `o_agentworkdata_pid_epid_key_unique`、`o_segment` 的 `o_segment_scriptid_segmentindex_unique`），
 *      旧正则要求 `add (?:unique )?index` → 这两条整体漏掉，于是 `o_agentWorkData` 的
 *      `projectId` / `episodesId` / `key` **三列一次都没被检查过**（`key` 恰好是 varchar(255)，
 *      所以当时是真绿；换成 text 就漏判）。
 *
 * 实测覆盖增量（修复轮 1，同一份 DDL，用**旧抽取函数**逐字跑出来的对照）：
 *   旧 = **44** 条 ref / 23 张表 / 4 张表无 ref；新 = **67** 条 ref / 27 张表 / 0 张无 ref（仅 001_schema）。
 *   ⚠【Phase 1c Task 1】纳入 005/006 后实测 **82** 条 ref（见下面 `allDdl` 的调用点）。
 *   44 也是覆盖护栏 `toBeGreaterThan(60)` 的取值依据 —— 下限卡在旧(44)与新(67/82)之间。
 */
function keyRefsOf(stmts: string[]): KeyRef[] {
  const out: KeyRef[] = [];
  const push = (table: string, index: string, raw: string): void => {
    const hasPrefix = /\(\s*\d+\s*\)\s*$/.test(raw);
    const col = raw.replace(/\(\s*\d+\s*\)\s*$/, "").trim().replace(/^`|`$/g, "");
    if (col) out.push({ table, index, col, hasPrefix });
  };
  for (const s of stmts) {
    const create = /^create table `([^`]+)` \(([\s\S]*)\)(?: default character set [a-z0-9_]+)?$/.exec(s);
    if (create) {
      const [, table, body] = create;
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === "," && depth === 0) {
          parts.push(body.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(body.slice(start));
      for (const raw of parts) {
        const part = raw.trim();
        // 形状 1：表级主键（含多列复合）
        if (/^primary key\b/i.test(part)) {
          for (const c of (part.match(/\(([^)]*)\)/)?.[1] ?? "").split(",")) push(table, "primary key", c);
          continue;
        }
        // 形状 2：列属性主键（**没有括号**，且整段就该是"列名 + 类型 + 修饰"）
        const col = /^`([^`]+)`\s+([\s\S]+)$/.exec(part);
        if (col && /(?:^|\s)primary key(?:\s|$)/i.test(col[2])) push(table, "primary key (列属性)", col[1]);
      }
      continue;
    }
    // 形状 3：alter 追加索引 / 唯一键（`add unique` 不带 `index` 一词）
    const alter = /^alter table `([^`]+)` add (?:unique )?(?:index )?`([^`]+)`\(([^)]*)\)$/.exec(s);
    if (alter) for (const c of alter[3].split(",")) push(alter[1], alter[2], c);
  }
  return out;
}

function countKeyRefs(stmts: string[]): number {
  return keyRefsOf(stmts).length;
}

/**
 * 机械判据：返回"被 key 规格引用、类型是 text/blob 家族、又没给 key 前缀长度"的列。
 * 空数组 = 全部合法；任何一条非空都会让真 MySQL 报 **ER_BLOB_KEY_WITHOUT_LENGTH (1170)**。
 */
function scanKeyedTextColumns(stmts: string[]): string[] {
  const ddlByTable = new Map<string, string>();
  for (const s of stmts) {
    const m = /^create table `([^`]+)`/.exec(s);
    if (m) ddlByTable.set(m[1], s);
  }
  const bad: string[] = [];
  for (const ref of keyRefsOf(stmts)) {
    if (ref.hasPrefix) continue; // `col`(N) 是合法的 text 索引写法
    const ddl = ddlByTable.get(ref.table);
    if (!ddl) {
      bad.push(`${ref.table}.${ref.col}: 找不到对应的 create table`);
      continue;
    }
    let ty: string;
    try {
      ty = colType(ddl, ref.col);
    } catch {
      bad.push(`${ref.table}.${ref.col}: DDL 里找不到该列`);
      continue;
    }
    if (KEY_UNSAFE_TYPE.test(ty)) bad.push(`${ref.table}.${ref.col} 是 ${ty}，却出现在 ${ref.index} 里`);
  }
  return bad.sort();
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

  it("decimal() 生成 fixed-scale decimal", () => {
    const ddl = ddlOf((t) => { types(mysql).decimal(t, "duration", 18, 6); });
    expect(ddl).toContain("`duration` decimal(18, 6)");
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

  it("任何被索引/主键引用的列都不得是 text/longtext（真 MySQL 会 ER_BLOB_KEY_WITHOUT_LENGTH 1170）", async () => {
    // ⚠ 这条断言的来历（Task 7 首次真连 MySQL 时抓到）：`memories.type` 是 `t.text()`
    //    （mysql 侧编译成 `longtext`），而它出现在复合索引 `memories_isolationkey_type_index` 里 ——
    //    服务端直接拒绝：`alter table memories add index ... - BLOB/TEXT column 'type' used in
    //    key specification without a key length`（errno 1170），**整个 001_schema 迁移失败**。
    //    上面的「memories.isolationKey 是 varchar」只钉住了**那一个列名**：同一个反例（同一条规则、
    //    同一个索引、相邻的那一列）完全逃逸。手写清单必然漏，所以这里改成**机械扫描**：
    //    从编译出来的全部 DDL 里抽出每一条 key 规格的列，再逐列抠类型 —— 加新索引时不需要维护任何清单。
    //    ⚠ 修复轮 1：`keyRefsOf` 的抽取面当时**窄于它声称的范围**（只认表级 `primary key (` 与
    //    `add (unique )?index`）→ 实测漏掉 **18** 张表的列属性主键与 2 条 `add unique`
    //    （`o_agentWorkData` 的 `key` 列一次都没被检查过）。形状清单见 `keyRefsOf` 的注释。
    //    （合并审查修复 6：原来这里写"20 张表的列属性主键"，与同一文件的形状分布断言不符。）
    //    ⚠ 为什么静态断言也值得有：1170 是**服务端**的语义校验，SQL 串本身完全合法，
    //    所以"没连过真 MySQL"时它是唯一能提前发现的手段（真连的断言在
    //    `tests/mysql-integration.test.ts`，门控 MIWO_TEST_MYSQL=1）。
    const stmts = await allDdl();
    const bad = scanKeyedTextColumns(stmts);
    // 覆盖护栏：正则失效时 bad=[] 与 keyRefs=[] 会同为空 → 假绿。
    // ⚠ 实测值（修复轮 1，仅 001_schema）：**67** 条 key ref / 27 张表全部至少 1 条。旧抽取面只有 44 条 / 23 张表。
    // ⚠【Phase 1c Task 1】把 005/006 也纳进来后，**最终落地结构**的 key ref 实测 **82** 条
    //   （33 张 create；DDL 流里另有暂存表 `o_user_new`，本扫描按"全部语句"跑，含它）。
    //   60 这条下限仍然卡在"旧抽取面（44）"与"新抽取面（82）"之间 —— 抽取面一旦退回旧形状，这里先红。
    expect(countKeyRefs(stmts)).toBeGreaterThan(60);
    expect(bad).toEqual([]);

    // ⚠ **形状分布的机械判据**（合并审查修复 6）：这段代码上方的注释原来写着"列属性主键 20 张 /
    //    表级 3 张 / 复合 4 张"，与实现不符（实测 **18 / 9，其中表级里 4 张是复合主键**）。
    //    注释里的数字要能被人复核才不会漂移，所以这里把它变成断言：`keyRefsOf` 一旦漏掉某种形状，
    //    这两个数字先红，而不是让读者去信一句注释。
    //
    // ⚠【Phase 1c Task 1】计数口径**必须排除暂存表**（`o_user_new` / `o_user_old`）：
    //   它们是"建了又 rename 掉"的中间表（迁移结束时并不存在，**不登记策略**），
    //   `tools/migration-tables.cjs` 的 `deployedTables` 同样排除它们。不排除的话
    //   `o_user_new` 会同时进"列属性主键"与"建表"两个计数（实测 22 / 34 而不是 21 / 33）——
    //   数字本身没错，但它描述的是"迁移过程中出现过的表"，与策略表/落库结构的口径不是一回事。
    //   `o_user_old` 只在 `down` 里建，`up` 路径上看不到（`up` 的暂存表就是 `o_user_new`）。
    const STAGING = new Set(["o_user_new", "o_user_old"]);
    // ⚠ 暂存表的**全部**语句（create 与 alter）都要排除：`o_user_new` 的两条 `add unique`
    //   里表名含子串 `o_user`，只按"建表语句"过滤会让它从 **alter** 那条缝里漏回来（实测踩到）。
    const deployedStmts = await deployedDdl();
    const refs = keyRefsOf(deployedStmts);
    expect([...refs].some((r) => STAGING.has(r.table)), "暂存表不得出现在最终结构里").toBe(false);
    const colAttrTables = new Set(refs.filter((r) => r.index === "primary key (列属性)").map((r) => r.table));
    const tableLevelCols = new Map<string, number>();
    for (const r of refs) if (r.index === "primary key") tableLevelCols.set(r.table, (tableLevelCols.get(r.table) ?? 0) + 1);
    const compositeTables = [...tableLevelCols.values()].filter((n) => n > 1);
    // ⚠ 18 → **21**（Phase 1c Task 1）：`005_accounts` 的 `o_invite` / `o_auditLog` 与
    //   `006_quota_grants` 的 `o_modelGrant` 用 `t.pk(T)`（`o_user` 重建后也是）。
    // ⚠ 27 → **29**：014_access_groups adds `o_modelGroup` and `o_userGroup` via t.pk(T).
    expect(colAttrTables.size, "列属性主键（`t.pk(T)` 形态）的表数").toBe(29);
    // The access-group join tables compile their composite constraints separately; these counts
    // intentionally cover the create-table shapes parsed above, not all platform constraints.
    expect(tableLevelCols.size, "表级 `primary key (…)`（含复合）的表数").toBe(12);
    expect(compositeTables.length, "表级主键里是复合主键的表数").toBe(6);
    // `o_user` appears with both historical and rebuilt shapes; two new t.pk tables add two names.
    expect(new Set([...colAttrTables, ...tableLevelCols.keys()]).size, "两种形状涉及的表名并集").toBe(41);
    expect(colAttrTables.size + tableLevelCols.size, "两种形状的命中次数之和").toBe(41);

    // 判别力自证（在**合成 DDL** 上跑同一个谓词）。五条分别钉住 `keyRefsOf` 的每一种形状，
    // 以及"同一形状的负例"——负例是必需的：只加正例时，"抽取面变宽后误报/漏报"两种退化都不会被发现。
    // ① 表级主键 + text 列 → 违规（这是 Task 7 真连抓到的那个 1170 原型）
    expect(
      scanKeyedTextColumns([
        "create table `t` (`type` longtext not null, primary key (`type`)) default character set utf8mb4",
      ])
    ).toHaveLength(1);
    // ② **text 列 + 列属性 `primary key`** → 违规。
    //    ⚠ 注意负例要构造得准：这一条必须是"**text 列自己**带列属性 primary key"。
    //    写成"`id` bigint ... primary key, `type` longtext"是**错的合成负例** —— 那种 DDL 里
    //    `type` 压根不在任何 key 规格里（合法的），断言它红等于要求误报。（本修复轮踩过这个坑。）
    expect(
      scanKeyedTextColumns([
        "create table `t` (`id` bigint unsigned not null auto_increment primary key, `type` longtext primary key) default character set utf8mb4",
      ])
    ).toHaveLength(1);
    // ③ **text 列 + `add unique`（没有 `index` 一词）** → 违规
    expect(
      scanKeyedTextColumns([
        "create table `t` (`id` bigint unsigned not null auto_increment primary key, `type` longtext not null) default character set utf8mb4",
        "alter table `t` add unique `t_type_unique`(`type`)",
      ])
    ).toHaveLength(1);
    // ④ 带 key 前缀长度（`type`(20)）是 MySQL 允许的写法，不得误报（三种形状里最容易被抽到的就是它）
    expect(
      scanKeyedTextColumns([
        "create table `t` (`id` bigint unsigned not null auto_increment primary key, `type` longtext not null) default character set utf8mb4",
        "alter table `t` add index `t_type_index`(`type`(20))",
      ])
    ).toHaveLength(0);
    // ⑤ 复合索引里**只有后缀列是 text**（`add unique ... (`isolationKey`, `type`)`：
    //    前缀列 `isolationKey` 是 varchar（合法），**后一列 `type` 才是 longtext**）→ 必须仍然抓到 `type`。
    //    （合并审查修复 6：这里原来写"只有前缀列是 text"，措辞**反了** ——
    //      前缀列恰恰是合法的那个，违规的是它后面那一列。）
    //    这就是 memories 的真实形状：前缀列是 varchar（合法），后面那一列才是违规列；
    //    抽取面只抓"第一列"或只抓"带前缀长度的列"都会在这里假绿。
    expect(
      scanKeyedTextColumns([
        "create table `t` (`isolationKey` varchar(191) not null, `type` longtext not null) default character set utf8mb4",
        "alter table `t` add unique `t_isolationkey_type_unique`(`isolationKey`, `type`)",
      ])
    ).toHaveLength(1);
  });

  /**
   * `scripts/export-sqlite.cjs` 的目标侧长度上限**只能来自 `001_schema`**（修复轮 1）。
   *
   * 修复的 bug：那张上限表原来是**手写常量**，`o_agentWorkData.data: 255` 在 `e76f46f` 把那列
   * 改成 `t.text()`（mysql `longtext`）之后没被同步删掉 → 导出报告一直打印
   * `⚠ o_agentWorkData.data：上限 255 字符（001_schema 收窄后的上限）… 5 行超长`
   * 这条**陈旧告警**。手写常量与 schema 之间没有机械联系 ⇒ 必然漂移。
   *
   * 现在上限由 `scripts/schema-limits.cjs` 的 `deriveTargetLimits()` 从 schema 编译出的 DDL
   * 机械推导（导出脚本只读它，不再有任何手写上限）。这条用例做两件事：
   *   ① **漂移即红**：推导结果必须逐键等于下面的期望表；
   *   ② **哨兵语义**：目标侧是 `longtext` 家族的列必须是 `MAX_LENGTH`（不是某个数字），
   *      这样导出侧才知道"这列不做超长判定"，`o_agentWorkData.data` 才不会再被报成超长。
   */
  it("导出脚本的目标侧长度上限是从 001_schema 机械推导的（漂移即红，o_agentWorkData.data 必须无数字上限）", async () => {
    const limits = await deriveTargetLimits({
      // ⚠ 直接注入 vitest 已经 import 的那份 schema，而不是让 schema-limits.cjs 去 require
      //    那个 `.ts`：vitest 的模块图里 `require` 一个 `.ts` 会走 vitest 自己的解析器，
      //    而 `@/db/dialect` 这条别名在那条 CJS require 链上解析不了
      //    （实测 `ERR_MODULE_NOT_FOUND: Cannot find package '@/db'`）。
      //    生产路径（`node --import=tsx scripts/export-sqlite.cjs`）走的是 migrationPath，tsx 认得别名。
      schema: schema as unknown as { up: (k: unknown) => Promise<void> },
      knexFactory: knexFactory,
    });
    const narrow = (v: number | symbol | undefined): number | "MAX_LENGTH" | undefined =>
      typeof v === "number" ? v : v === MAX_LENGTH ? "MAX_LENGTH" : undefined;
    const got: Record<string, number | "MAX_LENGTH"> = {};
    for (const [k, v] of Object.entries(limits)) {
      const n = narrow(v);
      if (n !== undefined) got[k] = n;
    }

    // ① 修复轮 1 的那条陈旧条目（本用例存在的直接理由）：
    //    `o_agentWorkData.data` 已经是 `t.text()`（mysql `longtext`），**绝不能**再是 255。
    expect(narrow(limits["o_agentWorkData.data"]), "o_agentWorkData.data 的目标侧上限").toBe("MAX_LENGTH");
    // 同一根因的第二个形状：`o_tasks.relatedObjects` 是 `t.text()`，源库却声明着 varchar(255)；
    // 目标侧无数字上限 ⇒ 导出脚本对它不再产生 oversize 记录（老版本会报"上限 255 / 2 行超长"）。
    expect(narrow(limits["o_tasks.relatedObjects"]), "o_tasks.relatedObjects 的目标侧上限").toBe("MAX_LENGTH");
    // 修复轮 1 把这两列的 varchar 收窄改回了 TEXT（长路径不得被截断）→ 必须也是 MAX_LENGTH
    expect(narrow(limits["o_modelPrompt.fileName"])).toBe("MAX_LENGTH");
    expect(narrow(limits["o_modelPrompt.path"])).toBe("MAX_LENGTH");

    // ② 反向的机械判据：**有数字上限的列就是 schema 里那 27 个 `T.string(...)` / `t.vstr(...)`**，
    //    一个不多、一个不少。这条比"抽查几个 key"强：任何"把 varchar 悄悄改成 text"（或反过来）
    //    都会在这里红，而且报出**多/少了哪一列**。
    const BOUNDED: Array<[string, number]> = [
      ["memories.id", 191], ["memories.isolationKey", 191], ["memories.type", 191],
      ["o_agentDeploy.desc", 255], ["o_agentDeploy.key", 255], ["o_agentDeploy.model", 255],
      ["o_agentDeploy.modelName", 255], ["o_agentDeploy.name", 255], ["o_agentDeploy.type", 255],
      ["o_agentWorkData.key", 255],
      ["o_artStyle.name", 255],
      ["o_assets.promptState", 255],
      ["o_event.detail", 255], ["o_event.name", 255],
      ["o_modelPrompt.model", 255], ["o_modelPrompt.vendorId", 255],
      ["o_project.imageModel", 255], ["o_project.imageQuality", 255], ["o_project.projectType", 255],
      ["o_project.videoModel", 255],
      ["o_prompt.name", 255], ["o_prompt.type", 255],
      ["o_setting.key", 191],
      ["o_tasks.model", 255], ["o_tasks.state", 255], ["o_tasks.taskClass", 255],
      ["o_vendorConfig.id", 191],
    ];
    expect(BOUNDED.length, "有数字上限的列数（机械推导的实测值）").toBe(27);
    const expectedBounded: Record<string, number> = {};
    for (const [k, v] of BOUNDED) expectedBounded[k] = v;
    const gotBounded: Record<string, number> = {};
    for (const [k, v] of Object.entries(got)) if (typeof v === "number") gotBounded[k] = v;
    expect(gotBounded).toEqual(expectedBounded);
    // 同一份清单再逐条钉一次，失败时报出具体列名（上面整表比对只给差集）
    for (const [k, v] of BOUNDED) expect(got[k], `${k} 的目标侧上限`).toBe(v);

    // ③ 覆盖护栏：推导整体失效（例如 schema 没注入成功、DDL 解析全空）时上面每一条都会
    //    报 undefined，但那种"全 undefined"最好在这里一眼看出来：实测 109 条列。
    expect(Object.keys(got).length).toBeGreaterThan(100);
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

  it("o_user 的主键**是** bigint unsigned auto_increment（Phase 1c Task 1 已重建，spec §7.1）", async () => {
    // ⚠ 这条断言在 Phase 1c Task 1 **反了过来**：1a/1b 时 `o_user` 是"代码显式给 id、不带自增"，
    //   所以当时断言的是 `not.toContain("auto_increment")`。`005_accounts` 按 §7.1 把 `o_user`
    //   重建为 `t.pk(T)`（bigint unsigned auto_increment primary key）—— 老行的 id **值**仍然保真
    //   （迁移里显式带 `id` 插入），所以这不是语义倒退，而是把主键交还给自增语义。
    //   ⚠ 005 会"建 `o_user_new` → drop `o_user` → rename"，所以这里看**最后一条**相关语句。
    const last = await lastDdlOf("o_user");
    expect(last?.kind).toBe("rename");
    const created = await createDdlFor("o_user");
    expect(created).toContain("`id` bigint unsigned not null auto_increment primary key");
    expect(created).toContain("`username` varchar(64) not null");
    expect(created).toContain("`email` varchar(191) null");
    expect(created).toContain("`passwordHash` varchar(255) not null default ''");
    expect(created).toContain("`role` varchar(16) not null default 'user'");
    expect(created).toContain("`status` varchar(16) not null default 'active'");
    expect(created).toContain("`tokenVersion` int unsigned not null default '0'");
    expect(created).toContain("`mustChangePassword` tinyint not null default '0'");
    expect(created).toContain("`createdAt` bigint unsigned not null");
    expect(created).toContain("`lastLoginAt` bigint null");
    // 两个唯一键（§7.1）：username / email
    const uniq = (await ddlFor("o_user")).split("\n").filter((l) => /add unique/.test(l));
    expect(uniq.some((l) => /\(`username`\)/.test(l))).toBe(true);
    expect(uniq.some((l) => /\(`email`\)/.test(l))).toBe(true);
    // 重建路径本身也要出现在 DDL 流里（drop 旧表 + rename 暂存表）
    const all = (await allDdl()).join("\n");
    expect(all).toContain("drop table `o_user`");
    expect(all).toContain("rename table `o_user_new` to `o_user`");
  });

  it("Phase 1c Task 1 的新表在 MySQL 侧编译成合法形状（复合主键 / 索引 / 微元列）", async () => {
    // o_userSetting：复合主键 (userId, key)，且 key 是 varchar（TEXT 主键 → ERROR 1170）
    const setting = await createDdlFor("o_userSetting");
    expect(setting).toContain("`userId` bigint unsigned not null");
    expect(setting).toContain("`key` varchar(64) not null");
    expect(setting).toMatch(/primary key \(`userId`, `key`\)/);
    // o_loginAttempt：复合主键 (username, ip)，两个毫秒列是 bigint unsigned
    const attempt = await createDdlFor("o_loginAttempt");
    expect(attempt).toMatch(/primary key \(`username`, `ip`\)/);
    for (const col of ["lockedUntil", "firstFailedAt", "updatedAt"]) {
      expect(colType(attempt, col), `o_loginAttempt.${col}`).toBe("bigint unsigned");
    }
    // o_auditLog：两个索引 + 自增主键
    const audit = await createDdlFor("o_auditLog");
    expect(audit).toContain("`id` bigint unsigned not null auto_increment primary key");
    const auditAlter = (await ddlFor("o_auditLog")).split("\n").filter((l) => /^alter table/.test(l));
    expect(auditAlter.some((l) => /add index `o_auditlog_userid_createdat_index`\(`userId`, `createdAt`\)/.test(l))).toBe(true);
    expect(auditAlter.some((l) => /add index `o_auditlog_action_createdat_index`\(`action`, `createdAt`\)/.test(l))).toBe(true);
    // o_account：**表级**单列主键（不是列级 `primary key`，见 006 的注释）+ 微元余额是 bigint
    const account = await createDdlFor("o_account");
    expect(account).toMatch(/primary key \(`userId`\)/);
    expect(account).not.toContain("auto_increment"); // userId 由调用方给，不是自增 id
    expect(colType(account, "balanceMicro")).toBe("bigint");
    expect(colType(account, "frozenMicro")).toBe("bigint");
    // o_invite / o_modelGrant：自增主键 + 各自唯一的 code 索引 / (userId,enabled) 索引
    const invite = await createDdlFor("o_invite");
    expect(invite).toContain("`id` bigint unsigned not null auto_increment primary key");
    expect((await ddlFor("o_invite")).split("\n").some((l) => /add unique `o_invite_code_unique`\(`code`\)/.test(l))).toBe(true);
    const grant = await createDdlFor("o_modelGrant");
    expect(grant).toContain("`userId` bigint unsigned not null");
    expect(grant).toContain("`enabled` tinyint not null default '1'");
    expect((await ddlFor("o_modelGrant")).split("\n").some((l) => /add index `o_modelgrant_userid_enabled_index`\(`userId`, `enabled`\)/.test(l))).toBe(true);
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

  it("009_billing 编译为合法 MySQL DDL，金额类型和唯一键受约束", async () => {
    const usage = await ddlFor("o_usage");
    const ledger = await ddlFor("o_ledger");
    const order = await ddlFor("o_order");
    const price = await ddlFor("o_price");
    const admission = await ddlFor("o_dailyQuotaAdmission");
    const callAdmission = await ddlFor("o_usageAdmission");

    expect(colType(usage, "costMicro")).toBe("bigint unsigned");
    expect(colType(usage, "videoSeconds")).toBe("decimal(18, 6)");
    expect(colType(usage, "quantity")).toBe("decimal(30, 9)");
    expect(usage).toContain("`providerCallId` varchar(128)");
    expect(usage).toMatch(/add unique `o_usage_userid_providercallid_unique`\(`userId`, `providerCallId`\)/);
    expect(usage).not.toMatch(/unique .*`requestId`/);
    expect(colType(ledger, "amountMicro")).toBe("bigint");
    expect(colType(ledger, "balanceAfter")).toBe("bigint");
    expect(ledger).toMatch(/add unique `o_ledger_userid_idempotencykey_unique`\(`userId`, `idempotencyKey`\)/);
    expect(colType(order, "amountMicro")).toBe("bigint unsigned");
    expect(order).toMatch(/add unique `o_order_outtradeno_unique`\(`outTradeNo`\)/);
    expect(order).toMatch(/add unique `o_order_externaltradeid_unique`\(`externalTradeId`\)/);
    expect(colType(price, "unitPriceMicro")).toBe("bigint unsigned");
    expect(price).toContain("`model` varchar(96)");
    expect(colType(admission, "userId")).toBe("bigint unsigned");
    expect(admission).toMatch(/add unique `o_dailyquota_user_vendor_model_day_unique`\(`userId`, `vendorId`, `model`, `dayStart`\)/);
    expect(colType(callAdmission, "userId")).toBe("bigint unsigned");
    expect(colType(callAdmission, "dayStart")).toBe("bigint unsigned");
    expect(colType(callAdmission, "admittedAt")).toBe("bigint unsigned");
    expect(colType(callAdmission, "jobId")).toBe("bigint unsigned");
    expect(callAdmission).toContain("`providerCallId` varchar(128)");
    expect(callAdmission).toMatch(/add unique `o_usageadmission_userid_providercallid_unique`\(`userId`, `providerCallId`\)/);
    const usageAlter = (await allDdlCollected()).filter((entry) => entry.kind === "alter" && /alter table `o_usage`/.test(entry.sql));
    expect(usageAlter.some((entry) => /`quantity`/.test(entry.sql) && /decimal\(30, 9\)/.test(entry.sql) && /null/i.test(entry.sql)), usageAlter.map((entry) => entry.sql).join("\\n")).toBe(true);
    expect([usage, ledger, order, price, admission, callAdmission].join("\n")).not.toMatch(/foreign key/i);
  });

  it("迁移建出的表恰好 46 张（含授权分组表；暂存表 `o_user_new` 不计入最终结构）", async () => {
    const created: string[] = [];
    for (const s of await allDdl()) {
      const m = /^create table `([^`]+)`/.exec(s);
      if (m) created.push(m[1]);
    }
    // ⚠ DDL 流里会出现 36 条 create（含 005 的暂存表 `o_user_new`，它随后被 rename 掉）；
    //   "最终落地的表"必须排除它 —— 与 `tools/migration-tables.cjs` 的 `deployedTables` 同口径。
    expect(created).toContain("o_user_new");
    const deployed = created.filter((t) => t !== "o_user_new" && t !== "o_user_old");
    // 35 → 41（billing plus admission tables）→ 46 (access groups)
    expect(deployed.length).toBe(46);
    expect(new Set(deployed).size).toBe(46);
  });
});

void mysql.destroy();
