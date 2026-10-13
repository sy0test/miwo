#!/usr/bin/env node
/**
 * Gate (Phase 1a / Task 4, controller ruling 3): the boot chain must not touch the
 * retired startup DDL routines `initDB` / `fixDB`.
 *
 * WHY a dedicated gate instead of an assertion inside check-copy.cjs:
 *   check-copy.cjs is the "copy completeness" gate (file counts / tracked-vs-disk floors).
 *   It deliberately asserts that `src/lib/initDB.ts` EXISTS (line ~94) because
 *   `scripts/verify-phase0.cjs` needs it. Folding a "must not be referenced" rule into the
 *   same file would put two contradictory duties in one script and would tempt a future
 *   reader to relax a floor to make it pass. This gate is narrow, has its own script name,
 *   its own npm script (`verify:dead-ddl`) and its own exit code.
 *
 * WHAT it checks: start at `apps/api/src/app.ts` (= the non-Electron entry; it calls
 *   `startServe()` at module level) and walk the **static import graph** via `@/...` and
 *   relative specifiers. Two independent ways of naming the retired routines are caught:
 *
 *     (a) bare identifiers `initDB` / `fixDB` in real code (comments AND string literals
 *         stripped) - i.e. `import initDB`, `initDB(`, `fixDB(`;
 *     (b) **string-specifier edges**: any specifier that resolves to
 *         `<...>/lib/initDB.ts` / `<...>/lib/fixDB.ts` - i.e. `require("@/lib/fixDB")`,
 *         `import("@/lib/initDB")` and the side-effect form `import "@/lib/initDB"`.
 *
 *   (b) is not redundant: `lib/fixDB.ts` / `lib/initDB.ts` carry **no code-level bare
 *   identifier of their own**, so "pull the module into the graph with a specifier" would
 *   otherwise produce zero hits. That form is exactly the coupling this gate exists to
 *   prevent (a module-level `import "@/lib/initDB"` is re-evaluated on every boot).
 *
 *   Any hit outside the explicit exemption list = failure (exit 1).
 *
 * WHY "reachable modules" and not "files that run code at import time":
 *   Every module on the chain above is *evaluated* during boot (CJS `require` semantics),
 *   so naming either routine there is already a boot-time coupling. Distinguishing
 *   "module body" from "inside an exported function" would need a real parser and would
 *   only re-open the hole for dynamic `require`s. The stricter, simpler rule is also the
 *   one a reviewer can verify by hand.
 *
 * Exemptions mirror tools/check-brand.cjs's style: per file, with a reason, and each one
 * must hit **exactly** its declared `count` occurrences or the gate turns red - both a
 * shrunken count (stale exemption, e.g. after Phase 1b deletes those routes) and a grown
 * count (an exemption silently hiding MORE than it declares) are failures. There is no
 * "at least N" slack, so the list can never become a blanket whitelist.
 *
 * A module that cannot be resolved is reported as a WARNING (`unresolved`), never as a
 * silent skip, so a review can see exactly what was not covered.
 *
 * Usage: node tools/check-dead-ddl.cjs
 * Exit 0 = pass, 1 = fail.
 *
 * SELF-TEST (proof the gate has discriminating power; see the Task 4 report "修复轮 1"):
 *   for each of the three specifier forms, temporarily add it to
 *   apps/api/src/utils/db.ts  -> exit 1 listing that file:line;
 *   restore byte-for-byte (sha256) -> exit 0.
 *     1. require("@/lib/fixDB");
 *     2. import("@/lib/initDB");
 *     3. import "@/lib/initDB";      (side-effect import - evaluated on every boot)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "apps", "api");
const SRC = path.join(API, "src");
const ENTRY = path.join(SRC, "app.ts");

/** Bare identifiers that must not appear in the boot chain. Covers `import initDB`,
 *  `import { db } ... initDB(`, and any other code-level naming. */
const FORBIDDEN = /\binitDB\b|\bfixDB\b/g;

/** The retired modules themselves: a specifier resolving to one of these files is an
 *  import-graph edge into the retired startup DDL/DML, whatever the binding looks like
 *  (`require(...)`, `import(...)`, side-effect `import "..."`). See the header, point (b). */
const FORBIDDEN_LIB_RE = /lib[\\/](initDB|fixDB)\.ts$/;

/** Extensions tried when resolving a specifier (Node CJS + tsx). `.d.ts` is included on
 *  purpose: several boot-chain modules import types from `@/types/database` and
 *  `./chatMessagesData`, both of which are **declaration-only** files - they carry no
 *  runtime code, but not resolving them would leave real modules silently unscanned. */
