/**
 * SQLite → 目标库的数据搬迁核心（spec §12.2 T5 的"从旧 SQLite 快照搬迁"）。
 *
 * ⚠ 这里**不建表**：表由 `001_schema` 迁移建好，本模块只搬数据。
 * ⚠ 这里**不猜列**：源列 ∩ 目标列才是要写的列，其余丢弃（源多）/ 留 NULL（目标多）。
 * ⚠ 这里**不写源库**：所有读源库的入口都是只读的（`scripts/export-sqlite.cjs` 用
 *    `better-sqlite3` 的 `{ readonly: true }`，并在导出前后断言源库 sha256 不变）。
 *
 * ───────────────────────── 五条不变式（Task 6 的核心）─────────────────────────
 *  1. **id 保真**：一切 id 原值搬运（`o_project.id = Date.now()` 这类大整数必须原样过去，
 *     否则 `o_assets.projectId` 全部指空）。
 *  2. **列交集**：源库有而目标库没有的列（例如老的 `o_agentWorkData.legacyOnlyColumn`）跳过；
 *     目标库有而源库没有的列（新增的 `userId`）留 NULL（回填归 Phase 1b）。
 *  3. **拒绝把坏数据带进唯一键**：`o_agentWorkData` 的 `(projectId, episodesId, key)` 重复行
 *     必须在导入前被发现并报告（`001_schema` 给它加了唯一键，重复行会让导入**中途失败**）。
 *  4. **进空库**：目标库必须是"迁移刚建好、业务表全空"的状态；发现非空即拒绝
 *     （防止二次导入把数据搞成两遍）。**平台种子表例外**，见下面的交接条款。
 *  5. **id 范围**：任何 id > 2^53−1 都拒绝（`bigNumberStrings:false` 下会精度丢失；
 *     实测最大是 `Date.now()` 的 1.7e12，远低于阈值，但仍要断言）。
 *
 * ───────────── ⚠ Task 5 交接条款：导入顺序与回滚语义（本文件是它的登记落点）─────────────
 *
 * `002_platform_seed` 的 `down` 判据是 **"仍是本仓库种子那一行"才删**（逐列**精确**比较，与
 * collation 无关：mysql 侧 `BINARY`、sqlite 侧 `COLLATE BINARY`；Task 5 独立审查修复 3 定的
 * "内容全等"方向，合并审查修复 1 把比较口径从 SQL `=` 加固成 collation 无关 ——
 * MySQL 的 `utf8mb4_0900_ai_ci` 下 `=` **大小写不敏感**，"只改大小写"的行会被误删）。
 * 因此搬迁链必须守住三条（改导入策略时，`tests/migration-seed.test.ts` 的
 * 「down 不误伤 Task 6 先导入的同键老数据」与 `tests/legacy-import.test.ts` 的种子表用例会红）：
 *
 *  1. **导入必须"跳过已存在"，不得 upsert / replace / 清表重灌。**
 *     四张平台表（`o_prompt` / `o_agentDeploy` / `o_setting` / `o_vendorConfig`）在 `002` 之后
 *     **已经有行**，而且 `o_setting` 平台键按 `002` 的显式断言**绝不含 `tokenKey`**。
 *     → 老库（或运维）那一行 `tokenKey` **不得**被导进目标库：那是 JWT 密钥，Phase 1c 才会把它
 *       统一到配置；本阶段把它导回 DB 等于"把刚搬出库的密钥又放回库"（`002_platform_seed.ts`
 *       末尾的断言会当场红）。见 `NEVER_IMPORT_SETTING_KEYS`。
 *     → 同身份键但内容不同的行按"已存在 → 跳过"处理：这样 `down` 的行为是可预测的（见第 2 条）。
 *  2. **回滚语义**（同一份文字也在根 `README.md` 的「迁移纪律」一节）：
 *     - 回滚只删"仍是本仓库种子那一行"的记录（逐列精确相等）：002 插的、此后没人改过的行 → 被删；
 *       **导入进来的行 → 保留**；
 *     - 因此 **"先跑 002 → 再导入 → 再 rollback" 不会误删任何导入数据**，但留下的也不是"空库"：
 *       平台表里会剩导入的那几行。要重做一遍必须让目标库回到"迁移刚建好 + 002 已跑"的状态，
 *       **不要**为了"回滚干净"手工 `TRUNCATE` 平台表。
 *     - 反向顺序（**先导入、后跑 002**）：`002` 会按身份键跳过已导入的同键行、只补缺失的键；
 *       这些被跳过的行在 `down` 时**不会**被删（内容不同）—— 这正是修复 3 要的方向。
 *  3. 断言口径：`tests/migration-seed.test.ts` 里"down 不误伤 Task 6 先导入的同键老数据"那条用例
 *     就是本条款的回归网。
 *
 * ───────────── 【Ruling 43】`bigint` 的类型归一化（导出→导入后类型与数值都不许变）─────────────
 *
 * `connect.ts` 给 MySQL 连接设了 `supportBigNumbers: true` / `bigNumberStrings: false`
 * —— 于是 **≤ 2^53−1 的 BIGINT 读回来是 number，超过才是 string**。老库可能在 TEXT 列里存了
 * 数字串、或者某条链路把它读成了 string，所以导入前必须按**目标列的声明类型**把数字串归一化成
 * `number`（见 `normalizeValue`），否则同一个 `projectId` 在导出物里是 number、导进去读回来是
 * string，应用侧 `===` 比较会静默失效。
 * 断言：`tests/legacy-import.test.ts` 的「bigint 往返：类型与数值都不变」用例 +
 * `checkIdTypes()`（导入后逐列扫"id 类列读回来还是不是 number"）。
 *
 * ───────────── 【Ruling 34/41】三条"只在真 MySQL 暴露"的风险，本模块的处理 ─────────────
 *  ① `o_agentWorkData` 的 `(projectId, episodesId, key)` 唯一键：老库若有重复行，
 *     `alter-add-unique`/`insert` 会让导入中途失败 → `findDuplicates()`（Knex 源）与
 *     `manifest.duplicates`（NDJSON 源）**在任何写入之前**报出来，`preflightImport()` 判为阻断。
 *  ② `o_agentWorkData.data` 仍是 `varchar(255)`，而它存的是 productionAgent 的 JSON：
 *     实测老库该列 **最大 103,624 字符、5 行超过 255**（`scripts/export-sqlite.cjs` 的 manifest
 *     `oversizeValues`）。sqlite 不强制 varchar 长度所以看不出问题，**真 MySQL 会
 *     `Data too long for column 'data'`** → 这是本 Task 必须如实上报的数据/结构缺口
 *     （处置需要拍板：放宽列 或 接受丢这 5 行，见 `--allow-oversize`）。
 *  ③ `memories.isolationKey` 在 `001_schema` 里是 `varchar(191)`：老库实测 max 31 → 安全，
 *     同一条 `oversizeValues` 机械检查会持续守住它。
 *
 * 超长值判据不写死 255：`preflightImport()` 从**目标库**的 `columnInfo()` 读
 * `{type, maxLength}`，只有 `varchar(N)` 这类有长度上限的列才检查。
 */
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

/**
 * 搬迁范围（与 spec 附录 A 的 29 张表相比：退役的两张不搬，**`o_user` 也不搬**）。
 *
 * ⚠⚠ **【Phase 1c Task 1】`o_user` 已从搬迁范围移除**（与 `scripts/export-sqlite.cjs` 的
 *   `TABLES` 逐名一致，两边由测试钉住）：老库的 `o_user` 是明文口令的 3 列表
 *   （`id` / `name` / `password`），而 `005_accounts` 之后它是 §7.1 的 10 列
 *   （`username` / `passwordHash` / `role` / …）。按"同名同列"导入会因
 *   `username` / `passwordHash` 是 NOT NULL 且无默认值而**整表插不进去**
 *   （实测 `SQLITE_CONSTRAINT_NOTNULL`）；而"强插成功"更糟 —— 那等于把明文口令带进新系统。
 *   账号的迁移归 `005_accounts` 的 up（老行 → disabled + 空哈希）+ bootstrap 流程。
 */
export const LEGACY_TABLES = [
  "o_project", "o_artStyle", "o_agentDeploy", "o_setting", "o_tasks", "o_prompt", "o_modelPrompt",
  "o_novel", "o_event", "o_eventChapter", "o_script", "o_assets", "o_image", "o_storyboard",
  "o_agentWorkData", "o_video", "o_videoTrack", "o_vendorConfig", "o_imageFlow",
  "o_assets2Storyboard", "o_scriptAssets", "memories", "o_assetsRole2Audio", "o_segment", "o_shot", "o_shotAssets",
] as const;

/** JS 安全整数上界（2^53−1）。 */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * **平台种子表**（`002_platform_seed` 的四张表）。它们是"进空库"不变式的唯一例外：
 * `002` 之后这四张表已经有行，导入时必须逐行"跳过已存在"，不得 upsert（见文件头交接条款）。
 */
export const SEED_TABLES = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"] as const;

/**
 * 种子表的**身份键**（与 `002_platform_seed.ts` 的 `seedTable(..., keyOf)` 逐字一致）。
 * 判"已存在"必须用同一个键，否则 up 与导入会对同一行给出两种判断。
 */
export const SEED_IDENTITY_KEYS: Record<string, string[]> = {
  o_prompt: ["type"],
  o_agentDeploy: ["key"],
  o_setting: ["key"],
  o_vendorConfig: ["id"],
};

/**
 * 种子表的**主键列**。身份键之外的第二种冲突：老库的 `o_prompt` 行可能换了 `type` 但留着
 * 已被种子占用的 `id` → 直接 insert 会撞主键。此时**必须跳过并报告**（绝不 upsert，
 * 也绝不改种子的 id —— 那会破坏 `down` 的"逐列精确相等"判定）。
 */
export const SEED_PRIMARY_KEYS: Record<string, string[]> = {
  o_prompt: ["id"],
  o_agentDeploy: ["id"],
  o_setting: ["key"],
  o_vendorConfig: ["id"],
};

/**
 * **绝不导回目标库的 `o_setting` 键**：`tokenKey` 是 JWT 密钥，Phase 1c 才把它统一到配置
 * （`MIWO_JWT_SECRET`）。老库那一行留在老库里；导回去会让 `002_platform_seed` 的显式断言当场红。
 */
