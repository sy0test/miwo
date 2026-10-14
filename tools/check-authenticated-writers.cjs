#!/usr/bin/env node
/**
 * 特权原语 `runAsAuth()` 的**调用方门禁**（Phase 1c Task 4；控制器裁定 §2.1）。
 *
 * ── 为什么需要它 ──
 * `runAsAuth()`（`apps/api/src/db/noContext.ts`）造 `{role:"admin", userId:0, source:"system"}`，
 * 是**未认证上下文里唯一能写 platform 表**的路（登录/注册/登出/改密都发生在建租户 ctx **之前**）。
 * 它与 `systemDb`（裸 knex 绕过口）是同级的**特权原语**，但 1b 起只有 `systemDb` 有调用方门禁
 * （`tools/check-tenant-exceptions.cjs` 的 `systemDbUsers` 精确集合），`runAsAuth` 没有。
 * 后果：下一个人可以写
 *
 *     await runAsAuth(async () => u.db("o_user").where("id", req.body.id).update({...}))
 *
 * = 全站账号接管，而**没有任何机械判据**会红。
 *
 * ── 判据（精确集合，不是"存在性"）──
 *   ① `apps/api/src` 下命中 `runAsAuth` 的**文件集合**必须与
 *      `tools/auth-writer-registry.json` 的 `callers[].path` **逐项相等**（多/少都红）；
 *   ② 每个文件的**调用处数**必须等于登记的 `count`（"已在名单里的文件里多加一处"同样红）；
 *   ③ 每条登记必须有 `note`（人话理由）与 `evidence`（`xxx.test.ts#用例名`，且该文件必须存在）；
 *   ④ 判据基于**剥注释后**的文本（Ruling 239 的教训：注释里写 `runAsAuth(...)` 不该被判成调用）；
 *   ⑤ 自证观测（Ruling 243）：「一个命中都没有」不等于干净 —— 观测不到就 `exit 3`。
 *
 * ── 另一半（"platform 写只有两条合法路径"）──
 * 静态集合管不住"用别的名字拿到特权 ctx"。所以运行时由守卫本体断言：
 * `src/db/tenant-guard.ts` 的 `assertPlatformWriteAllowed()` 只放行
 * ① `ctx.source === "system" && ctx.role === "admin" && ctx.userId === 0`（= runAsAuth 原语）
 * ② `ctx.role === "admin"`（真管理员请求）
 * 判别力用例：`apps/api/tests/platform-write-paths.test.ts`（含 `source:"http" + role:"admin" + userId:0`
 * 的**伪造** ctx 必须被拒 —— 旧实现会放行它）。
 *
 * 用法：
 *   node tools/check-authenticated-writers.cjs            # 门禁
 *   node tools/check-authenticated-writers.cjs --record   # 只重算并打印观测到的集合/处数（**不**自动写登记：
 *                                                         # 特权原语的授权必须人工过目，写回也走人工编辑）
 *
 * 退出码：0 = 集合与处数逐项一致且标注齐全；1 = 漂移/未登记/标注缺失；3 = 观测不到（扫描没跑起来）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "apps", "api");
const SRC = path.join(API, "src");
const REGISTRY = path.join(__dirname, "auth-writer-registry.json");
const FACTS = path.join(__dirname, "auth-writer-facts.ts");
const RECORD = process.argv.includes("--record");

/** 只认**调用**（`runAsAuth(`），不认"提到这个名字"；配合剥注释使用。 */
const CALL_RE = /\brunAsAuth\s*\(/g;

const failures = [];

/**
 * 剥注释（**保持行号**：被剥掉的字符用空格补齐）。与 check-tenant-exceptions.cjs 同口径。
 * ⚠ 单行注释用 `[^:\\]` 保护 `http://`；字符串里的 `//` 仍会被误剥 —— 对本判据无影响
 *   （`runAsAuth(` 出现在字符串里不是调用，误剥只会更保守）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
}

/** 显式递归目录（禁止依赖 shell 的隐式递归）。 */
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

// ---------- 机械扫描：文件 → 调用处数（剥注释）----------
const files = walk(SRC).sort();
const observed = {};
let totalCalls = 0;
for (const f of files) {
  const text = stripComments(fs.readFileSync(f, "utf8"));
  const n = (text.match(CALL_RE) || []).length;
  if (n > 0) {
    observed[rel(f)] = n;
    totalCalls += n;
  }
}

// ---------- 自证观测（Ruling 243）：观测不到 ≠ 干净 ----------
if (files.length < 100 || totalCalls === 0 || !observed[rel(path.join(SRC, "auth", "service.ts"))]) {
  console.error(
    `check-authenticated-writers 无法完成：本次扫描观测不足（扫描到 ${files.length} 个 .ts、` +
      `runAsAuth 调用共 ${totalCalls} 处、命中文件 ${Object.keys(observed).length} 个` +
      `${observed[rel(path.join(SRC, "auth", "service.ts"))] ? "" : "、连 auth/service.ts 都没命中"}）。` +
      ` —— "观测不到"不等于"干净"。`,
  );
  process.exit(3);
}

if (RECORD) {
  console.log("观测到的 runAsAuth 调用集合（--record 只打印，**不**自动写登记）：");
  for (const p of Object.keys(observed).sort()) console.log(`  ${p}  count=${observed[p]}`);
  process.exit(0);
}

if (!fs.existsSync(REGISTRY)) {
  console.error(`缺少 ${rel(REGISTRY)}，请先按 tools/check-authenticated-writers.cjs 的文件头人工登记。`);
  process.exit(1);
}
const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
const callers = Array.isArray(registry.callers) ? registry.callers : [];

// ---------- ① 精确集合 ----------
const declared = callers.map((c) => c.path).sort();
const actual = Object.keys(observed).sort();
if (JSON.stringify(declared) !== JSON.stringify(actual)) {
  failures.push(
    `runAsAuth 调用方集合不一致（特权原语必须逐条登记，**未登记的调用点即失败**）：\n` +
      `      登记 ${declared.join(", ") || "（空）"}\n      代码 ${actual.join(", ") || "（空）"}\n` +
      `      新增调用点 ${actual.filter((p) => !declared.includes(p)).join(", ") || "（无）"}\n` +
      `      登记多余 ${declared.filter((p) => !actual.includes(p)).join(", ") || "（无）"}`,
  );
}

// ---------- ② 每文件调用处数 ----------
for (const c of callers) {
  const n = observed[c.path];
  if (n === undefined) continue; // ① 已报
  if (n !== c.count) {
    failures.push(
      `runAsAuth 调用处数漂移：${c.path} 登记 count=${c.count}，代码实测 ${n} 处` +
        `${n > c.count ? "（**多在已登记文件里加了一处** —— 同样必须人工过目）" : "（少了一处：请核对是否被误删）"}`,
    );
  }
}

// ---------- ③ 每条登记必须有 note + evidence（且 evidence 指向真实测试文件）----------
for (const c of callers) {
  if (!String(c.note || "").trim()) failures.push(`登记 ${c.path} 缺少 note（人话理由）`);
  const ev = String(c.evidence || "");
  if (!/^[a-z0-9./-]+\.test\.ts#/.test(ev)) {
    failures.push(`登记 ${c.path} 的 evidence 必须形如 "xxx.test.ts#用例名"，实际：${JSON.stringify(c.evidence)}`);
    continue;
  }
  // evidence 里的路径是**仓库根相对**（`apps/api/tests/xxx.test.ts`）或 `tests/xxx.test.ts`，
  // 两种写法都支持：统一按"相对 apps/api"解析（`tests/…` 前缀只保留一份）。
  const tf = ev.split("#")[0].replace(/^apps\/api\//, "");
  if (!fs.existsSync(path.join(API, tf))) {
    failures.push(`登记 ${c.path} 的 evidence 指向的测试文件不存在：${tf}`);
  }
}

// ---------- ④ 原语本体必须仍是"显式系统身份 + userId 0" ----------
const primitiveText = fs.existsSync(path.join(SRC, "db", "noContext.ts"))
  ? fs.readFileSync(path.join(SRC, "db", "noContext.ts"), "utf8")
  : "";
if (!/export\s+function\s+runAsAuth/.test(primitiveText)) {
  failures.push(`特权原语 runAsAuth 不在 ${registry.primitiveFile}（登记清单的前提失效，请核对是否被改名/搬走）`);
}
if (!/AUTH_SYSTEM_USER_ID\s*=\s*0/.test(primitiveText)) {
  failures.push("noContext.ts 的 AUTH_SYSTEM_USER_ID 不再是常量 0 —— 系统身份必须「不属于任何用户」（fail-closed）");
}

// ---------- ⑤ 运行时那一半：真 tsx 进程导入守卫的许可判定（探针，观测不到就 exit 3）----------
const probe = spawnSync(process.execPath, ["--import=tsx", path.relative(API, FACTS)], {
  cwd: API,
  encoding: "utf8",
  timeout: 120000,
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: "--import=tsx" },
});
const probeOut = `${probe.stdout || ""}${probe.stderr || ""}`;
const line = probeOut.split(/\r?\n/).find((l) => l.startsWith("AUTH_WRITER_FACTS="));
if (!line) {
  console.error(`check-authenticated-writers 无法完成：事实探针没有输出 AUTH_WRITER_FACTS=（exit ${probe.status}）。`);
  console.error(`  —— "观测不到"不等于"干净"（Ruling 243）。探针输出尾部：\n${probeOut.slice(-800)}`);
  process.exit(3);
}
let facts;
try {
  facts = JSON.parse(line.slice("AUTH_WRITER_FACTS=".length));
} catch (err) {
  console.error(`check-authenticated-writers 无法完成：探针输出不是合法 JSON：${String(err)}`);
  process.exit(3);
}
if (facts.observed !== true || !Array.isArray(facts.allowed) || facts.allowed.length < 2) {
  console.error(`check-authenticated-writers 无法完成：探针自证不足。${JSON.stringify(facts).slice(0, 400)}`);
  process.exit(3);
}
// 两条合法路径必须**恰好**被放行，其余一律拒绝（这里的清单就是"platform 写的合法路径"）。
// ⚠ `socket-admin` 允许是**刻意**的：`source` 是**来源标签**，不是权限开关 —— socket 侧同样由
//   `src/socket/tenant.ts` 用 DB 里的 role 建 ctx，与 HTTP 同源；把它算成"第三条路"会让同一个
//   管理员在两种传输上行为不同。判别力靠 `forged-system-admin-userId1`：**形状像系统身份但不是**
//   （`source:"system"` + `role:"admin"` 却 `userId ≠ 0`）必须被拒 —— 旧实现只看 `role === "admin"`，会放行它。
const wantAllowed = [
  "system-ctx(runAsAuth) => true",
  "http-admin => true",
  "socket-admin => true",
  "forged-system-admin-userId1 => false",
  "http-admin-userId0 => true",
  "http-user => false",
  "no-ctx => false",
];
if (JSON.stringify(facts.allowed) !== JSON.stringify(wantAllowed)) {
  failures.push(
    `platform 写的许可判定漂移（"只有 admin ctx 或 runAsAuth 两条合法路径"）：\n` +
      `      期望 ${JSON.stringify(wantAllowed)}\n      实测 ${JSON.stringify(facts.allowed)}`,
  );
}

if (failures.length) {
  console.error("check-authenticated-writers 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `check-authenticated-writers 通过：runAsAuth 调用方 ${actual.length} 个文件 / ${totalCalls} 处与登记逐项一致` +
    `（${actual.join(", ")}）；platform 写许可判定 = ${facts.allowed.length} 条观测全部符合"仅 admin ctx 或系统身份"；` +
    `扫描 ${files.length} 个 .ts（已剥注释）。`,
);
