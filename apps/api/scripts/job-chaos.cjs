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
 *   C. 无重叠执行：**按 (jobId, attempt) 分组**配对 [start,end]，同一 job 的相邻 attempt 不重叠
 *      （事件流 `${MIWO_DATA_DIR}/job-selftest.jsonl`）。⚠ 被 SIGKILL 的 attempt **没有 end**
 *      —— 这是 B 断言强制发生的场景，不参与重叠判定（否则 B 与 C 互相矛盾，见 review-D.md F-1）
 *   D. 上限不被突破：按 50ms 采样，全局在跑数 ≤ `JOB_POLICY.globalMaxRunning`、
 *      单用户在跑数 ≤ `JOB_POLICY.perUserMaxRunning`（**上界只来自 policy.ts**，不是环境变量默认值 —— F-2）
 *   E. 没有"永久 running"：终态检查时 state=running 的行数 == 0
 *
 * ⚠ 本文件可以被 `require`（纯函数 `buildSpans` / `findOverlaps` / `resolveLimits` 已导出，供
 *   `tests/job-chaos-assertions.test.ts` 做判别力用例）；**直接执行时**才跑 main()。
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

/**
 * 【F-1】把事件流按 **(jobId, attempt)** 分组，得到每次 attempt 的 `[start, end]` 跨度。
 *
 * ── 为什么必须按 attempt 分组（而不是"第 i 个 start 配第 i 个 end"）──
 * 本 harness **自己**会 SIGKILL 一个 worker（见下面第 5 步）制造租约回收，而 `handlers/selftest.ts`
 * 只在**正常跑完**后才 append `end` ⇒ 被杀的 attempt **永远没有 end**。于是"第 i 个 start 配第 i 个
 * end"会整体错位：被杀 attempt 的 start 与**重跑 attempt 的 end** 配成一个横跨两次执行的区间，
 * 重跑的 start 落在这个假区间内 ⇒ 误判"区间重叠" ⇒ C FAIL。
 * 而 B 断言（`max(attempts) >= 2`）**强制这个场景必须发生** ⇒ 旧算法下 B 与 C 互相矛盾，
 * **队列实现完全正确时** CI mysql job / `verify:phase1d` 的 D2 也会变红（review-D.md F-1）。
 *
 * ── 口径 ──
 *   · 每个 (jobId, attempt) 至多一个 start / 一个 end；`e = null` = **这次 attempt 没有正常收尾**
 *     （被 SIGKILL / 租约丢失 / 进程退出）。这是**预期内**的状态，不是异常。
 *   · 返回 `Map<jobId, Array<{attempt, s, e}>>`（按 s 升序；没有 start 的事件只保留在 `unknown` 计数里）。
 */
function buildSpans(events) {
  const byJob = new Map();
  let orphanEnds = 0;
  for (const e of events) {
    if (e === null || typeof e !== "object" || e.jobId === undefined) continue;
    if (!byJob.has(e.jobId)) byJob.set(e.jobId, new Map());
    const attempts = byJob.get(e.jobId);
    const attempt = e.attempt === undefined ? 1 : e.attempt;
    if (!attempts.has(attempt)) attempts.set(attempt, { attempt, s: null, e: null, userId: undefined });
    const a = attempts.get(attempt);
    if (e.event === "start") {
      a.s = e.ts;
      if (e.userId !== undefined) a.userId = e.userId;
    } else if (e.event === "end") {
      if (a.s === null) orphanEnds += 1; // 只有 end 没有 start ⇒ 事件流不完整，下面当异常报
      a.e = e.ts;
    }
  }
  const out = new Map();
  for (const [jobId, attempts] of byJob) {
    const spans = [...attempts.values()]
      .filter((a) => a.s !== null)
      .sort((x, y) => x.s - y.s);
    out.set(jobId, spans);
  }
  out.orphanEnds = orphanEnds; // Map 上挂一个计数（调用方打印用；不影响遍历）
  return out;
}

/**
 * 【F-1】找出**同一条 job 的相邻 attempt 之间**的重叠（= 两次执行真的同时在跑）。
 *
 * ⚠ 只有**左端 attempt 有 end** 时才能判定："它还没结束，右端就开始了"。
 *   左端 `e === null`（被 SIGKILL）说明我们**不知道**它何时停下 ⇒ 该 attempt **不参与重叠判定**
 *   （否则 chaos 自己制造的场景必然误判，见 `buildSpans` 的头注）。
 * ⚠ 这个放宽**不影响**真正要守的不变式：一条 job 被两个 worker 同时执行时，两次 attempt
 *   **都会有 end**（都正常/失败收尾），相邻区间必然重叠 ⇒ 照样红（见 `tests/job-chaos-assertions.test.ts`
 *   的 `REAL_OVERLAP` 用例：这是"只收紧不放宽"的判别力证据）。
 */
function findOverlaps(jobSpans) {
  const overlaps = [];
  for (const [jobId, spans] of jobSpans) {
    for (let i = 1; i < spans.length; i += 1) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (prev.e === null) continue; // 左端没有 end ⇒ 无法判定（被 SIGKILL 是预期场景）
      if (cur.s < prev.e) overlaps.push({ jobId, prev, cur });
    }
  }
  return overlaps;
}