export const NEVER_IMPORT_SETTING_KEYS = ["tokenKey"];

/** 唯一键查重清单（与 `001_schema` 的 unique 约束一一对应）。 */
export const UNIQUE_KEYS: Record<string, string[]> = {
  o_agentWorkData: ["projectId", "episodesId", "key"],
  o_segment: ["scriptId", "segmentIndex"],
};

// ---------------------------------------------------------------------------
// 计划（plan）
// ---------------------------------------------------------------------------

export interface TablePlan {
  table: string;
  sourceExists: boolean;
  targetExists: boolean;
  sourceColumns: string[];
  targetColumns: string[];
  /** 实际会写入的列 = 源 ∩ 目标 */
  columns: string[];
  /** 源有但目标没有的列（会被丢弃） */
  droppedSourceColumns: string[];
  /** 目标有但源没有的列（会留 NULL） */
  missingTargetColumns: string[];
  sourceRows: number | null;
  targetRows: number | null;
  /**
   * 目标库的列声明类型（`knex.columnInfo()` 的 `type`，例如 sqlite `integer`/`bigint`、
   * mysql `bigint`/`varchar`）。用来决定哪些列要做【Ruling 43】的数值归一化。
   */
  targetColumnTypes?: Record<string, string>;
  /** 目标库的列长度上限（`knex.columnInfo()` 的 `maxLength`，`varchar(N)` 才有值）。 */
  targetColumnMaxLengths?: Record<string, number | null>;
}

export interface DuplicateReport {
  table: string;
  key: string[];
  rows: Array<Record<string, unknown> & { n: number | string }>;
}

type ColumnInfo = Record<string, { type?: string; maxLength?: number | string | null }>;

/**
 * `better-sqlite3` 的 `PRAGMA table_info()` 形状（**只用于脚本/测试的只读取样**，
 * 不参与导入判定）。`pk` 是主键内的序号（复合主键 1..N，0 = 不是主键列）。
 */
export interface SourceColumnInfo {
  name: string;
  type?: string;
  pk?: number;
}

/**
 * 只读源库的最小结构面（**不**依赖 `better-sqlite3` 的类型包：本仓库没装
 * `@types/better-sqlite3`，而"为了一个取样的类型就加一个 devDependency"不值）。
 * 目前只有边界抽样需要"从源库按主键取整行"，用到的就这一个方法。
 */
export interface ReadonlySqliteSource {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

/** 判定"目标库缺表 / 目标库非空 / manifest 有阻断项"这类**写入之前**必须知道的事。 */
export interface PreflightIssue {
  kind:
    | "missing-target-table"
    | "non-empty-target"
    | "duplicate-unique-key"
    | "bad-id"
    | "oversize-value"
    | "numeric-overflow"
    | "numeric-range-unverified"
    | "forbidden-setting-key";
  table: string;
  detail: string;
  /** `true` = 在**当前目标方言**下会真的失败（必须阻断）；`false` = 只登记不阻断。 */
  blocking: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function columns(knex: Knex, table: string): Promise<string[]> {
  const info = (await knex(table).columnInfo()) as ColumnInfo;
  return Object.keys(info);
}

async function columnInfo(knex: Knex, table: string): Promise<ColumnInfo> {
  return (await knex(table).columnInfo()) as ColumnInfo;
}

function typeMap(info: ColumnInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(info)) out[k] = String(v?.type ?? "");
  return out;
}

function maxLengthMap(info: ColumnInfo): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(info)) {
    const raw = v?.maxLength;
    const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    out[k] = Number.isFinite(n) && n > 0 ? n : null;
  }
  return out;
}

async function countRows(knex: Knex, table: string): Promise<number> {
  const row = (await knex(table).count({ n: "*" }).first()) as { n: number | string } | undefined;
  return row ? Number(row.n) : 0;
}

/** 目标方言（只用来决定"超长值是否阻断"这类与方言相关的判断）。 */
export function dialectOfKnex(knex: Knex): "sqlite" | "mysql" {
  const raw = (knex.client as unknown as { dialect?: string; config?: { client?: string } })?.dialect ??
    (knex.client as unknown as { config?: { client?: string } })?.config?.client;
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("sqlite")) return "sqlite";
  if (s.includes("mysql") || s.includes("maria")) return "mysql";
  throw new Error(`[import] 无法判定目标方言，client=${JSON.stringify(raw)}`);
}

/**
 * 会被归一化成 `number` 的列类型（两个方言的 `columnInfo().type` 并集）。
 * ⚠ 判据用**类型**而不是列名：`o_vendorConfig.id` / `memories.id` 这类文本 id 必须保持 string。
 */
const INTEGER_TYPES = new Set([
  "int", "integer", "tinyint", "smallint", "mediumint", "bigint",
  "decimal", "numeric", "float", "double", "real", "unsigned big int",
]);

/**
 * **有界整数**类型在两个方言下的取值范围（`001_schema` 用 `t.integer()`/`u32()` 生成的
 * MySQL 列就是**有符号 int**）。
 *
 * ⚠ 为什么要有这张表（Task 6 实跑发现的**第四个**"只在真 MySQL 暴露"的风险）：
 *    `001_schema` 给 `o_segment.projectId` / `o_shot.projectId` 建的是 `int`，
 *    而它们在老库里存的是 `o_project.id`（= `Date.now()` 毫秒值，实测 1791385147125）。
 *    sqlite 的 INTEGER 是 64 位 → 本机看不出问题；**真 MySQL 严格模式下会
 *    `Out of range value for column`**（非严格模式则静默夹到 2147483647 = 数据损坏）。
 *    这是本 Task 必须如实上报的结构缺口，不是导入脚本能修的。
 */
const INT_RANGES: Record<string, [number, number]> = {
  tinyint: [-128, 127],
  smallint: [-32768, 32767],
  mediumint: [-8388608, 8388607],
  int: [-2147483648, 2147483647],
  integer: [-2147483648, 2147483647],
};

/** 数字串 → number（【Ruling 43】）。只对"目标列声明为整数/浮点"的列生效，且只接受安全整数。 */
export function normalizeValue(value: unknown, numeric: boolean): unknown {
  if (!numeric || value === null || value === undefined) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "" || !/^[+-]?\d+$/.test(t)) return value;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : value;
  }
  if (typeof value === "bigint") {
    if (value <= BigInt(MAX_SAFE) && value >= -BigInt(MAX_SAFE)) return Number(value);
    throw new Error(`[import] 值 ${value.toString()} 超出 JS 安全整数范围（> ${MAX_SAFE}），拒绝归一化：这会静默丢精度`);
  }
  return value;
}

/** 某一行的列子集 + 数值归一化。 */
function pickRow(row: Record<string, unknown>, cols: string[], numeric: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    if (!(c in row)) continue; // 源行缺这一列（NDJSON 里不会出现）→ 交给目标库的默认值/NULL
    out[c] = normalizeValue(row[c], numeric.has(c));
  }
  return out;
}

/**
 * `varchar(N)` 的字符长度检查。**按 Unicode 码点计数**：MySQL 的 VARCHAR 上限是**字符数**，
 * 而 JS 的 `String.length` 是 UTF-16 码元数（补充平面字符 / emoji 会被算成 2）。
 * 单趟扫描、不分配数组 —— 这一列在老库里可能有 10 万字符。
 */
export function charLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) i += 1; // 高代理 + 低代理 = 1 个码点
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 计划（Brief Step 1 的接口）
// ---------------------------------------------------------------------------

export async function planImport(opts: { src: Knex; dst: Knex; tables?: readonly string[] }): Promise<TablePlan[]> {
  const tables = opts.tables ?? LEGACY_TABLES;
  const out: TablePlan[] = [];
  for (const table of tables) {
    const sourceExists = await opts.src.schema.hasTable(table);
    const targetExists = await opts.dst.schema.hasTable(table);
    const sourceColumns = sourceExists ? await columns(opts.src, table) : [];
    const targetColumns = targetExists ? await columns(opts.dst, table) : [];
    const targetSet = new Set(targetColumns);
    const sourceSet = new Set(sourceColumns);
    const info = targetExists ? await columnInfo(opts.dst, table) : {};
    out.push({
      table,
      sourceExists,
      targetExists,
      sourceColumns,
      targetColumns,
      columns: sourceColumns.filter((c) => targetSet.has(c)),
      droppedSourceColumns: sourceColumns.filter((c) => !targetSet.has(c)),
      missingTargetColumns: targetColumns.filter((c) => !sourceSet.has(c)),
      sourceRows: sourceExists ? await countRows(opts.src, table) : null,
      targetRows: targetExists ? await countRows(opts.dst, table) : null,
      targetColumnTypes: typeMap(info),
      targetColumnMaxLengths: maxLengthMap(info),
    });
  }
  return out;
}

/**
 * 目标库里"已经有业务数据"的表（`importExport` 的 preflight 用它拒绝二次导入）。
 *
 * ⚠ `o_setting` 与其余三张**种子表**都在 `002_platform_seed` 之后非空 —— 它们由
 * `importExport` 走"跳过已存在"的路径，所以**不算**"非空"（否则合法搬迁永远起步不了）。
 */
export function nonEmptyBusinessTables(plans: TablePlan[], seedTables: readonly string[] = SEED_TABLES): TablePlan[] {
  const seed = new Set(seedTables);
  return plans.filter(
    (p) => p.targetExists && (p.targetRows ?? 0) > 0 && !seed.has(p.table) && !p.table.startsWith("knex_"),
  );
}

/** 唯一键查重（在源库上跑）。【Ruling 34/41 ①】 */
export async function findDuplicates(src: Knex, plans: TablePlan[]): Promise<DuplicateReport[]> {
  const out: DuplicateReport[] = [];
  for (const p of plans) {
    const key = UNIQUE_KEYS[p.table];
    if (!key || !p.sourceExists) continue;
    const rows = await src(p.table)
      .select(key)
      .count({ n: "*" })
      .groupBy(key)
      .havingRaw("COUNT(*) > 1");
    if (rows.length) out.push({ table: p.table, key, rows: rows as DuplicateReport["rows"] });
  }
  return out;
}

