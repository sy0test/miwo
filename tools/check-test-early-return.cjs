#!/usr/bin/env node
/**
 * 门禁：**禁止"静默早退"这种测试形态**（Phase 1a / Task 11；控制器裁定 B = ★Ruling 127）。
 *
 * ── 为什么需要一条**形态**门禁，而不是再加一条断言 ──
 * 已发现的真缺口：`tests/mysql-integration.test.ts` 里那条"sqlite → MySQL 全量搬迁"用例原先以
 *
 *     if (!fs.existsSync(devPath)) return; // CI 上没有 dev 库快照
 *
 * 开头。`apps/api/data/db2.sqlite` **被 `.gitignore` 忽略** ⇒ 真 runner 的全新 checkout 上
 * 这条用例**必然静默早退**；而 vitest 摘要**仍然写 `7 passed`**。
 * 根因是**语义空洞**：早退（`return`）在 vitest 里**既不是 pass 也不是 skip** ——
 * 所以"0 skipped"这类断言**测不到它**（那条断言只数 skipped；早退连 skip 都不算）。
 * 换句话说：**任何靠"数 skipped"来防漏测的门禁，都对早退免疫**。
 * 加断言治不了这个形态问题（下一个人随手再写一个 `return;` 就又漏了），所以这里禁形态本身。
 *
 * ── 判据（刻意窄，只打"用例体最外层的前置守卫"）──
 * 对每个 `tests/**\/*.test.ts`：
 *   1. 扫描 `it(...)` / `test(...)` / `it.skipIf(...)` 等**用例注册调用**；
 *   2. 用花括号配对取出**用例函数体**（`(name..., <fn>);`）；
 *   3. 剥掉注释与字符串字面量、再剥掉**所有**花括号块（`for`/`try`/`if`… 的体）；
 *   4. 在剩下的"骨架"上找 `if (…) {…} return;` / `if (…) return;` 形态。
 *
 * ⚠ 第 3 步是**关键**，也是这条门禁不误报的原因：它只打"留在**最外层**的 return"。
 *   仓库里现有三处 `return;` 都在块内，**必须继续放行**：
 *     · `tests/legacy-import.test.ts:59`、`tests/migration-seed.test.ts:38`
 *       —— `afterAll` 里的"删临时目录重试 5 次"循环（`for (...) { try { rmSync; return; } catch {} }`）；
 *     · `tests/migration-column-fit.test.ts:300` —— `if (!fs.existsSync(DEV_DB)) { 断言 fixture 形状; return; }`
 *       （Task 6 刻意改造过：它**先做了一条真断言**才早退，不是裸 return；本门禁不改它，
 *       但它的 `return;` 在 `if` 的**块内**，第 3 步已经把它剥掉）。
 *
 * ⚠ 判据**只**覆盖"函数体最外层、由 if 守卫的裸 return"。不做更宽的"禁止任何 return"：
 *   那会把大量合法的"提前返回结果"（例如 `if (x) return null;` 在辅助函数里）也打成红，
 *   而那种写法在用例体里并不构成"用例静默消失"。
 *
 * 退出码：0 = 没有任何"最外层前置守卫式 return"；1 = 有（逐条打印文件:行 + 原文）。
 *
 * 用法：node tools/check-test-early-return.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "apps", "api", "tests");

/** 递归收集 `*.test.ts`（跳过 `*.test.ts` 之外的、以及 node_modules）。 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "fixtures") continue;
      walk(p, out);
    } else if (e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * **单遍词法扫描**：把注释与字符串/模板串里的内容换成空格（**保留换行**，行号才对得上）。
 *
 * ⚠ 为什么不能图省事用"先正则删注释、再正则删字符串"（初版就是这么写的，实测**整个门禁失效**）：
 *   本仓库的注释里带反引号（`` `it.skipIf` ``、`` `return;` ``），而中文注释里又几乎没有配对的 `'`。
 *   于是"找引号对"的朴素扫描会**从注释里的一个反引号或单引号开始，把后面上千行真代码一起吞掉**，
 *   结果 `it.skipIf(...)` 这些注册调用根本没进扫描 —— 探针实测：把裸 `return;` 写回真实文件，
 *   门禁照样打印"通过"。所以这里按**字符序**一次走完，状态机上区分
 *   `code / line-comment / block-comment / string / template`，注释优先级高于字符串
 *   （`//` 之后的反引号是注释文字，不是模板串开头）。
 *
 * @param {string} src
 * @returns {string} 等长（逐行行号不变）的"只剩代码骨架"副本
 */
