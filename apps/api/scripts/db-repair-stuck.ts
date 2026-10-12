/**
 * `db:repair-stuck`：手动清除"卡在生成中"的残留行（Phase 1a / Task 4，控制器裁定 2）。
 *
 * ── 为什么需要它 ──
 * 旧 `fixDB` 在**每次启动**时无条件把 6 类 `state='生成中'` 的行改判成失败
 * （见 `src/lib/fixDB.ts` 的「矫正因软件异常退出导致的状态不一致问题」一段）。
 * Phase 1a / Task 4 摘掉了这条启动期副作用，理由是**无条件写**会与多实例互相踩、
 * 并会误杀正在运行的任务。正式的替代机制是 **Phase 1d 的队列租约超时**（spec §9.2）。
 *
 * 在 1d 落地之前，"重启后残留的生成中行"就**没有**自动改判途径了 —— 本脚本是那段窗口期的
 * **手工替代品**（一个显式、可审计、默认不写库的命令），不是"把副作用换个地方装回去"：
 *   - 默认 **dry-run**（只打印将被改判的行），必须显式 `--apply` 才写库；
 *   - 默认只动 **超过 1 小时**没有时间戳更新的行（避免误杀正在跑的任务）；
 *   - **幂等**：改判过的行不再是"生成中"，第二次跑就是 0 行。
 *
 * ── 用法（在 apps/api 下）──
 *   pnpm.cmd run db:repair-stuck                                   # dry-run；默认窗口 1h
 *   pnpm.cmd run db:repair-stuck --apply                           # 真的改判
 *   pnpm.cmd run db:repair-stuck -- --older-than=30m               # 窗口 30 分钟（cutoff = now - 30m）
 *   pnpm.cmd run db:repair-stuck -- --older-than=3600000           # 毫秒窗口（cutoff = now - 1h）
 *   pnpm.cmd run db:repair-stuck -- --older-than=2026-10-12T00:00:00Z
 *         # ⚠ 绝对时间**就是 cutoff 本身**（"行时间戳 <= 该时刻"），不是"从现在往前推"。
 * ⚠ pnpm 会原样转发参数；`pnpm run x -- --apply` 在 pnpm 10 下会把**字面量 `--`** 也传进来
 *   （无害：本脚本只按前缀认参），但**推荐**直接用 `--apply` 形式。
 *
 * ⚠ **不会**新增任何 `MIWO_*` 环境变量（裁定 5）：本脚本只读 `config`，参数全走命令行。
 * ⚠ 目标库由 `config.db` 决定（`MIWO_DB_DRIVER` / `MIWO_DATA_DIR`），与 `db:migrate` 同一口径。
 *    在一次性库上试：把 `MIWO_DATA_DIR` 指到 `%TEMP%` 下的空目录。
 *
 * ⚠ 本仓库是 CJS（tsconfig `module: CommonJS`）：**不能写顶层 await**，所以入口包在 `main()` 里。
 */
import type { Knex } from "knex";
import { config } from "@/config";
import { createKnex, describeTarget } from "@/db/connect";
// ⚠ 数据库**目标护栏**（Task 11 / 控制器裁定 A：禁止默认打到真实 dev 库）。
//    本文件是"写库"脚本（`--apply` 会 UPDATE 六类"生成中"行），所以两条护栏都上。
//    与 `db-migrate.ts` 同一位置、同一理由：纯 CJS 的 `scripts/db-target-guard.cjs`，
//    类型来自同目录 `db-target-guard.d.cts`（`export =` + esModuleInterop）。
import guard from "./db-target-guard.cjs";

/** 与旧 fixDB 逐条对应的 6 类"生成中"状态。`timeColumn` 是该表**真正存在**的时间列
 *  （`o_image` 没有 —— 见下面 SKIP 的说明）。 */
interface StuckSpec {
  table: string;
  stateColumn: string;
  /** 真·"进行中"的取值（`state`/`promptState` 是中文 "生成中"；novel/script 是数字 0）。 */
  activeValue: string | number;
  /** 改判后的取值。 */
  failedValue: string | number;
  /** 失败原因列（novel/script 也是 `errorReason`）。 */
  reasonColumn: string;
  reasonText: string;
  /** 用来判定"多久没动过"的时间列（毫秒时间戳）；`null` = 该表没有时间列。 */
  timeColumn: string | null;
}

const SKIPPED_BY_DESIGN =
  "Legacy 'software exited' correction: table has no timestamp column at all, so an --older-than window cannot be enforced on it; skipped rather than touching possibly-running rows.";