/**
 * 校验所有"看起来像 id"的列都在安全整数范围内（防盗用 `bigNumberStrings:false` 的精度坑）。
 *
 * ⚠ **不加 `limit`**：原来那版 `.limit(10000)` 只看前一万行 —— 越界值恰好落在后面就是
 * "检查过了、其实没查"。sqlite 侧一次全表扫（只 pluck 这一列）在本项目的量级上开销可接受，
 * 而"漏检"是不可接受的。
 */
export async function checkIdRanges(src: Knex, plans: TablePlan[]): Promise<Array<{ table: string; column: string; value: string }>> {
  const bad: Array<{ table: string; column: string; value: string }> = [];
  for (const p of plans) {
    if (!p.sourceExists) continue;
    const cols = p.sourceColumns.filter((c) => c === "id" || /(^|[A-Za-z])Id$/.test(c) || c === "userId" || c === "projectId");
    for (const col of cols) {
      // better-sqlite3 会把超过 2^53 的整数读成 number（已失真）或 string（若声明为 TEXT）
      const rows = (await src(p.table).whereNotNull(col).select(col)) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const v = r[col];
        if (typeof v === "bigint") {
          if (v > BigInt(MAX_SAFE)) bad.push({ table: p.table, column: col, value: v.toString() });
        } else if (typeof v === "string" && /^\d+$/.test(v)) {
          if (Number(v) > MAX_SAFE) bad.push({ table: p.table, column: col, value: v });
        } else if (typeof v === "number" && v > MAX_SAFE) {
          bad.push({ table: p.table, column: col, value: String(v) });
        }
      }
    }
  }
  return bad;
}

/**
 * 导入后扫一遍目标库：所有"**声明为整数类型**的 id 类列"读回来必须还是 `number`
 * （【Ruling 43】的机械断言）。返回漂移项（空 = 类型保真）。
 *
 * ⚠ 判据必须带**目标列类型**这一条：`o_vendorConfig.id`（varchar）/ `memories.id`（UUID varchar）
 *  / `o_agentDeploy.vendorId`（longtext）名字里都有 `id`，但它们的**正确类型就是 string**。
 *  只按列名筛会把它们全报成"类型漂移"（实测踩过：110 处假阳性）。
 * 超过 2^53 的值在 `bigNumberStrings:false` 下会是 string —— 那是 preflight 的 `bad-id` 阻断项。
 */
export async function checkIdTypes(dst: Knex, plans: TablePlan[]): Promise<Array<{ table: string; column: string; value: string; jsType: string }>> {
  const drift: Array<{ table: string; column: string; value: string; jsType: string }> = [];
  for (const p of plans) {
    if (!p.targetExists) continue;
    const numeric = numericColumns(p.targetColumnTypes);
    const cols = p.columns.filter(
      (c) => numeric.has(c) && (c === "id" || /(^|[A-Za-z])Id$/.test(c) || c === "userId" || c === "projectId"),
    );
    for (const col of cols) {
      const rows = (await dst(p.table).whereNotNull(col).select(col)) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const v = r[col];
        const t = typeof v;
        if (t !== "number" && v !== null && v !== undefined) {
          drift.push({ table: p.table, column: col, value: String(v), jsType: t });
        }
      }
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// 逐表导入（Knex → Knex）
// ---------------------------------------------------------------------------

export interface ImportResult {
  table: string;
  rows: number;
  /** 目标表在导入前后的行数（不变式：`after − before === rows`）。 */
  targetRowsBefore: number;
  targetRowsAfter: number;
}

/**
 * 把一张表从 `src` 搬到 `dst`（按 columns 交集，批量插入，保持 id 原值）。
 *
 * 分页口径（与 brief 的差异是**有意**的，且被自身断言兜住）：
 *   · 有 `id` 列 → 按 `id` 游标分页（大表上是 O(n)）；
 *   · 没有 `id` 列（4 张关联表，主键是复合的）→ 按**全部列**排序 + OFFSET 分页。
 *     ⚠ brief 的写法是"永远按 `columns[0]` 游标"：`o_assets2Storyboard.columns[0]` 是
 *     `storyboardId`，**不唯一** → 跨批次边界的行会被静默跳过。所以按 id 游标或 OFFSET 二选一。
 *   · 循环结束后断言 `done === sourceRows` 且 `after − before === done`：任何"静默少搬"当场炸。
 */
export async function importTable(opts: {
  src: Knex;
  dst: Knex;
  plan: TablePlan;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const { src, dst, plan } = opts;
  const batchSize = opts.batchSize ?? 500;
  const before = plan.targetExists ? await countRows(dst, plan.table) : 0;
  if (!plan.sourceExists || !plan.targetExists || !plan.columns.length) {
    return { table: plan.table, rows: 0, targetRowsBefore: before, targetRowsAfter: before };
  }
  const total = plan.sourceRows ?? 0;
  const numeric = numericColumns(plan.targetColumnTypes);
  const cursor = plan.columns.includes("id") ? "id" : null;
  let done = 0;
  let lastId: unknown;

  for (;;) {
    let q = src(plan.table).select(plan.columns);
    if (cursor) {
      q = q.orderBy(cursor, "asc").limit(batchSize);
      if (lastId !== undefined) q = q.where(cursor, ">", lastId as never);
    } else {
      q = q.orderBy(plan.columns).offset(done).limit(batchSize);
    }
    const rows = (await q) as Array<Record<string, unknown>>;
    if (!rows.length) break;
    if (cursor) lastId = rows[rows.length - 1][cursor];
    await dst(plan.table).insert(rows.map((r) => pickRow(r, plan.columns, numeric)));
    done += rows.length;
    opts.onProgress?.(done, total);
  }

  const after = await countRows(dst, plan.table);
  if (total !== null && done !== total) {
    throw new Error(`[import] ${plan.table} 行数不符：源 ${total} 行，只搬了 ${done} 行（分页丢行？）`);
  }
  if (after - before !== done) {
    throw new Error(
      `[import] ${plan.table} 写入行数与目标表增量不符：写入 ${done} 行，目标表 ${before} → ${after}（有冲突/被覆盖？）`,
    );
  }
  return { table: plan.table, rows: done, targetRowsBefore: before, targetRowsAfter: after };
}

/** 从 `columnInfo().type` 推出"需要数值归一化"的列集合。 */
export function numericColumns(types: Record<string, string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!types) return out;
  for (const [col, t] of Object.entries(types)) {
    if (INTEGER_TYPES.has(String(t).toLowerCase())) out.add(col);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 导出物（NDJSON + manifest）—— 搬迁链真正走的那条路
// ---------------------------------------------------------------------------

export interface ExportTableRecord {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
  columns: string[];
}

export interface ExportManifest {
  generatedAt: string;
  source: string;
  /** 导出前 / 导出后的源库 sha256：必须相等（【Ruling 1】导出对源库只读）。 */
  sourceSha256Before?: string;
  sourceSha256After?: string;
  sourceSideEffects?: { freshCompanionFiles: string[]; note: string };
  tables: ExportTableRecord[];
  duplicates: Array<{ table: string; key: string[]; rows: Array<Record<string, unknown>> }>;
  badIds: Array<{ table: string; column: string; value: string }>;
  /** 【Ruling 34/41】逐列长度体检（只记有 `varchar(N)` 声明或已知敏感的列）。 */
  columnStats?: Record<string, { declaredType: string; maxLength: number | null; maxChars: number | null; overDeclaredLength: number }>;
  oversizeValues?: Array<{ table: string; column: string; declaredType: string; declaredLength: number; maxChars: number; rowsOver: number }>;
  /** 执行本次导出的实现版本，便于日后复核口径没变。 */
  exporter?: string;
}

export function readExportManifest(dir: string): ExportManifest {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) throw new Error(`[import] 缺 ${p}：先跑 scripts/export-sqlite.cjs`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as ExportManifest;
}

/** 读一张表的 NDJSON（空表 = 0 行）。 */
export function readExportRows(dir: string, table: string): Array<Record<string, unknown>> {
  const p = path.join(dir, `${table}.ndjson`);
  if (!fs.existsSync(p)) throw new Error(`[import] 缺导出文件 ${p}`);
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`[import] ${table}.ndjson:${i + 1} 不是合法 JSON（导出物被截断了？）：${(e as Error).message}`);
      }
    });
}

// ---------------------------------------------------------------------------
// preflight（写入之前的全部闸门）
// ---------------------------------------------------------------------------

/** 由 manifest + 目标库的 columnInfo 拼出计划（**不读源库**）。 */
export async function plansFromManifest(dst: Knex, manifest: ExportManifest, only?: string | null): Promise<TablePlan[]> {
  const out: TablePlan[] = [];
  for (const rec of manifest.tables) {
    if (only && rec.name !== only) continue;
    const targetExists = await dst.schema.hasTable(rec.name);
    const info = targetExists ? await columnInfo(dst, rec.name) : {};
    const targetColumns = Object.keys(info);
    const targetSet = new Set(targetColumns);
    const sourceSet = new Set(rec.columns);
    out.push({
      table: rec.name,
      sourceExists: true,
      targetExists,
      sourceColumns: rec.columns,
      targetColumns,
      columns: rec.columns.filter((c) => targetSet.has(c)),
      droppedSourceColumns: rec.columns.filter((c) => !targetSet.has(c)),
      missingTargetColumns: targetColumns.filter((c) => !sourceSet.has(c)),
      sourceRows: rec.rows,
      targetRows: targetExists ? await countRows(dst, rec.name) : null,
      targetColumnTypes: typeMap(info),
      targetColumnMaxLengths: maxLengthMap(info),
    });
  }
  return out;
}

/**
 * 【Ruling 34/41 ②③】超长值体检：拿**目标库**的 `varchar(N)` 上限去量导出物里的字符串。
 *
 * 为什么必须在这里做而不是等 insert 抛：sqlite 目标**不强制** varchar 长度（永远不炸），
 * 而真 MySQL 在严格模式下直接 `Data too long for column`——那会变成"导入到一半炸掉"。
 * 所以：mysql 目标 = 阻断项；sqlite 目标 = 只登记（本机无 MySQL 时的诚实口径）。
 */
