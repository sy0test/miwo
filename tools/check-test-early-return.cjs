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
 * ── 判据（【H1 修复后】**与文件头声称的范围一致**）──
 * 对每个 `tests/**\/*.test.ts`：
 *   1. 扫描 `it(...)` / `test(...)` / `it.skipIf(...)` 等**用例注册调用**；
 *   2. 用花括号配对取出**用例函数体**（`(name..., <fn>);`）；
 *   3. 剥掉注释与字符串字面量，然后**按花括号深度**找出**最外层**（深度 0）的静默早退。
 *
 * ⚠ 第 3 步是**关键**，也是这条门禁不误报的原因：它只打"留在**最外层**的 return"。
 *   仓库里现有三处 `return;` 都在块内，**必须继续放行**：
 *     · `tests/legacy-import.test.ts:71`、`tests/migration-seed.test.ts:38`
 *       —— `afterAll` 里的"删临时目录重试 5 次"循环（`for (...) { try { rmSync; return; } catch {} }`）；
 *     · `tests/migration-column-fit.test.ts:300` —— `if (!fs.existsSync(DEV_DB)) { 断言 fixture 形状; return; }`
 *       （Task 6 刻意改造过：它**先做了一条真断言**才早退，不是裸 return；本门禁不改它）。
 *
 * ⚠⚠ 【H1·必做】原版**判据窄于它声称的范围**：它剥块时把整个 `{…}`（含块内 `return`）抹成空格
 *   ⇒ **有括号形态 `if (c) { return; }`、`else { return; }`、裸 `return;` 全部被放行**，
 *   而 `:22` 明写覆盖 `if (…) {…} return;` 与 `if (…) return;` 两种。这是"声称检测而实际不检测"。
 *   现在按**深度**判定，三种形态**都判红**（`form` 字段如实标出命中形态）：
 *     · `if-bare`    `if (c) return;`
 *     · `if-braced`  `if (c) { return; }`（块内 `return` 之前无真语句）
 *     · `bare`       最外层的裸 `return;`
 *   仍然**不**碰"块内的 return"（含 `for`/`try` 里的、以及"先做真断言才早退"那种）。
 *
 * ⚠ 判据**不**做更宽的"禁止任何 return"：那会把大量合法的"提前返回结果"
 *   （例如 `if (x) return null;` 在辅助函数里）也打成红，而那种写法在用例体里并不构成"用例静默消失"。
 *
 * ── 【H2·必做】`it.only` / `describe.only` / `test.only` 一律判红 ──
 *   为什么必须在这条门禁里（而不是"以后再加"）：`.only` 是**静默早退的同一族、换了入口**——
 *   `it.only` 下 vitest **只跑那一条**，摘要仍写 `Tests 1 passed (1)`、**0 skipped**，
 *   于是 `verify-mysql-migration.cjs` 的 skip 计数与 `ranN > 0` **全部通过**（终审实测）。
 *   本门禁的 `REGISTER_RE` 早就**认识** `.only`（它在 `skipIf|runIf|only|skip|...` 名单里），
 *   却**从不判红** —— 认识一个危险形态却不对它做任何事，比不认识更糟（它制造"已覆盖"的错觉）。
 *
 * 退出码：0 = 没有"最外层前置守卫式 return"、也没有 `.only`；1 = 有（逐条打印文件:行 + 原文）。
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
  const hits = [];

  /**
   * 判断"用例体**最外层**的静默早退"。三种形态都算（【H1 修复】）：
   *   (a) `if (…) return;`            —— 无括号（原版就认这个）
   *   (b) `if (…) { return; }`        —— **有括号**（原版**漏报**：剥块时把 `return` 一起抹掉了）
   *   (c) 最外层的裸 `return;`         —— 连守卫都没有（原版同样漏报）
   *
   * ⚠ 只在**最外层**判定（花括号深度 0，相对用例体）：块内的 `return` 一律放行，
   *   仓库里现有三处都必须继续通过（`for` 里删临时目录重试、`if (!x) { 真断言; return; }`）。
   *   ——这正是原版"剥掉所有块"想达到的效果；这里改用**深度跟踪**达到同一效果，
   *     好处是"块本身"的信息没有丢，于是有括号形态能被看见。
   */
  let depth = 0;
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (c === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    // ---- (c) 最外层的裸 return ----
    if (depth === 0 && /^return\b/.test(cleaned.slice(i))) {
      const after = cleaned.slice(i);
      const rm = /^return\s*;/.exec(after);
      if (rm) {
        const line = bodyStartLine + cleaned.slice(0, i).split("\n").length - 1;
        hits.push({ line, text: rm[0].replace(/\s+/g, " ").trim(), form: "bare" });
        i += rm[0].length;
        continue;
      }
    }
    // ---- (a)/(b) 最外层的 `if (…) …return;` ----
    if (depth === 0 && /^if\s*\(/.test(cleaned.slice(i))) {
      const open = cleaned.indexOf("(", i);
      const close = matchParen(cleaned, open);
      if (close < 0) {
        i += 1;
        continue;
      }
      const rest = cleaned.slice(close + 1);
      // (a) 无括号：`if (…) return;`
      const bare = /^\s*return\s*;/.exec(rest);
      // (b) 有括号：`if (…) { return; }`（块内 `return` 之前不许有真语句 —— 见 hasRealWork）
      const braced = /^\s*\{\s*return\s*;/.exec(rest);
      if (bare) {
        const line = bodyStartLine + cleaned.slice(0, i).split("\n").length - 1;
        hits.push({ line, text: cleaned.slice(i, close + 1 + bare[0].length).replace(/\s+/g, " ").trim(), form: "if-bare" });
        i = close + 1 + bare[0].length;
        continue;
      }
      if (braced) {
        // ⚠ 排除"先做真断言才早退"的刻意形态（`if (!x) { expect(...); return; }`）：
        //    块内 `return` 之前**只允许空白**。用原文判（骨架把语句抹成空格，分不出来）。
        const braceRel = close + 1 + rest.indexOf("{");
        const returnRel = close + 1 + rest.indexOf("return");
        if (!hasRealWorkBeforeReturn(bodySrc, braceRel, returnRel)) {
          const end = close + 1 + braced[0].length;
          const line = bodyStartLine + cleaned.slice(0, i).split("\n").length - 1;
          hits.push({ line, text: cleaned.slice(i, end).replace(/\s+/g, " ").trim(), form: "if-braced" });
          i = end;
          continue;
        }
      }
    }
    i += 1;
  }
  return hits;
}

/**
 * 【H1 配套】判断 `if` 块内 `return` **之前**是否已有真实语句。
 *
 * 为什么需要：`migration-column-fit.test.ts:300` 的形态是
 *   `if (!fs.existsSync(DEV_DB)) { expect(...).toMatch(...); return; }`
 * —— 它**先做了一条真断言**才早退，Task 6 刻意如此，本门禁**必须继续放行**。
 * 而骨架化会把块内语句抹成空格，"有没有真语句"在骨架上分辨不出来 ⇒ 回到**原文**判：
 * 取该 `if` 的块体原文，剥掉注释与字符串，看 `return` 之前有没有非空白的语句。
 *
 * @param {string} rawBody 用例体**原文**
 * @param {number} blockOpenRel 块 `{` 在 rawBody 里的相对下标
 * @param {number} returnRel `return` 在 rawBody 里的相对下标
 */
function hasRealWorkBeforeReturn(rawBody, blockOpenRel, returnRel) {
  const inner = skeletonize(rawBody.slice(blockOpenRel + 1, returnRel));
  // 去掉残留的花括号/分号/空白后还有内容 = 真有语句。
  return /[^\s{};]/.test(inner);
}

/**
 * 【H2·必做】`.only` 的识别：`it.only(...)` / `test.only(...)` / `describe.only(...)`，
 * 以及链式变体（`it.only.each(...)`、`describe.only.skip(...)`）。
 *
 * ⚠ 判据必须落在**已骨架化**的文本上（注释里的 `.only` 是说明、不是代码）：
 *   本文件头部与多处注释都在讨论 `.only`，若拿原文匹配会立刻自伤。
 */
const ONLY_RE = /\b(?:it|test|describe)(?:\s*\.\s*(?:only|each|skip|skipIf|runIf|todo|fails|concurrent|for))*\s*\.\s*only\s*\(/g;

const failures = [];
const onlyHits = [];
const files = walk(TESTS_DIR).sort();
if (!files.length) {
  console.error(`check-test-early-return 失败：在 ${TESTS_DIR} 下找不到任何 *.test.ts（扫描范围写错了？）`);
  process.exit(1);
}

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const cleaned = skeletonize(raw);

  // ---- 【H2】`.only` 扫描（在骨架上做：注释/字符串里的 `.only` 不算）----
  ONLY_RE.lastIndex = 0;
  let om;
  while ((om = ONLY_RE.exec(cleaned)) !== null) {
    const line = cleaned.slice(0, om.index).split("\n").length;
    const srcLine = raw.split(/\r?\n/)[line - 1] || "";
    onlyHits.push(
      `${path.relative(ROOT, file).split(path.sep).join("/")}:${line}\n` +
        `      形态：${om[0].replace(/\s+/g, " ").trim()}\n` +
        `      原文：${srcLine.trim()}\n` +
        `      为什么禁（【H2】）：\`.only\` 下 vitest **只跑那一条**，而摘要仍写 \`Tests 1 passed (1)\`、\n` +
        `      **0 skipped** ⇒ \`verify-mysql-migration.cjs\` 的 skip 计数与 \`ranN>0\` **全部通过**。\n` +
        `      它与本门禁要防的"静默早退"是同一族（用例静默不执行），只是换了入口。\n` +
        `      本地调试请用 \`pnpm exec vitest run <文件> -t "<用例名>"\`，**不要**提交 \`.only\`。`,
    );
  }

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
          `      命中形态：${hit.form}（if-bare = \`if (c) return;\`；if-braced = \`if (c) { return; }\`；bare = 最外层裸 \`return;\`）\n` +
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

// ---- 【H2】`.only` 的失败汇总（与"静默早退"分开报，便于一眼看出是哪一类）----
if (onlyHits.length) {
  console.error("check-test-early-return 失败：`tests/**` 里出现 `.only`（【H2】它会让其余用例静默不执行，而摘要仍全绿）：\n");
  for (const f of onlyHits) console.error("  - " + f + "\n");
  process.exit(1);
}

if (failures.length) {
  console.error("check-test-early-return 失败：出现「静默早退」形态的用例（控制器裁定 B / Ruling 127）：\n");
  for (const f of failures) console.error("  - " + f + "\n");
  process.exit(1);
}

console.log(
  `check-test-early-return 通过（扫了 ${files.length} 个 *.test.ts：无最外层守卫式 \`return;\`（含**有括号**形态）、无 \`.only\`）`,
);
