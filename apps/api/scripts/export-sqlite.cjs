#!/usr/bin/env node
/**
 * 从 SQLite 导出为"按表分文件的 NDJSON"（搬迁链的第一步，可单独重跑）。
 *
 * 用法（都从 apps/api 下跑，或走 `pnpm.cmd run db:export`）：
 *   node scripts/export-sqlite.cjs [--db=路径] [--out=目录]
 * 默认：--db=./data/db2.sqlite  --out=./.tmp-migrate/export
 *
 * 输出：
 *   <out>/<table>.ndjson   每行一个 JSON 对象（列名与源库一致）
 *   <out>/manifest.json    { generatedAt, source, sourceSha256Before/After, tables: [{name, rows, bytes,
 *                            sha256, columns}], duplicates, badIds, columnStats, oversizeValues }
 *
 * ─────────────────────────── 两条硬纪律 ───────────────────────────
 *
 * 1. **对源库只读**（Phase 1a / Task 6 Ruling 1）：
 *    `better-sqlite3` 以 `{ readonly: true }` 打开；打开前与关闭后各算一次源库 sha256，
 *    **必须相等**，否则退出码 1 并打印两个值。同时记录 `-wal` / `-shm` / `-journal` 伴随文件
 *    是否在导出过程中**新出现**（`sourceSideEffects`）—— 那条断言就是"没写源库"的机械证据。
 *
 * 2. **用户真实库绝不在范围**：`%APPDATA%\ToonFlow\data\db2.sqlite` 是用户机在用的库，
 *    本脚本对它是**硬拒绝**（连只读打开都不做）。搬迁只针对仓库里的 dev 库快照。
 *
 * 退出码：
 *   0 = 导出完成（**超长值只登记不阻断**，见下）
 *   1 = 致命错误（源库不存在/不可读、正在写用户真实库、sha256 变了、写出错）
 *   2 = 有**阻断项**（`duplicates` / `badIds` 非空）：这种导出物**不得**拿去导入
 *
 * ⚠ 超长值为什么**不**给 exit 2：老库实测 `o_agentWorkData.data` 最大 103,624 字符，
 *    而 `001_schema` 里它是 `varchar(255)` —— sqlite 不强制长度（所以老库能存下），
 *    真 MySQL 在严格模式下会 `Data too long for column`。这是**已存在的数据/结构缺口**，
 *    不是导出脚本能修的：脚本如实登记进 manifest 的 `oversizeValues`，由**导入侧**按方言阻断
 *    （见 `src/db/legacy/import.ts` 的 `preflightImport`），处置需要人拍板。
 *    把导出也打成阻断会让"体检报告"本身拿不到 —— 那正是最需要看到的东西。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const argOf = (p, d) => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : d;
};
const SRC = path.resolve(API_ROOT, argOf("--db=", path.join("data", "db2.sqlite")));
const OUT = path.resolve(API_ROOT, argOf("--out=", path.join(".tmp-migrate", "export")));

/** 与 spec 附录 A 的 29 张表一致；退役的两张（o_skillList / o_skillAttribution）不搬。 */
const TABLES = [
  "o_user", "o_project", "o_artStyle", "o_agentDeploy", "o_setting", "o_tasks", "o_prompt", "o_modelPrompt",
  "o_novel", "o_event", "o_eventChapter", "o_script", "o_assets", "o_image", "o_storyboard",
  "o_agentWorkData", "o_video", "o_videoTrack", "o_vendorConfig", "o_imageFlow",
  "o_assets2Storyboard", "o_scriptAssets", "memories", "o_assetsRole2Audio", "o_segment", "o_shot", "o_shotAssets",
];
const UNIQUE = { o_agentWorkData: ["projectId", "episodesId", "key"], o_segment: ["scriptId", "segmentIndex"] };
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 目标结构（`001_schema`）对这些列的长度上限。
 *
 * ⚠ 为什么写死而不是从源库 PRAGMA 推：源库里 `memories.isolationKey` 声明的是 **TEXT**
 *   （没有长度），而 `001_schema` 把它收窄成 `varchar(191)`。真 MySQL 按**目标**上限强制，
 *   所以体检必须用目标口径。这几条就是 `001_schema` 里的 `t.vstr(T, ...)` / `T.string(...)`。
 */
