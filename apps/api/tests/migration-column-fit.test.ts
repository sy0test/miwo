/**
 * 机械体检：**老库实测值域 vs `001_schema` 编译出的 MySQL 目标类型**。
 *
 * 为什么需要它（根因，不是"多写一条测试"）：
 *   `int` 列装毫秒值（`Date.now()`）这类缺口**只在真 MySQL 才暴露** —— sqlite 的 INTEGER 是 64 位，
 *   本机的回归网、`verify-phase0` 全都看不出问题。本轮（修复轮 2）挖出的第三批
 *   `o_segment.projectId` / `o_shot.projectId` 之所以漏掉，根因是当时的判据是一张**手工清单**
 *   （`migration-ddl-mysql.test.ts` 里只写了 10 个外键列）—— 清单外的表永远不会被检查。
 *
 * 所以本文件把判据换成**机械扫描**：
 *   1. 用**假 knex**（`knex({client:"mysql2"})`，不连服务端）把 `001_schema.up` 编译成 MySQL DDL 串，
 *      逐列解析出 mysql 类型（`int` / `bigint unsigned` / `varchar(255)` / `longtext`…）；
 *   2. 老库的逐列实测值域来自 `tests/fixtures/legacy-column-stats.json`（由
 *      `scripts/gen-legacy-column-stats.cjs` **只读**打开老库机械记录；老库本身不入库，
 *      所以 CI 上没有老库也能跑）；
 *   3. 判定**复用生产代码**：`src/db/legacy/import.ts` 的 `outOfRangeValues()`（有界整数越界）与
 *      `oversizeValues()`（`varchar(N)` 超长）—— 导入脚本用的就是这两个函数，
 *      断言它们对"目标类型 + 老库值域"的结论为空，等于断言"真 MySQL 导入不会因类型太窄而失败或夹断"。
 *
 * 三条判据：
 *   A. **整数族列名宽度一致**（不需要老库数据）：同名整数列在整个 schema 里必须只有一种 mysql 类型。
 *      —— 这是"新增一张表、`projectId` 又写成 `int`"这类**无数据也能抓到**的守卫。
 *   B. **值域 vs 目标类型**（fixture 驱动，任何机器都跑）：`int` 上界 2147483647 与 `varchar(N)` 的 N。
 *   C. **活库复核**（有老库时跑）：直接读老库的**真实行**跑同样的生产判定；并用源库 sha256 断言
 *      "fixture 记录的值域确实是当前这个文件的值域"（fixture 过期不会静默放过）。
 *
 * ⚠ 它证明的是"目标类型装得下老库的实测值域"，**不证明 MySQL 服务端接受这些 DDL**
 *   （后者要 Task 7 的真连接）。与 `migration-ddl-mysql.test.ts` 的分工：那个文件钉"DDL 串对不对"，
 *   本文件钉"类型够不够宽"。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import knexFactory, { type Knex } from "knex";
import { outOfRangeValues, oversizeValues, type TablePlan } from "@/db/legacy/import";
import schema from "@/db/migrations/001_schema";

const API_ROOT = path.resolve(__dirname, "..");
const DEV_DB = path.join(API_ROOT, "data", "db2.sqlite");
const FIXTURE = path.join(__dirname, "fixtures", "legacy-column-stats.json");

/** 编译 DDL 用的"假 knex"：只用来生成 SQL 串，**不连任何服务端**（与 `migration-ddl-mysql.test.ts` 同法）。 */
const mysql = knexFactory({ client: "mysql2", connection: { host: "127.0.0.1", user: "x", database: "miwo" } });
afterAll(() => {
  void mysql.destroy();
});

interface TargetColumn {
  name: string;
  /** mysql 类型名（与 `knex.columnInfo()` 的口径一致：`int` / `bigint` / `varchar` / `longtext`…）。 */
  type: string;
  /** `varchar(N)` / `char(N)` 的 N；其余为 null。 */
  length: number | null;
  unsigned: boolean;
  raw: string;
}