export function oversizeValues(
  plan: TablePlan,
  rows: Array<Record<string, unknown>>,
): Array<{ table: string; column: string; declaredType: string; declaredLength: number; maxChars: number; rowsOver: number }> {
  const out: Array<{ table: string; column: string; declaredType: string; declaredLength: number; maxChars: number; rowsOver: number }> = [];
  const limits: Record<string, number> = {};
  for (const [col, type] of Object.entries(plan.targetColumnTypes ?? {})) {
    const n = plan.targetColumnMaxLengths?.[col] ?? null;
    // `text` / `longtext` / `blob` 的 maxLength 是 null（不走这条）；只有真正带长度上限的列才量。
    if (n && n > 0 && !/text|blob/i.test(type)) limits[col] = n;
  }
  if (!Object.keys(limits).length) return out;
  for (const col of plan.columns) {
    const limit = limits[col];
    if (!limit) continue;
    let maxChars: number | null = null;
    let over = 0;
    for (const row of rows) {
      const v = row[col];
      if (typeof v !== "string") continue;
      // 快速通道：UTF-16 长度都没超，就不用按码点复算（补充平面字符才会少算）。
      const len = v.length > limit ? charLength(v) : v.length;
      if (maxChars === null || len > maxChars) maxChars = len;
      if (len > limit) over += 1;
    }
    if (over > 0) {
      out.push({
        table: plan.table,
        column: col,
        declaredType: plan.targetColumnTypes?.[col] ?? "",
        declaredLength: limit,
        maxChars: maxChars ?? 0,
        rowsOver: over,
      });
    }
  }
  return out;
}

/**
 * 超长值是否**阻断**导入（【Ruling 34/41 ②】）。
 *
 * 抽成纯函数是为了让"MySQL 上会阻断"这条判据**在本机没有 MySQL 时也能被断言**
 * （`tests/legacy-import.test.ts`：`oversizeBlocks("mysql", false) === true`）。
 * 语义：真 MySQL 在严格模式下 `Data too long for column` → 必须在写入前阻断；
 * sqlite 不强制 varchar 长度 → 只登记不阻断。
 */
export function oversizeBlocks(dialect: "sqlite" | "mysql", allowOversize: boolean | undefined): boolean {
  return dialect === "mysql" && !allowOversize;
}

export interface PreflightResult {
  manifest: ExportManifest;
  plans: TablePlan[];
  issues: PreflightIssue[];
  blocking: PreflightIssue[];
  /** 只要 `--allow-oversize` 才会被降级的那类阻断项（便于 CLI 打印处置建议）。 */
  oversize: Array<{ table: string; column: string; declaredType: string; declaredLength: number; maxChars: number; rowsOver: number }>;
  /** 同上，但目标是**有界整数**列（`int` 装不下 `Date.now()` 毫秒值）。 */
  outOfRange: Array<{ table: string; column: string; declaredType: string; lo: number; hi: number; min: number; max: number; rowsOver: number }>;
}

/**
 * 【Task 6 实跑新增】有界整数列的**取值范围**体检。
 *
 * `001_schema` 里 `o_segment.projectId` / `o_shot.projectId` 是 `int`（= `T.integer()`），
 * 而老库这两列存的是 `o_project.id`（`Date.now()` 毫秒值）→ 真 MySQL 上
 * `Out of range value`（严格）或静默夹断（非严格）。sqlite 是 64 位 INTEGER，本机永远不炸。
 * 与 `oversizeValues` 同理：mysql 目标阻断，sqlite 只登记。
 */
export function outOfRangeValues(
  plan: TablePlan,
  rows: Array<Record<string, unknown>>,
): Array<{ table: string; column: string; declaredType: string; lo: number; hi: number; min: number; max: number; rowsOver: number }> {
  const out: Array<{ table: string; column: string; declaredType: string; lo: number; hi: number; min: number; max: number; rowsOver: number }> = [];
  for (const col of plan.columns) {
    const type = String(plan.targetColumnTypes?.[col] ?? "").toLowerCase();
    const range = INT_RANGES[type];
    if (!range) continue;
    const [lo, hi] = range;
    let min = Infinity;
    let max = -Infinity;
    let over = 0;
    for (const row of rows) {
      const raw = row[col];
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) continue;
      if (n < min) min = n;
      if (n > max) max = n;
      if (n < lo || n > hi) over += 1;
    }
    if (over > 0) out.push({ table: plan.table, column: col, declaredType: type, lo, hi, min, max, rowsOver: over });
  }
  return out;
}

export interface PreflightResult {
  manifest: ExportManifest;
  plans: TablePlan[];
  issues: PreflightIssue[];
  blocking: PreflightIssue[];
  /** 只要 `--allow-oversize` 才会被降级的那类阻断项（便于 CLI 打印处置建议）。 */
  oversize: Array<{ table: string; column: string; declaredType: string; declaredLength: number; maxChars: number; rowsOver: number }>;
}

/**
 * 写入之前的全部闸门。顺序刻意如此：
 *   manifest 阻断项 → 缺表 → 非空业务表 → 不可表示的值（超长 / 越界，按方言）。
 * **只读**：本函数不写目标库。
 */
export async function preflightImport(opts: {
  dst: Knex;
  manifest: ExportManifest;
  dir: string;
  only?: string | null;
  allowOversize?: boolean;
}): Promise<PreflightResult> {
  const { dst, manifest } = opts;
  const dialect = dialectOfKnex(dst);
  const plans = await plansFromManifest(dst, manifest, opts.only);
  const issues: PreflightIssue[] = [];

  if (manifest.duplicates?.length) {
    for (const d of manifest.duplicates) {
      issues.push({
        kind: "duplicate-unique-key",
        table: d.table,
        detail: `唯一键 (${d.key.join(", ")}) 有 ${d.rows.length} 组重复 —— 001_schema 的唯一约束会让导入中途失败`,
        blocking: true,
      });
    }
  }
  if (manifest.badIds?.length) {
    for (const b of manifest.badIds) {
      issues.push({
        kind: "bad-id",
        table: b.table,
        detail: `${b.column} = ${b.value} 超出 2^53−1（bigNumberStrings:false 下会丢精度）`,
        blocking: true,
      });
    }
  }

  for (const p of plans) {
    if (!p.targetExists) {
      issues.push({ kind: "missing-target-table", table: p.table, detail: "目标库缺这张表（先跑 db:migrate）", blocking: true });
    }
  }
  for (const p of nonEmptyBusinessTables(plans)) {
    issues.push({
      kind: "non-empty-target",
      table: p.table,
      detail: `目标库该表已有 ${p.targetRows} 行 —— 导入必须是"进空库"（防止二次导入把数据搞成两遍）`,
      blocking: true,
    });
  }

  // "不可表示的值"：`varchar(N)` 超长 或 有界整数越界。
  // mysql 目标下会真的失败（`Data too long` / `Out of range value`）→ 阻断；
  // sqlite 目标不强制长度与位宽 → 只登记（真 MySQL 会失败）。
  // ⚠ 这里会把每张表的 NDJSON 读进来一遍（只为量长度/范围）—— 写入阶段还会再读一次。
  //    本项目的搬迁量级（实测 2,373 行）下这是可接受的代价，换来的是"写入之前就知道会不会炸"。
  const oversize: PreflightResult["oversize"] = [];
  const outOfRange: PreflightResult["outOfRange"] = [];
  for (const p of plans) {
    if (!p.targetExists) continue;
    const rows = readExportRows(opts.dir, p.table);
    for (const o of oversizeValues(p, rows)) oversize.push(o);
    // ⚠ 位宽体检**只在 mysql 目标上做**：sqlite 的 `columnInfo()` 把 `t.u64()` / `pk()` / `t.ms()`
    //    全都报成 `integer`/`bigint`，与真正的 MySQL `int` **不可区分** —— 在 sqlite 上跑必然
    //    把 10 个 `bigint unsigned` 外键列报成"越界"（实测假阳性 13 条）。判据不能靠猜。
    if (dialect === "mysql") for (const o of outOfRangeValues(p, rows)) outOfRange.push(o);
  }
  if (dialect !== "mysql" && plans.some((p) => p.targetExists)) {
    issues.push({
      kind: "numeric-range-unverified",
      table: "(全部)",
      detail:
        "目标不是 MySQL：sqlite 的列类型无法表达 MySQL 位宽（`t.u64()` 在 sqlite 上也是 `integer`），" +
        "所以**整数越界体检未执行** —— 真 MySQL 目标上才会跑 `outOfRangeValues()`" +
        "（已知它会命中 `o_segment.projectId` / `o_shot.projectId`，见根 README 的「真实数据搬迁」一节）",
      blocking: false,
    });
  }
  const blocks = oversizeBlocks(dialect, opts.allowOversize);
  for (const o of oversize) {
    issues.push({
      kind: "oversize-value",
      table: o.table,
      detail:
        `${o.column} 是 ${o.declaredType}(${o.declaredLength})，导出物里有 ${o.rowsOver} 行超长（最大 ${o.maxChars} 字符）` +
        (dialect === "mysql" ? " —— MySQL 严格模式下 Data too long，必须先放宽列或接受丢这些行" : " —— sqlite 不强制 varchar 长度，本机不阻断（真 MySQL 会失败）"),
      blocking: blocks,
    });
  }
  for (const o of outOfRange) {
    issues.push({
      kind: "numeric-overflow",
      table: o.table,
      detail:
        `${o.column} 是 ${o.declaredType}（范围 ${o.lo}..${o.hi}），导出物里取值 ${o.min}..${o.max}，${o.rowsOver} 行越界` +
        (dialect === "mysql" ? " —— MySQL 严格模式下 Out of range value，必须先放宽列或接受丢这些行" : " —— sqlite 的 INTEGER 是 64 位，本机不阻断（真 MySQL 会失败）"),
      blocking: blocks,
    });
  }

  const blocking = issues.filter((i) => i.blocking);
  return { manifest, plans, issues, blocking, oversize, outOfRange };
}

// ---------------------------------------------------------------------------
// 写入（NDJSON → 目标库）
// ---------------------------------------------------------------------------

