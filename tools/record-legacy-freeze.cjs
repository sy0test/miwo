#!/usr/bin/env node
/**
 * 旧仓库冻结清单：**生成 + 校验**（Task 12 必做 8）。
 *
 * ── 为什么要有这个工具 ──
 * Phase 0 的"旧仓库零改动"原来只有两条同机自证：`tools/.phase0-old-baseline.json` 里 8 个文件的
 * sha256（两仓约 782+ 受控文件，覆盖 ≈1%），而该基线文件还被 `.gitignore` 忽略 —— 既不可复核、
 * 也拦不住"已经脏了的受控文件在 Phase 0 期间被再次改写"。本工具把这件事升级成**入库可检**：
 *   · 清单 `tools/legacy-freeze.json` **提交进仓库**（相对路径键，不含机器特定绝对路径）
 *     ⇒ 任何一次改动都会出现在 diff 里，可被 review；
 *   · `--check` 一键对比当前旧仓库与基线，任何一个字节变了就报红。
 *
 * ── 记录了什么（"键用相对路径"）──
 *   每个旧仓库：
 *     · `head`                      —— `git rev-parse HEAD`
 *     · `statusPorcelainSha256`     —— `git status --porcelain` **全量输出的原字节 sha256**
 *                                      （口径 = 默认 core.quotepath；行数即任务里说的 "340/47"）
 *     · `statusPorcelainLines`      —— 上面那次输出的行数
 *     · `statusPorcelainUallLines`  —— `-uall` 变体的行数（未跟踪文件逐个展开）
 *     · `dirtyCounts`               —— 按 porcelain 状态码分类的计数
 *     · `keyFiles`                  —— `data/version.txt`、`data/db2.sqlite` 的 sha256
 *     · `dirtyFileSha256`           —— **porcelain 列出的每一个文件**的 sha256（键 = 仓内相对路径，
 *                                      取自 `git -c core.quotepath=false status --porcelain -uall`，
 *                                      这样含中文的文件名也能直接读盘）
 *     · `deletedPaths`              —— porcelain 里"已删除"的路径（无内容可 hash，单独列出）
 *   最后一项是本工具相对"只 hash 状态输出"的**实质增量**：状态字串相同但文件内容被换掉
 *   （"已经脏"→"又被改写"）只在逐文件 sha256 上看得出来。
 *
 * ── 取值口径（必须如实说明，别把它当"旧仓库是干净的"的证明）──
 *   `--record` 记录的是**记录当刻的实际状态**。两个旧仓库在记录时就**已经是脏的**
 *   （upstream 340 条 porcelain、web 47 条，其中 `data/version.txt` 已是 ` M`）。
 *   所以这份清单能证明的是 **"自记录时刻起没有新增改动"**；
 *   它**不能**证明"Phase 0 期间没有改动"——那需要一份 Phase 0 开始前就存在的基线，
 *   而本仓库里没有（原基线只覆盖 8 个文件且已 gitignore）。
 *   本工具**不会**把"当前状态"包装成"干净"：`--check` 只回答"和基线是否一致"。
 *
 * ── 硬约束：对旧仓库**只读** ──
 *   · 只执行 `gitReadOnly()` 白名单里的 git 只读子命令（rev-parse/status/ls-files/log/show/cat-file）；
 *   · `git status` 一律带 `--no-optional-locks`（否则 git 会刷新 `.git/index` 的 stat 缓存，等于写旧仓库）；
 *   · 只读文件（fs.readFileSync），**绝不** add / commit / checkout / stash / writeFile 到旧仓库；
 *   · 新写入只发生在**本仓库**的 `tools/legacy-freeze.json`（`--record`）与 stdout。
 *
 * ── 用法 ──
 *   node tools/record-legacy-freeze.cjs                      # 记录（已存在清单时拒绝覆盖，除非 --force）
 *   node tools/record-legacy-freeze.cjs --force              # 显式重记（会刷新基线，慎用）
 *   node tools/record-legacy-freeze.cjs --check              # 校验当前旧仓库是否与清单一致
 *   node tools/record-legacy-freeze.cjs --check --manifest <路径>   # 用另一份清单校验（做反向验证用）
 *   node tools/record-legacy-freeze.cjs --upstream <路径> --web <路径>
 *
 * 退出码：0 = 通过/已记录；1 = 有漂移、清单缺失、或旧仓库不存在（**缺仓库不算通过**）。
 *
 * ⚠ 为什么不放进 CI：CI（以及任何全新克隆）上没有这两个旧仓库，`--check` 只会报"无旧仓库"。
 *   本清单的价值是"基线入库可复核" + "在有旧仓库的机器上一键查漂移"（与 `verify:phase0` 同一性质，
 *   见 README「Phase 0 验收的执行边界」）。
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "tools", "legacy-freeze.json");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const FORCE = argv.includes("--force");
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const manifestPath = argValue("--manifest", MANIFEST);
const REPOS = {
  upstream: argValue("--upstream", path.resolve(ROOT, "..", "..", "code", "toonflow-upstream")),
  web: argValue("--web", path.resolve(ROOT, "..", "..", "code", "toonflow-web")),
};
const KEY_FILES = ["data/version.txt", "data/db2.sqlite"];

// ── git 只读白名单：这是"绝不改旧仓库"的第一道防线 ──
const READ_ONLY_GIT = new Set(["rev-parse", "status", "ls-files", "log", "show", "cat-file"]);
/** 取 git 的子命令名：跳过选项，以及 `-c <k=v>` 的取值。 */
function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c") {
      i += 1;
      continue;
    }
    if (args[i].startsWith("-")) continue;
    return args[i];
  }
  return "";
}
function gitReadOnly(repo, args) {
  const sub = gitSubcommand(args);
  if (!READ_ONLY_GIT.has(sub)) throw new Error(`拒绝执行非只读 git 子命令: git ${args.join(" ")}`);
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function sha256File(abs) {
  try {
    return sha256(fs.readFileSync(abs));
  } catch (e) {
    // 不掩盖：读不到就如实写进清单（值是 `!ERROR:<code>`，`--check` 会逐字对比）
    return `!ERROR:${e.code || "UNKNOWN"}`;
  }
}

/** 把 porcelain 文本解析成 [{ xy, p }]（`-c core.quotepath=false` 下路径是原始 UTF-8）。 */
function parsePorcelain(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
    }
    out.push({ xy, p });
  }
  return out;
}