/** 按**顶层**逗号切分（忽略括号内的逗号，例如 `float(8, 2)` / `decimal(10, 2)`）。 */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 从单条 `create table` 语句里抠出每一列的名字与 mysql 类型。 */
function parseColumns(stmt: string): TargetColumn[] {
  const open = stmt.indexOf("(");
  const close = stmt.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error(`DDL 形态不认识：${stmt}`);
  const out: TargetColumn[] = [];
  for (const seg of splitTopLevel(stmt.slice(open + 1, close))) {
    const s = seg.trim();
    if (!s) continue;
    // 表级约束（primary key / unique / index / constraint …）不是列定义
    if (/^(primary key|unique|index|key|constraint|foreign key)\b/i.test(s)) continue;
    const m = /^`([^`]+)`\s+(.+)$/.exec(s);
    if (!m) continue;
    const rest = m[2];
    const t = /^([a-z0-9_]+)\s*(?:\(\s*([^)]*)\s*\))?(\s+unsigned)?/i.exec(rest);
    if (!t) throw new Error(`列类型解析失败：${s}`);
    const type = t[1].toLowerCase();
    const argRaw = (t[2] ?? "").trim();
    const args = argRaw ? argRaw.split(",").map((x) => x.trim()) : [];
    const length =
      (type === "varchar" || type === "char") && args.length === 1 && /^\d+$/.test(args[0]) ? Number(args[0]) : null;
    out.push({ name: m[1], type, length, unsigned: Boolean(t[3]), raw: rest });
  }
  return out;
}

/** 把 `001_schema.up` 编译成 MySQL DDL，逐表返回列清单。 */
async function compileTargetSchema(): Promise<Map<string, TargetColumn[]>> {
  const byTable = new Map<string, TargetColumn[]>();
  const collector: any = {
    client: mysql.client,
    schema: {
      createTable: (name: string, cb: any) => {
        const stmts = mysql.schema.createTable(name, cb).toSQL().map((s) => s.sql);
        const ddl = stmts.find((s) => /^create table /i.test(s.trim()));
        if (!ddl) throw new Error(`没有为 ${name} 生成 create table DDL`);
        byTable.set(name, parseColumns(ddl));
        return Promise.resolve();
      },
      dropTableIfExists: () => Promise.resolve(),
    },
    raw: () => Promise.resolve(),
  };
  await (schema as any).up(collector);
  return byTable;
}

interface ColumnStats {
  declared: string;
  rows: number;
  min: number | null;
  max: number | null;
  maxChars: number | null;
}
interface Fixture {
  source: { path: string; sha256: string; bytes: number; tables: number; columns: number; rows: number };
  stats: Record<string, Record<string, ColumnStats>>;
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;

/** 合成"只含极值"的行：范围/长度判定都是**单调**的，所以极值行与全量行给出**同一个结论**。 */
function extremeRows(cols: Array<[string, ColumnStats]>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const lo: Record<string, unknown> = {};
  const hi: Record<string, unknown> = {};
  const str: Record<string, unknown> = {};
  for (const [col, s] of cols) {
    if (s.min !== null) lo[col] = s.min;
    if (s.max !== null) hi[col] = s.max;
    if (s.maxChars !== null) str[col] = "x".repeat(s.maxChars);
  }
  for (const r of [lo, hi, str]) if (Object.keys(r).length) rows.push(r);
  return rows;
}

function planFor(table: string, cols: TargetColumn[], sourceColumns: string[]): TablePlan {
  return {
    table,
    sourceExists: true,
    targetExists: true,
    sourceColumns,
    targetColumns: cols.map((c) => c.name),
    columns: cols.map((c) => c.name),
    droppedSourceColumns: [],
    missingTargetColumns: [],
    sourceRows: null,
    targetRows: null,
    targetColumnTypes: Object.fromEntries(cols.map((c) => [c.name, c.type])),
    targetColumnMaxLengths: Object.fromEntries(cols.map((c) => [c.name, c.length])),
  };
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("机械体检：老库实测值域 vs 001_schema 的 MySQL 目标类型", () => {
  it("判据 A：同名整数列在整个 schema 里只有一种 mysql 类型（不需要老库数据，CI 也跑）", async () => {
    const target = await compileTargetSchema();
    const INT_FAMILY = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
    // 列名 → 类型 → 出现处。同一逻辑键（projectId / userId / …）宽度不一致 = 又漏了一张表。
    const widths = new Map<string, Map<string, string[]>>();
    for (const [table, cols] of target) {
      for (const c of cols) {
        if (!INT_FAMILY.has(c.type)) continue;
        const key = c.type + (c.unsigned ? " unsigned" : "");
        if (!widths.has(c.name)) widths.set(c.name, new Map());
        const byType = widths.get(c.name)!;
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(`${table}.${c.name}`);
      }
    }
    const bad: string[] = [];
    for (const [name, byType] of widths) {
      if (byType.size < 2) continue;
      const parts = [...byType.entries()].map(([key, where]) => `${key} @ ${where.join(", ")}`);
      bad.push(`VIOLATION 整数列 ${name} 出现了 ${byType.size} 种 mysql 类型：${parts.join(" | ")}`);
    }
    expect(
      bad,
      [
        `同名整数列宽度必须一致（否则"装同一批毫秒值"的列里必有一张表装不下）：`,
        ...bad,
      ].join("\n")
    ).toEqual([]);
    // 覆盖护栏：确认真的扫到了全库（不是"没扫到所以没意见"）
    expect(target.size).toBe(27);
    expect(widths.size).toBe(42); // 27 张表里共 42 个不同的整数列名（数变了说明扫描范围变了）
  });

  it("判据 B：fixture 记录的实测值域全部落在目标 mysql 类型内（越界/超长各逐列报出）", async () => {
    const target = await compileTargetSchema();
    const outOfRange: string[] = [];
    const oversize: string[] = [];
    let totalTargetColumns = 0;
    let checkedInt = 0;
    let checkedVarchar = 0;
    let noSourceEvidence = 0;
    let unbounded = 0;
    const tables = [...target.keys()].sort();
    for (const table of tables) {
      const cols = target.get(table)!;
      const stats = fixture.stats[table] ?? {};
      const known = cols.filter((c) => stats[c.name]);
      totalTargetColumns += cols.length;
      for (const c of cols) {
        // ⚠ `outOfRangeValues` 的 INT_RANGES 只认**有符号**键（tinyint/smallint/mediumint/int/integer）：
        //   "unsigned 的窄整数列"会**查不到范围而被静默跳过** → 判据就有洞。这种列现在不存在，
        //   用下面的断言把它钉死（一旦出现，先扩 INT_RANGES 再谈）。
        const boundedInt = !c.unsigned && /^(tinyint|smallint|mediumint|int|integer)$/.test(c.type);
        const boundedStr = c.length !== null;
        if (!boundedInt && !boundedStr) {
          // 目标类型本身没有上界（`bigint` / `longtext` / `float` / `text`…）→ 不存在"装不下"
          unbounded += 1;
        } else if (!stats[c.name]) {
          // 目标有这一列、老库没有（例如本迁移新增的 userId / directorManual）→ 没有实测值域可用。
          // 这类列**不能靠数据判**，由判据 A（同名整数列宽度一致）与迁移审阅兜住。
          noSourceEvidence += 1;
        } else if (boundedInt) checkedInt += 1;
        else checkedVarchar += 1;
      }
      if (!known.length) continue;
      const plan = planFor(table, known, Object.keys(stats));
      const rows = extremeRows(known.map((c) => [c.name, stats[c.name]]));
      for (const v of outOfRangeValues(plan, rows)) {
        outOfRange.push(
          `VIOLATION ${v.table}.${v.column}: 目标 mysql 类型 ${v.declaredType} 上界 ${v.hi}，老库实测 ${v.min}..${v.max}（${v.rowsOver} 行越界）`
        );
      }
      for (const v of oversizeValues(plan, rows)) {
        oversize.push(
          `VIOLATION ${v.table}.${v.column}: 目标 mysql 类型 ${v.declaredType}(${v.declaredLength}) 上限 ${v.declaredLength} 字符，老库实测最长 ${v.maxChars} 字符（${v.rowsOver} 行超长）`
        );
      }
    }
    const message = [
      `老库实测值域超出目标类型（真 MySQL 会 Out of range / Data too long，非严格模式则静默夹断）：`,
      ...outOfRange,
      ...oversize,
    ].join("\n");
    // 一行可引用的体检结论（取证用：违规数必须是 0）
    console.log(
      `[column-fit] 判据 B：扫描 ${target.size} 张表 / ${totalTargetColumns} 列` +
        `（有界整数 ${checkedInt}、有界 varchar ${checkedVarchar}、无实测值域 ${noSourceEvidence}、类型本身无上界 ${unbounded}）` +
        ` → 越界 ${outOfRange.length} / 超长 ${oversize.length}`
    );
    expect([...outOfRange, ...oversize], message).toEqual([]);
    // 覆盖护栏（**不是**装饰）：四个桶必须覆盖全部 27 张表的 226 个列 —— "没扫到所以没意见"是不允许的。
    // 数变了就说明目标 schema 或解析逻辑变了，先核对再改这些数（别顺手放开）。
    expect(totalTargetColumns).toBe(226);
    expect(checkedInt).toBe(47);
    expect(checkedVarchar).toBe(26);
    expect(noSourceEvidence).toBe(0);
    expect(unbounded).toBe(153);
    expect(checkedInt + checkedVarchar + noSourceEvidence + unbounded).toBe(totalTargetColumns);
    expect(fixture.source.sha256, "fixture 来源变了：若确为重新记录，请同步更新这一行").toBe(
      "44716850b443f53524c1046afac4ecfbc6c21cc35c8da3a329781031b09c4ef2"
    );
    // 解析器 / 判据的自检（这两条是"判据有没有洞"的守卫，不是装饰）：
    const all = [...target].flatMap(([t, cols]) => cols.map((c) => [t, c] as const));
    expect(
      all.filter(([, c]) => /^(varchar|char)$/.test(c.type) && c.length === null).map(([t, c]) => `${t}.${c.name}`),
      "varchar/char 没解析出长度 → 会被当成无上界而静默跳过"
    ).toEqual([]);
    expect(
      all.filter(([, c]) => c.unsigned && /^(tinyint|smallint|mediumint|int|integer)$/.test(c.type)).map(([t, c]) => `${t}.${c.name}`),
      "unsigned 的窄整数列不在 INT_RANGES 里 → outOfRangeValues 会静默跳过它；先扩 INT_RANGES"
    ).toEqual([]);
  });

  it("判据 C：老库在时，直接拿真实行跑同一判定，并用 sha256 断言 fixture 没过期", async () => {
    if (!fs.existsSync(DEV_DB)) {
      // 老库快照不入库（apps/api/.gitignore 忽略 *.sqlite）→ CI 上只有判据 A/B。
      // 判据 B 的 fixture 已由 sha256 钉住（见上一条），所以这里不是"什么都验不了"。
      expect(fixture.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      return;
    }
    expect(sha256(DEV_DB), "老库字节变了 → fixture 记录的实测值域已过期，请重跑 scripts/gen-legacy-column-stats.cjs --write").toBe(
      fixture.source.sha256
    );
    expect(fs.statSync(DEV_DB).size).toBe(fixture.source.bytes);

    const target = await compileTargetSchema();
    const src: Knex = knexFactory({
      client: "better-sqlite3",
      connection: { filename: DEV_DB, options: { readonly: true } },
      useNullAsDefault: true,
    });
    const outOfRange: string[] = [];
    const oversize: string[] = [];
    let scannedRows = 0;
    try {
      for (const table of [...target.keys()].sort()) {
        const stats = fixture.stats[table];
        if (!stats) continue;
        const cols = target.get(table)!.filter((c) => stats[c.name]);
        if (!cols.length) continue;
        const rows = (await src(table).select(cols.map((c) => c.name))) as Array<Record<string, unknown>>;
        scannedRows += rows.length;
        const sourceRows = stats[cols[0].name].rows;
        expect(rows.length, `${table} 的 fixture 行数与活库不一致 → fixture 过期`).toBe(sourceRows);
        const plan = planFor(table, cols, cols.map((c) => c.name));
        for (const v of outOfRangeValues(plan, rows)) {
          outOfRange.push(`VIOLATION ${v.table}.${v.column}: 目标 ${v.declaredType} 上界 ${v.hi}，活库实测 ${v.min}..${v.max}`);
        }
        for (const v of oversizeValues(plan, rows)) {
          oversize.push(
            `VIOLATION ${v.table}.${v.column}: 目标 ${v.declaredType}(${v.declaredLength})，活库实测最长 ${v.maxChars} 字符`
          );
        }
      }
    } finally {
      await src.destroy();
    }
    console.log(
      `[column-fit] 判据 C：活库真实行扫描 ${scannedRows} 行 → 越界 ${outOfRange.length} / 超长 ${oversize.length}（老库 sha256 未变）`
    );
    expect([...outOfRange, ...oversize], "活库真实行跑出的越界/超长清单必须为空").toEqual([]);
    // 覆盖护栏：本机活库应扫到 2 千行以上（少于这个量级说明查询悄悄失效了）
    expect(scannedRows).toBeGreaterThan(2000);
    // 只读自证：本用例全程只读，跑完老库 sha256 必须不变
    expect(sha256(DEV_DB), "本用例必须只读老库").toBe(fixture.source.sha256);
  });
});