export interface ImportTableOutcome {
  table: string;
  sourceRows: number;
  read: number;
  inserted: number;
  /** 目标库已有同身份键的行 → 跳过（**绝不 upsert**，见文件头交接条款）。 */
  skippedExisting: number;
  /** 上面那些"跳过"里，**内容与目标行不同**的数量 —— 这一部分老库状态**没有**搬过去，必须有人拍板。 */
  skippedDifferent: number;
  /** 平台键（`o_setting.tokenKey` 之类）绝不导回 → 跳过。 */
  skippedForbidden: number;
  /** 主键被种子行占用、身份键却不同 → 跳过并报告（绝不 upsert）。 */
  conflicts: number;
  /**
   * `--allow-oversize` 下被主动放弃的"**目标列表示不了**"的行数：
   * `varchar(N)` 超长 或 有界整数越界（两者都不截断、不夹断，整行丢弃）。
   */
  skippedUnrepresentable: number;
  targetRowsBefore: number;
  targetRowsAfter: number;
  droppedSourceColumns: string[];
  missingTargetColumns: string[];
}

/**
 * **期望在目标库里不存在**的行（被主动跳过的行）。比对阶段必须能区分
 * "这条源行按设计没搬" 与 "这条源行搬丢了" —— 否则 `compare-db` 会在
 * `o_setting.tokenKey` 这类**必须不搬**的行上永远报红。
 *
 * ⚠ `skipped-different-seed` / `skipped-pk-conflict-seed` 是 **Task 8 Step 1 新增的两类**
 * （全量搬迁时被边界抽样抓到的真实缺口，见 `import.ts` 文件头的交接条款 1）：
 * 种子表里"同身份键但内容不同"的老库行按交接条款**必须跳过、不得 upsert** ——
 * 于是目标库里那一格**永久保留种子值**。跳过是**设计如此**，但"老库状态没搬过去"这句
 * 必须被**逐条登记**出来：这正是不许 `down` 按键删的理由（运营改过的那一行要留住）。
 * 登记之后 `compare-db` 才能把它归因成"按设计的缺席"，而不是既误报红、又悄悄瞒掉。
 *
 * ⚠ **合并审查修复 2：豁免粒度是 (行, 列)，不是整行。** 上面两类**必须**给出 `columns`
 * （= 导入那一刻源行与目标已存在行的**差异列集合**），比对阶段只对这些格子放行 ——
 * 整行豁免会把**同一行里别的列**的真实差异一起吃掉（那是"比对了但没比出来"的假绿）。
 * 用可辨识联合而不是可选字段，是为了让"忘记给列"变成**编译错误**：
 *   · 只有 `forbidden-setting-key` / `skipped-unrepresentable` / `pk-conflict` 这三个"整行不搬"
 *     的原因才允许不带 `columns`（它们不是"保留目标侧那一格的值"，而是整行缺席）。
 */
export type ExpectedAbsent =
  | {
      table: string;
      pk: Record<string, unknown>;
      reason: "forbidden-setting-key" | "skipped-unrepresentable" | "pk-conflict";
    }
  | {
      table: string;
      pk: Record<string, unknown>;
      reason: "skipped-different-seed" | "skipped-pk-conflict-seed";
      /** **只有这些列**允许与源不同（= 目标侧保留的是"导入前已经在那里的那一行"的值）。 */
      columns: string[];
    };

/** `expectedAbsent` 的逐条登记的条数上限（超长行可能有上万条时不让报告无界膨胀）。 */
export const EXPECTED_ABSENT_CAP = 2000;

export interface ImportExportResult {
  dialect: "sqlite" | "mysql";
  applied: boolean;
  plans: TablePlan[];
  issues: PreflightIssue[];
  blocking: PreflightIssue[];
  oversize: PreflightResult["oversize"];
  outOfRange: PreflightResult["outOfRange"];
  outcomes: ImportTableOutcome[];
  expectedAbsent: ExpectedAbsent[];
  /** 导入后 id 类列的类型漂移（空 = 【Ruling 43】类型保真）。 */
  idTypeDrift: Array<{ table: string; column: string; value: string; jsType: string }>;
}

function forbiddenSettingRow(table: string, row: Record<string, unknown>): boolean {
  if (table !== "o_setting") return false;
  return NEVER_IMPORT_SETTING_KEYS.includes(String(row.key));
}

/**
 * 源行 vs 目标里**已经存在**的那一行 → **差异列集合**（合并审查修复 2）。
 *
 * 这个集合就是 `ExpectedAbsent.columns` 的来源，也是比对阶段 `accountedMismatches` 的**粒度**：
 * 只放行"导入那一刻就不同的那些格子"。整行豁免会把同一行里别的列的真实差异一起吃掉 ——
 * 例如 `o_vendorConfig.id='volcengine'` 登记了 `enable`，若目标那一行的 `models` 后来被改坏了，
 * 整行豁免会让它**静默通过**；按列登记则照样判红。
 *
 * 判定口径与 `importExport` 里"内容相同即跳过"的判定**同一套**（`valuesEqual` + 目标列类型推出的
 * `numericColumns`），所以不会出现"导入说相同、登记说不同"的自相矛盾。
 */
function differingColumns(
  row: Record<string, unknown>,
  existing: Record<string, unknown>,
  columns: string[],
  numeric: Set<string>,
): string[] {
  const incoming = pickRow(row, columns, numeric);
  return Object.entries(incoming)
    .filter(([k, v]) => !valuesEqual(v, existing[k]).equal)
    .map(([k]) => k);
}

/**
 * 把 `export-sqlite.cjs` 的产物写进目标库。
 *
 * `apply=false`（默认）只做 preflight 并打印计划 —— dry-run 是默认值，`--apply` 才写。
 * **绝不做 upsert / replace / 清表重灌**：种子表逐行"不存在才插"，其余表批量 insert
 * （目标表在 preflight 里已证明是空的）。
 */