const EXTS = [".ts", ".tsx", ".js", ".cjs", ".mjs", ".d.ts"];

/**
 * Explicit exemptions. Every entry must hit **exactly** `count` occurrences - no more, no
 * less (see the header). A `count` that is too high = stale exemption; too low = the
 * exemption would silently hide an extra occurrence.
 *
 * NOTE (honest scope): the four route modules below are *reachable* from app.ts because
 * `src/router.ts` statically imports every route (it is a generated file). Task 4 removed
 * the **unconditional, every-boot** invocations in `src/utils/db.ts`; these four are
 * user-triggered admin/ops endpoints whose handler bodies call `initDB` on request.
 * Removing/rewriting those endpoints is Phase 1b (see src/db/tenant-exceptions.json).
 * Phase 1a must not change route/业务 code, so they are exempted here - individually, so
 * that when Phase 1b deletes them this gate turns red and the list gets cleaned up.
 */
const EXEMPTIONS = [
  // ⚠ `apps/api/src/routes/other/deleteAllData.ts` 曾在此登记（count: 2：`import initDB` + `initDB(db, true)`）。
  //   **Phase 1b Task 7 已按本 gate 的设计把它清掉**：该路由改为**无条件 501 停用**，不再 import `initDB`、
  //   也不再持有 `systemDb` ⇒ 命中数 2 → 0。gate 头的规矩是"路线被改写/删除时清单必须清掉"
  //   （count 不符即红），所以这里删条目而**不是**放宽判据；路由文件本身与 `router.ts` 的挂载都保留
  //   （删了会让 check-copy 的构件断言与依赖图一起漂）。
  {
    file: "apps/api/src/routes/setting/dbConfig/clearData.ts",
    count: 2,
    reason:
      "GET /setting/dbConfig/clearData drops all tables then calls initDB(db) to rebuild them - request-triggered, not boot-triggered. Phase 1b 只做了收权（requireAdmin），接口仍可用；Phase 1c 才决定它是改是删。",
  },
  {
    file: "apps/api/src/routes/setting/dbConfig/importData.ts",
    count: 2,
    reason:
      "POST /setting/dbConfig/importData drops all tables, calls initDB(db) and then imports rows - request-triggered, not boot-triggered. Phase 1b reworks it; Phase 1a must not touch route code.",
  },
  {
    file: "apps/api/src/routes/setting/dev/getSwitchAiDevTool.ts",
    count: 1,
    reason:
      "GET /setting/dev/getSwitchAiDevTool imports initDB but NEVER calls it (dead import). Recorded here so the gate is honest about the current state; removing the dead import is a 1-line cleanup that belongs with the Phase 1b route work.",
  },
];

const failures = [];
const warnings = [];

/** Replace every range in `src` with spaces (newlines preserved) so offsets/line numbers stay exact. */
function blankRanges(src, ranges) {
  if (!ranges.length) return src;
  const chars = src.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
}

/**
 * One pass that finds comments AND string/template literals.
 * Returns { comments: [[s,e]...], strings: [[s,e]...] } so callers can strip either set
 * independently (import specifiers live inside strings, so the graph pass must keep them).
 */
function scan(src) {
  const comments = [];
  const strings = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const s = i;
      while (i < n && src[i] !== "\n") i++;
      comments.push([s, i]);
      continue;
    }
    if (c === "/" && d === "*") {
      const s = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      comments.push([s, i]);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      const s = i;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i = Math.min(n, i + 1);
      strings.push([s, i]);
      continue;
    }
    i++;
  }
  return { comments, strings };
}

