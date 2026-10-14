#!/usr/bin/env node
/**
 * Task 9 的**可复现红端harness**（评审可直接 `node tools/tenant-redend.cjs`）。
 *
 * 为什么需要它：Task 9 的三类红端（拿掉守卫 ⇒ 套件大面积红、空转护栏、9 种 `systemDb`/裸 `db` 形态）
 * 都需要**临时改源码**；而 `apps/api/src/**` 同时被"遍历 src"的用例读 ⇒ 在主仓里改会互相污染。
 * 所以本脚本把篡改全部放进 `%TEMP%` 的 **git worktree 隔离副本**里，还原源 = 副本自己的 HEAD（VCS），
 * 并**逐个自证**（junction/文件/还原 sha 都校验）—— 观测不到就 `exit 3`，绝不发假结论。
 *
 * 用法：node tools/tenant-redend.cjs [--repo=<绝对路径>]
 * 退出码：0 = 全部红端符合预期；1 = 有不符合；3 = 隔离副本没搭起来（不发结论）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");

const argRepo = process.argv.find((a) => a.startsWith("--repo="));
const REPO = argRepo ? argRepo.slice("--repo=".length) : path.resolve(__dirname, "..");
const WT = path.join(process.env.TEMP || process.env.TMP, "miwo-t9-redend-wt");
const J_ROOT = path.join(WT, "node_modules");
const J_API = path.join(WT, "apps", "api", "node_modules");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
const runIn = (args, cwd, withTsx) => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (withTsx) env.NODE_OPTIONS = "--import=tsx";
  const r = spawnSync(process.execPath, args, { cwd: cwd || WT, encoding: "utf8", windowsHide: true, timeout: 900000, env });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};
const verdicts = [];
const judge = (name, ok, detail) => {
  verdicts.push({ name, ok });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " —— " + detail : ""));
};

function dropWorktree() {
  for (const j of [J_ROOT, J_API]) if (fs.existsSync(j)) sh("cmd", ["/c", "rmdir", j]);
  sh("git", ["-C", REPO, "worktree", "remove", "--force", WT]);
  if (fs.existsSync(WT)) {
    try {
      fs.rmSync(WT, { recursive: true, force: true });
    } catch {
      /* 残留可接受：junction 已经拆掉了 */
    }
  }
  sh("git", ["-C", REPO, "worktree", "prune"]);
}
function restore(rel) {
  execFileSync("git", ["-C", WT, "checkout", "--", rel], { encoding: "utf8" });
  const want = execFileSync("git", ["-C", WT, "show", `HEAD:${rel}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return sha256(want) === sha256(fs.readFileSync(path.join(WT, rel)));
}

dropWorktree();
sh("git", ["-C", REPO, "worktree", "add", "--detach", WT, "HEAD"]);
for (const [p, t] of [
  [J_ROOT, path.join(REPO, "node_modules")],
  [J_API, path.join(REPO, "apps", "api", "node_modules")],
]) {
  if (!fs.existsSync(p)) {
    try {
      fs.symlinkSync(t, p, "junction");
    } catch (e) {
      console.error("[junction] " + p + " failed: " + String(e && e.message));
    }
  }
}
const VITEST = path.join(J_API, "vitest", "vitest.mjs");
const GATE = path.join(WT, "tools", "check-tenant-exceptions.cjs");
const FIXTURE = path.join(WT, "apps", "api", "src", "routes", "other", "configHealth.ts");
const API_WT = path.join(WT, "apps", "api");
const pre = {
  vitest: fs.existsSync(VITEST),
  apiTsx: fs.existsSync(path.join(J_API, "tsx")),
  gate: fs.existsSync(GATE),
  fixture: fs.existsSync(FIXTURE),
};
console.log("[copy] " + WT + " @ " + execFileSync("git", ["-C", WT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + " " + JSON.stringify(pre));
if (!pre.vitest || !pre.apiTsx || !pre.gate || !pre.fixture) {
  console.error("FATAL: isolated copy incomplete —— abort (no verdicts)");
  dropWorktree();
  process.exit(3);
}

const SUITES = ["tests/tenant-isolation.test.ts", "tests/tenant-isolation-http.test.ts"];
const summaryOf = (o) => (o.match(/Tests\s+.*/) || ["(no summary)"])[0].trim();

// A1：拿掉守卫的租户判定（策略表里所有 tenant → platform）
{
  const rel = "apps/api/src/db/policies.ts";
  const abs = path.join(WT, rel);
  const orig = fs.readFileSync(abs, "utf8");
  const mutated = orig.replace(/: "tenant"/g, ': "platform"');
  if (mutated === orig) judge("A1 tamper-anchor", false, "anchor not found");
  else {
    let red, green, ok;
    try {
      fs.writeFileSync(abs, mutated, "utf8");
      red = runIn([VITEST, "run", ...SUITES], API_WT, false);
    } finally {
      ok = restore(rel);
      green = runIn([VITEST, "run", ...SUITES], API_WT, false);
    }
    console.log("A1_RED   " + red.status + "  " + summaryOf(red.out));
    console.log("A1_GREEN " + green.status + "  " + summaryOf(green.out));
    judge("A1 guard-removed => suites massively red (restored byte-identical: " + ok + ")", red.status !== 0 && green.status === 0 && ok, summaryOf(red.out));
  }
}

// A2：空转护栏（种子成功但什么都不写）
{
  const rel = "apps/api/scripts/seed-tenant-fixture.ts";
  const abs = path.join(WT, rel);
  const orig = fs.readFileSync(abs, "utf8");
  const mutated = orig.replace(
    "  await dbReady;",
    '  await dbReady;\n  if (process.env.__T9_NOOP_SEED__ === "1") { console.log("[seed] RED-END no-op"); process.exit(0); }',
  );
  let res, ok;
  try {
    fs.writeFileSync(abs, mutated, "utf8");
    res = spawnSync(process.execPath, [path.join("apps", "api", "scripts", "verify-phase1b.cjs")], {
      cwd: WT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 900000,
      env: { ...process.env, __T9_NOOP_SEED__: "1" },
    });
  } finally {
    ok = restore(rel);
  }
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const guardFired = /fixtureRows=0/.test(out);
  for (const l of out.split(/\r?\n/).filter((x) => /fixtureRows|summary/.test(x)).slice(0, 3)) console.log("A2| " + l.trim());
  judge("A2 idle-guard: empty fixture => verify-phase1b fails (restored: " + ok + ")", res.status === 1 && guardFired && ok);
}

// B：9 种形态
const CASES = [
  ["B1 named-no-alias", 'import { systemDb } from "@/utils/db";\nvoid systemDb;\n', "red-systemdb"],
  ["B2 aliased", 'import { systemDb as sdb } from "@/utils/db";\nvoid sdb;\n', "red-systemdb"],
  ["B3 namespace", 'import * as dbmod from "@/utils/db";\nvoid dbmod.systemDb;\n', "red-systemdb"],
  ["B4 relative", 'import { systemDb } from "../../../utils/db";\nvoid systemDb;\n', "red-systemdb"],
  ["B5 dynamic import", 'export async function __b5() { const { systemDb } = await import("@/utils/db"); return systemDb; }\n', "red-systemdb"],
  ["B6 require", 'const { systemDb: reqSdb } = require("@/utils/db");\nvoid reqSdb;\n', "red-systemdb"],
  ["B7 bare { db }", 'import { db } from "@/utils/db";\nvoid db;\n', "red-baredb"],
  ["B8 default import (control)", 'import dbDefault from "@/utils/db";\nvoid dbDefault;\n', "not-systemdb"],
  ["B9 comment-only (Ruling 239)", '// import { systemDb } from "@/utils/db";\n', "green"],
];
for (const [label, snippet, expect] of CASES) {
  const orig = fs.readFileSync(FIXTURE, "utf8");
  let res;
  try {
    fs.writeFileSync(FIXTURE, orig + "\n" + snippet, "utf8");
    res = runIn([GATE], WT, false);
  } finally {
    restore("apps/api/src/routes/other/configHealth.ts");
  }
  const out = res.out;
  const sysMismatch = /systemDb \u4f7f\u7528\u8005\u4e0d\u4e00\u81f4/.test(out);
  const bareDb = /\u88f8 db \u547d\u540d\u5bfc\u5165/.test(out);
  const ok =
    expect === "red-systemdb" ? res.status === 1 && sysMismatch
    : expect === "red-baredb" ? res.status === 1 && bareDb
    : expect === "not-systemdb" ? !sysMismatch
    : res.status === 0;
  judge(label + " (exit=" + res.status + " systemDb=" + sysMismatch + " bareDb=" + bareDb + ")", ok);
}

dropWorktree();
const failed = verdicts.filter((v) => !v.ok).length;
console.log("--- summary: " + (verdicts.length - failed) + " / " + verdicts.length + " red-end checks passed; copy removed=" + !fs.existsSync(WT) + " ---");
process.exit(failed ? 1 : 0);