function skeletonize(src) {
  const S = 0, LINE = 1, BLOCK = 2, SQ = 3, DQ = 4, TPL = 5;
  let state = S;
  let out = "";
  let i = 0;
  const keep = (c) => (c === "\n" ? "\n" : " ");
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === S) {
      if (c === "/" && n === "/") {
        state = LINE;
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = BLOCK;
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = SQ;
        out += " ";
        i += 1;
        continue;
      }
      if (c === '"') {
        state = DQ;
        out += " ";
        i += 1;
        continue;
      }
      if (c === "`") {
        state = TPL;
        out += " ";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === LINE) {
      if (c === "\n") {
        state = S;
        out += "\n";
      } else out += " ";
      i += 1;
      continue;
    }
    if (state === BLOCK) {
      if (c === "*" && n === "/") {
        state = S;
        out += "  ";
        i += 2;
        continue;
      }
      out += keep(c);
      i += 1;
      continue;
    }
    // 字符串 / 模板串：处理转义，找到配对的收尾引号
    if (c === "\\") {
      out += keep(c) + keep(n === undefined ? "" : n);
      i += 2;
      continue;
    }
    if ((state === SQ && c === "'") || (state === DQ && c === '"') || (state === TPL && c === "`")) {
      state = S;
      out += " ";
      i += 1;
      continue;
    }
    out += keep(c);
    i += 1;
  }
  return out;
}

/** 找出与 `open` 处 `{` 配对的 `}`（忽略花括号在注释/字符串里的情况 —— 入参须已清洗）。 */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 用例注册调用的名字（`it` / `test` 及其 `skipIf` / `runIf` / `only` / `skip` / `todo` / `each` 变体）。
 * ⚠ 用"词边界 + 可选点式链"匹配：`it.each([...])`、`it.skipIf(x)`、`describe.skip` 都要认出来；
 *   但**不**匹配 `unit(`、`witness(` 这类巧合前缀。
 */