export async function importExport(opts: {
  dst: Knex;
  dir: string;
  manifest?: ExportManifest;
  only?: string | null;
  apply: boolean;
  batchSize?: number;
  allowOversize?: boolean;
  log?: (msg: string) => void;
}): Promise<ImportExportResult> {
  const log = opts.log ?? (() => {});
  const manifest = opts.manifest ?? readExportManifest(opts.dir);
  const dialect = dialectOfKnex(opts.dst);
  const pf = await preflightImport({ dst: opts.dst, manifest, dir: opts.dir, only: opts.only, allowOversize: opts.allowOversize });
  const { plans, issues, blocking } = pf;

  log(`[import] 目标方言：${dialect}`);
  log("[import] 计划：");
  for (const p of plans) {
    const warn = p.droppedSourceColumns.length ? `  ⚠ 丢弃源列: ${p.droppedSourceColumns.join(",")}` : "";
    const extra = p.missingTargetColumns.length ? `  ⚠ 目标多列(留 NULL): ${p.missingTargetColumns.join(",")}` : "";
    log(`  ${p.table.padEnd(24)}${String(p.sourceRows).padStart(8)} 行 → ${p.columns.length} 列${warn}${extra}`);
  }
  for (const i of issues) log(`[import] ${i.blocking ? "✘ 阻断" : "⚠ 登记"} [${i.kind}] ${i.table}: ${i.detail}`);

  if (blocking.length) {
    log(`[import] 拒绝导入：${blocking.length} 条阻断项（见上）`);
    return { dialect, applied: false, plans, issues, blocking, oversize: pf.oversize, outOfRange: pf.outOfRange, outcomes: [], expectedAbsent: [], idTypeDrift: [] };
  }

  const outcomes: ImportTableOutcome[] = [];
  const expectedAbsent: ExpectedAbsent[] = [];
  const noteAbsent = (e: ExpectedAbsent): void => {
    if (expectedAbsent.length < EXPECTED_ABSENT_CAP) expectedAbsent.push(e);
  };
  if (!opts.apply) {
    log("[import] DRY-RUN（加 --apply 才写）");
    return { dialect, applied: false, plans, issues, blocking, oversize: pf.oversize, outOfRange: pf.outOfRange, outcomes, expectedAbsent, idTypeDrift: [] };
  }

  /** `--allow-oversize` 下要主动放弃的行（**整行丢弃**，绝不截断/夹断 —— 那会静默改数据）。 */
  const oversizeLimits = new Map<string, number>();
  const rangeLimits = new Map<string, [number, number]>();
  if (opts.allowOversize) {
    for (const o of pf.oversize) oversizeLimits.set(`${o.table}.${o.column}`, o.declaredLength);
    for (const o of pf.outOfRange) rangeLimits.set(`${o.table}.${o.column}`, [o.lo, o.hi]);
  }
  const isUnrepresentable = (table: string, row: Record<string, unknown>): boolean => {
    for (const [k, limit] of oversizeLimits) {
      const dot = k.lastIndexOf(".");
      if (k.slice(0, dot) !== table) continue;
      const v = row[k.slice(dot + 1)];
      if (typeof v === "string" && charLength(v) > limit) return true;
    }
    for (const [k, [lo, hi]] of rangeLimits) {
      const dot = k.lastIndexOf(".");
      if (k.slice(0, dot) !== table) continue;
      const raw = row[k.slice(dot + 1)];
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (Number.isFinite(n) && (n < lo || n > hi)) return true;
    }
    return false;
  };

  const batchSize = opts.batchSize ?? 500;
  for (const plan of plans) {
    const rows = readExportRows(opts.dir, plan.table);
    if (plan.sourceRows !== null && rows.length !== plan.sourceRows) {
      throw new Error(`[import] ${plan.table} 导出物行数与 manifest 不符：manifest ${plan.sourceRows}，文件 ${rows.length}`);
    }
    const numeric = numericColumns(plan.targetColumnTypes);
    const before = await countRows(opts.dst, plan.table);
    const outcome: ImportTableOutcome = {
      table: plan.table,
      sourceRows: plan.sourceRows ?? rows.length,
      read: rows.length,
      inserted: 0,
      skippedExisting: 0,
      skippedDifferent: 0,
      skippedForbidden: 0,
      conflicts: 0,
      skippedUnrepresentable: 0,
      targetRowsBefore: before,
      targetRowsAfter: before,
      droppedSourceColumns: plan.droppedSourceColumns,
      missingTargetColumns: plan.missingTargetColumns,
    };
    const isSeed = (SEED_TABLES as readonly string[]).includes(plan.table);
    // 期望"目标库里没有"的行要用**主键**（不是身份键）登记，比对阶段才定位得到。
    const pkCols = SEED_PRIMARY_KEYS[plan.table] ?? ["id"];
    const pkOf = (row: Record<string, unknown>): Record<string, unknown> => pickRow(row, pkCols, numeric);

    if (isSeed) {
      const identity = SEED_IDENTITY_KEYS[plan.table] ?? ["id"];
      const pk = SEED_PRIMARY_KEYS[plan.table] ?? identity;
      const samePkAsIdentity = JSON.stringify(pk) === JSON.stringify(identity);
      for (const row of rows) {
        if (forbiddenSettingRow(plan.table, row)) {
          outcome.skippedForbidden += 1;
          noteAbsent({ table: plan.table, pk: pkOf(row), reason: "forbidden-setting-key" });
          continue;
        }
        if ((oversizeLimits.size || rangeLimits.size) && isUnrepresentable(plan.table, row)) {
          outcome.skippedUnrepresentable += 1;
          noteAbsent({ table: plan.table, pk: pkOf(row), reason: "skipped-unrepresentable" });
          continue;
        }
        const ident = pickRow(row, identity, numeric);
        // 身份键列在这一行里缺失 → `.where({})` 会退化成"匹配任意一行"（静默误判"已存在"）。
        // 宁可报告成冲突也不能猜。实测老库不该出现，但缺列时必须是响的。
        if (!Object.keys(ident).length) {
          outcome.conflicts += 1;
          noteAbsent({ table: plan.table, pk: pkOf(row), reason: "pk-conflict" });
          log(`  ⚠ ${plan.table}：有一行缺身份键 (${identity.join(",")})，跳过`);
          continue;
        }
        const existing = (await opts.dst(plan.table).where(ident).first()) as Record<string, unknown> | undefined;
        if (existing) {
          outcome.skippedExisting += 1;
          // ⚠ 关键的可观测性：同身份键但**内容不同**的老库行在这里被丢弃（按交接条款"已存在 → 跳过"，
          //    不得 upsert）。数量必须报出来，否则"用户的老状态没搬过去"是静默的。
          //
          // ⚠ 合并审查修复 2：登记的是**差异列集合**（(行,列) 粒度），不是"整行豁免" ——
          //    整行豁免会把同一行里别的列的真实差异一起吃掉。见 `ExpectedAbsent` 的注释。
          const differing = differingColumns(row, existing, plan.columns, numeric);
          if (differing.length) {
            outcome.skippedDifferent += 1;
            // **逐条**登记（不只是计数）：`compare-db` 靠它把"这一格按设计没搬"与"搬丢了"分开。
            noteAbsent({ table: plan.table, pk: pkOf(row), reason: "skipped-different-seed", columns: differing });
            // 逐行打印：这是"老库状态没搬过去"的**唯一**证据面（实测命中 1 行：
            // `o_vendorConfig.id='volcengine'` 老库 `enable=1`、种子 `enable=0`）。
            log(
              `  ⚠ ${plan.table} ${JSON.stringify(pkOf(row))} 与种子同身份键但内容不同 → 保留种子值` +
                `（差异列：${differing.join(",")}；老库那一行未搬，需拍板）`,
            );
          }
          continue;
        }
        if (!samePkAsIdentity) {
          const pkWhere = pickRow(row, pk, numeric);
          const occupied = (await opts.dst(plan.table).where(pkWhere).first()) as Record<string, unknown> | undefined;
          if (occupied) {
            outcome.conflicts += 1;
            // 目标那一行是**另一个实体**（身份键都不同）→ 差异列可能很多，同样逐列登记。
            // 登记之后，(行,列) 粒度的豁免只覆盖"导入那一刻就不同的格子"；此后目标行再被别人
            // 改出**新的**差异，比对阶段会照旧判红。
            noteAbsent({
              table: plan.table,
              pk: pkOf(row),
              reason: "skipped-pk-conflict-seed",
              columns: differingColumns(row, occupied, plan.columns, numeric),
            });
            continue;
          }
        }
        await opts.dst(plan.table).insert(pickRow(row, plan.columns, numeric));
        outcome.inserted += 1;
      }
    } else {
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        let kept = chunk;
        if (oversizeLimits.size || rangeLimits.size) {
          kept = chunk.filter((row) => !isUnrepresentable(plan.table, row));
          for (const dropped of chunk) {
            if (isUnrepresentable(plan.table, dropped)) noteAbsent({ table: plan.table, pk: pkOf(dropped), reason: "skipped-unrepresentable" });
          }
          outcome.skippedUnrepresentable += chunk.length - kept.length;
        }
        if (!kept.length) continue;
        await opts.dst(plan.table).insert(kept.map((r) => pickRow(r, plan.columns, numeric)));
        outcome.inserted += kept.length;
      }
    }

    outcome.targetRowsAfter = await countRows(opts.dst, plan.table);
    const accounted = outcome.inserted + outcome.skippedExisting + outcome.skippedForbidden + outcome.conflicts + outcome.skippedUnrepresentable;
    if (accounted !== outcome.read) {
      throw new Error(
        `[import] ${plan.table} 行数记账不符：读 ${outcome.read} 行，写入 ${outcome.inserted} + 跳过 ${accounted - outcome.inserted} = ${accounted}`,
      );
    }
    if (outcome.targetRowsAfter - outcome.targetRowsBefore !== outcome.inserted) {
      throw new Error(
        `[import] ${plan.table} 写入行数与目标表增量不符：写入 ${outcome.inserted}，目标表 ${outcome.targetRowsBefore} → ${outcome.targetRowsAfter}`,
      );
    }
    const skipNote = outcome.skippedExisting ? `，跳过已存在 ${outcome.skippedExisting}` : "";
    const diffNote = outcome.skippedDifferent ? `（其中内容不同 ${outcome.skippedDifferent} —— 老库状态未搬迁，需拍板）` : "";
    const forbiddenNote = outcome.skippedForbidden ? `，拒绝导回 ${outcome.skippedForbidden}（${NEVER_IMPORT_SETTING_KEYS.join("/")}）` : "";
    const conflictNote = outcome.conflicts ? `，⚠ 主键冲突跳过 ${outcome.conflicts}` : "";
    const oversizeNote = outcome.skippedUnrepresentable ? `，⚠ 超长/越界丢弃 ${outcome.skippedUnrepresentable}` : "";
    log(`  ✔ ${plan.table}：写入 ${outcome.inserted} 行${skipNote}${diffNote}${forbiddenNote}${conflictNote}${oversizeNote}，目标表现有 ${outcome.targetRowsAfter} 行`);
    outcomes.push(outcome);
  }

  const idTypeDrift = await checkIdTypes(opts.dst, plans);
  for (const d of idTypeDrift) log(`[import] ✘ 类型漂移 ${d.table}.${d.column} = ${d.value}（读到 ${d.jsType}，应为 number）`);
  if (!idTypeDrift.length) log("[import] 【Ruling 43】id 类列类型保真：读回来全是 number");

  return { dialect, applied: true, plans, issues, blocking, oversize: pf.oversize, outOfRange: pf.outOfRange, outcomes, expectedAbsent, idTypeDrift };
}

// ---------------------------------------------------------------------------
// 两库比对（行数 + 抽样深比较）
// ---------------------------------------------------------------------------

export interface SourceSample {
  /** 主键列名（`PRAGMA table_info` 的 pk 标记）；复合主键就是多列。 */
  pk: string[];
  rows: Array<Record<string, unknown>>;
}
export type SourceSamples = Record<string, SourceSample>;

export interface SampleMismatch {
  pk: Record<string, unknown>;
  column: string;
  source: unknown;
  target: unknown;
  reason: string;
}

/**
 * 源抽样行在目标里**存在**、但某些列与源不同 —— 而这些列是被明确拍板"按设计不搬"的。
 *
 * 目前唯一来源：种子表里"同身份键但内容不同"的老库行（`skipped-different-seed`）——
 * 导入按交接条款保留种子值，于是那一格**必然**与源不同（实测 `o_vendorConfig.id='volcengine'`
 * 老库 `enable=1` vs 种子 `0`）。
 *
 * ⚠ 为什么不是"直接不报"：报红会把**设计如此**说成缺陷（下一个审查者会去修一个不存在的 bug），
 * 而不报就是**静默**（连"老库这一格没搬"都看不出来）。所以走**第三条路**：逐条登记进报告、
 * 在打印里显式列出、并且**只对登记过的 (行, 列) 组合**生效 —— 同一行别的列不一致照样判红。
 *
 * ⚠ **实现口径（合并审查修复 2）**：登记的那份 `columns` 是**导入那一刻**算出来的差异列集合
 * （`differingColumns()`），比对阶段用 `accountedColumns` 按 `(行签名 → 列集合)` 逐列查。
 * 不是"这一行登记过就整行放行" —— 整行豁免会把同一行里别的列的真差异一起吃掉。
 */
export interface AccountedMismatch extends SampleMismatch {
  /** 为什么这一格允许不同（来自 `expectedAbsent` 的登记原因）。 */
  accountedBy: ExpectedAbsent["reason"];
}

/** 源行在目标库里找不到时的归因（只有 `unexpected` 才算差异）。 */
export interface MissingInTarget {
  pk: Record<string, unknown>;
  reason: ExpectedAbsent["reason"] | "unexpected";
}

export interface TableCompare {
  table: string;
  sourceRows: number;
  targetRows: number;
  /** 有导入结果时 = `targetRowsBefore + inserted`（导入后应有的行数）；否则 = 源行数。 */
  expectedTargetRows: number;
  rowsMatch: boolean;
  /** 目标 − 源。非 0 **不一定是错**：`o_setting.tokenKey` 按裁定必须不搬、超长行可能被主动丢。
   *  归因见本行的 `accounted`。 */
  rowsDeltaVsSource: number;
  accounted?: ImportTableOutcome;
  samplesChecked: number;
  /** 均匀抽样（首/中/末 + 均匀分布）命中的行数。 */
  uniformPicks: number;
  /** **边界抽样**（每列最长文本 / 数值极值）命中的行数 —— Task 8 Step 1 的分层那一层。 */
  extremePicks: number;
  missingInTarget: MissingInTarget[];
  mismatches: SampleMismatch[];
  /** 被登记为"按设计不同"的单元格（见 `AccountedMismatch`）。它们**不**让 `ok` 变 false，
   *  但必须在报告里逐条可见 —— 打印时也照列，不许只留在 JSON 里。 */
  accountedMismatches: AccountedMismatch[];
}

