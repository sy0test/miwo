#!/usr/bin/env node
/**
 * Phase 1d（任务队列）唯一验收命令。用法（**仓库根**）：
 *   node apps/api/scripts/verify-phase1d.cjs
 *   node apps/api/scripts/verify-phase1d.cjs --require-mysql     # CI 的 mysql job：该跑的没跑就是 FAIL
 *
 * ── 分组（每组的 pass/fail/skip 逐条打印；结尾 `通过 N / 跳过 M / 失败 K`，失败一律 EXIT 1）──
 *   A. 结构与注册（本机必跑，纯静态 + 少量子进程）
 *   B. 静态 SQL / 方言（**本机无 MySQL 时"守住 MySQL 正确性"的替代证据**：mysql2 客户端上的
 *      `toSQL()` 文本 + 毫秒列清单；**一律标注"未实测"**，真机口径在 CI 的 mysql job）
 *   C. sqlite 端到端（全新数据目录 → 迁移 → 入队 → 真起 worker → 终态 + 事件流）
 *   D. MySQL 端到端（`MIWO_TEST_MYSQL=1` 才跑；否则打印 SKIP；`--require-mysql` 时 SKIP ⇒ FAIL）
 *   E. 门禁 + 既有验收（门禁脚本 / typecheck / 单测 / 6 个既有 verify）
 *
 * ⚠ 脚本自己创建/清理临时数据目录（`%TEMP%` 下一次性目录），**逐个绝对路径**删除（禁通配符）。
 * ⚠ 观测不到 ⇒ `exit 3`（Ruling 243）：比如"worker 子进程压根没起来"不能算通过。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const API_DIR = path.join(ROOT, "apps", "api");
const REQUIRE_MYSQL = process.argv.includes("--require-mysql");
const MYSQL_ENABLED = process.env.MIWO_TEST_MYSQL === "1";

const results = [];
const rec = (group, id, status, detail) => {
  results.push({ group, id, status, detail });
  const mark = status === "pass" ? "✔" : status === "skip" ? "○" : "✘";
  console.log(`  ${mark} [${group}] ${id} —— ${detail}`);
};
const skip = (group, id, detail) => rec(group, id, "skip", detail);
const pass = (group, id, detail) => rec(group, id, "pass", detail);
const fail = (group, id, detail) => rec(group, id, "fail", detail);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: "utf8", shell: false, timeout: opts.timeout || 900_000, env: { ...process.env, ...(opts.env || {}) } });
}
/** `node --import=tsx <script>`（Windows 上 tsx 的 loader 必须是 file:// URL）。 */
function runTsx(script, env = {}, cwd = API_DIR, timeout = 300_000) {
  const tsxLoader = require.resolve("tsx", { paths: [API_DIR] });
  const { pathToFileURL } = require("url");
  return spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, script], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout });
}

