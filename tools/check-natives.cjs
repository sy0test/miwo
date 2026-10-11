#!/usr/bin/env node
/**
 * 断言运行期原生模块在工作区里可加载（pnpm 10 默认跳过构建脚本，必须显式批准）。
 *
 * ── 为什么这份清单必须与 `pnpm.onlyBuiltDependencies` **双向核对** ──
 * 旧版把 `onlyBuiltDependencies` 4 项里的**前 2 项**（better-sqlite3 / sharp）写死在数组里，
 * 后 2 项（sqlite3 / onnxruntime-node）**静默不检**：清单里加一项、脚本不加，门禁照样绿。
 * 现在清单的**唯一真相是根 `package.json` 的 `pnpm.onlyBuiltDependencies`**，脚本必须逐项覆盖它，
 * 两个方向都不许有差集：
 *   · 清单有、脚本没声明 → 红（漏检 = 门禁缺口）；
 *   · 脚本声明了、清单没有 → 红（同一份名单两处维护，迟早分叉）。
 *
 * ── 两级判定（逐项显式声明，**不许静默跳过**）──
 *   must    —— 不可加载即失败（运行时主链路依赖）。
 *   lenient —— 不可加载时**必须打印具体原因**，并且要**同时证明**它确实是"依赖图里声明了、
 *              但本平台没装（可选/平台相关）"，而不是"被误删或被写错"：
 *              (a) 它出现在 `pnpm-lock.yaml`（说明依赖图里声明过，不是拼错的幽灵名）；
 *              (b) 它**不是** `apps/api` 的直接依赖（直接依赖却加载不了，那是真故障，必须红）。
 *              两条证据缺一 → 仍然判失败。
 *
 * 用法：node tools/check-natives.cjs
 * 退出码 0 = 通过，1 = 失败（逐条打印失败原因）。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "apps", "api");

/** 每个包一项：level 与 reason 都必须显式写出来（reason 会被打印，防止"沉默的宽松"）。 */
const EXPECTED = {
  "better-sqlite3": {
    level: "must",
    reason: "运行时主库驱动（knex 的 better-sqlite3 客户端），启动即 require",
  },
  sharp: {
    level: "must",
    reason: "图片处理，启动期就被 utils 加载",
  },
  sqlite3: {
    level: "must",
    reason: "knex 的 sqlite3 客户端 + @rmp135/sql-ts 代码生成；本机（Windows/Node 24）实测可加载",
  },
  "onnxruntime-node": {
    level: "lenient",
    reason:
      "@huggingface/transformers 的平台相关可选依赖（向量/嵌入模型推理）。它是**传递（可选）依赖**、不是 apps/api 的直接依赖，" +
      "本机 Windows 上未安装；未安装时记忆/嵌入相关能力不可用，但应用能起 —— 故不判失败，仅如实报告",
  },
};

const failures = [];
const skipped = [];
const lockfile = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8");
const apiPkg = JSON.parse(fs.readFileSync(path.join(API, "package.json"), "utf8"));
const apiDirectDeps = new Set([...Object.keys(apiPkg.dependencies || {}), ...Object.keys(apiPkg.devDependencies || {})]);

// ── 双向核对：脚本声明的清单 == 根 package.json 的 pnpm.onlyBuiltDependencies ──
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const declared = ((rootPkg.pnpm || {}).onlyBuiltDependencies || []).slice().sort();
const covered = Object.keys(EXPECTED).sort();
const missing = declared.filter((n) => !covered.includes(n));
const extra = covered.filter((n) => !declared.includes(n));
if (missing.length) {
  failures.push(
    `package.json 的 pnpm.onlyBuiltDependencies 里有 ${missing.length} 项没被本脚本检查（静默漏检）: ${missing.join(", ")} —— ` +
      `请在 EXPECTED 里补上并显式声明 level/reason`,
  );
}
if (extra.length) {
  failures.push(
    `本脚本检查了 ${extra.length} 项但 package.json 的 pnpm.onlyBuiltDependencies 里没有: ${extra.join(", ")} —— ` +
      `同一份名单两处维护必然分叉，请对齐`,
  );
}

for (const name of declared.length ? declared : covered) {
  const spec = EXPECTED[name];
  if (!spec) continue; // 已在 missing 里报过
  const level = spec.level;
  if (level !== "must" && level !== "lenient") {
    failures.push(`${name} 的 level 非法（必须是 "must" 或 "lenient"）：${level}`);
    continue;
  }
  if (!spec.reason || !spec.reason.trim()) {
    failures.push(`${name} 缺少 reason（不允许沉默的宽松判定）`);
    continue;
  }

  let mod = null;
  let err = null;
  try {
    mod = require(require.resolve(name, { paths: [API] }));
  } catch (e) {
    err = `${e.code || ""} ${String(e.message).split("\n")[0]}`.trim();
  }

  if (mod !== null) {
    const t = typeof mod;
    if (t === "function" || t === "object") {
      console.log(`OK    ${name}（${level}，导出 ${t}）`);
    } else {
      failures.push(`${name} 加载结果类型异常: ${t}`);
    }
    continue;
  }

  if (level === "must") {
    failures.push(`${name} 加载失败（level=must）: ${err}`);
    continue;
  }

  // level=lenient：不可加载时必须举证，不能只写一句理由。
  const evidence = [];
  if (!lockfile.includes(name)) evidence.push(`pnpm-lock.yaml 里找不到 ${name}（不是"依赖图里声明过但没装"，更像被写错/误删）`);
  if (apiDirectDeps.has(name)) evidence.push(`${name} 是 apps/api 的**直接依赖**，直接依赖加载不了就是真故障，不能走 lenient`);
  if (evidence.length) {
    failures.push(`${name} 加载失败且 lenient 举证不成立（level=lenient）: ${err}\n      - ` + evidence.join("\n      - "));
    continue;
  }
  skipped.push(`${name}（${err}）`);
  console.log(`SKIP  ${name} —— 未安装，原因：${spec.reason}；实测错误：${err}；举证：pnpm-lock.yaml 有声明 + 非 apps/api 直接依赖`);
}

if (failures.length) {
  console.error("check-natives 失败：");
  for (const f of failures) console.error("  - " + f);
  console.error("处置：确认根 package.json 的 pnpm.onlyBuiltDependencies 含这些包，然后重跑 pnpm.cmd install。");
  process.exit(1);
}
console.log(
  `check-natives 通过（清单双向核对一致，共 ${declared.length} 项：可加载 ${declared.length - skipped.length}，` +
    `显式跳过 ${skipped.length}${skipped.length ? " → " + skipped.join("、") : ""}）`,
);
