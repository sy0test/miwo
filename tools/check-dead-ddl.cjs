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
 *   relative specifiers. In every reachable module, strip comments and string literals and
 *   then look for the bare identifiers `initDB` / `fixDB`. Any hit outside the explicit
 *   exemption list = failure (exit 1).
 *
 * WHY "reachable modules" and not "files that run code at import time":
 *   Every module on the chain above is *evaluated* during boot (CJS `require` semantics),
 *   so naming either routine there is already a boot-time coupling. Distinguishing
 *   "module body" from "inside an exported function" would need a real parser and would
 *   only re-open the hole for dynamic `require`s. The stricter, simpler rule is also the
 *   one a reviewer can verify by hand.
 *
 * Exemptions mirror tools/check-brand.cjs's style: per file, with a reason, and each one
 * must REALLY hit (its declared `min` occurrence count) or the gate turns red - so a stale
 * exemption (e.g. after Phase 1b deletes those routes) cannot survive unnoticed.
 *
 * A module that cannot be resolved is reported as a WARNING (`unresolved`), never as a
 * silent skip, so a review can see exactly what was not covered.
 *
 * Usage: node tools/check-dead-ddl.cjs
 * Exit 0 = pass, 1 = fail.
 *
 * SELF-TEST (proof the gate has discriminating power; see Task 4 report):
 *   temporarily add `import fixDB from "@/lib/fixDB";` to apps/api/src/utils/db.ts
 *   -> exit 1 listing that line; restore byte-for-byte (sha256) -> exit 0.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "apps", "api");
const SRC = path.join(API, "src");
const ENTRY = path.join(SRC, "app.ts");

/** Bare identifiers that must not appear in the boot chain. Covers `import initDB`,
 *  `import { db } ... initDB(`, `require("@/lib/fixDB")` and the `import EDGE` form. */
const FORBIDDEN = /\binitDB\b|\bfixDB\b/g;

/** Extensions tried when resolving a specifier (Node CJS + tsx). `.d.ts` is included on
 *  purpose: several boot-chain modules import types from `@/types/database` and
 *  `./chatMessagesData`, both of which are **declaration-only** files - they carry no
 *  runtime code, but not resolving them would leave real modules silently unscanned. */
const EXTS = [".ts", ".tsx", ".js", ".cjs", ".mjs", ".d.ts"];

/**
 * Explicit exemptions. Every entry must actually hit at least `min` occurrences.
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
  {
    file: "apps/api/src/routes/other/deleteAllData.ts",
    min: 2,
    reason:
      "POST /other/deleteAllData is the user-triggered 'wipe every table' endpoint: it imports initDB and calls initDB(db, true) inside the request handler. Phase 1b deletes the route (it is unauthenticated); Phase 1a must not touch route code.",
  },
  {
    file: "apps/api/src/routes/setting/dbConfig/clearData.ts",
    min: 2,
    reason:
      "GET /setting/dbConfig/clearData drops all tables then calls initDB(db) to rebuild them - request-triggered, not boot-triggered. Phase 1b reworks it (see tenant-exceptions.json); Phase 1a must not touch route code.",
  },
  {
    file: "apps/api/src/routes/setting/dbConfig/importData.ts",
    min: 2,
    reason:
      "POST /setting/dbConfig/importData drops all tables, calls initDB(db) and then imports rows - request-triggered, not boot-triggered. Phase 1b reworks it; Phase 1a must not touch route code.",
  },
  {
    file: "apps/api/src/routes/setting/dev/getSwitchAiDevTool.ts",
    min: 1,
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
const reachable = [];
const seen = new Set();
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
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(graphText))) {
      const spec = m[1];
      if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;
      const target = resolveSpec(file, spec);
      if (target) queue.push(target);
      else warnings.push(`unresolved specifier "${spec}" in ${rel(file)} (not scanned)`);
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

// ---- apply exemptions; each must really hit ----
const covered = new Set();
for (const ex of EXEMPTIONS) {
  const mine = hits.filter((h) => h.file === ex.file);
  if (mine.length < ex.min) {
    failures.push(
      `exemption is stale: ${ex.file} declares min=${ex.min} occurrence(s) of initDB/fixDB but only ${mine.length} found ` +
        `(${mine.length === 0 ? "file no longer references them" : "count shrank"}) -> delete or fix the exemption`,
    );
    continue;
  }
  for (const h of mine) covered.add(`${h.file}:${h.line}:${h.token}`);
}

const unexplained = hits.filter((h) => !covered.has(`${h.file}:${h.line}:${h.token}`));

// ---- guard: an exemption must not hide MORE than it declares (no blanket whitelist) ----
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
  for (const f of failures) console.error("  - " + f);
  console.error(`  scanned: ${reachable.length} reachable module(s) from apps/api/src/app.ts`);
  process.exit(1);
}
console.log(
  `check-dead-ddl passed (boot chain clean): ${reachable.length} module(s) reachable from src/app.ts, ` +
    `${hits.length} exempted occurrence(s) in ${EXEMPTIONS.length} file(s), 0 unexplained`,
);