const SCHEMA_LIMITS = {
  "o_agentWorkData.data": 255,
  "o_agentWorkData.key": 255,
  "memories.isolationKey": 191,
  "memories.id": 191,
  "o_setting.key": 191,
  "o_vendorConfig.id": 191,
};

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** 伴随文件（-wal / -shm / -journal）：导出前后都不该**新**出现。 */
function companions(p) {
  const out = {};
  for (const suffix of ["-wal", "-shm", "-journal"]) out[suffix] = fs.existsSync(p + suffix);
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// ---- 硬拒绝：用户机真实库（绝不在范围，连只读打开都不做）----
const USER_DATA = path.join(process.env.APPDATA || "", "ToonFlow", "data").toLowerCase();
if (USER_DATA && SRC.toLowerCase().startsWith(USER_DATA)) {
  die(`拒绝执行：${SRC}\n  这是用户机正在使用的真实库（%APPDATA%\\ToonFlow\\data）。搬迁链只处理仓库内的 dev 库快照，对它连只读比对都不做。`);
}

if (!fs.existsSync(SRC)) die(`源库不存在：${SRC}`);

let Database;
try {
  Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
} catch {
  Database = require("better-sqlite3");
}

const before = { sha256: sha256(SRC), companions: companions(SRC) };
const db = new Database(SRC, { readonly: true });

fs.mkdirSync(OUT, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  sourceSha256Before: before.sha256,
  sourceSha256After: null,
  sourceSideEffects: { freshCompanionFiles: [], note: "" },
  tables: [],
  duplicates: [],
  badIds: [],
  columnStats: {},
  oversizeValues: [],
  exporter: "apps/api/scripts/export-sqlite.cjs",
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** 把 better-sqlite3 读出来的值转成可 JSON 化的值；不能安全表示的一律记进 badIds。 */
function forJson(table, row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) {
      die(`发现 BLOB 列：${table}.${k} —— 本脚本只支持文本/数字（BLOB 需要 base64 方案，请先拍板）`);
    }
    if (typeof v === "bigint") {
      if (v > MAX_SAFE || v < -MAX_SAFE) {
        manifest.badIds.push({ table, column: k, value: v.toString() });
        out[k] = v.toString();
      } else {
        out[k] = Number(v);
      }
      continue;
    }
    out[k] = v === undefined ? null : v;
  }
  return out;
}

const isIdCol = (c) => c === "id" || /(^|[A-Za-z])Id$/.test(c) || c === "userId" || c === "projectId";

for (const table of TABLES) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) {
    console.log(`跳过 ${table}：源库无此表`);
    continue;
  }
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const colNames = cols.map((c) => c.name);
  const rows = db.prepare(`SELECT * FROM "${table}"`).all().map((r) => forJson(table, r));
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const buf = Buffer.from(body, "utf8");
  fs.writeFileSync(path.join(OUT, `${table}.ndjson`), buf);
  manifest.tables.push({ name: table, rows: rows.length, bytes: buf.length, sha256: sha(buf), columns: colNames });
  console.log(`${table}: ${rows.length} 行, ${buf.length} B`);

  // ---- 唯一键查重（【Ruling 34/41 ①】：重复行会让目标库的唯一约束在导入中途失败）----
  if (UNIQUE[table]) {
    const keys = UNIQUE[table];
    const dup = db
      .prepare(`SELECT ${keys.join(", ")}, COUNT(*) AS n FROM "${table}" GROUP BY ${keys.join(", ")} HAVING COUNT(*) > 1`)
      .all();
    if (dup.length) {
      manifest.duplicates.push({ table, key: keys, rows: dup });
      console.warn(`  ⚠ ${table} 有 ${dup.length} 组重复（唯一键 ${keys.join(",")}）`);
    }
  }

  // ---- id 范围（> 2^53-1 会丢精度）----
  for (const c of colNames.filter(isIdCol)) {
    for (const r of rows) {
      const v = r[c];
      if (typeof v === "number" && v > Number.MAX_SAFE_INTEGER) manifest.badIds.push({ table, column: c, value: String(v) });
      else if (typeof v === "string" && /^\d+$/.test(v)) {
        try {
          if (BigInt(v) > MAX_SAFE) manifest.badIds.push({ table, column: c, value: v });
        } catch {
          /* 不是整数串，忽略 */
        }
      }
    }
  }

  // ---- 长度体检（【Ruling 34/41 ②③】）----
  for (const c of cols) {
    const declared = String(c.type || "");
    const m = /\(\s*(\d+)\s*\)/.exec(declared);
    const declaredLen = m ? Number(m[1]) : null;
    const schemaLimit = SCHEMA_LIMITS[`${table}.${c.name}`] || null;
    if (declaredLen === null && schemaLimit === null) continue; // 无长度约束的列不体检
    const limit = schemaLimit !== null && declaredLen !== null ? Math.min(schemaLimit, declaredLen) : (schemaLimit !== null ? schemaLimit : declaredLen);
    const stat = db
      .prepare(`SELECT COALESCE(MAX(LENGTH("${c.name}")), 0) AS maxChars, SUM(CASE WHEN LENGTH("${c.name}") > ? THEN 1 ELSE 0 END) AS rowsOver FROM "${table}"`)
      .get(limit);
    manifest.columnStats[`${table}.${c.name}`] = {
      sourceDeclaredType: declared,
      targetLimit: limit,
      limitSource: schemaLimit !== null ? "001_schema" : "源库声明",
      maxChars: stat.maxChars,
      rowsOver: stat.rowsOver,
    };
    if (stat.rowsOver > 0) {
      manifest.oversizeValues.push({
        table,
        column: c.name,
        sourceDeclaredType: declared,
        targetLimit: limit,
        limitSource: schemaLimit !== null ? "001_schema" : "源库声明",
        maxChars: stat.maxChars,
        rowsOver: stat.rowsOver,
      });
    }
  }
}

