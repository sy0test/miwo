#!/usr/bin/env node
/**
 * 隔离特例清单的防漂移门禁（spec §6.3 / 附录 B）。
 *
 * Phase 1b 的租户隔离设计是「所有 DB 访问走 utils/db.ts 的 fail-closed 包装层」。
 * 但仓库里有三类调用点**绕过**那个包装层，必须是一份**显式清单**而不是藏在代码里：
 *
 *   bypassFiles —— 直接 `import { db } from "@/utils/db"`（拿到裸 knex，不经过包装层）。
 *                  spec 附录 B.1 的定义就是这样：绕过的判据是「直接命名导入裸 db」。
 *   joins       —— 对 `o_*` 表的 join（被 join 的表要不要一起过滤租户，必须人工判定）。
 *   raws        —— `db.raw(...)` / `u.db.raw(...)` 调用（绕过 query builder，条件靠手写）。
 *
 * 用法：
 *   node tools/check-tenant-exceptions.cjs            # 门禁：清单必须与代码逐条一致，且每条都已确认
 *   node tools/check-tenant-exceptions.cjs --record   # 重新机械扫描并写回清单（保留已有的人工标注）
 *
 * 退出码：0 = 清单与代码一致且全部已标注；1 = 有漂移、有未标注、或清单缺失。
 *
 * ── 为什么扫描正则与 task-12-brief.md 的示例不完全相同（差异很小，是**刻意**的）──
 *   1. join：brief 示例是 `\.(leftJoin|innerJoin|rightJoin|join)\("o_`——它会把
 *      `path.join("o_xxx")`（文件路径拼接）和 `["o_xx", ...].join(` 也算成 DB join。
 *      本脚本要求表名参数紧跟引号（`\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`+"`"+`]o_`），
 *      只放宽了参数前的空格。实测当前代码库两者结果**完全相同**（都是 28 处 / 20 文件），
 *      但这个收紧能在新代码写 `path.join("o_...")` 时避免假红。
 *   2. raw：`\.raw\(` 会同时命中 `db.raw(` 与 `u.db.raw(`，也允许中间的空格。
 *   3. bypass：brief 示例是 `import\s*\{\s*db\s*\}\s*from\s*"@\/utils\/db"`（单引号没覆盖）。
 *      本脚本用 `import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/utils\/db["']`，
 *      多覆盖单引号与 `{ db, other }` 混排。实测当前代码库两者结果**完全相同**（都是 7 个）。
 *
 * ── 扫描范围（哪些文件**不算**特例）──
 *   `src/utils/db.ts` 自身、`src/utils.ts`（包装层的导出出口）、
 *   `src/lib/fixDB.ts`、`src/utils/taskRecord.ts`、`src/utils/agent/embedding.ts`：
 *   这些文件内部也用裸 db，但它们是**包装层自身 / 启动期改库 / 非请求上下文**，
 *   判据是「**命名导入** `{ db }`」而不是「任何 db 用法」——与 spec 附录 B.1 的口径一致。
 *   `src/lib/initDB.ts` / `src/lib/fixDB.ts` 还 `import { Knex } from "knex"`（只是**类型**）。
 *   这些"已知且已排除"的项在清单的 `scanScope.excludedKnownDirectDbImports` 里明列，
 *   一旦多出一个就直接红：想加新的裸 db 文件，必须显式改这个白名单，不能悄悄溜进来。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "apps/api/src");
const INV = path.join(SRC, "db/tenant-exceptions.json");
const RECORD = process.argv.includes("--record");

// 对 `o_*` 表的 join：表名必须是紧跟左括号（允许空格）的字符串字面量。
// 见文件头注释：比 brief 示例严一格，实测结果一致，避免 `path.join("o_…")` 假红。
const JOIN_RE = /\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`]o_/;
const JOIN_TARGET_RE = /\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`](o_[A-Za-z0-9_]+)/;
const RAW_RE = /\.raw\s*\(/;
const BYPASS_RE = /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/utils\/db["']/;

// 已知的"内部用裸 db 但不是特例"的文件（判据见文件头）。多一个就红，少一个也红。
const KNOWN_DIRECT_DB = [
  "apps/api/src/lib/fixDB.ts",
  "apps/api/src/lib/initDB.ts",
  "apps/api/src/utils.ts",
  "apps/api/src/utils/agent/embedding.ts",
  "apps/api/src/utils/db.ts",
  "apps/api/src/utils/taskRecord.ts",
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function scan() {
  const joins = {};
  const raws = {};
  const bypassFiles = [];
  const directDbImports = [];
  const files = walk(SRC).sort();
  for (const f of files) {
    const r = rel(f);
    const text = fs.readFileSync(f, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (JOIN_RE.test(line)) {
        joins[r] = joins[r] || { count: 0, lines: [], tables: [] };
        joins[r].count += 1;
        joins[r].lines.push(i + 1);
        const m = JOIN_TARGET_RE.exec(line);
        if (m) joins[r].tables.push(m[2]);
      }
      if (RAW_RE.test(line)) {
        raws[r] = raws[r] || { count: 0, lines: [] };
        raws[r].count += 1;
        raws[r].lines.push(i + 1);
      }
    });
    if (/(^|\n)\s*import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/utils\/db["']/.test(text)) {
      bypassFiles.push(r);
    }
    if (/(^|\n)\s*import\s+\w+\s+from\s*["']@\/utils\/db["']/.test(text)) {
      directDbImports.push(r);
    }
  }
  return { files: files.length, joins, raws, bypassFiles, directDbImports };
}

const failures = [];

if (RECORD) {
  const found = scan();
  const prev = fs.existsSync(INV) ? JSON.parse(fs.readFileSync(INV, "utf8")) : { joins: {}, raws: {}, bypassFiles: [] };

  // 保留已有的人工标注（按文件保留 confirmed/note），机械部分（count/lines/tables）重算。
  const keepMap = (prevMap, nextMap) => {
    for (const [k, v] of Object.entries(nextMap)) {
      const old = prevMap[k];
      nextMap[k] = {
        count: v.count,
        lines: v.lines,
        tables: v.tables,
        confirmed: old ? Boolean(old.confirmed) : false,
        note: old ? old.note || "" : "",
      };
    }
  };
  keepMap(prev.joins || {}, found.joins);
  keepMap(prev.raws || {}, found.raws);

  const prevBypass = prev.bypassFiles || [];
  const out = {
    generatedAt: new Date().toISOString(),
    note: "Phase 1b 的 apps/api/src/db/policies.ts 必须读取本文件作为特例依据。confirmed=true 且 note 非空才算标注完成。",
    scanScope: {
      srcRoot: "apps/api/src",
      tsFilesScanned: found.files,
      joins: "对 o_* 表的 join（表名是紧跟左括号的字符串字面量）",
      raws: "db.raw(...) / u.db.raw(...)",
      bypassFiles: "直接命名导入裸 db：import { db } from \"@/utils/db\"（spec 附录 B.1 的判据）",
      excludedKnownDirectDbImports: KNOWN_DIRECT_DB,
      excludedReason:
        "包装层自身（utils.ts / utils/db.ts）、启动期改库（lib/fixDB.ts、lib/initDB.ts 的 Knex 只是类型）、非请求上下文（utils/taskRecord.ts、utils/agent/embedding.ts）用的是默认导出的 dbClient，不受请求上下文隔离约束；它们是内部层，不记为特例。",
    },
    joins: found.joins,
    raws: found.raws,
    bypassFiles: found.bypassFiles.map((p) => {
      const old = prevBypass.find((x) => x.path === p);
      return { path: p, confirmed: old ? Boolean(old.confirmed) : false, note: old ? old.note || "" : "" };
    }),
    directDbImports: found.directDbImports,
  };

  fs.mkdirSync(path.dirname(INV), { recursive: true });
  fs.writeFileSync(INV, JSON.stringify(out, null, 2) + "\n", "utf8");
  const total = Object.keys(out.joins).length + Object.keys(out.raws).length + out.bypassFiles.length;
  const jTotal = Object.values(out.joins).reduce((a, v) => a + v.count, 0);
  const rTotal = Object.values(out.raws).reduce((a, v) => a + v.count, 0);
  console.log(
    `已写入机械清单 -> apps/api/src/db/tenant-exceptions.json（${total} 个文件待标注：join ${Object.keys(out.joins).length} 文件/${jTotal} 处、raw ${Object.keys(out.raws).length} 文件/${rTotal} 处、bypass ${out.bypassFiles.length} 个；另外记录 directDbImports ${out.directDbImports.length} 个）`,
  );
  process.exit(0);
}

if (!fs.existsSync(INV)) {
  console.error(`缺少 ${rel(INV)}，请先运行：node tools/check-tenant-exceptions.cjs --record`);
  process.exit(1);
}

const inv = JSON.parse(fs.readFileSync(INV, "utf8"));
const found = scan();

function diffMap(label, declared, actual) {
  for (const [file, v] of Object.entries(actual)) {
    if (!declared[file]) {
      failures.push(`${label}: 清单缺 ${file}（代码里有 ${v.count} 处，行 ${v.lines.join(",")}）`);
    } else if (declared[file].count !== v.count) {
      failures.push(`${label}: ${file} 清单 ${declared[file].count} 处，代码 ${v.count} 处（代码行 ${v.lines.join(",")}）`);
    } else if (JSON.stringify(declared[file].lines) !== JSON.stringify(v.lines)) {
      failures.push(`${label}: ${file} 处数相同但行号漂移——清单 ${declared[file].lines.join(",")}，代码 ${v.lines.join(",")}`);
    }
  }
  for (const file of Object.keys(declared)) {
    if (!actual[file]) failures.push(`${label}: 清单有 ${file}，但代码里已找不到`);
  }
}

diffMap("joins", inv.joins || {}, found.joins);
diffMap("raws", inv.raws || {}, found.raws);

const declaredBypass = (inv.bypassFiles || []).map((x) => x.path).sort();
if (JSON.stringify(declaredBypass) !== JSON.stringify(found.bypassFiles.slice().sort())) {
  failures.push(
    `bypassFiles 不一致：\n      清单 ${declaredBypass.join(", ")}\n      代码 ${found.bypassFiles.slice().sort().join(", ")}`,
  );
}

// 已知的"内部用裸 db"白名单：多一个（新出现的裸 db 文件）或少一个都要红。
const declaredKnown = ((inv.scanScope || {}).excludedKnownDirectDbImports || []).slice().sort();
if (JSON.stringify(declaredKnown) !== JSON.stringify(KNOWN_DIRECT_DB.slice().sort())) {
  failures.push(
    `scanScope.excludedKnownDirectDbImports 与脚本内置白名单不一致：\n      清单 ${declaredKnown.join(", ")}\n      脚本 ${KNOWN_DIRECT_DB.slice().sort().join(", ")}`,
  );
}
const newDirect = (inv.directDbImports || []).filter(
  (p) => !declaredBypass.includes(p) && !KNOWN_DIRECT_DB.includes(p),
);
if (newDirect.length) failures.push(`出现未经登记的直接 db 导入（既不是特例也不是已知内部层）：\n      ` + newDirect.join("\n      "));

// 每条必须已确认且有说明
const unconfirmed = [];
const noNote = [];
for (const [group, map] of [
  ["joins", inv.joins || {}],
  ["raws", inv.raws || {}],
]) {
  for (const [file, v] of Object.entries(map)) {
    if (!v.confirmed) unconfirmed.push(`${group}:${file}`);
    if (!v.note || !v.note.trim()) noNote.push(`${group}:${file}`);
  }
}
for (const x of inv.bypassFiles || []) {
  if (!x.confirmed) unconfirmed.push(`bypass:${x.path}`);
  if (!x.note || !x.note.trim()) noNote.push(`bypass:${x.path}`);
}

if (unconfirmed.length) failures.push(`未确认（confirmed=false）共 ${unconfirmed.length} 条：\n      ` + unconfirmed.join("\n      "));
if (noNote.length) failures.push(`缺少标注说明（note 为空）共 ${noNote.length} 条：\n      ` + noNote.join("\n      "));

if (failures.length) {
  console.error("check-tenant-exceptions 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

const jFiles = Object.keys(inv.joins).length;
const rFiles = Object.keys(inv.raws).length;
const jTotal = Object.values(inv.joins).reduce((a, v) => a + v.count, 0);
const rTotal = Object.values(inv.raws).reduce((a, v) => a + v.count, 0);
const total = jFiles + rFiles + (inv.bypassFiles || []).length;
console.log(
  `check-tenant-exceptions 通过（${total} 个文件已确认：join ${jFiles} 文件/${jTotal} 处 / raw ${rFiles} 文件/${rTotal} 处 / bypass ${(inv.bypassFiles || []).length} 个）`,
);