export interface CompareReport {
  generatedAt: string;
  target: string;
  dialect: "sqlite" | "mysql";
  tables: TableCompare[];
  ok: boolean;
  notes: string[];
}

/**
 * 值相等判据（抽样深比较用）。
 *
 * 刻意**不做**的两件事：
 *  · **不 trim 字符串**：MySQL 的 ci collation / 尾随空格语义与 sqlite 不同（【Ruling 77】），
 *    比较器把差异吃掉就等于把"MySQL 上回滚判定会变"这件事藏起来。差异必须报出来。
 *  · **不把数字串当数字**：类型漂移由 `checkIdTypes()` 单独断言，比较器只比"值"。
 * 会做的两件事：
 *  · `bigint` → 安全范围内取 number（同一个值在两个驱动下的合法表示）；
 *  · 非整数浮点用 1e-6 相对容差（MySQL `float` 与 sqlite `REAL` 的尾数差，属表示差异不是数据差异）。
 */
export function valuesEqual(a: unknown, b: unknown): { equal: boolean; reason: string } {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return { equal: na === nb, reason: na === nb ? "" : "一侧为 NULL" };
  if (typeof na === "bigint" || typeof nb === "bigint") {
    const x = typeof na === "bigint" ? na : BigInt(Math.trunc(Number(na)));
    const y = typeof nb === "bigint" ? nb : BigInt(Math.trunc(Number(nb)));
    return { equal: x === y, reason: x === y ? "" : "bigint 数值不同" };
  }
  if (typeof na === "boolean" || typeof nb === "boolean") {
    const x = na ? 1 : 0;
    const y = nb ? 1 : 0;
    return { equal: x === y, reason: x === y ? "" : "布尔表示不同" };
  }
  if (typeof na === "number" && typeof nb === "number") {
    if (Number.isInteger(na) && Number.isInteger(nb)) return { equal: na === nb, reason: na === nb ? "" : "整数不同" };
    const scale = Math.max(Math.abs(na), Math.abs(nb), 1);
    const equal = Math.abs(na - nb) / scale <= 1e-6;
    return { equal, reason: equal ? "" : `浮点差超容差（src ${na} vs dst ${nb}）` };
  }
  if (Buffer.isBuffer(na) || Buffer.isBuffer(nb)) {
    const x = Buffer.isBuffer(na) ? na.toString("hex") : String(na);
    const y = Buffer.isBuffer(nb) ? nb.toString("hex") : String(nb);
    return { equal: x === y, reason: x === y ? "" : "二进制内容不同" };
  }
  if (typeof na === "object" || typeof nb === "object") {
    const x = JSON.stringify(na);
    const y = JSON.stringify(nb);
    return { equal: x === y, reason: x === y ? "" : "结构化值不同" };
  }
  return { equal: na === nb, reason: na === nb ? "" : `类型/值不同（src ${typeof na} vs dst ${typeof nb}）` };
}

/**
 * **比对口径**的等价判据（= `valuesEqual` + 两条显式容忍），Task 8 Step 1。
 *
 * 与 `valuesEqual` 分开的原因：那一条是**生产函数**（导入侧"跳过已存在"的逐行判定、
 * 回滚判定都间接依赖它的严格性），它必须继续把 `"0"` 与 `0`、`"a "` 与 `"a"` 判成不同；
 * 而**比对报告**这一侧的口径由 brief 给出：容忍 `null`/`undefined` 同义、
 * 容忍 `0`/`"0"` 这类"同值的两种合法字符串表示"。
 *
 * 两条容忍都**只加一条后路**：先跑 `valuesEqual`，只在它判不相等时才回退到
 * `String(a) === String(b)`。所以
 *   · `"a "` vs `"a"` → `String` 也不等 → **仍然报差异**（【Ruling 77】不许被吃掉）；
 *   · `"A"` vs `"a"` → 仍然报差异（大小写差异不许被 ci collation 吃掉）；
 *   · `"0"` vs `0` → 回退命中 → 不算差异（brief 明确要求）。
 * ⚠ **结构化值（object）不走回退**：`String({})` 恒是 `"[object Object]"`，
 *   那会让两行**完全不同**的 JSON 悄悄判等。
 */
export function equivalentForCompare(a: unknown, b: unknown): { equal: boolean; reason: string } {
  const strict = valuesEqual(a, b);
  if (strict.equal) return strict;
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return strict; // null 只与 null 同义
  if (typeof na === "object" || typeof nb === "object") return strict;
  if (String(na) === String(nb)) return { equal: true, reason: "" };
  return strict;
}

/** 一列被抽中的"边界行"（每个指标只取 1 行，见 `extremeRowPicks`）。 */
export interface ExtremePick {
  column: string;
  /**
   * `longest-text` = 该列存过的最长文本所在的行；`max-number` / `min-number` = 数值极值行。
   * 文字口径按**码点数**（与 `charLength` 一致），所以"最长"就是真最长。
   */
  metric: "longest-text" | "max-number" | "min-number";
  /** 该列在这一行上的原始值（证据用）。 */
  value: unknown;
  /** 该行的主键（与 `source-samples.json` 的 `pk` 列名一致）。 */
  pk: Record<string, unknown>;
}

/** `columnInfo().type` 里属于"文本"的那些（两个方言的并集）。 */
function isTextType(type: string): boolean {
  return /char|text|clob/i.test(type);
}

/**
 * **分层抽样**（Task 8 Step 1 的核心补强）：在"首/中/末 + 均匀分布"之外，
 * 再**定点**抽"每张表每一列的最长文本行 / 数值极值行"。
 *
 * 为什么必须有这一层：均匀抽样抽不中"边界"。老库里最关键的几条数据恰好是边界 ——
 * `o_agentWorkData.data` 最长 **103,624 字符**（一次性把 longtext 的往返验掉）、
 * `memories.content` / `o_script.content` 的万字长文、`o_project.id` 的 `Date.now()` 毫秒值、
 * `o_shot.duration` 这类 `float(8,2)`。只靠"抽 8 行"能全绿，却**从没读过那 5 行超长数据** ——
 * 那是"抽样覆盖不足的假绿"，不是"数据一致"。
 *
 * 取数用 SQL 而不是把整表读进内存：只 `SELECT col ORDER BY LENGTH(col) DESC LIMIT 1` /
 * `MAX(col)` / `MIN(col)`，每列 3 条常量级查询（本项目**搬迁范围** 26 张表 / **204** 列实测秒级；整库口径 29 表 / 219 列 —— 差是退役两表 + `o_user`。⚠ 别用目标 schema 的 226 列，那是第三个口径）。
 * `MAX/MIN` 在 SQLite 的**列亲和性**下按数值比较（TEXT 列里混的数字串会被当数字比）；
 * 那对"抽边界"这个目的无害：抽中的必须是**真实存在的行**，而取行用主键回来取，不做任何转换。
 *
 * ⚠ 源库以**只读**打开（调用方负责），本函数只发 SELECT。
 */
export async function extremeRowPicks(
  src: Knex,
  manifest: Pick<ExportManifest, "tables">,
  samples: SourceSamples,
): Promise<Record<string, ExtremePick[]>> {
  const out: Record<string, ExtremePick[]> = {};
  for (const t of manifest.tables) {
    const table = t.name;
    const sample = samples[table];
    const pk = sample?.pk ?? [];
    if (!sample || !pk.length || !t.rows) continue;
    const info = (await src(table).columnInfo()) as ColumnInfo;
    const picks: ExtremePick[] = [];
    for (const [col, meta] of Object.entries(info)) {
      const type = String(meta?.type ?? "");
      const text = isTextType(type);
      const numeric = numericColumns({ [col]: type }).size > 0;
      try {
        if (text) {
          const r = (await src(table)
            .select(pk)
            .select(src.raw("?? as ??", [col, "__v"]))
            .whereNotNull(col)
            .orderByRaw("LENGTH(??) DESC", [col])
            .first()) as Record<string, unknown> | undefined;
          if (r) picks.push({ column: col, metric: "longest-text", value: r.__v, pk: pickRow(r, pk, new Set()) });
        }
        if (numeric) {
          for (const metric of ["max-number", "min-number"] as const) {
            const r = (await src(table)
              .select(pk)
              .select(src.raw("?? as ??", [col, "__v"]))
              .whereNotNull(col)
              .orderBy(col, metric === "max-number" ? "desc" : "asc")
              .first()) as Record<string, unknown> | undefined;
            if (r) picks.push({ column: col, metric, value: r.__v, pk: pickRow(r, pk, new Set()) });
          }
        }
      } catch (e) {
        // 类型判不准不该让整轮比对挂掉：登记下来，该列退回"均匀抽样"覆盖。
        console.warn(`[compare] ${table}.${col} 的边界抽样失败（${(e as Error).message}），该列只由均匀抽样覆盖`);
      }
    }
    if (picks.length) out[table] = picks;
  }
  return out;
}

/**
 * 行数比对 + 抽样单元格深比较（样本由 `compare-db.cjs` 从源库按主键取好）。
 *
 * 行数的**权威判据**不是"目标行数 == 源行数"：`o_setting.tokenKey` 按裁定必须不搬、
 * 超长行可能被主动丢 —— 拿源行数当期望会让这几种**按设计的缺席**看起来像数据丢失。
 * 所以：
 *   · 有 `outcomes`（导入刚跑完）时，期望值 = `targetRowsBefore + inserted`（导入后应有的行数）；
 *   · 没有 `outcomes` 时（拿任意两库比），期望值 = 源行数（严格口径）。
 * 另外每条"源行在目标里找不到"的样本都要归因：`expectedAbsent` 里登记过的 = 按设计缺席，
 * 其余一律 `unexpected` 并判红。
 */