db.close();

const after = { sha256: sha256(SRC), companions: companions(SRC) };
manifest.sourceSha256After = after.sha256;
const freshCompanions = Object.keys(after.companions).filter((k) => after.companions[k] && !before.companions[k]);
manifest.sourceSideEffects.freshCompanionFiles = freshCompanions;
manifest.sourceSideEffects.note =
  "导出对源库只读：sha256 前后一致，且未新出现 -wal/-shm/-journal 伴随文件。";
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

// ---- 打印证据（这些行就是"老库数据体检"的原文）----
const totalRows = manifest.tables.reduce((s, t) => s + t.rows, 0);
console.log("");
console.log(`已导出到 ${OUT}`);
console.log(`  源库 sha256（导出前）：${before.sha256}`);
console.log(`  源库 sha256（导出后）：${after.sha256}`);
console.log(`  sha256 一致：${before.sha256 === after.sha256}`);
console.log(`  新出现的伴随文件：${freshCompanions.length ? freshCompanions.join(", ") : "（无）"}`);
console.log(`  表：${manifest.tables.length}，总行数：${totalRows}`);
console.log(`  重复键组：${manifest.duplicates.length}，越界 id：${manifest.badIds.length}`);
console.log("  长度体检（有长度上限的列，超长才列出）：");
const over = manifest.oversizeValues;
if (!over.length) console.log("    （无超长值）");
for (const o of over) {
  const how = o.limitSource === "001_schema" ? "001_schema 收窄后的上限" : "源库声明";
  console.log(`    ⚠ ${o.table}.${o.column}：上限 ${o.targetLimit} 字符（${how}；源库声明类型 ${o.sourceDeclaredType || "无"}），实测最大 ${o.maxChars} 字符，${o.rowsOver} 行超长`);
}
for (const key of ["o_agentWorkData.data", "memories.isolationKey"]) {
  const s = manifest.columnStats[key];
  if (s) console.log(`  ${key}：max ${s.maxChars} 字符 / 上限 ${s.targetLimit}（${s.limitSource}），超长 ${s.rowsOver} 行`);
}

if (before.sha256 !== after.sha256) {
  die(`源库在导出期间被改写：前 ${before.sha256} 后 ${after.sha256} —— 导出必须只读，已中止`);
}
if (freshCompanions.length) {
  die(`导出过程中源库新出现伴随文件 ${freshCompanions.join(", ")} —— 说明不是纯只读打开，已中止`);
}
if (manifest.duplicates.length || manifest.badIds.length) {
  console.error("⚠ 有阻断项，导出的数据不得导入；见 manifest.json 的 duplicates / badIds");
  process.exit(2);
}
console.log("导出完成：无阻断项（duplicates / badIds 为空）");