/**
 * 【F-2】D 断言的上界**只能**来自 `JOB_POLICY`（api/worker 真正用的那份），不许用硬编码默认值。
 *
 * 旧实现 `Number(process.env.MIWO_CHAOS_GLOBAL_MAX || 8)`：CI 没设这两个变量 ⇒ 验的是**旧的** 8/2，
 * 而策略（spec §15 的 O10 口径）本来就是"会改的地方" ⇒ 收紧时恒真、放宽时误红（review-D.md F-2）。
 * 现在：上界 = `JOB_POLICY.*`；`MIWO_CHAOS_*` 若被设置，**必须与策略一致**，否则拒绝跑（EXIT 2）。
 */
function resolveLimits(policy, env = process.env) {
  const global = Number(policy.globalMaxRunning);
  const perUser = Number(policy.perUserMaxRunning);
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const problems = [];
  const gEnv = num(env.MIWO_CHAOS_GLOBAL_MAX);
  const pEnv = num(env.MIWO_CHAOS_PER_USER_MAX);
  if (gEnv !== undefined && gEnv !== global) problems.push(`MIWO_CHAOS_GLOBAL_MAX=${gEnv} 与 JOB_POLICY.globalMaxRunning=${global} 不一致`);
  if (pEnv !== undefined && pEnv !== perUser) problems.push(`MIWO_CHAOS_PER_USER_MAX=${pEnv} 与 JOB_POLICY.perUserMaxRunning=${perUser} 不一致`);
  return { global, perUser, problems, source: "JOB_POLICY" };
}

/** CLI 路径：真读 `@/jobs/policy` 的 `JOB_POLICY`（用 tsx 的 CJS 钩子 require TS；失败即拒跑）。 */
function loadJobPolicy() {
  try {
    require("tsx/cjs");
  } catch (e) {
    fail(2, `[chaos] 无法注册 tsx/cjs（${e.message}）—— 上界必须来自 JOB_POLICY，拒绝用硬编码默认值`);
  }
  try {
    return require(path.join(API_DIR, "src", "jobs", "policy.ts")).JOB_POLICY;
  } catch (e) {
    fail(2, `[chaos] 读不到 @/jobs/policy 的 JOB_POLICY（${e.message}）—— 拒绝用硬编码默认值`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 0) 驱动门禁：必须 MySQL（⚠ 必须在 main() 里：本文件被单测 `require` 时不得退出进程）──
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

    // C 无重叠执行（【F-1】按 (jobId, attempt) 分组配对；无 end 的 attempt 不参与重叠判定）
    const jobSpans = buildSpans(events);
    const overlaps = findOverlaps(jobSpans);
    for (const o of overlaps) {
      say(`[chaos]   ⚠ job #${o.jobId} attempt ${o.prev.attempt}→${o.cur.attempt} 区间重叠：${JSON.stringify(o.prev)} vs ${JSON.stringify(o.cur)}`);
    }
    const killedAttempts = [...jobSpans.values()].flat().filter((s) => s.e === null).length;
    const C = overlaps.length === 0 && jobSpans.orphanEnds === 0;
    if (jobSpans.orphanEnds) say(`[chaos]   ⚠ 事件流有 ${jobSpans.orphanEnds} 条 end 没有对应 start（事件流不完整）`);
    say(
      `[chaos] C 无重叠执行：事件 ${events.length} 条 / job ${jobSpans.size} 个 / 重叠 ${overlaps.length} ⇒ ${C ? "PASS" : "FAIL"}` +
        `（其中 ${killedAttempts} 次 attempt 无 end = 被 SIGKILL/中止，按设计不参与重叠判定）`,
    );

    // D 并发上限（50ms 采样）【F-2】上界只来自 JOB_POLICY；MIWO_CHAOS_* 只能用于"一致性自检"
    const policy = loadJobPolicy();
    const { global: GLOBAL_MAX, perUser: PER_USER_MAX, problems: limitProblems } = resolveLimits(policy, process.env);
    if (limitProblems.length) {
      // 明确拒绝跑：env 与策略不一致时"验的是旧上界"，正是 F-2 的形态
      fail(2, `[chaos] 上界来源冲突（拒绝用旧上界跑验收）：\n        ${limitProblems.join("\n        ")}\n        ⇒ 请删掉 MIWO_CHAOS_*，或让它与 apps/api/src/jobs/policy.ts 的 JOB_POLICY 一致`);
    }
    say(`[chaos] D 上界来源：JOB_POLICY globalMaxRunning=${GLOBAL_MAX} / perUserMaxRunning=${PER_USER_MAX}`);
    const intervals = [];
    for (const [, spans] of jobSpans) {
      for (const a of spans) {
        // ⚠ 无 end 的 attempt（被 SIGKILL）用 "start + selftest 时长" 兜底：这是**下界**估计（它至少跑了 MS），
        //    对"峰值是否超上限"这个断言是保守方向（可能高估并发），不会把超限洗掉。
        intervals.push({ s: a.s, e: a.e === null ? a.s + MS : a.e, userId: a.userId });
      }
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

/**
 * ⚠ **只有直接跑本文件时才进 main()**：`tests/job-chaos-assertions.test.ts` 要 `require` 本文件来
 * 单测 `buildSpans` / `findOverlaps` / `resolveLimits`（F-1/F-2 的判别力用例）——那时**不许**退出进程、
 * 不许连 MySQL。所以驱动门禁（必须 MySQL）与 mysql2 的 require 都在 main() 内部。
 */
if (require.main === module) {
  main();
}

module.exports = { buildSpans, findOverlaps, resolveLimits };
