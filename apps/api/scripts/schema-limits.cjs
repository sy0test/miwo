#!/usr/bin/env node
/**
 * 从 `001_schema` **机械推导**"目标结构（MySQL 侧）对每一列的长度上限"。
 *
 * 为什么必须是推导而不是手写常量（修复轮 1）：
 *   `export-sqlite.cjs` 原来有一张手写的 `SCHEMA_LIMITS`，其中
 *   `"o_agentWorkData.data": 255` 在 `e76f46f` 把那列从 `varchar(255)` 改成 `t.text()`
 *   （mysql `longtext`）之后**没有被同步删除** → 导出报告继续打印
 *   `⚠ o_agentWorkData.data：上限 255 字符（001_schema 收窄后的上限）… 5 行超长`
 *   这条**陈旧告警**，读者会以为那 5 行超长数据仍然有风险。手写常量与 schema 之间没有
 *   任何机械联系，所以它一定会漂移；改成从 schema 推导之后，"漂移"这件事在结构上不存在了。
 *
 * 口径（必须与导出/导入侧一致）：
 *   - 只登记**目标侧有明确字符上限**的列：`varchar(N)` / `char(N)` → N。
 *   - `text` 家族（mysql 侧 `t.text(name, "longtext")` → `longtext`）→ 不是"某个数字上限"，
 *     而是"4 GiB 级、实际等于没有约束"。登记成哨兵 `MAX_LENGTH`，让调用方决定怎么处理
 *     （导出侧把它当"无上限"跳过长度体检；导入侧的 `preflightImport` 另有自己的判据）。
 *     ⚠ 不要在这里返回 `null`：`null` 与"schema 里根本没有这一列"无法区分，
 *     而"某一列被悄悄收窄了"正是要发现的东西。
 *   - 不登记 `int` / `bigint` / `datetime` / `float` / `tinyint` / `json` 这些没有字符长度语义的列
 *     —— 它们不参与字符长度体检。
 *
 * 实现：用 mysql 方言的假 knex 收下 `001_schema.up()` 编译出来的全部 DDL，再逐条
 * `create table` 拆列。**不连任何数据库**。这也是本模块能同时被
 * `scripts/export-sqlite.cjs`（CJS 运行期）与 `tests/migration-ddl-mysql.test.ts`
 * （vitest，走 `createRequire`）复用的原因：它只依赖 knex 的编译器。
 */
"use strict";

const path = require("path");

/** `text` 家族的字符上限哨兵：表示"目标侧实际上是 longtext，没有可比的数字上限"。 */
const MAX_LENGTH = Symbol("MAX_LENGTH");

/** 目标侧有明确字符上限的类型（带括号长度）。`varbinary`/`binary` 不在范围（本仓没有）。 */
const BOUNDED_TYPE = /^(varchar|char|nvarchar|nchar)$/i;
/** `text` / `blob` 家族：mysql 侧统一编译成 `longtext` / `longblob`，没有数字上限。 */
const UNBOUNDED_TEXT = /^(tiny|medium|long)?(text|blob)$/i;

/**
 * 从一条 `create table` 的表体里按**深度 0 的逗号**拆出每个列定义，返回列名 → 长度口径。
 * 用括号深度（而不是正则）判列结束：`decimal(8,2)` 这类类型里就有逗号。
 */
function columnsOf(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  const out = new Map();
  for (const raw of parts) {
    const part = raw.trim();
    // 表级约束（`primary key (...)` / `unique key ...`）不是列定义
    const m = /^`([^`]+)`\s+([\s\S]+)$/.exec(part);
    if (!m) continue;
    const name = m[1];
    const type = m[2];
    const head = /^([A-Za-z]+)/.exec(type);
    if (!head) continue;
    const keyword = head[1].toLowerCase();
    const paren = /^\((\d+)/.exec(type.slice(head[0].length).trim());
    if (paren && BOUNDED_TYPE.test(keyword)) {
      out.set(name, Number(paren[1]));
      continue;
    }
    if (UNBOUNDED_TEXT.test(keyword)) out.set(name, MAX_LENGTH);
  }
  return out;
}

/**
 * 用 mysql 方言把 `001_schema.up()` 编译成 DDL（不连库），返回 `{ "table.col": limit }`。
 *
 * @param {object} opts
 * @param {any}    opts.knexFactory    knex 工厂（`require("knex")`）
 * @param {string} [opts.migrationPath] `001_schema` 的模块路径（`.ts`）。**没给 `schema` 时必填**：
 *   走 tsx（`node --import=tsx` / `pnpm run db:export`）时 tsx 认得 `@/*` 别名，node 原生 require 即可。
 *   ⚠ 走 vitest 时**不要**用它：vitest 的模块图有自己的解析器，`require` 一个 `.ts` 会走
 *   vitest 的 transform，而 `@/db/dialect` 那条别名在**这条 CJS require 链**上解析不了
 *   （实测 `ERR_MODULE_NOT_FOUND: Cannot find package '@/db'`，两种 code 都试过）。
 *   那种场景请用下面的 `schema` 直接注入。
 * @param {any}    [opts.schema]       已经加载好的 `001_schema` 模块（`{ default: { up } }` 或 `{ up }`）。
 *   优先生效：给了它就不再 require 任何东西 —— 测试里传 `import schema from "@/db/migrations/001_schema"`
 *   的那一个实例，既绕开别名解析，又保证断言用的就是 vitest 看到的同一份 schema。
 * @returns {Promise<Record<string, number | symbol>>}
 */
async function deriveTargetLimits({ migrationPath, knexFactory, schema: schemaIn }) {
  const mysql = knexFactory({
    client: "mysql2",
    connection: { host: "127.0.0.1", user: "x", database: "miwo" },
  });
  const stmts = [];
  const collector = {
    client: mysql.client,
    schema: {
      createTable: (name, cb) => {
        for (const s of mysql.schema.createTable(name, cb).toSQL()) stmts.push(s.sql);
        return Promise.resolve();
      },
      dropTableIfExists: () => Promise.resolve(),
    },
    raw: () => Promise.resolve(),
  };
  try {
    let schema = schemaIn;
    if (!schema) {
      if (!migrationPath) throw new Error("[schema-limits] 必须给 schema 或 migrationPath 之一");
      const mod = require(migrationPath);
      schema = mod && mod.default ? mod.default : mod;
    }
    if (!schema || typeof schema.up !== "function") {
      throw new Error("[schema-limits] 拿到的 001_schema 没有 up() —— 模块形状变了？");
    }
    await schema.up(collector);
  } finally {
    void mysql.destroy();
  }

  const limits = {};
  for (const s of stmts) {
    const m = /^create table `([^`]+)` \(([\s\S]*)\)(?: default character set [a-z0-9_]+)?$/.exec(s);
    if (!m) continue;
    for (const [col, len] of columnsOf(m[2])) limits[m[1] + "." + col] = len;
  }
  // 覆盖护栏：推导出来为空 = 正则/加载失效，绝不能当成"没有任何列有长度上限"放过去
  // （那会让长度体检整段静默失效，正是修复轮 1 之前的陈旧告警问题的反面）。
  if (Object.keys(limits).length === 0) {
    throw new Error(
      "[schema-limits] 从 001_schema 推导出的长度上限是空的 —— " +
        "fake-knex 收集或 DDL 解析失效了；不要把它当成'没有列有上限'",
    );
  }
  return limits;
}

module.exports = { deriveTargetLimits, MAX_LENGTH, columnsOf, BOUNDED_TYPE, UNBOUNDED_TEXT };