// ───────────────────────── A. 结构与注册 ─────────────────────────
function groupA() {
  console.log("\n[A] 结构与注册");
  exists("apps/api/src/worker.ts") ? pass("A", "A1 worker 入口存在", "apps/api/src/worker.ts") : fail("A", "A1 worker 入口存在", "缺文件");

  const build = exists("apps/api/scripts/build.ts") ? read("apps/api/scripts/build.ts") : "";
  build.includes("workerBuildConfig") && build.includes("worker.js")
    ? pass("A", "A2 双产物构建", "build.ts 有 workerBuildConfig → data/serve/worker.js")
    : fail("A", "A2 双产物构建", "build.ts 缺 worker 产物配置");

  const idx = read("apps/api/src/db/migrations/index.ts");
  const hasJob = /import\s+\S+\s+from\s+["']@\/db\/migrations\/\d{3}_job[-_]queue["']/.test(idx);
  const hasGate = /import\s+\S+\s+from\s+["']@\/db\/migrations\/\d{3}_vendor[-_]gate["']/.test(idx);
  hasJob && hasGate ? pass("A", "A3 o_job/o_gate 迁移已登记", "MIGRATIONS 含 007/008（允许 kebab-case）") : fail("A", "A3 o_job/o_gate 迁移已登记", "index.ts 里找不到 007/008 的 import");

  const reg = read("apps/api/src/jobs/registry.ts");
  const types = [...reg.matchAll(/type:\s*"([^"]+)"/g)].map((m) => m[1]);
  const EXPECTED = ["video.generate", "video.batchGenerate", "image.assets.batch", "image.storyboard.batch", "image.productionAssets.batch", "prompt.batch", "selftest.sleep"];
  // registry.ts 只是数组，type 字面量在 handlers 里；改为扫 handlers 目录
  const handlersDir = path.join(API_DIR, "src", "jobs", "handlers");
  const handlerTypes = [];
  for (const f of fs.readdirSync(handlersDir).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(handlersDir, f), "utf8");
    // ⚠ 只认"definition 上的 type 字段"（行首缩进 + `type:` + 字符串），别把 `cfg.taskClass` 之类的字面量也算进来
    for (const m of src.matchAll(/^\s{2}type:\s*"([^"]+)"/gm)) handlerTypes.push(m[1]);
  }
  const okA4 = EXPECTED.every((t) => handlerTypes.includes(t)) && handlerTypes.length === EXPECTED.length;
  okA4 ? pass("A", "A4 注册表 7 个类型", handlerTypes.sort().join(",")) : fail("A", "A4 注册表 7 个类型", `实际 ${handlerTypes.sort().join(",")}`);

  // A5：六个入队路由不得再有进程内 fire-and-forget（剥注释）
  const routesRoot = path.join(API_DIR, "src", "routes");
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const strip = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, "")).join("\n");
  const enqueueRoutes = walk(routesRoot).filter((p) => fs.readFileSync(p, "utf8").includes("enqueueJob("));
  const bad = enqueueRoutes.filter((p) => {
    const s = strip(fs.readFileSync(p, "utf8"));
    return s.includes("pLimit(") || s.includes("Promise.all(tasks)");
  });
  enqueueRoutes.length >= 6 && bad.length === 0
    ? pass("A", "A5 入队路由无进程内 fire-and-forget", `${enqueueRoutes.length} 个入队路由，0 个残留`)
    : fail("A", "A5 入队路由无进程内 fire-and-forget", `入队路由 ${enqueueRoutes.length}，残留 ${bad.map((b) => path.relative(ROOT, b)).join(",")}`);

  // A6：socket 层不得再挂 namespace 级 disconnect（真扫目录，剥注释）
  const sockRoot = path.join(API_DIR, "src", "socket");
  const offenders = walk(sockRoot).filter((p) => strip(fs.readFileSync(p, "utf8")).includes('nsp.on("disconnect"'));
  offenders.length === 0 ? pass("A", "A6 socket 无 namespace 级 disconnect", `扫了 ${walk(sockRoot).length} 个文件`) : fail("A", "A6 socket 无 namespace 级 disconnect", offenders.join(","));
}