const REGISTER_RE = /\b(?:it|test)(?:\s*\.\s*(?:skipIf|runIf|only|skip|todo|fails|concurrent|each|for))*\s*\(/g;

/**
 * 在骨架上找"前置守卫式 return"：`if ( … ) return ;`
 *
 * ⚠ **必须用括号配对，不能用 `if\s*\([^)]*\)`**（初版就是这么写的，实测**漏报**）：
 *   守卫条件里几乎总有嵌套括号 —— `if (!fs.existsSync(devPath)) return;` 的
 *   `[^)]*` 会在 `fs.existsSync(devPath` 之后的第一个 `)` 停住，于是整条断言判"没有命中"，
 *   **判别力为零且看不出来**（探针实测：把裸 `return;` 写回去它照样报"通过"）。
 *   这正是本 Task 要防的那种"看起来在检查、其实什么都没查"的东西，所以这里连同原因一起记下来。
 */
function findGuardReturns(bodySrc, bodyStartLine) {
  const cleaned = skeletonize(bodySrc);
  // 剥掉所有花括号**块**（保留块外的骨架）：for/try/if 的体都在这里面。
  let skeleton = "";
  let i = 0;
  while (i < cleaned.length) {
    if (cleaned[i] === "{") {
      const end = matchBrace(cleaned, i);
      if (end < 0) {
        skeleton += cleaned.slice(i);
        break;
      }
      // 保留换行，行号才对得上
      skeleton += cleaned.slice(i, end + 1).replace(/[^\n]/g, " ");
      i = end + 1;
      continue;
    }
    skeleton += cleaned[i];
    i += 1;
  }

  const hits = [];
  const ifRe = /\bif\s*\(/g;
  let m;
  while ((m = ifRe.exec(skeleton)) !== null) {
    const open = skeleton.indexOf("(", m.index);
    const close = matchParen(skeleton, open);
    if (close < 0) continue;
    // 条件之后（同一骨架里）紧跟的就是 `return ;`
    const after = skeleton.slice(close + 1);
    const rm = /^\s*return\s*;/.exec(after);
    if (!rm) continue;
    const line = bodyStartLine + skeleton.slice(0, m.index).split("\n").length - 1;
    hits.push({ line, text: skeleton.slice(m.index, close + 1 + rm[0].length).replace(/\s+/g, " ").trim() });
  }
  return hits;
}

const failures = [];
const files = walk(TESTS_DIR).sort();
if (!files.length) {
  console.error(`check-test-early-return 失败：在 ${TESTS_DIR} 下找不到任何 *.test.ts（扫描范围写错了？）`);
  process.exit(1);
}

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const cleaned = skeletonize(raw);
  REGISTER_RE.lastIndex = 0;
  let m;
  while ((m = REGISTER_RE.exec(cleaned)) !== null) {
    // 从注册调用的 `(` 开始，找**第一个** `{`（那就是函数体的开始）。
    // 在它之前允许出现 `skipIf(!x)` / `"name"` / `,` / `async` / `()` —— 都不含裸 `{`。
    const openParen = cleaned.indexOf("(", m.index);
    if (openParen < 0) continue;
    const closeParen = matchParen(cleaned, openParen);
    if (closeParen < 0) continue;
    const window = cleaned.slice(openParen, closeParen + 1);
    const braceRel = window.indexOf("{");
    if (braceRel < 0) continue; // 没有函数体（例如 `it.todo("x")`）
    const braceAbs = openParen + braceRel;
    const bodyEnd = matchBrace(cleaned, braceAbs);
    if (bodyEnd < 0) continue;
    const body = raw.slice(braceAbs + 1, bodyEnd);
    const bodyStartLine = raw.slice(0, braceAbs + 1).split("\n").length;
    for (const hit of findGuardReturns(body, bodyStartLine)) {
      const srcLine = raw.split(/\r?\n/)[hit.line - 1] || "";
      failures.push(
        `${path.relative(ROOT, file).split(path.sep).join("/")}:${hit.line}\n` +
          `      形态：${hit.text}\n` +
          `      原文：${srcLine.trim()}\n` +
          `      为什么禁：用例体最外层的 \`return;\` 是**静默早退** —— vitest 里既不是 pass 也不是 skip，\n` +
          `      "0 skipped" 这类断言测不到它（Task 11 实测：dev 库被 gitignore 后，搬家用例在全新 checkout\n` +
          `      上必然早退，摘要照样写 \`7 passed\`）。改成**显式**跳过或显式失败：\n` +
          `        · 条件跳过：\`it.skipIf(!条件)(name, fn)\`（会进摘要，含 skip 计数）\n` +
          `        · 或 \`it(name, () => { if (!条件) throw new Error("应跑而未跑：<原因>") })\`\n` +
          `      参考实现：apps/api/tests/mysql-integration.test.ts 的 DEV_DB_PRESENT + it.skipIf。`,
      );
    }
  }
}

/** 与 `matchBrace` 同构，但配的是圆括号。 */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

if (failures.length) {
  console.error("check-test-early-return 失败：出现「静默早退」形态的用例（控制器裁定 B / Ruling 127）：\n");
  for (const f of failures) console.error("  - " + f + "\n");
  process.exit(1);
}

console.log(`check-test-early-return 通过（扫了 ${files.length} 个 *.test.ts，没有用例体最外层的守卫式 \`return;\`）`);
