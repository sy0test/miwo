#!/usr/bin/env node
/**
 * 一次性转换脚本（Phase 1c Task 8，**提交进仓库以便复核**）：
 *   `apps/api/data/vendor/<id>.ts`（沙箱形态） → `apps/api/src/vendors/<id>.ts`（ES 模块形态）
 *
 * ── 旧形态长什么样 ──
 * 13 个适配器都是"给 vm2 沙箱执行"的：**0 个 import**、靠 `declare const createOpenAI: any;` 等
 * 假装 20 个全局存在、靠 `exports.vendor = vendor;` 把结果吐回沙箱、末尾补 `export {};` 让
 * TypeScript 把文件当模块（否则顶层 `declare` + 重复名字会撞全局）。
 *
 * ── 转换规则（4 条，机械、无例外）──
 *   1. 删掉 `export {};` / `export { };` 这类空导出行（新文件用真正的 `export { … }`；
 *      留着它虽然合法，但会让"该文件到底导出了什么"有两个来源）。
 *   2. 收集所有 `^\s*exports\.<name>\s*=\s*<name>;?$` 行里的 `<name>`（**保持出现顺序**），
 *      然后把**这些赋值行一并删除**。为什么必须删而不是留着：沙箱里 `exports` 是 `runCode`
 *      注入的对象，模块形态里没有这个名字 —— 留着就是"引用未声明变量"（TS2304）。
 *      实测 13/13 文件里 `exports.<name>` **只**出现在这批赋值行上（`null.ts:315` 那处
 *      是**注释**里教人怎么写适配器，不是代码），所以"删干净"是可验证的。
 *   3. 文件顶部插入一行固定 import 头（`src/vendors/runtime.ts`）。
 *   4. 末尾追加 `export { a, b, … };`。
 *   5. 删掉**沙箱全局的 `declare const`**（`declare const createOpenAI: any;` 等）。
 *      ⚠ 这一步是**实测**加上的：第一版把 `declare const` 留在产物里，`tsc` 当场报
 *      **13 个文件 × N 条 `TS2440: Import declaration conflicts with local declaration of 'x'`**
 *      —— `declare const` 在本文件里就是"局部声明"，与 import 同名直接冲突（不是"import 胜出"，
 *      我原以为是后者）。沙箱形态必须有这些声明（否则模块里引用全局就是 TS2304）；
 *      模块形态必须没有（import 就是声明）。
 *      判据：删的是**名字恰好落在 `SANDBOX_GLOBALS` 里**的 `declare const` 行；
 *      `declare const exports: { … }`（多行对象）与适配器自己的 `declare const SERVICE` 之类
 *      **一律保留**（前者是旧 `exports` 对象的形状说明，后者不是沙箱全局）。
 *
 * ── 用法 ──
 *   node apps/api/scripts/vendor-to-module.cjs            # 干跑：只转换到内存 + esbuild 解析校验，不写盘
 *   node apps/api/scripts/vendor-to-module.cjs --apply    # 写盘（目标已存在 ⇒ 报错退出；--force 覆盖）
 *
 * 干跑（无 `--apply`）也做**全部**校验并打印结论，所以"迁移前先看会不会崩"是免费的。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const API_ROOT = path.resolve(__dirname, "..");
const SRC_DIR_DEFAULT = path.join(API_ROOT, "data", "vendor");
/** `--src=<路径>`：源目录覆盖。
 *  存在的理由是**可复核性**：`data/vendor/` 已随 Task 8 删除，要"重跑一遍看产物是否逐字节相同"
 *  就得先把 13 个源文件从 VCS 取到仓库外（`git show HEAD~:<file>` → `%TEMP%`），再指过来。
 *  没有这个开关，"转换脚本可重跑"就只是一句话。 */
const srcArg = process.argv.find((a) => a.startsWith("--src="));
const SRC_DIR = srcArg ? path.resolve(API_ROOT, srcArg.slice("--src=".length)) : SRC_DIR_DEFAULT;
const OUT_DIR = path.join(API_ROOT, "src", "vendors");
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

/** 固定 import 头（与 `src/vendors/runtime.ts` 的导出**逐一对应**；名字顺序照旧沙箱对象）。 */
const IMPORT_HEAD = `import { createOpenAI, createDeepSeek, createZhipu, createQwen, createAnthropic, createOpenAICompatible, createXai, createMinimax, createGoogleGenerativeAI, zipImage, zipImageResolution, urlToBase64, mergeImages, pollTask, logger, jsonwebtoken, crypto, FormData, axios } from "@/vendors/runtime";
`;

