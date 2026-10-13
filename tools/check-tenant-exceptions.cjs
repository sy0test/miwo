#!/usr/bin/env node
/**
 * 隔离特例清单的防漂移门禁（spec §6.3 / 附录 B；Phase 1b Task 8 收口 Ruling 202/204/243）。
 *
 * Phase 1b 的租户隔离设计是「所有请求期 DB 访问走 utils/db.ts 的 fail-closed 包装层」。
 * 但仓库里有几类调用点**绕过**那个包装层，必须是一份**显式清单**而不是藏在代码里：
 *
 *   systemDbUsers —— 拿到**裸 knex**（`systemDb`）的文件。这是唯一合法的绕过口，必须逐个登记。
 *                    **判据与 specifier 形态解耦**（Task 8）：命名 `{ systemDb }`、别名 `{ systemDb as x }`、
 *                    命名空间 `import * as m` + `m.systemDb`、相对路径 `../../utils/db`、
 *                    动态 `await import(...)`、`require(...)` 解构 —— 任一形态都命中。
 *                    ⚠ 默认导入 `import x from "@/utils/db"` 拿到的是**受守卫**的 handle（不是绕过口），
 *                      由下面的 `directDbImports` 判据覆盖（那 3 个文件是包装层内部/非请求上下文）。
 *   bypassFiles   —— 「把裸 handle 绑定成名字 `db`」的文件（`import { systemDb as db }`）。
 *                    ⚠ **裸 `import { db }` 已在本阶段删除，且现在是硬失败**（`BARE_DB_IMPORT_RE`）：
 *                      它曾经是 spec 附录 B.1 的 7 个绕过口，Task 3/7 全部清掉 ⇒ 谁再写回来当场红。
 *   joins         —— 对 `o_*` 表的 join（被 join 的表要不要一起过滤租户，必须人工判定）。
 *   raws          —— `db.raw(...)` / `u.db.raw(...)` 等（绕过 query builder，条件靠手写）。
 *
 * 除了"处数 count + 行号 lines"，还有两件**清单唯一不可替代**的东西必须一起比对：
 *   1. joins 的 `tables`（**被 join 的是哪张表**）：只比 count/lines 会漏掉"同行号同处数但表名被换掉"，
 *      而 policies.ts 正是**按这份清单**注入隔离策略。
 *   2. `directDbImports` / `scanScope` —— 与**本次扫描结果**比较（拿清单里的旧记录比会恒真假绿）。
 *
 * ── Task 8 的四处修复（F3–F6；brief Step 2）──
 *   F3 **跨行 join**：逐行扫描看不到把 `.leftJoin(` 与表名拆到两行的写法。修法：另用"把换行折成空格"的
 *      副本判定**是否存在** join 调用，若折叠版有而逐行版没有 ⇒ 报"跨行 join"失败（行号仍用逐行版，避免漂移）。
 *   F4 **RAW 接收者**：旧 `RAW_RE = /\.raw\s*\(/` 不限接收者（`pool.raw(`、`foo.raw(` 都会被算成 db.raw）。
 *      收紧为只认守卫/裸客户端的接收者名。
 *   F5 **scanScope 全字段校验**：旧版只比对 `excludedKnownDirectDbImports`，`srcRoot`/`tsFilesScanned` 等
 *      形同装饰（而报告拿它们当证据）。
 *   F6 `clearTable` 的 note 措辞（"值没有参数化"其实说反了：**表名**是插值、值本身是参数化的）——
 *      在 Task 8 重写 note 时一并改正。
 *
 * ── 每条特例必须有 Phase 1b 处置与证据（`phase1b` 字段，**非 --record 模式下必填**）──
 *   `phase1b.disposition ∈ {guard-auto, guard-auto+code, systemDb+admin, route-removed-later}`
 *   `phase1b.evidence` 形如 `xxx.test.ts#用例名`，且 `xxx.test.ts` 必须真实存在
 *   （⚠ 只校验**文件存在**，不校验用例名 —— 这是已知限制，写进 Task 8 报告）。
 *
 * ── 扫描前必须剥注释（Ruling 239 的假阳性教训）──
 *   `isolation-key.ts` 的注释里就写着 `import u from "@/utils"` 这类解释文字；不剥注释会把"解释为什么
 *   不能这么写"判成"真的这么写了"。`stripComments()` 用**空格替换**保持行号不变。
 *
 * 用法：
 *   node tools/check-tenant-exceptions.cjs            # 门禁：清单必须与代码逐条一致，且每条都已标注
 *   node tools/check-tenant-exceptions.cjs --record   # 重新机械扫描并写回清单（**保留**人工标注；
 *                                                     # 只有"该条目的行号/表名变了"才重置为未标注）
 *
 * 退出码：0 = 一致且全部已标注；1 = 有漂移/未标注/清单缺失；3 = 检查自身没跑起来（观测不到应有输入）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "apps/api/src");
const INV = path.join(SRC, "db/tenant-exceptions.json");
const RECORD = process.argv.includes("--record");

// 对 `o_*` 表的 join：表名必须是紧跟左括号（允许空格）的字符串字面量。
// ⚠ 比 brief 示例严一格：避免把 `path.join("o_…")` / `["o_x"].join(` 算成 DB join。
const JOIN_RE = /\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`]o_/;
const JOIN_TARGET_RE = /\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`](o_[A-Za-z0-9_]+)/;
// F4：raw 必须限定接收者（旧版 `/\.raw\s*\(/` 会把 `pool.raw(`、`foo.raw(` 也算进来）。
const RAW_RE = /\b(?:u\.db|db|systemDb|trx|knex|conn|connection)\s*\.\s*raw\s*\(/;
// 「把裸 handle 绑定成名字 db」：`import { systemDb as db }`（别名任意）——当前的 6 个 bypass。
const BYPASS_RE = /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["'][^"']*utils\/db["']/;
// 裸 `import { db }`：本阶段的 7 个附录 B.1 绕过口已被删除 ⇒ **出现即失败**。
const BARE_DB_IMPORT_RE = /import\s*\{\s*db\s*\}\s*from\s*["'][^"']*utils\/db["']/;
// 默认导入（拿到的是**受守卫**的 handle，不是绕过口）。
const DEFAULT_DB_IMPORT_RE = /(^|\n)\s*import\s+\w+\s+from\s*["'][^"']*utils\/db["']/;
// 直接 `import knex from "knex"`（会绕过守卫的 raw/子查询通道）——只允许出现在 src/db/** 与 src/lib/**。
const KNEX_IMPORT_RE = /(^|\n)\s*import\s+(?!type\b)[^\n]*\bfrom\s*["']knex["']/;
const KNEX_IMPORT_ALLOWED = [/^apps\/api\/src\/db\//, /^apps\/api\/src\/lib\//];

const DB_MODULE = String.raw`[^"']*utils\/db`;

/** 从 `@/utils/db` 拿到**裸 `systemDb`** 的所有形态（与 specifier 写法解耦）。 */
const SYSTEM_DB_FORMS = [
  // ① 命名导入（含别名）
  new RegExp(String.raw`import\s*\{[^}]*\bsystemDb\b[^}]*\}\s*from\s*["']${DB_MODULE}["']`),
  // ② 动态 import 解构：`const { systemDb } = await import("@/utils/db")`
  new RegExp(String.raw`\{\s*systemDb\b[^}]*\}\s*=\s*(?:await\s+)?import\s*\(\s*["']${DB_MODULE}["']`),
  // ③ require 解构：`const { systemDb } = require("@/utils/db")`（含 `.default` 变体不在此列）
  new RegExp(String.raw`\{\s*systemDb\b[^}]*\}\s*=\s*require\s*\(\s*["']${DB_MODULE}["']`),
];