function snapshot(name) {
  const repo = REPOS[name];
  if (!fs.existsSync(repo)) return { missing: true, repo };
  const head = gitReadOnly(repo, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const porcelainRaw = gitReadOnly(repo, ["status", "--porcelain"]); // 原字节 → 用于 hash（口径与 "340/47" 一致）
  const porcelainText = porcelainRaw.toString("utf8");
  const uallRaw = gitReadOnly(repo, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]);
  const uallText = uallRaw.toString("utf8");
  const entries = parsePorcelain(uallText);

  const dirtyCounts = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, other: 0 };
  const dirtyFileSha256 = {};
  const deletedPaths = [];
  const unreadable = [];
  for (const { xy, p } of entries) {
    if (xy === "??") dirtyCounts.untracked += 1;
    else if (xy.includes("D")) dirtyCounts.deleted += 1;
    else if (xy.includes("R")) dirtyCounts.renamed += 1;
    else if (xy.includes("A")) dirtyCounts.added += 1;
    else if (xy.includes("M")) dirtyCounts.modified += 1;
    else dirtyCounts.other += 1;

    if (xy.includes("D")) {
      deletedPaths.push(p);
      continue;
    }
    const v = sha256File(path.join(repo, p));
    dirtyFileSha256[p] = v;
    if (v.startsWith("!ERROR:")) unreadable.push(`${p} → ${v}`);
  }

  const keyFiles = {};
  for (const rel of KEY_FILES) keyFiles[rel] = sha256File(path.join(repo, rel));

  return {
    missing: false,
    repo,
    relPathFromRepoRoot: path.relative(ROOT, repo).split(path.sep).join("/"),
    head,
    statusPorcelainSha256: sha256(porcelainRaw),
    statusPorcelainLines: porcelainText.split("\n").filter(Boolean).length,
    statusPorcelainUallLines: uallText.split("\n").filter(Boolean).length,
    dirtyCounts,
    keyFiles,
    dirtyFileSha256,
    deletedPaths,
    unreadable,
  };
}

// ───────────────────────────── 记录 ─────────────────────────────
if (!CHECK) {
  if (fs.existsSync(manifestPath) && !FORCE) {
    console.error(
      `拒绝覆盖已存在的清单: ${path.relative(ROOT, manifestPath)}\n` +
        `  理由：允许"失败了就顺手重记基线"等于给中途的误改背书（与 verify-phase0.cjs 同一条原则）。\n` +
        `  真要有意刷新基线，请显式加 --force，并在提交信息里说明为什么。`,
    );
    process.exit(1);
  }
  const out = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "tools/record-legacy-freeze.cjs",
    scope:
      "旧仓库（code/toonflow-upstream、code/toonflow-web）的冻结清单。键全部用**相对路径**（仓内相对路径 / 相对本仓库的仓位置），不含机器特定的绝对路径。",
    limitation:
      "记录的是**记录当刻**的实际状态；两仓在记录时**已经是脏的**。因此本清单证明的是「自记录时刻起没有新增改动」，**不能**证明「Phase 0 期间没有改动」。",
    checkMode:
      "node tools/record-legacy-freeze.cjs --check（只读两仓；任一字段不一致即退出码 1。CI 上没有旧仓库，故不进 CI）",
    policy:
      "本工具对旧仓库**只读**：只用 rev-parse/status/ls-files/log/show/cat-file，status 一律 --no-optional-locks（避免刷新 .git/index），绝不 add/commit/checkout/写文件。",
    repos: {},
  };
  for (const name of Object.keys(REPOS)) {
    const snap = snapshot(name);
    if (snap.missing) {
      console.error(`旧仓库不存在，无法记录: ${name} → ${snap.repo}`);
      process.exit(1);
    }
    delete snap.missing;
    delete snap.repo;
    out.repos[name] = snap;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  for (const name of Object.keys(out.repos)) {
    const r = out.repos[name];
    console.log(
      `已记录 ${name}: HEAD ${r.head.slice(0, 12)}  porcelain ${r.statusPorcelainLines} 行 ` +
        `(sha256 ${r.statusPorcelainSha256.slice(0, 12)}…)  逐文件 ${Object.keys(r.dirtyFileSha256).length} 个、删除 ${r.deletedPaths.length} 个`,
    );
    for (const rel of KEY_FILES) console.log(`    ${rel} → ${String(r.keyFiles[rel]).slice(0, 16)}…`);
    if (r.unreadable.length) console.log(`    ⚠ 读不到内容（已如实记录，不掩盖）: ${r.unreadable.join(", ")}`);
  }
  console.log(`已写入 ${path.relative(ROOT, manifestPath)}`);
  process.exit(0);
}