const EXPORT_LINE_RE = /^\s*exports\.([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*;?\s*$/;
const EMPTY_EXPORT_RE = /^\s*export\s*\{\s*\};?\s*$/;

/** 旧沙箱提供的 20 个全局（与 `src/vendors/runtime.ts` 的导出逐一对应；`fetch` 是 Node 全局）。 */
const SANDBOX_GLOBALS = [
  "createOpenAI",
  "createDeepSeek",
  "createZhipu",
  "createQwen",
  "createAnthropic",
  "createOpenAICompatible",
  "createXai",
  "createMinimax",
  "createGoogleGenerativeAI",
  "zipImage",
  "zipImageResolution",
  "urlToBase64",
  "mergeImages",
  "pollTask",
  "fetch",
  "axios",
  "FormData",
  "logger",
  "jsonwebtoken",
  "crypto",
];

/** 单行 `declare const <name>: …;`（允许行尾注释；多行的 `declare const exports: {` 不在内）。 */
const DECLARE_CONST_RE = /^\s*declare\s+const\s+([A-Za-z_$][\w$]*)\s*:.*;\s*(?:\/\/.*)?$/;
/** 多行声明的**首行**（`declare const pollTask: (` 这种，type 在后续行）。 */
const DECLARE_CONST_OPEN_RE = /^\s*declare\s+const\s+([A-Za-z_$][\w$]*)\s*:/;

/** 收集一个文件里的导出名（保持出现顺序、去重）。 */
function collectExports(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(EXPORT_LINE_RE);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** 旧文件**代码行**里出现的 `exports.<name>` 名字（注释里的不算 —— `null.ts:315` 在注释里
 *  教人怎么写适配器，把它算进来会误报"XXX 没被收集"）。 */
function codeExportsMentions(text) {
  const out = new Set();
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
  for (const m of code.matchAll(/\bexports\.([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}

function convert(text) {
  const lines = text.split(/\r?\n/);
  // 规则 1 + 2 + 5：空 `export {};`、`exports.X = X;` 赋值行、以及沙箱全局的 `declare const` 都删掉。
  // ⚠ 5 必须按**声明块**删（不是按行）：`declare const pollTask: (` 的 type 在后续行上
  //   （`vidu.ts:73`），只删首行会留下半截语法。单行形态（含行尾注释）与多行形态都要覆盖。
  const droppedDeclares = [];
  const kept = [];
  let skippingDeclare = false;
  for (const l of lines) {
    if (skippingDeclare) {
      if (/;\s*(?:\/\/.*)?$/.test(l)) skippingDeclare = false;
      continue;
    }
    if (EMPTY_EXPORT_RE.test(l) || EXPORT_LINE_RE.test(l)) continue;
    const single = l.match(DECLARE_CONST_RE);
    if (single && SANDBOX_GLOBALS.includes(single[1])) {
      droppedDeclares.push(single[1]);
      continue;
    }
    const open = l.match(DECLARE_CONST_OPEN_RE);
    // ⚠ `exports` 不在跳过名单里：沙箱形态下它只是"结果收集对象"的形状说明，
    //   而 `exports.vendor = vendor` 那几行已被块形态的 `export { … }` 取代（规则 4）
    //   ⇒ 现存的那一坨 `declare const exports` 是**死声明**。不删它的理由见文件头。
    if (open && SANDBOX_GLOBALS.includes(open[1])) {
      droppedDeclares.push(open[1]);
      if (!/;\s*(?:\/\/.*)?$/.test(l)) skippingDeclare = true;
      continue;
    }
    kept.push(l);
  }
  const body = kept.join("\n");
  // ⚠ 头部注释里**不得**出现那两个被禁模块的名字（`apps/api/tests/vendors-registry.test.ts` 会扫
  //   "活代码行"，模板字符串里的注释行也算活代码）。所以这里用"沙箱"指代，不写模块名。
  const inserted = `// ⚠ 本文件由 ` + "`apps/api/scripts/vendor-to-module.cjs`" + ` 从 ` + "`apps/api/data/vendor/`" + ` 转换而来（Phase 1c Task 8）。\n` +
    `//   沙箱执行通道已删除：适配器现在是**编译期内置**的普通 ES 模块，运行期不加载/不执行任何外部代码。\n` +
    IMPORT_HEAD + body;
  const names = collectExports(text);
  return { code: `${inserted}\n\nexport { ${names.join(", ")} };\n`, names, droppedDeclares, unterminatedDeclare: skippingDeclare };
}

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`❌ 源目录不存在：${SRC_DIR}（迁移完成后本脚本只用于复核，源已随 git 删除）`);
    process.exit(1);
  }
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts")).sort();
  if (!files.length) {
    console.error(`❌ ${SRC_DIR} 里没有 .ts`);
    process.exit(1);
  }

  // 幂等：目标已存在就报错退出（除非 --force）——避免"再跑一次把人工改过的产物覆盖掉"。
  const existing = files.map((f) => path.join(OUT_DIR, f)).filter((p) => fs.existsSync(p));
  if (APPLY && existing.length && !FORCE) {
    console.error(`❌ 目标已存在 ${existing.length} 个文件（首次：${path.relative(API_ROOT, existing[0])}）。要覆盖请加 --force。`);
    process.exit(1);
  }
  if (APPLY && FORCE && existing.length) {
    // ⚠⚠ 这不是"例行提示"，是一个**已知会丢东西**的操作：产物里至少有 7 处**人工补丁**
    //   （6 处 `as any` 类型断言 + `metoken.ts` 的两个接口定义 —— 沙箱形态下 tsconfig 把
    //   `data/**/*.ts` 排除在外，所以那些类型错误从来没被看见过）。`--force` 会按源文件重新生成，
    //   把补丁全部抹掉。要重跑请先 `git diff apps/api/src/vendors` 记住补丁，或者只跑干跑模式。
    console.error(
      `⚠⚠ --force 会覆盖 ${existing.length} 个已有产物。产物里含**人工补丁**` +
        `（类型断言 6 处 + metoken.ts 的 ImageConfig/TTSConfig）—— 覆盖后必须重新补上并重跑 typecheck。`,
    );
  }

  // 转换 + 逐个 esbuild 解析（**校验必须真的跑**：观测不到就 exit 1，不是"看起来没问题"）。
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch (err) {
    console.error(`❌ 本机没有 esbuild，无法做"产物可被解析"的校验：${err && err.message}`);
    process.exit(1);
  }

  const results = [];
  let totalNames = 0;
  let totalDropped = 0;
  let ok = 0;
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
    const { code, names, droppedDeclares, unterminatedDeclare } = convert(src);
    totalNames += names.length;
    totalDropped += droppedDeclares.length;
    // 残留断言（改前是 87 处 `exports.X =`；转换后必须是 0 处**赋值行**）
    const leftover = code.split(/\r?\n/).filter((l) => EXPORT_LINE_RE.test(l)).length;
    const mentions = codeExportsMentions(src);
    const missed = [...mentions].filter((n) => !names.includes(n));
    if (leftover) problems.push(`${f}: 仍有 ${leftover} 处 exports.X = 赋值行`);
    if (missed.length) problems.push(`${f}: 有 exports. 名字没被收集：${missed.join(", ")}`);
    if (!names.length) problems.push(`${f}: 一处导出都没收集到`);
    // 沙箱全局的 `declare const` 必须删干净（留着就是 TS2440，实测踩过）
    const stillDeclared = code.split(/\r?\n/).filter((l) => {
      const m = l.match(DECLARE_CONST_OPEN_RE);
      return m && SANDBOX_GLOBALS.includes(m[1]);
    });
    if (stillDeclared.length) problems.push(`${f}: 仍残留沙箱全局的 declare const ${stillDeclared.length} 行`);
    // 删块时若一直没遇到行尾 `;` 会把后面的代码一起吞掉 ⇒ 单独点名（esbuild 那条也会红，但看不出原因）
    if (unterminatedDeclare) problems.push(`${f}: 删除 declare 块时吞掉了文件尾部（未见到行尾 ';'）`);
    // 顶层 await 不得出现（CJS 产物）。⚠ 只看**第 0 列**的 `await`：缩进的 await 在
    // async 函数体里是合法的，用 `^\s*await` 会把正常代码误报（第一版就是这么假红的）。
    if (/^await\s/m.test(code)) problems.push(`${f}: 产物含顶层 await（CJS 下不允许）`);
    try {
      esbuild.transformSync(code, { loader: "ts", format: "cjs", target: "esnext" });
      ok += 1;
    } catch (err) {
      problems.push(`${f}: esbuild 解析失败：${err && err.message}`);
    }
    results.push({ f, code, names, droppedDeclares });
  }

  console.log(
    `转换：${files.length} 个文件、收集到 ${totalNames} 处导出、删除沙箱全局 declare const ${totalDropped} 行、` +
      `esbuild 解析通过 ${ok}/${files.length}`,
  );
  for (const r of results) {
    console.log(`  ${r.f}\t导出 ${r.names.length} 个（删 declare ${r.droppedDeclares.length} 行）：${r.names.join(", ")}`);
  }
  if (problems.length) {
    console.error("❌ 转换校验失败：");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }

  if (!APPLY) {
    console.log("（干跑：没有写盘。加 --apply 才写进 src/vendors/）");
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const r of results) {
    fs.writeFileSync(path.join(OUT_DIR, r.f), r.code, "utf8");
    // 写盘后**读回来**核对字节数（写盘是这次任务里最不可逆的一步，必须自证）
    const back = fs.statSync(path.join(OUT_DIR, r.f)).size;
    if (back !== Buffer.byteLength(r.code, "utf8")) {
      console.error(`❌ ${r.f} 写盘后字节数不符：期望 ${Buffer.byteLength(r.code, "utf8")}，实际 ${back}`);
      process.exit(1);
    }
  }
  console.log(`✅ 已写入 ${results.length} 个文件到 ${path.relative(process.cwd(), OUT_DIR)}`);
  console.log("   ⚠ 还需人工做的一步：`null` 是保留字 —— `import * as null from …` 非法，");
  console.log("     注册表里必须写 `import * as nullVendor from \"@/vendors/null\";`（见 src/vendors/index.ts）。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