/** 已知的"内部用裸 db 但不是特例"的文件（判据见文件头）。多一个就红，少一个也红。 */
const KNOWN_DIRECT_DB = [
  "apps/api/src/lib/fixDB.ts",
  "apps/api/src/lib/initDB.ts",
  "apps/api/src/utils.ts",
  "apps/api/src/utils/agent/embedding.ts",
  "apps/api/src/utils/db.ts",
  "apps/api/src/utils/taskRecord.ts",
];

/** Phase 1b 允许的处置类别（brief Step 3 的契约，不自创新词）。 */
const PHASE1B_DISPOSITIONS = new Set(["guard-auto", "guard-auto+code", "systemDb+admin", "route-removed-later"]);

/**
 * 剥注释（**保持行号**：被剥掉的字符用空格补齐，换行不动）。
 * ⚠ `//` 一层用 `[^:\\]` 保护 `http://` 这类字面量；字符串里的 `//` 仍会被误剥 —— 对本脚本的判据无影响
 *   （我们只找 import/join/raw 这些**代码位置**，误剥只会让判据更保守）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

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

/**
 * 一个文件是否**拿到了裸 `systemDb`**（与 specifier 形态解耦）。
 * 覆盖：命名/别名导入、命名空间导入 + `<ns>.systemDb` 使用、相对路径、动态 `import()`、`require()`。
 */