export async function compareRows(opts: {
  dst: Knex;
  manifest: ExportManifest;
  samples: SourceSamples;
  plans: TablePlan[];
  outcomes?: ImportTableOutcome[];
  expectedAbsent?: ExpectedAbsent[];
  /** 每个源侧抽样行被哪一层抽中（`uniform` / `extreme`），同一行被两层抽中只算一次。 */
  pickKinds?: Record<string, Array<{ pk: Record<string, unknown>; kind: "uniform" | "extreme" }>>;
}): Promise<CompareReport> {
  const { dst, manifest, samples, plans } = opts;
  const planOf = new Map(plans.map((p) => [p.table, p]));
  const outcomeOf = new Map((opts.outcomes ?? []).map((o) => [o.table, o]));
  const absentKeys = new Set((opts.expectedAbsent ?? []).map((e) => `${e.table}|${pkSignature(e.pk)}`));
  const tables: TableCompare[] = [];
  const notes: string[] = [];
  let ok = true;

  for (const rec of manifest.tables) {
    const plan = planOf.get(rec.name);
    const outcome = outcomeOf.get(rec.name);
    const targetRows = (await dst.schema.hasTable(rec.name)) ? await countRows(dst, rec.name) : -1;
    const expectedTargetRows = outcome ? outcome.targetRowsBefore + outcome.inserted : rec.rows;
    // ⚠ **种子表用 `>=`，其余表用 `==`**（brief Step 2 的"种子表为 `>=`"）：
    //   四张平台表在 `002` 之后已经有种子行，导入对它们"跳过已存在" —— 于是有两种合法形状：
    //     ① 导入的老库行与种子行的身份键**不重合** → 目标 = 种子 + 导入的老库行 ≥ 源行数；
    //     ② 老库那一行在目标库里**已经被种子占了同名身份键** → 目标 < 源（少的那条是"按设计跳过"）。
    //   两种都不是数据丢失（②由 `missingInTarget` 的归因单独判），所以行数只能当下界用。
    //   非种子表没有这个自由度：preflight 已证明它们"进空库"，目标必须**恰好**等于应有行数。
    const isSeedTable = (SEED_TABLES as readonly string[]).includes(rec.name);
    const rowsMatch = isSeedTable ? targetRows >= expectedTargetRows : targetRows === expectedTargetRows;
    if (!rowsMatch) ok = false;
    const sample = samples[rec.name];
    const kinds = opts.pickKinds?.[rec.name] ?? [];
    let uniformPicks = 0;
    let extremePicks = 0;
    const mismatches: SampleMismatch[] = [];
    const accountedMismatches: AccountedMismatch[] = [];
    const missingInTarget: MissingInTarget[] = [];
    let checked = 0;
    const seedSkips = (opts.expectedAbsent ?? []).filter(
      (e): e is Extract<ExpectedAbsent, { columns: string[] }> =>
        e.table === rec.name && (e.reason === "skipped-different-seed" || e.reason === "skipped-pk-conflict-seed"),
    );
    if (plan && sample) {
      // ⚠ 数值归一化用**目标列类型**推出的集合（【Ruling 43】），与导入侧同一个 `numericColumns()` ——
      //   两处若用不同判据，比对会报出导入侧根本不会产生的差异（假阳性）。
      const numeric = numericColumns(plan.targetColumnTypes);
      // 同一行被均匀层与边界层同时抽中时只算一次：否则 `samplesChecked` 会虚高，
      // "抽了 N 行"这句话就不再是"读了 N 条不同的行"。
      const seen = new Set<string>();
      const pickKind = new Map(kinds.map((k) => [pkSignature(k.pk), k.kind]));
      // "这一行/这一格按设计没搬"的登记集合（**合并审查修复 2：粒度 = (行, 列)**）。
      // 种子行可能用**身份键**登记（`o_vendorConfig` 是 `id`，与主键相同；但 `o_prompt` 是 `type`、
      // `o_setting`/`o_agentDeploy` 是 `key`）—— 两种签名都收。
      // ⚠ 值里带的是 `columns`：**只有登记过的那几列**允许与源不同；同一行别的列照旧判红。
      const accountedColumns = new Map<string, { reason: ExpectedAbsent["reason"]; columns: Set<string> }>();
      for (const e of seedSkips) {
        const values = Object.values(e.pk);
        const entry = { reason: e.reason as ExpectedAbsent["reason"], columns: new Set(e.columns) };
        // 空 `columns` = 没有一格被登记 ⇒ 不豁免任何格子（宁红不瞒；导入侧不可能产生空集合：
        // 只有"确有差异列"才会登记这两类原因）。
        if (!entry.columns.size) continue;
        accountedColumns.set(`${e.table}|${pkSignature(e.pk)}`, entry);
        if (values.length === 1) {
          for (const alias of ["id", "type", "key"]) {
            accountedColumns.set(`${e.table}|${pkSignature({ [alias]: values[0] })}`, entry);
          }
        }
      }
      for (const srcRow of sample.rows) {
        const pkWhere: Record<string, unknown> = {};
        for (const c of sample.pk) pkWhere[c] = normalizeValue(srcRow[c], true);
        const sig = pkSignature(pkWhere);
        if (seen.has(sig)) continue;
        seen.add(sig);
        if (pickKind.get(sig) === "extreme") extremePicks += 1;
        else uniformPicks += 1;
        const dstRow = (await dst(rec.name).where(pkWhere).first()) as Record<string, unknown> | undefined;
        if (!dstRow) {
          const expected = absentKeys.has(`${rec.name}|${sig}`);
          missingInTarget.push({ pk: pkWhere, reason: expected ? absentReasonFor(opts.expectedAbsent, rec.name, pkWhere) : "unexpected" });
          if (!expected) ok = false;
          continue;
        }
        checked += 1;
        // 目标行里"指向登记过的那一行"的任一标识（主键 + 身份键常见列名）。
        // ⚠ **合并审查修复 2**：命中的是"这一行登记了哪几列"，逐列放行 —— 整行豁免会把同一行里
        //    其它列的真实差异一起吃掉（那正是本修复要堵的假绿）。
        let rowAccount: { reason: ExpectedAbsent["reason"]; columns: Set<string> } | undefined;
        for (const idCol of new Set(["id", "type", "key", ...sample.pk])) {
          if (dstRow[idCol] === undefined) continue;
          const hit = accountedColumns.get(`${rec.name}|${pkSignature({ [idCol]: dstRow[idCol] })}`);
          if (hit) {
            rowAccount = hit;
            break;
          }
        }
        for (const col of plan.columns) {
          if (!(col in srcRow)) continue;
          const v = equivalentForCompare(normalizeValue(srcRow[col], numeric.has(col)), dstRow[col]);
          if (v.equal) continue;
          if (rowAccount && rowAccount.columns.has(col)) {
            // 目标那一格**保留的是种子值**（老库那一行按交接条款未搬）→ 登记，不判红。
            accountedMismatches.push({
              pk: pkWhere,
              column: col,
              source: srcRow[col],
              target: dstRow[col],
              reason: v.reason,
              accountedBy: rowAccount.reason,
            });
            continue;
          }
          mismatches.push({ pk: pkWhere, column: col, source: srcRow[col], target: dstRow[col], reason: v.reason });
          ok = false;
        }
      }
      // ⚠ **不许"静默的不一致"**：如果这张表有登记过"按设计跳过、内容不同"的行，
      //   而这一轮采样**既没读到差异、也没登记到那些行**，那说明采样根本没碰到它们 —— 报告必须说出来。
      //   （Task 8 实跑就是靠这条从"27 张表全绿"里发现 `o_vendorConfig.volcengine.enable`
      //     那一格：均匀抽样没抽中它，边界抽样抽中了。）
      if (seedSkips.length && !mismatches.length && !accountedMismatches.length) {
        notes.push(
          `${rec.name}: 导入按"跳过已存在"放弃了 ${seedSkips.length} 行老库状态（内容与种子不同），` +
            `但本轮抽样没读到这些行 —— 那是**采样覆盖不足**，不是"数据一致"。`,
        );
      }
      if (accountedMismatches.length) {
        notes.push(
          `${rec.name}: ${accountedMismatches.length} 处单元格**按设计**与源不同（保留种子值），已逐条登记进 accountedMismatches —— 需拍板`,
        );
      }
      if (sample.pk.length > 1) notes.push(`${rec.name}: 复合主键 (${sample.pk.join(",")}) 用于定位抽样行`);
      if (extremePicks) notes.push(`${rec.name}: 边界抽样命中 ${extremePicks} 行（每列最长文本 / 数值极值）`);
      if (plan.columns.length && checked < plan.columns.length) {
        // 抽样行数少于列数时，逐列覆盖是有保证的（每行比全部列），但"某些列从未被读过"仍要显式说出来。
        notes.push(`${rec.name}: 抽样 ${checked} 行 × ${plan.columns.length} 列 —— 每行都比全部列，列覆盖完整`);
      }
    }
    tables.push({
      table: rec.name,
      sourceRows: rec.rows,
      targetRows,
      expectedTargetRows,
      rowsMatch,
      rowsDeltaVsSource: targetRows - rec.rows,
      accounted: outcome,
      samplesChecked: checked,
      uniformPicks,
      extremePicks,
      missingInTarget,
      mismatches,
      accountedMismatches,
    });
  }
  return { generatedAt: new Date().toISOString(), target: "", dialect: dialectOfKnex(dst), tables, ok, notes };
}

/** 主键的稳定签名（比对 `expectedAbsent` 用；值经 `valuesEqual` 的同一套归一化）。 */
export function pkSignature(pk: Record<string, unknown>): string {
  return Object.keys(pk)
    .sort()
    .map((k) => `${k}=${String(pk[k])}`)
    .join("&");
}

/**
 * 源抽样行在目标里缺席 → 取 `expectedAbsent` 里登记的那条原因。
 *
 * ⚠ 登记里的两类种子跳过原因**原样透传**（`skipped-different-seed` / `skipped-pk-conflict-seed`）：
 * 它们落在"按设计没搬"这一侧（不算差异），但报告里的字面原因必须能让人**分清**是
 * "JWT 密钥不搬"还是"种子占了同身份键、老库那一格留在老库"。
 */
function absentReasonFor(list: ExpectedAbsent[] | undefined, table: string, pk: Record<string, unknown>): MissingInTarget["reason"] {
  const sig = pkSignature(pk);
  const hit = (list ?? []).find((e) => e.table === table && pkSignature(e.pk) === sig);
  return hit ? (hit.reason as MissingInTarget["reason"]) : "unexpected";
}