// ───────────────────────── B. 静态 SQL / 方言 ─────────────────────────
function groupB() {
  console.log("\n[B] 静态 SQL / 方言（本机无 MySQL 的替代证据；MySQL 一律未实测）");
  const probe = path.join(os.tmpdir(), `miwo-verify1d-dialect-${Date.now()}.cjs`);
  fs.writeFileSync(
    probe,
    [
      `const { createKnex } = require("@/db/connect");`,
      `const { buildClaimQuery } = require("@/jobs/store");`,
      `(async () => {`,
      `  const db = createKnex({ env: "dev", port: 10599, host: "127.0.0.1", dataDir: process.env.MIWO_DATA_DIR, mediaDir: process.env.MIWO_DATA_DIR + "/oss", storageDriver: "local", publicBaseUrl: "http://x", trustProxy: 0, jwtSecret: "x".repeat(48), db: { driver: "mysql", host: "127.0.0.1", port: 3307, user: "miwo", password: "miwo", name: "miwo" } });`,
      `  const sql = buildClaimQuery(db, { now: 1, limit: 1, lock: true }).toSQL().sql;`,
      `  console.log("CLAIM_SQL=" + sql);`,
      `  await db.destroy().catch(() => {});`,
      `  process.exit(0);`,
      `})().catch((e) => { console.log("ERR=" + e.message); process.exit(3); });`,
    ].join("\n"),
    "utf8",
  );
  try {
    const r = runTsx(probe, {
      MIWO_DATA_DIR: path.join(os.tmpdir(), "miwo-verify1d-b"),
      MIWO_ENV: "dev",
      MIWO_PORT: "10599",
      MIWO_HOST: "127.0.0.1",
      MIWO_JWT_SECRET: "x".repeat(48),
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const m = /CLAIM_SQL=(.*)/.exec(out);
    if (!m) {
      r.status === 3 ? fail("B", "B1 claim 候选查询（mysql 方言）", `观测不到：${out.slice(0, 200)}`) : fail("B", "B1 claim 候选查询（mysql 方言）", out.slice(0, 200));
    } else {
      const sql = m[1].trim();
      // ⚠【review-D F-3 修正·文案不再说谎】旧文案写"含 state 条件"，但断言**根本没查** state
      //   （复核轮实测：把 claim() 的条件 UPDATE 的 state 条件去掉后，B1/C1/C2 **仍绿**）。
      //   现在三条都真查：
      //     · `state` = ?  —— `state` 是**参数化**的，所以断言的是**参数位**的存在（不是字面量 'queued'）；
      //     · `nextAttemptAt` / `leaseUntil` —— 两条租约条件；
      //     · `for update skip locked` —— mysql 专属方言。
      //   ⚠ 边界（必须说清，不许再含糊）：B1 覆盖的是**候选 SELECT**（`buildClaimQuery`）。
      //     "两个 worker 同抢一条"真正靠的是 claim() 里的**条件 UPDATE**（`.andWhere("state","queued")`），
      //     它由 **B3 的源码级机械守卫** + `tests/job-store.test.ts` 的**两条独立连接**行为用例守着。
      const hasStateParam = sql.includes("`state` = ?");
      const ok = sql.includes("for update skip locked") && hasStateParam && sql.includes("`leaseUntil`") && sql.includes("`nextAttemptAt`");
      ok
        ? pass("B", "B1 claim 候选查询（mysql 方言）", "含 for update skip locked + `state` = ? 参数位 + leaseUntil/nextAttemptAt（**未连真机**）")
        : fail("B", "B1 claim 候选查询（mysql 方言）", `缺项 stateParam=${hasStateParam} sql=${sql.slice(0, 200)}`);
    }
  } finally {
    fs.rmSync(probe, { force: true });
  }

  // B2：毫秒列清单（从 001/005/006/007/008 源码机械推导的 t.ms( 次数）
  const migDir = path.join(API_DIR, "src", "db", "migrations");
  let msCount = 0;
  const files = [];
  for (const f of fs.readdirSync(migDir).filter((f) => /^\d{3}_.+\.ts$/.test(f))) {
    const n = (fs.readFileSync(path.join(migDir, f), "utf8").match(/t\.ms\(/g) || []).length;
    if (n) files.push(`${f}:${n}`);
    msCount += n;
  }
  msCount >= 15
    ? pass("B", "B2 毫秒列（t.ms）清单", `${msCount} 列，来自 ${files.join(" ")}（**MySQL 列类型未实测**）`)
    : fail("B", "B2 毫秒列（t.ms）清单", `只数到 ${msCount} 列（下界 15）`);

  // B3：【review-D F-3 补】claim 的**条件 UPDATE** 必须带 `state` 条件（源码级机械守卫）。
  //   —— 为什么单开一条：B1 查的是候选 SELECT，而"两个 worker 不会抢同一条任务"靠的是 claim() 里
  //      `UPDATE … WHERE id=? AND state='queued'` 这条**条件写**。复核轮实测：删掉那个条件后
  //      B1/C1/C2 仍绿（C 组是单 worker 顺序路径）。行为层的判别力在
  //      `tests/job-store.test.ts:182`（两条**独立连接**并发 claim，只有一条赢）—— 那条一直在跑；
  //      这里补一条源码级守卫，让"删掉那行"在本验收里也**立刻红**（不是靠人去记得跑单测）。
  {
    const storeSrc = fs.readFileSync(path.join(API_DIR, "src", "jobs", "store.ts"), "utf8");
    const hasStateCond = /\.andWhere\("state",\s*"queued"\)/.test(storeSrc);
    hasStateCond
      ? pass("B", "B3 claim 条件 UPDATE 带 state（源码级守卫）", 'store.ts 含 .andWhere("state", "queued")；行为判别力见 tests/job-store.test.ts 的两连接用例')
      : fail("B", "B3 claim 条件 UPDATE 带 state（源码级守卫）", 'store.ts 里找不到 .andWhere("state", "queued")：两个 worker 会抢同一条任务');
  }
}

// ───────────────────────── C. sqlite 端到端 ─────────────────────────
function groupC() {
  console.log("\n[C] sqlite 端到端（本机必跑）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-verify1d-c-"));
  const probe = path.join(tmp, "c-probe.cjs");
  const jsonl = path.join(tmp, "job-selftest.jsonl");
  fs.writeFileSync(
    probe,
    [
      `const fs = require("fs");`,
      `const { dbReady } = require("@/utils/db");`,
      `const { createKnex } = require("@/db/connect");`,
      `const { createJobStore } = require("@/jobs/store");`,
      `const { createJobRegistry } = require("@/jobs/registry");`,
      `const { startWorkerLoop } = require("@/jobs/worker");`,
      `(async () => {`,
      `  // ⚠ 不能自己再跑一遍 runMigrations：import @/jobs/* 已经触发 @/utils → utils/db 的"连接 → 迁移"链，`,
      `  //    两遍并发迁移会在 knex_migrations 上报 SQLITE_ERROR（实测踩到）。这里只 await 那次既有的 dbReady。`,
      `  await dbReady;`,
      `  const db = createKnex({ env: "dev", port: 10599, host: "127.0.0.1", dataDir: process.env.MIWO_DATA_DIR, mediaDir: process.env.MIWO_DATA_DIR + "/oss", storageDriver: "local", publicBaseUrl: "http://x", trustProxy: 0, jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: process.env.MIWO_DATA_DIR + "/db2.sqlite" } });`,
      `  const registry = createJobRegistry(require("@/jobs/registry").JOB_DEFINITIONS);`,
      `  const store = createJobStore({ db, registry });`,
      `  const ids = [];`,
      `  for (let i = 0; i < 3; i += 1) { const { jobId } = await store.enqueue({ type: "selftest.sleep", userId: i + 1, payload: { ms: 700, tag: "verify1d-" + i } }); ids.push(jobId); }`,
      `  const runner = startWorkerLoop({ store, registry, workerId: "verify1d" });`,
      `  const t0 = Date.now();`,
      `  while (Date.now() - t0 < 60000) {`,
      `    const rows = await store.list({ scope: { all: true }, limit: 10 });`,
      `    if (rows.length === 3 && rows.every((r) => ["succeeded","dead","canceled"].includes(r.state))) break;`,
      `    await new Promise((r) => setTimeout(r, 100));`,
      `  }`,
      `  await runner.stop();`,
      `  const rows = await store.list({ scope: { all: true }, limit: 10 });`,
      `  const succeeded = rows.filter((r) => r.state === "succeeded").length;`,
      `  const running = rows.filter((r) => r.state === "running").length;`,
      `  console.log("C_RESULT=" + JSON.stringify({ succeeded, running, ids }));`,
      `  await db.destroy();`,
      `  process.exit(succeeded === 3 && running === 0 ? 0 : 1);`,
      `})().catch((e) => { console.log("ERR=" + (e && e.stack || e)); process.exit(3); });`,
    ].join("\n"),
    "utf8",
  );
  try {
    const r = runTsx(probe, {
      MIWO_DATA_DIR: tmp,
      MIWO_ENV: "dev",
      MIWO_PORT: "10599",
      MIWO_HOST: "127.0.0.1",
      MIWO_JWT_SECRET: "x".repeat(48),
    }, API_DIR, 180_000);
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const ok = r.status === 0 && /C_RESULT=.*"succeeded":3/.test(out);
    ok ? pass("C", "C1 sqlite 端到端", "3 条 selftest 全 succeeded、0 条 running（真 worker 循环）") : fail("C", "C1 sqlite 端到端", `exit=${r.status} ${out.slice(-300)}`);

    // C2：事件流成对（start/end 各一次/job）
    if (fs.existsSync(jsonl)) {
      const evs = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const byJob = new Map();
      for (const e of evs) byJob.set(e.jobId, (byJob.get(e.jobId) || 0) + 1);
      const paired = [...byJob.values()].filter((n) => n === 2).length;
      paired === 3 ? pass("C", "C2 事件流 start/end 成对", `${evs.length} 条事件 / 3 个 job 各一对`) : fail("C", "C2 事件流 start/end 成对", `成对 ${paired}/3（事件 ${evs.length} 条）`);
    } else {
      fail("C", "C2 事件流 start/end 成对", "job-selftest.jsonl 不存在 —— 观测不到");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────── D. MySQL 端到端 ─────────────────────────
function groupD() {
  console.log("\n[D] MySQL 端到端");
  if (!MYSQL_ENABLED) {
    const detail = "SKIP（未设 MIWO_TEST_MYSQL=1）—— 本机不启 MySQL，3307 独占；MySQL 全线未实测";
    if (REQUIRE_MYSQL) fail("D", "D1 MySQL 集成测试", `${detail}；--require-mysql 下 SKIP 视为 FAIL`);
    else skip("D", "D1 MySQL 集成测试", detail);
    if (REQUIRE_MYSQL) fail("D", "D2 多进程 chaos", `${detail}；--require-mysql 下 SKIP 视为 FAIL`);
    else skip("D", "D2 多进程 chaos", detail);
    return;
  }
  const r1 = run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/job-mysql-integration.test.ts"], { cwd: API_DIR, env: { MIWO_TEST_MYSQL: "1" } });
  r1.status === 0 ? pass("D", "D1 MySQL 集成测试", "job-mysql-integration 全绿（真连 3307）") : fail("D", "D1 MySQL 集成测试", `exit=${r1.status}`);
  const r2 = run(process.execPath, ["scripts/job-chaos.cjs"], { cwd: API_DIR, env: { MIWO_TEST_MYSQL: "1" } });
  r2.status === 0 ? pass("D", "D2 多进程 chaos", "job-chaos A–E 全绿") : fail("D", "D2 多进程 chaos", `exit=${r2.status}`);
}

// ───────────────────────── E. 门禁 + 既有验收 ─────────────────────────
function groupE() {
  console.log("\n[E] 门禁 + 既有验收");
  const HEAVY = process.env.MIWO_VERIFY1D_SKIP_HEAVY === "1";
  const gates = fs.readdirSync(path.join(ROOT, "tools")).filter((f) => /^check-.*\.cjs$/.test(f)).sort();
  for (const g of gates) {
    const r = run(process.execPath, [path.join("tools", g)]);
    r.status === 0 ? pass("E", `E-gate ${g}`, "EXIT 0") : fail("E", `E-gate ${g}`, `EXIT ${r.status}`);
  }
  const tc = run(process.execPath, [require.resolve("typescript/bin/tsc", { paths: [API_DIR] }), "--noEmit"], { cwd: API_DIR });
  tc.status === 0 ? pass("E", "E2 typecheck", "0 错") : fail("E", "E2 typecheck", `exit=${tc.status}`);

  if (HEAVY) {
    // 自检/调试用（`MIWO_VERIFY1D_SKIP_HEAVY=1`）：跳过 test/verify 这类分钟级子进程，**明确标 SKIP**
    skip("E", "E3 单测全绿", "MIWO_VERIFY1D_SKIP_HEAVY=1（自检模式，故意跳过）");
    skip("E", "E4 六个既有 verify", "MIWO_VERIFY1D_SKIP_HEAVY=1（自检模式，故意跳过）");
    return;
  }

  const vitest = path.join(API_DIR, "node_modules", "vitest", "vitest.mjs");
  // ⚠【review-D F-4】E3 必须用**一次性 dataDir**：旧口径与"另一次并发运行的全量测试"共享
  //   `vitest.config.ts` 里的同一个库（`D:\tmp\miwo-test-data`）⇒ 互相污染（复核轮实测：
  //   并发跑两次各出现 1 failed，独占跑即 584|14，会被误当成真回归）。
  //   现在给 E3 一个 `%TEMP%` 下的唯一目录，跑完**按绝对路径**删（`vitest.config.ts` 允许
  //   `MIWO_DATA_DIR` 覆盖，且**只接受仓库外**的路径 —— 免得有人把测试指到仓库 dev 库）。
  const e3Dir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-verify1d-e3-"));
  let t;
  try {
    t = run(process.execPath, [vitest, "run"], { cwd: API_DIR, timeout: 1_800_000, env: { MIWO_DATA_DIR: e3Dir } });
  } finally {
    fs.rmSync(e3Dir, { recursive: true, force: true });
  }
  const out = `${t.stdout || ""}`;
  const m = /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/.exec(out);
  const failedM = /(\d+) failed/.exec(out);
  const failed = failedM ? Number(failedM[1]) : 0;
  t.status === 0 && m && failed === 0
    ? pass("E", "E3 单测全绿", `${m[1]} passed${m[2] ? ` | ${m[2]} skipped` : ""}，0 failed（一次性 dataDir=${e3Dir}）`)
    : fail("E", "E3 单测全绿", `exit=${t.status} failed=${failed}${m ? ` passed=${m[1]}` : "（计数观测不到）"}`);

  // ⚠ 必须**直跑 `node <脚本>`**，不要 `spawnSync("pnpm.cmd", …)`：Windows 上 `.cmd` 是壳脚本，
  //   `shell: false` 起不来（实测 `EXIT null` = 进程根本没起来）+ `shell: true` 会引入 DEP0190 与参数拼接坑。
  //   命令直接从根 package.json 的 scripts 里解析（单一来源，不手抄第二份）。
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const s of ["verify:phase0", "verify:phase1a", "verify:phase1b", "verify:phase1c", "verify:phase1c-media", "verify:build"]) {
    const cmd = String((rootPkg.scripts || {})[s] || "");
    const m = /^node\s+(.+)$/.exec(cmd);
    if (!m) {
      fail("E", `E4 ${s}`, `package.json 里的 script 不是 \`node …\` 形式：${cmd}`);
      continue;
    }
    const r = run(process.execPath, m[1].split(" ").filter(Boolean), { timeout: 1_800_000 });
    r.status === 0 ? pass("E", `E4 ${s}`, "EXIT 0") : fail("E", `E4 ${s}`, `EXIT ${r.status}`);
  }
}

function main() {
  console.log(`[verify:phase1d] 仓库根 ${ROOT}`);
  console.log(`[verify:phase1d] MySQL 口径：MIWO_TEST_MYSQL=${process.env.MIWO_TEST_MYSQL || "(未设)"}  require-mysql=${REQUIRE_MYSQL}`);
  const t0 = Date.now();
  groupA();
  groupB();
  groupC();
  groupD();
  groupE();
  const nPass = results.filter((r) => r.status === "pass").length;
  const nSkip = results.filter((r) => r.status === "skip").length;
  const nFail = results.filter((r) => r.status === "fail").length;
  console.log(`\n========== Phase 1d 验收摘要：通过 ${nPass} / 跳过 ${nSkip} / 失败 ${nFail}（${((Date.now() - t0) / 1000).toFixed(1)}s）==========`);
  if (nFail) {
    for (const f of results.filter((r) => r.status === "fail")) console.log(`  ✘ [${f.group}] ${f.id} —— ${f.detail}`);
    process.exit(1);
  }
  if (nSkip && REQUIRE_MYSQL) {
    console.log("  ✘ --require-mysql 下不允许出现 SKIP（Ruling 26：永不执行的守卫 = 没有守卫）");
    process.exit(1);
  }
  console.log("Phase 1d 验收通过（MySQL 相关项按上表口径：未实测 / 已实测）");
  process.exit(0);
}

main();