function scanSystemDbUser(text) {
  if (SYSTEM_DB_FORMS.some((re) => re.test(text))) return true;
  // 命名空间导入 + 成员访问（`import * as m from "@/utils/db"` … `m.systemDb(`）
  const nsRe = new RegExp(String.raw`import\s*\*\s*as\s+(\w+)\s+from\s*["']${DB_MODULE}["']`, "g");
  for (const m of text.matchAll(nsRe)) {
    const re = new RegExp(String.raw`\b${m[1]}\s*\.\s*systemDb\b`);
    if (re.test(text)) return true;
  }
  // `require("@/utils/db").systemDb` / `(await import("@/utils/db")).systemDb`
  const directRe = new RegExp(
    String.raw`(?:require\s*\(\s*["']${DB_MODULE}["']\s*\)|import\s*\(\s*["']${DB_MODULE}["']\s*\))\s*\.\s*systemDb\b`,
  );
  return directRe.test(text);
}

function scan() {
  const joins = {};
  const raws = {};
  const bypassFiles = [];
  const systemDbUsers = [];
  const directDbImports = [];
  const knexImports = [];
  const bareDbImports = [];
  const crossLineJoins = [];
  const files = walk(SRC).sort();
  for (const f of files) {
    const r = rel(f);
    const rawText = fs.readFileSync(f, "utf8");
    const text = stripComments(rawText); // ⚠ 判据一律基于**剥注释后**的文本（Ruling 239）
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
    // F3：折叠换行后仍能看到 join，但逐行扫描没看到 ⇒ 跨行写法（报告出来，让作者写单行或扩展解析）。
    const collapsed = text.replace(/\s*\n\s*/g, " ");
    if (/\.(leftJoin|innerJoin|rightJoin|join)\(\s*["'`]o_/i.test(collapsed) && !joins[r]) {
      crossLineJoins.push(r);
    }
    if (BYPASS_RE.test(text)) bypassFiles.push(r);
    if (BARE_DB_IMPORT_RE.test(text)) bareDbImports.push(r);
    if (DEFAULT_DB_IMPORT_RE.test(text)) directDbImports.push(r);
    if (KNEX_IMPORT_RE.test(text)) knexImports.push(r);
    if (scanSystemDbUser(text)) systemDbUsers.push(r);
  }
  return { files: files.length, joins, raws, bypassFiles, systemDbUsers, directDbImports, knexImports, bareDbImports, crossLineJoins };
}

/** 校验一条 `phase1b` 标注（非 --record 模式下必填）。 */
function checkPhase1b(failures, label, v) {
  const d = v && v.phase1b;
  if (!d) {
    failures.push(`${label} 缺少 phase1b（Phase 1b 处置 + 证据；可选 disposition：${[...PHASE1B_DISPOSITIONS].join(" / ")}）`);
    return;
  }
  if (!PHASE1B_DISPOSITIONS.has(d.disposition)) {
    failures.push(`${label} 的 phase1b.disposition 非法：${String(d.disposition)}（可选：${[...PHASE1B_DISPOSITIONS].join(" / ")}）`);
  }
  if (!d.evidence || !/^[a-z0-9-]+\.test\.ts#/.test(d.evidence)) {
    failures.push(`${label} 的 phase1b.evidence 必须形如 "xxx.test.ts#用例名"，实际：${String(d.evidence)}`);
    return;
  }
  const testFile = d.evidence.split("#")[0];
  if (!fs.existsSync(path.join(ROOT, "apps", "api", "tests", testFile))) {
    failures.push(`${label} 的 phase1b.evidence 指向的测试文件不存在：${testFile}`);
  }
  if (!String(d.note || "").trim()) failures.push(`${label} 的 phase1b.note 为空（写"现在的代码怎么被隔离的"）`);
}

const failures = [];

if (RECORD) {
  const found = scan();
  const prev = fs.existsSync(INV) ? JSON.parse(fs.readFileSync(INV, "utf8")) : { joins: {}, raws: {}, bypassFiles: [] };

  /**
   * 保留人工标注，但**只在机械部分没变时**保留。
   * ⚠ Task 8 修正：旧实现无条件继承 `confirmed/note` ⇒ 一个 join 被改到别的行/别的表之后，
   *   旧标注（"这处已确认安全"）会**贴到已变化的条目上** = 假信心。现在按
   *   `lines + tables` 逐项比对，一致才继承；不一致重置为未标注（必须重新人工判定）。
   */
  const inherit = (foundMap, prevMap) => {
    const out = {};
    for (const [file, v] of Object.entries(foundMap)) {
      const old = (prevMap || {})[file];
      const same =
        old &&
        JSON.stringify(old.lines) === JSON.stringify(v.lines) &&
        JSON.stringify(old.tables ?? []) === JSON.stringify(v.tables ?? []);
      out[file] = same
        ? { ...v, confirmed: Boolean(old.confirmed), note: old.note || "", phase1b: old.phase1b || null }
        : { ...v, confirmed: false, note: "", phase1b: null };
    }
    return out;
  };

  const prevBypass = prev.bypassFiles || [];
  const prevSystemDb = prev.systemDbUsers || {};
  const systemDbUsersMap = {};
  for (const p of found.systemDbUsers.slice().sort()) {
    const old = prevSystemDb[p];
    const stillBare = prevBypass.find((x) => x.path === p);
    systemDbUsersMap[p] = old
      ? { confirmed: Boolean(old.confirmed), note: old.note || "", phase1b: old.phase1b || null }
      : { confirmed: Boolean(stillBare && stillBare.confirmed), note: (stillBare && stillBare.note) || "", phase1b: (stillBare && stillBare.phase1b) || null };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: "Phase 1b 的 apps/api/src/db/policies.ts 必须读取本文件作为特例依据。confirmed=true 且 note 非空才算标注完成；每条还必须有 phase1b（处置 + 证据）。",
    scanScope: {
      srcRoot: "apps/api/src",
      tsFilesScanned: found.files,
      joins: "对 o_* 表的 join（表名是紧跟左括号的字符串字面量）",
      raws: "db.raw(...) / u.db.raw(...)（接收者限定：u.db/db/systemDb/trx/knex/conn/connection）",
      systemDbUsers: "拿到裸 systemDb 的文件（命名/别名/命名空间/相对路径/动态 import/require 任一形态）",
      bypassFiles: "把裸 handle 绑定成名字 db 的文件：import { systemDb as db } from \"@/utils/db\"",
      bareDbImports: "裸 import { db } from \"@/utils/db\" —— **必须为空**（附录 B.1 的 7 个绕过口已全部删除）",
      directDbImports: "默认导入 import x from \"@/utils/db\"（受守卫的 handle；只允许已知内部层）",
      knexImports: "直接 import ... from \"knex\"（只允许 src/db/** 与 src/lib/**）",
      excludedKnownDirectDbImports: KNOWN_DIRECT_DB,
      excludedReason:
        "包装层自身（utils.ts / utils/db.ts）、启动期改库（lib/fixDB.ts、lib/initDB.ts 的 Knex 只是类型）、非请求上下文（utils/taskRecord.ts、utils/agent/embedding.ts）用的是默认导出的 dbClient，不受请求上下文隔离约束；它们是内部层，不记为特例。",
    },
    joins: inherit(found.joins, prev.joins),
    raws: inherit(found.raws, prev.raws),
    systemDbUsers: systemDbUsersMap,
    bypassFiles: found.bypassFiles.map((p) => {
      const old = prevBypass.find((x) => x.path === p) || prevSystemDb[p] || {};
      return { path: p, confirmed: Boolean(old.confirmed), note: old.note || "", phase1b: old.phase1b || null };
    }),
    bypassFilesHistory: prev.bypassFilesHistory || [],
    directDbImports: found.directDbImports,
    knexImports: found.knexImports,
  };

  fs.mkdirSync(path.dirname(INV), { recursive: true });
  fs.writeFileSync(INV, JSON.stringify(out, null, 2) + "\n", "utf8");
  const jTotal = Object.values(out.joins).reduce((a, v) => a + v.count, 0);
  const rTotal = Object.values(out.raws).reduce((a, v) => a + v.count, 0);
  console.log(
    `已写入机械清单 -> apps/api/src/db/tenant-exceptions.json（join ${Object.keys(out.joins).length} 文件/${jTotal} 处、raw ${Object.keys(out.raws).length} 文件/${rTotal} 处、systemDbUsers ${Object.keys(out.systemDbUsers).length} 个、bypass ${out.bypassFiles.length} 个、knexImports ${out.knexImports.length} 个、bareDbImports ${found.bareDbImports.length} 个）`,
  );
  process.exit(0);
}

if (!fs.existsSync(INV)) {
  console.error(`缺少 ${rel(INV)}，请先运行：node tools/check-tenant-exceptions.cjs --record`);
  process.exit(1);
}

const inv = JSON.parse(fs.readFileSync(INV, "utf8"));
const found = scan();

// ⚠ 自证"检查跑起来了"（Ruling 243 的精神）：扫描必须至少看到源文件与已声明的表清单。
//   观测不到 = 扫描根本没工作 ⇒ exit 3（"观测不到 ≠ 干净"）。
if (!(found.files > 100) || Object.keys(found.joins).length === 0 || Object.keys(found.raws).length === 0) {
  console.error(
    `check-tenant-exceptions 无法完成：本次扫描观测不足（files=${found.files}、join 文件=${Object.keys(found.joins).length}、raw 文件=${Object.keys(found.raws).length}）` +
      ` —— "观测不到"不等于"干净"。`,
  );
  process.exit(3);
}

function diffMap(label, declared, actual) {
  for (const [file, v] of Object.entries(actual)) {
    if (!declared[file]) {
      failures.push(`${label}: 清单缺 ${file}（代码里有 ${v.count} 处，行 ${v.lines.join(",")}）`);
    } else if (declared[file].count !== v.count) {
      failures.push(`${label}: ${file} 清单 ${declared[file].count} 处，代码 ${v.count} 处（代码行 ${v.lines.join(",")}）`);
    } else if (JSON.stringify(declared[file].lines) !== JSON.stringify(v.lines)) {
      failures.push(`${label}: ${file} 处数相同但行号漂移——清单 ${declared[file].lines.join(",")}，代码 ${v.lines.join(",")}`);
    } else if (JSON.stringify(declared[file].tables ?? []) !== JSON.stringify(v.tables ?? [])) {
      // ⚠ 这一支是"表名漂移"的唯一探测器：处数与行号都没变时，只有它知道"被 join 的表被换掉了"。
      failures.push(
        `${label}: ${file} tables 漂移——清单 ${JSON.stringify(declared[file].tables ?? [])}，代码 ${JSON.stringify(v.tables ?? [])}（行 ${v.lines.join(",")}）`,
      );
    }
  }
  for (const file of Object.keys(declared)) {
    if (!actual[file]) failures.push(`${label}: 清单有 ${file}，但代码里已找不到`);
  }
}

diffMap("joins", inv.joins || {}, found.joins);
diffMap("raws", inv.raws || {}, found.raws);

// ① systemDb（唯一合法绕过口）：**任一 specifier 形态**都必须逐条登记（Task 8 / Ruling 202/204/247）。
const declaredSystemDb = Object.keys(inv.systemDbUsers || {}).sort();
const actualSystemDb = found.systemDbUsers.slice().sort();
if (JSON.stringify(declaredSystemDb) !== JSON.stringify(actualSystemDb)) {
  failures.push(
    `systemDb 使用者不一致（绕过口必须显式登记，形态解耦：命名/别名/命名空间/相对/动态 import/require）：\n` +
      `      清单 ${declaredSystemDb.join(", ") || "（空）"}\n      代码 ${actualSystemDb.join(", ") || "（空）"}`,
  );
}
for (const [file, v] of Object.entries(inv.systemDbUsers || {})) {
  if (!v.confirmed) failures.push(`systemDbUsers:${file} 未确认（confirmed=false）`);
  if (!String(v.note || "").trim()) failures.push(`systemDbUsers:${file} 缺少标注说明（note 为空）`);
  checkPhase1b(failures, `systemDbUsers:${file}`, v);
}

// ② 裸 `import { db }`：**必须为空**（附录 B.1 的 7 个绕过口已删除）。
if (found.bareDbImports.length) {
  failures.push(`又出现了裸 db 命名导入（附录 B.1 的绕过口，必须为空）：\n      ` + found.bareDbImports.join("\n      "));
}
// ③ bypassFiles（绑定成名字 db 的形态）：清单与代码必须逐项一致。
const declaredBypass = (inv.bypassFiles || []).map((x) => x.path).sort();
if (JSON.stringify(declaredBypass) !== JSON.stringify(found.bypassFiles.slice().sort())) {
  failures.push(
    `bypassFiles 不一致：\n      清单 ${declaredBypass.join(", ")}\n      代码 ${found.bypassFiles.slice().sort().join(", ")}`,
  );
}
for (const x of inv.bypassFiles || []) {
  if (!x.confirmed) failures.push(`bypass:${x.path} 未确认（confirmed=false）`);
  if (!String(x.note || "").trim()) failures.push(`bypass:${x.path} 缺少标注说明（note 为空）`);
  checkPhase1b(failures, `bypass:${x.path}`, x);
}
// ④ 历史存档：附录 B.1 的 7 个绕过口必须**逐个**留下"后来怎么处置的"，别让审计链断掉。
const history = inv.bypassFilesHistory || [];
if (!Array.isArray(history) || history.length !== 7) {
  failures.push(`bypassFilesHistory 必须是 7 条历史存档（附录 B.1 的 7 个绕过口），实际 ${Array.isArray(history) ? history.length : "非数组"}`);
} else {
  for (const h of history) {
    if (!h.path || !String(h.note || "").trim()) failures.push(`bypassFilesHistory 条目缺 path/note：${JSON.stringify(h)}`);
    if (!h.phase1b || !PHASE1B_DISPOSITIONS.has(h.phase1b.disposition)) {
      failures.push(`bypassFilesHistory:${h.path} 缺少合法的 phase1b.disposition`);
    }
  }
}
// ⑤ 直接 import knex：只允许 src/db/** 与 src/lib/**（否则绕过守卫的 raw/子查询通道）。
const badKnex = found.knexImports.filter((p) => !KNEX_IMPORT_ALLOWED.some((re) => re.test(p)));
if (badKnex.length) {
  failures.push(`直接 import knex 的文件不在白名单内（会绕过租户守卫）：\n      ` + badKnex.join("\n      "));
}
const declaredKnex = (inv.knexImports || []).slice().sort();
if (JSON.stringify(declaredKnex) !== JSON.stringify(found.knexImports.slice().sort())) {
  failures.push(
    `knexImports 与本次扫描不一致（清单是上次 --record 的快照）：\n      清单 ${declaredKnex.join(", ")}\n      代码 ${found.knexImports.slice().sort().join(", ")}`,
  );
}
// ⑥ F3：跨行 join（逐行扫描看不到的写法）。
if (found.crossLineJoins.length) {
  failures.push(
    `存在**跨行书写**的 join（逐行扫描看不到，清单会漏登记）：\n      ` +
      found.crossLineJoins.join("\n      ") +
      `\n      请把 join 写成单行，或扩展本脚本的行号解析`,
  );
}

// 已知的"内部用裸 db"白名单：多一个（新出现的裸 db 文件）或少一个都要红。
const declaredKnown = ((inv.scanScope || {}).excludedKnownDirectDbImports || []).slice().sort();
if (JSON.stringify(declaredKnown) !== JSON.stringify(KNOWN_DIRECT_DB.slice().sort())) {
  failures.push(
    `scanScope.excludedKnownDirectDbImports 与脚本内置白名单不一致：\n      清单 ${declaredKnown.join(", ")}\n      脚本 ${KNOWN_DIRECT_DB.slice().sort().join(", ")}`,
  );
}
// ⑦ F5：scanScope **全字段**校验（旧版只比一个字段，其余是装饰）。
const scanScopeChecks = [
  ["srcRoot", (inv.scanScope || {}).srcRoot, "apps/api/src"],
  ["tsFilesScanned", Number((inv.scanScope || {}).tsFilesScanned ?? -1), found.files],
];
for (const [label, actual, expected] of scanScopeChecks) {
  if (actual !== expected) {
    failures.push(`scanScope.${label} 漂移：清单 ${String(actual)}，实际 ${String(expected)}（apps/api/src 下的 .ts 集合变了，请重跑 --record）`);
  }
}
// ⚠ 必须用 found.directDbImports（**本次扫描结果**），不能用 inv.directDbImports（清单里的旧记录）：
//   清单是 `--record` 用自身扫描结果写出来的，拿旧记录去比会让 newDirect **恒为空**（恒真假绿）。
const foundDirect = found.directDbImports.slice().sort();
const declaredDirect = (inv.directDbImports || []).slice().sort();
const newDirect = foundDirect.filter((p) => !declaredBypass.includes(p) && !KNOWN_DIRECT_DB.includes(p));
if (newDirect.length) failures.push(`出现未经登记的直接 db 导入（既不是特例也不是已知内部层）：\n      ` + newDirect.join("\n      "));
if (JSON.stringify(declaredDirect) !== JSON.stringify(foundDirect)) {
  failures.push(
    `directDbImports 与本次扫描不一致（清单是上次 --record 的快照，已过期，请重跑 --record）：\n      清单 ${declaredDirect.join(", ")}\n      代码 ${foundDirect.join(", ")}`,
  );
}

// ⑧ 每条特例必须已确认 + 有说明 + 有 phase1b 处置与证据
const unconfirmed = [];
const noNote = [];
for (const [group, map] of [
  ["joins", inv.joins || {}],
  ["raws", inv.raws || {}],
]) {
  for (const [file, v] of Object.entries(map)) {
    if (!v.confirmed) unconfirmed.push(`${group}:${file}`);
    if (!v.note || !v.note.trim()) noNote.push(`${group}:${file}`);
    checkPhase1b(failures, `${group}:${file}`, v);
  }
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
const total = jFiles + rFiles + Object.keys(inv.systemDbUsers || {}).length + (inv.bypassFiles || []).length;
console.log(
  `check-tenant-exceptions 通过（${total} 个文件已确认：join ${jFiles} 文件/${jTotal} 处 / raw ${rFiles} 文件/${rTotal} 处 / systemDbUsers ${Object.keys(inv.systemDbUsers || {}).length} 个 / bypass ${(inv.bypassFiles || []).length} 个；历史存档 ${(inv.bypassFilesHistory || []).length} 条；裸 db 导入 0；knexImports ${(inv.knexImports || []).length} 个）`,
);