// ───────────────────────────── 校验 ─────────────────────────────
if (!fs.existsSync(manifestPath)) {
  console.error(`缺少清单 ${path.relative(ROOT, manifestPath)}，请先运行：node tools/record-legacy-freeze.cjs`);
  process.exit(1);
}
const base = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];
const notes = [];
const missingRepos = [];

for (const name of Object.keys(base.repos || {})) {
  const want = base.repos[name];
  const got = snapshot(name);
  if (got.missing) {
    missingRepos.push(`${name} → ${got.repo}`);
    continue;
  }
  const simple = ["head", "statusPorcelainSha256", "statusPorcelainLines", "statusPorcelainUallLines"];
  for (const k of simple) {
    if (got[k] !== want[k]) failures.push(`${name}.${k}: 清单 ${want[k]} ≠ 当前 ${got[k]}`);
  }
  if (JSON.stringify(got.dirtyCounts) !== JSON.stringify(want.dirtyCounts)) {
    failures.push(`${name}.dirtyCounts: 清单 ${JSON.stringify(want.dirtyCounts)} ≠ 当前 ${JSON.stringify(got.dirtyCounts)}`);
  }
  for (const rel of KEY_FILES) {
    if (got.keyFiles[rel] !== want.keyFiles[rel]) {
      failures.push(`${name}.keyFiles["${rel}"]: 清单 ${want.keyFiles[rel]} ≠ 当前 ${got.keyFiles[rel]}`);
    }
  }
  if (JSON.stringify(got.deletedPaths) !== JSON.stringify(want.deletedPaths)) {
    failures.push(`${name}.deletedPaths 漂移：清单 ${want.deletedPaths.length} 项，当前 ${got.deletedPaths.length} 项`);
  }
  // 逐文件 sha256：**本工具的核心增量**（"已经脏 → 又被改写"只有这里看得见）
  const wantFiles = want.dirtyFileSha256 || {};
  const gotFiles = got.dirtyFileSha256 || {};
  const addedPaths = Object.keys(gotFiles).filter((p) => !(p in wantFiles));
  const gonePaths = Object.keys(wantFiles).filter((p) => !(p in gotFiles));
  const changedPaths = Object.keys(gotFiles).filter((p) => p in wantFiles && gotFiles[p] !== wantFiles[p]);
  if (addedPaths.length) failures.push(`${name}.dirtyFileSha256: 基线里没有的新脏文件 ${addedPaths.length} 个：${addedPaths.slice(0, 8).join(", ")}`);
  if (gonePaths.length) failures.push(`${name}.dirtyFileSha256: 基线里有、现在不在脏清单里的文件 ${gonePaths.length} 个：${gonePaths.slice(0, 8).join(", ")}`);
  if (changedPaths.length) {
    failures.push(
      `${name}.dirtyFileSha256: **内容被改写**的已脏文件 ${changedPaths.length} 个（状态字串没变，只有逐文件 sha256 看得出）：` +
        changedPaths.slice(0, 8).join(", "),
    );
  }
  if (got.unreadable.length) notes.push(`${name}: 读不到内容：${got.unreadable.join(", ")}`);
  if (!failures.length) {
    console.log(
      `OK    ${name}: HEAD ${got.head.slice(0, 12)}  porcelain ${got.statusPorcelainLines} 行（sha256 ${got.statusPorcelainSha256.slice(0, 12)}…），` +
        `逐文件 ${Object.keys(gotFiles).length} 个全部逐字节一致`,
    );
  }
}

if (missingRepos.length) {
  console.error("无法校验：本机缺少旧仓库：");
  for (const m of missingRepos) console.error("  - " + m);
  console.error("  ⚠ 这**不算通过**（缺仓库 ≠ 没漂移）。CI 上没有旧仓库，所以本清单不进 CI；");
  console.error("    它的价值是「基线入库可复核」+「在有旧仓库的机器上一键查漂移」。");
  process.exit(1);
}
if (failures.length) {
  console.error("legacy-freeze 校验失败（如实报告，不掩盖）：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
for (const n of notes) console.log("NOTE  " + n);
console.log(`legacy-freeze 校验通过（清单 ${path.relative(ROOT, manifestPath)} 与两个旧仓库逐字节一致）`);
