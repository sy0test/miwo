#!/usr/bin/env node
/**
 * 队列的**多进程混沌验收**（Phase 1d Task 10 / spec §12.2 T6）。
 *
 * ── 为什么必须真连 MySQL ──
 * 本 harness 要验的是"多个 worker 进程**并发领取同一张队列**、杀掉其中一个之后租约回收、
 * 零丢失、上限不被突破"。sqlite 单文件在多进程下没有行锁语义（`for update skip locked` 只在
 * MySQL/PG 有效，见 `src/db/store.ts` 的候选查询注释）⇒ 未连 MySQL 时以 **EXIT 2** 退出并说明，
 * **绝不**打印"通过"（Ruling 243：观测不到 ≠ 通过）。
 *
 * ── 断言（每条都打印机器可读行）──
 *   A. 零丢失：终态（succeeded/dead/canceled）数 == M
 *   B. 发生了回收：至少 1 条 attempts >= 2（否则租约回收没生效）
 *   C. 无重叠执行：同一 jobId 的 [start,end] 区间不重叠（事件流 `${MIWO_DATA_DIR}/job-selftest.jsonl`）
 *   D. 上限不被突破：按 50ms 采样，全局在跑数 ≤ globalMaxRunning、单用户在跑数 ≤ perUserMaxRunning
 *   E. 没有"永久 running"：终态检查时 state=running 的行数 == 0
 *
 * 用法（仓库根或 apps/api 下均可）：
 *   node apps/api/scripts/job-chaos.cjs                 # 默认 M=30 K=3 U=5 ms=400
 *   node apps/api/scripts/job-chaos.cjs --jobs=10 --workers=2
 *
 * ⚠ 本脚本**只碰 `selftest.sleep` 的行**（不碰任何业务表），且写完会清理自己造的行。
 * ⚠ MySQL 全线在本机**未实测**（3307 不启）—— 本脚本的存在正是为了让 CI 能真跑。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const API_DIR = path.join(ROOT, "apps", "api");

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const M = Number(arg("jobs", 30));
const K = Number(arg("workers", 3));
const U = Number(arg("users", 5));
const MS = Number(arg("ms", 400));
const PEER_POLL_MS = 250;
const DEADLINE_MS = 120_000;

const lines = [];
const say = (m) => {
  lines.push(m);
  console.log(m);
};
const fail = (code, m) => {
  say(m);
  process.exit(code);
};

// ── 0) 驱动门禁：必须 MySQL ──
if (String(process.env.MIWO_DB_DRIVER || "") !== "mysql") {
  console.error("[chaos] 本 harness 需要 MySQL（MIWO_DB_DRIVER=mysql）：sqlite 在多进程下没有行锁语义，");
  console.error("        '多 worker 并发领取' 与本组断言无法成立。");
  console.error("        ⇒ 本机（无 MySQL）请用 sqlite 单元用例；本脚本在 CI 的 mysql job / 服务器上跑。");
  console.error("        （这不是通过，也不是失败 —— 是'观测不到'，按 Ruling 243 以 EXIT 2 结束）");
  process.exit(2);
}

const mysql2 = (() => {
  try {
    return require(path.join(API_DIR, "node_modules", "mysql2", "promise"));
  } catch {
    try {
      return require("mysql2/promise");
    } catch (e) {
      fail(2, `[chaos] 找不到 mysql2（${e.message}）—— 请先在 apps/api 下 pnpm install`);
    }
  }
})();

const cfg = {
  host: process.env.MIWO_DB_HOST || "127.0.0.1",
  port: Number(process.env.MIWO_DB_PORT || 3307),
  user: process.env.MIWO_DB_USER || "miwo",
  password: process.env.MIWO_DB_PASSWORD || "miwo",
  database: process.env.MIWO_DB_NAME || "miwo_test",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = await mysql2.createConnection(cfg);
  const workers = [];
  const killAll = () => {
    for (const w of workers) {
      try {
        w.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  };

  try {
    const dataDir = process.env.MIWO_DATA_DIR || path.join(os.tmpdir(), `miwo-chaos-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const jsonl = path.join(dataDir, "job-selftest.jsonl");
    if (fs.existsSync(jsonl)) fs.rmSync(jsonl);

    // ── 2) 清理旧 selftest 行 ──
    await conn.execute("DELETE FROM o_job WHERE type = ?", ["selftest.sleep"]);
    say(`[chaos] 清理旧 selftest 行完成；dataDir=${dataDir}`);

    // ── 3) 插入 M 条（跨 U 个用户）──
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < M; i += 1) {
      const userId = (i % U) + 1;
      rows.push([userId, "selftest.sleep", JSON.stringify({ ms: MS, tag: `chaos-${now}-${i}` }), "queued", 0, 1, 100, 0, now, now]);
    }
    await conn.query(
      "INSERT INTO o_job (userId, type, payload, state, attempts, maxAttempts, priority, progress, createdAt, updatedAt) VALUES ?",
      [rows],
    );
    say(`[chaos] 已插入 M=${M} 条 selftest（users=${U}, ms=${MS}）`);

    // ── 4) 起 K 个 worker 进程 ──
    const tsxLoader = require.resolve("tsx", { paths: [API_DIR] });
    for (let i = 0; i < K; i += 1) {
      const child = spawn(process.execPath, ["--import", require("url").pathToFileURL(tsxLoader).href, path.join("src", "worker.ts")], {
        cwd: API_DIR,
        env: { ...process.env, MIWO_DATA_DIR: dataDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.__ready = false;
      child.stdout.on("data", (b) => {
        const s = String(b);
        if (s.includes("[worker] 已启动")) child.__ready = true;
      });
      child.stderr.on("data", () => {});
      workers.push(child);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && workers.some((w) => !w.__ready)) await sleep(PEER_POLL_MS);
    say(`[chaos] 已启动 K=${K} 个 worker（ready=${workers.filter((w) => w.__ready).length}/${K}）`);

    // ── 5) 等到"有任务在跑" → 杀一个 worker（制造租约回收）──
    let killed = false;
    while (Date.now() - t0 < DEADLINE_MS && !killed) {
      const [running] = await conn.query("SELECT id, workerId FROM o_job WHERE type = ? AND state = 'running' LIMIT 1", ["selftest.sleep"]);
      if (running.length) {
        const victim = workers.find((w) => w.__ready && !w.killed) || workers[0];
        victim.killed = true;
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/PID", String(victim.pid)], { stdio: "ignore" });
        } else {
          victim.kill("SIGKILL");
        }
        killed = true;
        say(`[chaos] 已对 worker pid=${victim.pid} 发 SIGKILL（制造租约丢失）`);
        break;
      }
      await sleep(PEER_POLL_MS);
    }
    if (!killed) say("[chaos] ⚠ 没等到 running 行，未杀 worker（回收断言可能不成立）");

    // ── 6) 等终态 ──
    let terminal = 0;
    let runningLeft = M;
    while (Date.now() - t0 < DEADLINE_MS) {
      const [[t]] = await conn.query(
        "SELECT SUM(state IN ('succeeded','dead','canceled')) AS terminal, SUM(state = 'running') AS running FROM o_job WHERE type = ?",
        ["selftest.sleep"],
      );
      terminal = Number(t.terminal || 0);
      runningLeft = Number(t.running || 0);
      if (terminal === M && runningLeft === 0) break;
      await sleep(PEER_POLL_MS);
    }

    // ── 7) 断言 ──
    const [[attempts]] = await conn.query("SELECT MAX(attempts) AS mx FROM o_job WHERE type = ?", ["selftest.sleep"]);
    const events = fs.existsSync(jsonl)
      ? fs
          .readFileSync(jsonl, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

    // A 零丢失
    const A = terminal === M;
    say(`[chaos] A 零丢失：终态 ${terminal}/${M} ⇒ ${A ? "PASS" : "FAIL"}`);

    // B 发生过回收
    const B = Number(attempts.mx || 0) >= 2;
    say(`[chaos] B 租约回收生效：max(attempts)=${attempts.mx} ⇒ ${B ? "PASS" : "FAIL"}`);

    // C 无重叠执行（按 jobId 组装区间）
    const spans = new Map();
    for (const e of events) {
      if (!spans.has(e.jobId)) spans.set(e.jobId, []);
      spans.get(e.jobId).push({ event: e.event, ts: e.ts, attempt: e.attempt });
    }
    let overlaps = 0;
    for (const [jobId, evs] of spans) {
      const starts = evs.filter((x) => x.event === "start").sort((a, b) => a.ts - b.ts);
      const ends = evs.filter((x) => x.event === "end").sort((a, b) => a.ts - b.ts);
      const intervals = starts.map((s, i) => ({ s: s.ts, e: ends[i] ? ends[i].ts : Number.POSITIVE_INFINITY })).sort((a, b) => a.s - b.s);
      for (let i = 1; i < intervals.length; i += 1) {
        if (intervals[i].s < intervals[i - 1].e) {
          overlaps += 1;
          say(`[chaos]   ⚠ job #${jobId} 区间重叠：${JSON.stringify(intervals[i - 1])} vs ${JSON.stringify(intervals[i])}`);
        }
      }
    }
    const C = overlaps === 0;
    say(`[chaos] C 无重叠执行：事件 ${events.length} 条 / job ${spans.size} 个 / 重叠 ${overlaps} ⇒ ${C ? "PASS" : "FAIL"}`);

    // D 并发上限（50ms 采样）
    const GLOBAL_MAX = Number(process.env.MIWO_CHAOS_GLOBAL_MAX || 8);
    const PER_USER_MAX = Number(process.env.MIWO_CHAOS_PER_USER_MAX || 2);
    const intervals = [];
    for (const [jobId, evs] of spans) {
      const starts = evs.filter((x) => x.event === "start").sort((a, b) => a.ts - b.ts);
      const ends = evs.filter((x) => x.event === "end").sort((a, b) => a.ts - b.ts);
      starts.forEach((s, i) => {
        const userId = evs.find((x) => x.userId !== undefined)?.userId;
        intervals.push({ s: s.ts, e: ends[i] ? ends[i].ts : s.ts + MS, userId });
      });
    }
    let peakGlobal = 0;
    let peakPerUser = 0;
    if (intervals.length) {
      const from = Math.min(...intervals.map((i) => i.s));
      const to = Math.max(...intervals.map((i) => i.e));
      for (let t = from; t <= to; t += 50) {
        const live = intervals.filter((i) => i.s <= t && t < i.e);
        peakGlobal = Math.max(peakGlobal, live.length);
        const byUser = {};
        for (const l of live) byUser[l.userId] = (byUser[l.userId] || 0) + 1;
        peakPerUser = Math.max(peakPerUser, ...Object.values(byUser), 0);
      }
    }
    const D = peakGlobal <= GLOBAL_MAX && peakPerUser <= PER_USER_MAX;
    say(`[chaos] D 上限未被突破：峰值 全局=${peakGlobal}≤${GLOBAL_MAX}、单用户=${peakPerUser}≤${PER_USER_MAX} ⇒ ${D ? "PASS" : "FAIL"}`);

    // E 无永久 running
    const E = runningLeft === 0;
    say(`[chaos] E 无永久 running：${runningLeft} 条 ⇒ ${E ? "PASS" : "FAIL"}`);

    const all = A && B && C && D && E;
    say(`[chaos] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ⇒ ${all ? "全部通过" : "有失败"}`);

    // 清理自己造的行
    await conn.execute("DELETE FROM o_job WHERE type = ?", ["selftest.sleep"]);
    await conn.end();
    killAll();
    if (!all) process.exit(1);
    if (!killed) fail(1, "[chaos] 没能在运行期杀掉任何 worker ⇒ 回收类断言不成立（观测不到 ≠ 通过）");
    process.exit(0);
  } catch (e) {
    killAll();
    try {
      await conn.end();
    } catch {
      /* 已断 */
    }
    fail(1, `[chaos] 异常：${e && e.stack ? e.stack : e}`);
  }
}

main();