const SPECS: StuckSpec[] = [
  {
    table: "o_novel",
    stateColumn: "eventState",
    activeValue: 0,
    failedValue: -1,
    reasonColumn: "errorReason",
    reasonText: "软件退出导致失败",
    timeColumn: "createTime",
  },
  {
    table: "o_script",
    stateColumn: "extractState",
    activeValue: 0,
    failedValue: -1,
    reasonColumn: "errorReason",
    reasonText: "软件退出导致失败",
    timeColumn: "createTime",
  },
  {
    table: "o_assets",
    stateColumn: "promptState",
    activeValue: "生成中",
    failedValue: "生成失败",
    reasonColumn: "promptErrorReason",
    reasonText: "软件退出导致失败",
    timeColumn: "startTime",
  },
  {
    table: "o_image",
    stateColumn: "state",
    activeValue: "生成中",
    failedValue: "生成失败",
    reasonColumn: "errorReason",
    reasonText: "软件退出导致失败",
    timeColumn: null,
  },
  {
    table: "o_storyboard",
    stateColumn: "state",
    activeValue: "生成中",
    failedValue: "生成失败",
    reasonColumn: "reason",
    reasonText: "软件退出导致失败",
    timeColumn: "createTime",
  },
  {
    table: "o_video",
    stateColumn: "state",
    activeValue: "生成中",
    failedValue: "生成失败",
    reasonColumn: "errorReason",
    reasonText: "软件退出导致失败",
    timeColumn: "time",
  },
];

const DEFAULT_OLDER_THAN_MS = 60 * 60 * 1000;
/** 一个值 <= 这个天数（毫秒）时按"窗口长度"解释，否则按"绝对时间点（epoch 毫秒）"解释。 */
const WINDOW_MAX_MS = 30 * 24 * 60 * 60 * 1000;

interface Args {
  apply: boolean;
  /** 判定阈值：行的时间戳 <= cutoffMs 才动。 */
  cutoffMs: number;
  olderThanSource: string;
}

/**
 * `--older-than=<值>`：**行的时间戳 <= cutoff 才动**。值有**两种**互不混淆的写法：
 *   1. **窗口长度**（默认，也是推荐用法）：`30m` / `6h` / `2d` / `3600000`（纯数字 = 毫秒数，
 *      上限 30 天）→ `cutoff = now - 窗口`。语义 = "多久没动过才算卡住"。
 *   2. **绝对时间点**：ISO（`2026-10-12T00:00:00Z`、`2026-10-12T08:00:00+08:00`）或
 *      epoch 毫秒（> 30 天的纯数字）→ `cutoff = 该时间点`（**直接就是阈值**，不再做减法）。
 *
 * ⚠ 第 2 种写法**必须**在命令输出/帮助里说清"它就是 cutoff 本身"：否则下一个人会很自然地
 *   读成"比这个时刻更老"，把阈值算反（本脚本开发时就踩过：传 `--older-than=2099-01-01` 反而
 *   选中了全部行）。宁可显式，也不要一个靠猜的语义。
 * 不写 `--older-than` 时就是默认窗口 1 小时（避免误杀正在跑的任务）。
 */
function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const raw = argv.find((a) => a.startsWith("--older-than="));
  if (!raw) {
    return { apply, cutoffMs: Date.now() - DEFAULT_OLDER_THAN_MS, olderThanSource: "default window 1h" };
  }
  const value = raw.slice("--older-than=".length).trim();
  if (value === "") throw new Error("--older-than= 后面必须跟值（窗口如 1h/30m/3600000，或绝对阈值如 2026-10-12T00:00:00Z）");

  // 相对窗口：30m / 6h / 2d / 500ms
  const rel = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
    const windowMs = n * factor;
    if (!(windowMs >= 0)) throw new Error(`--older-than 窗口非法："${value}"`);
    return { apply, cutoffMs: Date.now() - windowMs, olderThanSource: `window ${value} (${windowMs}ms) -> cutoff = now - window` };
  }

  // 纯数字：小的当"窗口毫秒数"，大的（> 30 天）当 epoch 毫秒阈值
  if (value !== "" && Number.isFinite(Number(value))) {
    const asNumber = Number(value);
    if (asNumber <= WINDOW_MAX_MS) {
      return { apply, cutoffMs: Date.now() - asNumber, olderThanSource: `window ${asNumber}ms -> cutoff = now - window` };
    }
    return { apply, cutoffMs: asNumber, olderThanSource: `absolute epoch-ms ${asNumber} (used as cutoff directly)` };
  }

  // 绝对时间点（其本身就是 cutoff）
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `--older-than 必须是窗口（1h / 30m / 3600000）或绝对阈值（ISO 如 2026-10-12T00:00:00Z，或 epoch 毫秒），实际 "${value}"`,
    );
  }
  return { apply, cutoffMs: parsed, olderThanSource: `absolute ${value} (used as cutoff directly)` };
}

/** 只保留**真正存在**的表/列；缺表（如还没迁移的空库）直接跳过而不是炸。 */
async function columnOk(db: Knex, table: string, column: string): Promise<boolean> {
  if (!(await db.schema.hasTable(table))) return false;
  return db.schema.hasColumn(table, column);
}

interface StuckRow {
  table: string;
  id: unknown;
  state: unknown;
  at: number | null;
}