function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // node_modules / node builtins / virtual specifiers
  for (const c of [base, ...EXTS.map((e) => base + e)]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep trying */
    }
  }
  for (const e of [".ts", ".tsx", ".js"]) {
    const idx = path.join(base, "index" + e);
    try {
      if (fs.statSync(idx).isFile()) return idx;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

// ---- walk the graph starting at src/app.ts ----
/** Line number (1-based) of a character offset; newline-preserving blanking keeps offsets exact. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

const reachable = [];
const seen = new Set();
/** Hits found via the *specifier* itself (header point (b)), keyed by `file:line`. */
const specifierHits = [];
const queue = [ENTRY];
if (!fs.existsSync(ENTRY)) {
  failures.push("entry module is missing: apps/api/src/app.ts");
} else {
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    reachable.push(file);
    const raw = fs.readFileSync(file, "utf8");
    const { comments } = scan(raw);
    const graphText = blankRanges(raw, comments); // comments gone, strings KEPT (specifiers live there)
    const rawLines = raw.split(/\r?\n/);
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(graphText))) {
      const spec = m[1];
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
      const target = resolveSpec(file, spec);
      if (!target) {
        warnings.push(`unresolved specifier "${spec}" in ${rel(file)} (not scanned)`);
        continue;
      }
      // (b) string-specifier edge into a retired module: counted even when the module
      // carries no bare identifier of its own (that is the whole point - see header).
      const lib = FORBIDDEN_LIB_RE.exec(target);
      if (lib) {
        const line = lineAt(graphText, m.index + m[0].length - 1 - spec.length);
        specifierHits.push({
          file: rel(file),
          line,
          token: lib[1],
          text: (rawLines[line - 1] || "").trim(),
          via: "specifier " + JSON.stringify(spec),
        });
      }
      queue.push(target);
    }
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

// ---- scan every reachable module's real code (comments AND strings stripped) ----
const hits = [];
for (const file of reachable) {
  const raw = fs.readFileSync(file, "utf8");
  const { comments, strings } = scan(raw);
  const code = blankRanges(raw, comments.concat(strings));
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  codeLines.forEach((line, idx) => {
    FORBIDDEN.lastIndex = 0;
    let m;
    while ((m = FORBIDDEN.exec(line))) {
      hits.push({
        file: rel(file),
        line: idx + 1,
        token: m[0],
        text: (rawLines[idx] || "").trim(),
      });
    }
  });
}

// ---- merge the specifier-only edges found during the graph walk ----
// A line already caught by a bare identifier is NOT counted twice: the exemption `count`
// means "number of coupling sites in this file", so one `import initDB from "@/lib/initDB"`
// stays one hit (it is caught by both detectors, but it is a single site).
for (const h of specifierHits) {
  if (hits.some((c) => c.file === h.file && c.line === h.line)) continue;
  hits.push(h);
}

// ---- apply exemptions; each must hit EXACTLY its declared count ----
const covered = new Set();
for (const ex of EXEMPTIONS) {
  const mine = hits.filter((h) => h.file === ex.file);
  if (mine.length !== ex.count) {
    const how =
      mine.length < ex.count
        ? `only ${mine.length} found (${mine.length === 0 ? "file no longer references them" : "count shrank"}) -> delete or fix the exemption`
        : `${mine.length} found -> the exemption would hide ${mine.length - ex.count} occurrence(s) more than it declares; fix the count or drop the extra reference`;
    failures.push(`exemption count mismatch: ${ex.file} declares count=${ex.count} occurrence(s) of initDB/fixDB but ${how}`);
    continue;
  }
  for (const h of mine) covered.add(`${h.file}:${h.line}:${h.token}`);
}

const unexplained = hits.filter((h) => !covered.has(`${h.file}:${h.line}:${h.token}`));

// ---- guard: no silent exemptions (empty reason) ----
// The "must not hide MORE than it declares" half of this guard lives in the count check
// above (`mine.length !== ex.count`), which is exact in BOTH directions.
for (const ex of EXEMPTIONS) {
  if (!ex.reason || !String(ex.reason).trim()) failures.push(`exemption for ${ex.file} has no reason (silent exemptions are not allowed)`);
}

if (unexplained.length) {
  for (const h of unexplained) {
    failures.push(`boot chain references ${h.token}: ${h.file}:${h.line}  ${h.text}`);
  }
}

for (const w of warnings) console.warn("[check-dead-ddl] warning: " + w);

if (failures.length) {
  console.error("check-dead-ddl FAILED: the boot chain (from apps/api/src/app.ts) must not use initDB/fixDB.");
  console.error("  The every-boot DDL/DML side effects were replaced by src/db/connect.ts connect() + src/db/migrations/.");
  console.error("  Two routines stay in the repo only for verify-phase0.cjs's artifact assertion (deleted in Phase 1c).");
  console.error("  Both the bare identifier and any specifier resolving to lib/initDB.ts / lib/fixDB.ts count as coupling.");
  for (const f of failures) console.error("  - " + f);
  console.error(`  scanned: ${reachable.length} reachable module(s) from apps/api/src/app.ts`);
  process.exit(1);
}
console.log(
  `check-dead-ddl passed (boot chain clean): ${reachable.length} module(s) reachable from src/app.ts, ` +
    `${hits.length} exempted occurrence(s) in ${EXEMPTIONS.length} file(s), 0 unexplained`,
);
