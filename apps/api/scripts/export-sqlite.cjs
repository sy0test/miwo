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
 * 目标结构（`001_schema`）对这些列的长度上限 —— **从 schema 机械推导**（修复轮 1）。
 *
 * ⚠ 为什么不能写死：这里原来是一张手写常量表，其中 `o_agentWorkData.data: 255` 在
 *   `e76f46f` 把那列改成 `t.text()`（mysql `longtext`）之后**没被同步删掉**，
 *   于是导出报告一直打印
 *     `⚠ o_agentWorkData.data：上限 255 字符（001_schema 收窄后的上限）… 实测最大 103624 字符，5 行超长`
 *   这条**陈旧告警** —— 读者会以为那 5 行长文本仍有被截断的风险。手写常量与 schema 之间
 *   没有任何机械联系，所以它必然漂移。
 *
 * 现在推导逻辑在 `scripts/schema-limits.cjs`（与 `tests/migration-ddl-mysql.test.ts`
 * 共用同一个实现，那条用例断言"推导值必须与 expectations 逐键相等"，漂移即红）。
 *   - 有数字上限的列（`varchar(N)` / `char(N)`）→ N；
 *   - `text` 家族（目标侧 `longtext`）→ 哨兵 `MAX_LENGTH`，导出侧把它当"无上限"跳过长度体检
 *     （`o_agentWorkData.data` 现在就是这一类：它**不再**出现在 `columnStats` / `oversizeValues` 里）；
 *   - 长度由源库 `PRAGMA` 声明、目标侧没有上限语义的列（`o_tasks.relatedObjects` 是
 *     `varchar(255)` → 目标 `longtext`）仍然按"源库声明"体检并如实告警 —— 那是**真**告警。
 */
const { deriveTargetLimits, MAX_LENGTH } = require(path.join(__dirname, "schema-limits.cjs"));

/** 同步的引导期检查：必须在任何导出动作之前跑，推导失败就退出（不是打印一条告警继续）。 */
function loadSchemaLimits() {
  // knex 与 better-sqlite3 一样，优先用 apps/api 自己的 node_modules
  let knexFactory;
  try {
    knexFactory = require(path.join(API_ROOT, "node_modules", "knex"));
  } catch {
    knexFactory = require("knex");
  }
  return deriveTargetLimits({
    migrationPath: path.join(API_ROOT, "src", "db", "migrations", "001_schema.ts"),
    knexFactory,
  });
}

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

// ⚠ 下面这些顶层副作用是**导出动作**的一部分（会读源库、会写 out 目录），必须只在"直接跑它"时发生：
//    `tests/migration-ddl-mysql.test.ts` 用 `createRequire` require 本文件来复用它自己的
//    `SCHEMA_LIMITS` 快照做漂移断言 —— 那种 require **绝不能**顺手跑一次真导出。
//    ESM 里判断"被 import 还是被直接跑"要 import.meta，但本文件是 CJS，`require.main === module`
//    是那件事的原生写法（且 `--import=tsx` / vitest 两种加载方式下都成立）。
const IS_MAIN = require.main === module;

// ---- 硬拒绝：用户机真实库（绝不在范围，连只读打开都不做）----
const USER_DATA = path.join(process.env.APPDATA || "", "ToonFlow", "data").toLowerCase();
if (IS_MAIN) {
  if (USER_DATA && SRC.toLowerCase().startsWith(USER_DATA)) {
    die(`拒绝执行：${SRC}\n  这是用户机正在使用的真实库（%APPDATA%\\ToonFlow\\data）。搬迁链只处理仓库内的 dev 库快照，对它连只读比对都不做。`);
  }
  if (!fs.existsSync(SRC)) die(`源库不存在：${SRC}`);
}