async function collect(db: Knex, spec: StuckSpec, cutoffMs: number): Promise<{ rows: StuckRow[]; skipped: string | null }> {
  if (!(await db.schema.hasTable(spec.table))) return { rows: [], skipped: `table ${spec.table} does not exist (skipped)` };
  if (!(await columnOk(db, spec.table, spec.stateColumn))) {
    return { rows: [], skipped: `table ${spec.table} has no column ${spec.stateColumn} (skipped)` };
  }
  if (!(await columnOk(db, spec.table, spec.reasonColumn))) {
    return { rows: [], skipped: `table ${spec.table} has no column ${spec.reasonColumn} (skipped)` };
  }

  if (spec.timeColumn === null || !(await columnOk(db, spec.table, spec.timeColumn))) {
    // 没有时间列 → **不敢**按 --older-than 判活；只报数，不改判。
    const countRow = (await db(spec.table).where(spec.stateColumn, spec.activeValue).count({ n: "*" } as any).first()) as
      | Record<string, unknown>
      | undefined;
    const n = Number((countRow && (countRow.n ?? Object.values(countRow)[0])) ?? 0);
    return {
      rows: [],
      skipped:
        n > 0
          ? `table ${spec.table} has ${n} '${String(spec.activeValue)}' row(s) but no usable time column -> NOT repairable by age. ${SKIPPED_BY_DESIGN}`
          : null,
    };
  }

  // ⚠ 这里必须把列名收进局部常量：`spec.timeColumn` 的类型是 `string | null`，
  //    而上面那个 `=== null` 判断**不能**把它收窄（TS 不跨属性访问做 discriminated narrowing）→
  //    直接用 `r[spec.timeColumn]` 会报 TS2538（null 不能作索引类型）。
  const timeCol: string = spec.timeColumn;
  const rows = (await db(spec.table)
    .where(spec.stateColumn, spec.activeValue)
    .andWhere(timeCol, "<=", cutoffMs)
    .select("id", spec.stateColumn, timeCol)) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((r) => ({
      table: spec.table,
      id: r.id,
      state: r[spec.stateColumn],
      at: r[timeCol] === null || r[timeCol] === undefined ? null : Number(r[timeCol]),
    })),
    skipped: null,
  };
}

function fmtTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "(no time)";
  return `${new Date(ms).toISOString()} (${ms})`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cutoffMs = args.cutoffMs;
  // ⚠ 在 `createKnex()` **之前**判定目标（同 `db-migrate.ts`）：sqlite 分支下建连就等于打开了
  //    那份文件，"连上再拦"已经把目标打开了。dry-run 也拦 —— 判别力不该取决于 `--apply`。
  guard.requireRepoDevDbAllowed({ argv: process.argv.slice(2), what: "db:repair-stuck" });

  const db = createKnex();
  try {
    console.log(
      `[repair-stuck] target: ${describeTarget()}  mode=${args.apply ? "APPLY" : "DRY-RUN"}  ` +
        `older-than=${args.olderThanSource}  cutoff=${new Date(cutoffMs).toISOString()} (${cutoffMs})`,
    );

    const all: StuckRow[] = [];
    const skips: string[] = [];
    for (const spec of SPECS) {
      const { rows, skipped } = await collect(db, spec, cutoffMs);
      if (skipped) skips.push(skipped);
      for (const r of rows) all.push(r);
    }

    console.log(`[repair-stuck] candidate rows (state = in-progress AND not updated since cutoff): ${all.length}`);
    for (const r of all) {
      console.log(`  - ${r.table}  id=${String(r.id)}  state=${String(r.state)}  time=${fmtTime(r.at)}`);
    }
    for (const s of skips) console.log(`  ! ${s}`);

    if (!all.length) {
      console.log("[repair-stuck] nothing to do (idempotent: already repaired or nothing stuck).");
      return;
    }

    if (!args.apply) {
      console.log("[repair-stuck] DRY-RUN: nothing written. Re-run with --apply to mark the rows above as failed.");
      return;
    }

    let changed = 0;
    for (const spec of SPECS) {
      const ids = all.filter((r) => r.table === spec.table).map((r) => r.id);
      if (!ids.length) continue;
      const patch: Record<string, unknown> = {};
      patch[spec.stateColumn] = spec.failedValue;
      patch[spec.reasonColumn] = spec.reasonText;
      const n = await db(spec.table).whereIn("id", ids as never[]).update(patch);
      changed += Number(n) || 0;
      console.log(`[repair-stuck] ${spec.table}: ${ids.length} row(s) -> ${String(spec.failedValue)} (driver reported ${String(n)})`);
    }
    console.log(`[repair-stuck] APPLIED: ${changed} row(s) updated.`);
  } finally {
    await db.destroy();
  }
}

/**
 * ⚠ 只在"被直接执行"时跑 `main()`（不要无条件调用）：这样本文件可以被别的脚本/测试 import
 *    复用 `SPECS` / `parseArgs` 而不产生副作用。
 *    本仓库是 CJS（tsx 把 .ts 转成 CJS），所以用 `require.main === module` 判别；
 *    与 `src/db/legacy/vendor-merge.ts` 的 CLI 入口同一写法。
 */
if (require.main === module) {
  main().catch((err) => {
    console.error("[repair-stuck] failed:", err);
    process.exit(1);
  });
}

/** 供测试/复用：默认时间窗口与"哪些表/列算生成中"的规格。 */
export { DEFAULT_OLDER_THAN_MS, SPECS, parseArgs };