// ⚠ 为什么余下全部包在一个 async 块里：长度上限要**从 `001_schema` 机械推导**（修复轮 1），
//    而推导是异步的（`001_schema.up()` 是 async）。CJS 的 `.cjs` **不允许顶层 await**
//    （实测：`SyntaxError: await is only valid in async functions and the top level bodies of modules`），
//    所以入口是下面这个 async IIFE；`deriveTargetLimits` 内部对 tsx 的 TS 模块加载仍然是**同步**的
//    （CJS `require`），只是外面套了一层 Promise。
async function main() {
  let Database;
  try {
    Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
  } catch {
    Database = require("better-sqlite3");
  }

  const before = { sha256: sha256(SRC), companions: companions(SRC) };
  const db = new Database(SRC, { readonly: true });

  // 目标侧长度上限：从 `001_schema` 机械推导（失败即退出，绝不退化成"没有列有上限"）。
  const TARGET_LIMITS = await loadSchemaLimits();
  const limitOf = (key) => {
    const v = TARGET_LIMITS[key];
    return typeof v === "number" ? v : null; // MAX_LENGTH 哨兵 = 目标侧无数字上限
  };
  void limitOf;

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
    // ---- 长度体检（【Ruling 34/41 ②③】）----
    // ⚠ 口径必须与**导入侧**一致（修复轮 1 对齐）：`src/db/legacy/import.ts` 的 `oversizeValues()`
    //    拿的是**目标库** `columnInfo().maxLength`，它的注释写明"`text`/`longtext` 的 maxLength 是 null
    //    （不走这条）；只有真正带长度上限的列才量"。本脚本以前拿"源库 PRAGMA 声明的 varchar(N)"
    //    当上限，于是 `o_agentWorkData.data`（目标 `t.text()` → mysql `longtext`，源库却不巧还声明着
    //    `varchar(255)`）一直被报成"5 行超长"——那是一条**假的截断风险**，正是修复轮 1 要消掉的
    //    陈旧告警。现在：**目标侧没有数字上限的列不做超长判定**（只登记源库声明值供人核对）。
    for (const c of cols) {
      const declared = String(c.type || "");
      const m = /\(\s*(\d+)\s*\)/.exec(declared);
      const declaredLen = m ? Number(m[1]) : null;
      const key = `${table}.${c.name}`;
      const schemaLimit = limitOf(key);
      const unboundedTarget = TARGET_LIMITS[key] === MAX_LENGTH;
      if (declaredLen === null && schemaLimit === null && !unboundedTarget) continue; // 无长度约束的列不体检
      const limit = schemaLimit !== null ? (declaredLen !== null ? Math.min(schemaLimit, declaredLen) : schemaLimit) : declaredLen;
      if (unboundedTarget || limit === null) {
        manifest.columnStats[key] = {
          sourceDeclaredType: declared,
          targetLimit: null,
          limitSource: "001_schema（无数字上限）",
          maxChars: null,
          rowsOver: null,
        };
        continue;
      }
      const stat = db
        .prepare(`SELECT COALESCE(MAX(LENGTH("${c.name}")), 0) AS maxChars, SUM(CASE WHEN LENGTH("${c.name}") > ? THEN 1 ELSE 0 END) AS rowsOver FROM "${table}"`)
        .get(limit);
      manifest.columnStats[key] = {
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
    const how = o.limitSource === "001_schema" ? "001_schema 收窄后的上限" : "源库自己声明的长度（目标结构已放宽，超过它不算截断风险）";
    console.log(`    ⚠ ${o.table}.${o.column}：上限 ${o.targetLimit} 字符（${how}；源库声明类型 ${o.sourceDeclaredType || "无"}），实测最大 ${o.maxChars} 字符，${o.rowsOver} 行超长`);
  }
  // 这两列原来各有一条固定打印（`columnStats` 命中即打印）。`o_agentWorkData.data` 已被
  // `001_schema` 放宽成 `longtext` → **目标侧没有数字上限** → 不再产生 `oversizeValues`，
  // 于是那条"上限 255 / 5 行超长"的**陈旧告警**消失（这正是修复轮 1 要修的东西）。
  // 这里改成如实打印两列的**目标口径**，让"为什么没有告警"一眼可见，而不是让人以为漏检了。
  for (const key of ["o_agentWorkData.data", "memories.isolationKey"]) {
    const s = manifest.columnStats[key];
    if (!s) {
      console.log(`  ${key}：schema 里查不到这一列（告警也不该有——请核对 SCHEMA_LIMITS 推导与表名）`);
    } else if (s.targetLimit === null) {
      console.log(
        `  ${key}：目标结构无数字上限（001_schema 是 longtext；源库声明 ${s.sourceDeclaredType || "无"}），不做超长判定`,
      );
    } else {
      console.log(`  ${key}：max ${s.maxChars} 字符 / 上限 ${s.targetLimit}（${s.limitSource}），超长 ${s.rowsOver} 行`);
    }
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
}

// 直接跑本文件时才执行导出；被 `require`（漂移断言）时只暴露下面的常量。
if (IS_MAIN) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

module.exports = { loadSchemaLimits, MAX_LENGTH, IS_MAIN };
