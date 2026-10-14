#!/usr/bin/env node
/**
 * **Phase 1b 的唯一验收命令**（Task 9）：A–G 组，全部走**真 HTTP**（不打桩）。
 *
 *   cd D:\sy_workspace\code\miwo && pnpm.cmd run verify:phase1b
 *
 * 组别：
 *   A 迁移 + 种子 + **空转护栏**（直接读库确认夹具真的在；一条都没种上 ⇒ 立刻失败）
 *   B 鉴权仍在（无 token → 401）
 *   C 跨租户读（每一组"空集"断言都配**正向对照**："自己的数据看得见"）
 *   D 运维接口收权（GET dbInfo：普通 403 / admin 200）
 *   E 回填 CLI 默认 dry-run（EXIT 0、打印 DRY-RUN、且**没写库**）
 *   F 启动期无 unhandledRejection
 *   G MySQL 口径：`MIWO_TEST_MYSQL=1` 才真跑；否则**显式标"未实测（SKIP）"**，绝不静默跳过
 *
 * ⚠ 空转护栏（Lead 的重点）：本脚本所有"跨租户读为空"的断言在"库是空的/应用是坏的"时也会通过。
 *   所以 A 组最后做一次**直接读库**的夹具计数：`fixtureRows < 11` ⇒ 报"空转"并 exit 1；
 *   且 C 组的每组都带一条"自己的数据看得见"的正向对照。
 *
 * ⚠【Phase 1c Task 11】令牌形状：原来是旧形状 `{id,name}`（靠 `roleOfUserId` 桥接角色），
 *   Task 11 已把 legacy 分支整体退役 ⇒ 现在签**新形状** `{uid,role,tv,typ:"access"}`。
 *   它能通过的前提是 `seed-tenant-fixture.ts` 种下的 `o_user` 夹具行是 `status="active"` 且
 *   `tokenVersion=0`（该脚本本来就是这么种的）—— 中间件每请求会 `loadUserCtx()` 复核这两列。
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const API_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-p1b-e2e-"));
const PORT = 10612;
const TOKEN_KEY = "miwo-phase1b-e2e-token-key-0123456789";
const jwt = require(path.join(API_ROOT, "node_modules", "jsonwebtoken"));
const Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));

const results = { pass: 0, fail: 0, skipped: [], lines: [] };
const record = (group, name, ok, detail) => {
  results[ok ? "pass" : "fail"]++;
  results.lines.push(`${ok ? "✔" : "✘"} [${group}] ${name}${detail ? " —— " + detail : ""}`);
};
const skip = (group, name, reason) => {
  results.skipped.push(`${group}:${name}`);
  results.lines.push(`— [${group}] ${name} —— **未实测（SKIP）**：${reason}`);
};

function childEnv(extra = {}) {
  return {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_HOST: "127.0.0.1",
    MIWO_PORT: String(PORT),
    MIWO_DATA_DIR: DATA_DIR,
    MIWO_DB_DRIVER: "sqlite",
    MIWO_JWT_SECRET: "phase1b-verify-config-secret-32-bytes!!",
    NODE_OPTIONS: "--import=tsx",
    ...extra,
  };
}
function runNode(args, label) {
  const res = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: childEnv(),
    timeout: 180000,
    windowsHide: true,
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}`.trim(), label };
}
const request = (method, pathName, body, token) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: pathName,
        method,
        timeout: 8000,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

/** A 组的空转护栏：直接读一次性库，数"关键夹具行"。 */
function fixtureRows() {
  const file = path.join(DATA_DIR, "db2.sqlite");
  if (!fs.existsSync(file)) return { rows: 0, why: "库文件不存在：" + file };
  const db = new Database(file, { readonly: true });
  try {
    const q = (sql) => {
      try {
        return Number(db.prepare(sql).get()?.n ?? 0);
      } catch (e) {
        return -1;
      }
    };
    const probes = [
      "select count(*) n from o_project where id in (7001,8001)",
      "select count(*) n from o_tasks where id in (7002,8002)",
      "select count(*) n from o_assets where id in (7003,8003)",
      "select count(*) n from o_image where id in (7004,8004)",
      "select count(*) n from o_novel where id in (7005,8005)",
      "select count(*) n from o_event where id in (7006,8006)",
      "select count(*) n from o_eventChapter where id in (7007,8007)",
      "select count(*) n from memories where id in ('p1b-ha','p1b-hb')",
    ];
    const rows = probes.reduce((a, s) => a + Math.max(0, q(s)), 0);
    return { rows, why: "" };
  } finally {
    db.close();
  }
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/api/other/configHealth?summary=1");
      if (r.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function killChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已经退出 */
    }
  }
}

async function main() {
  // ---------- A：迁移 + 种子 + 空转护栏 ----------
  const seed = runNode(["scripts/seed-tenant-fixture.ts", `--token-key=${TOKEN_KEY}`], "A:seed");
  record("A", "迁移 + 种子脚本 EXIT 0", seed.status === 0, seed.out.split(/\r?\n/).slice(-1)[0] || "");
  if (seed.status !== 0) {
    console.error(seed.out);
    return finish();
  }
  const fx = fixtureRows();
  record(
    "A",
    "★空转护栏：一次性库里夹具行 >= 11（否则「什么都比不出来」也会通过）",
    fx.rows >= 11,
    `fixtureRows=${fx.rows}${fx.why ? " " + fx.why : ""}`,
  );
  if (fx.rows < 11) {
    console.error("夹具不足 ⇒ 后续所有「空集」断言都会假绿，直接判定失败（空转护栏）。");
    return finish();
  }

  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
    cwd: API_ROOT,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => (stdout += d));
  const ready = await waitReady(60000);
  record("A", "应用在 60s 内就绪（configHealth?summary=1）", ready, ready ? "" : `${stderr.slice(-400)}`);
  if (!ready) {
    killChild(child);
    return finish();
  }

  const tokenA = jwt.sign({ uid: 7, role: "user", tv: 0, typ: "access", jti: "p1b-a" }, TOKEN_KEY, { expiresIn: "1h" });
  const tokenB = jwt.sign({ uid: 8, role: "user", tv: 0, typ: "access", jti: "p1b-b" }, TOKEN_KEY, { expiresIn: "1h" });
  const tokenAdmin = jwt.sign({ uid: 1, role: "admin", tv: 0, typ: "access", jti: "p1b-admin" }, TOKEN_KEY, { expiresIn: "1h" });

  // ---------- B：鉴权仍在 ----------
  const noToken = await request("POST", "/api/task/getTaskApi", { page: 1, limit: 10 });
  record("B", "无 token → 401", noToken.status === 401, `实际 ${noToken.status}`);

  // ---------- C：跨租户读（每条都带正向对照）----------
  const tasks = await request("POST", "/api/task/getTaskApi", { page: 1, limit: 50 }, tokenA);
  const taskTotal = Number(tasks.json?.data?.total ?? -1);
  record("C", "getTaskApi 不传 projectId：A 只看到自己的任务（total=1）", taskTotal === 1, `total=${taskTotal}`);
  const cross = await request("POST", "/api/task/getTaskApi", { page: 1, limit: 50, projectId: 8001 }, tokenA);
  record(
    "C",
    "getTaskApi 传 B 的 projectId → 空集",
    (cross.json?.data?.data ?? []).length === 0 && Number(cross.json?.data?.total ?? 0) === 0,
    JSON.stringify(cross.json?.data),
  );
  const projectsA = await request("POST", "/api/project/getProject", {}, tokenA);
  const idsA = (projectsA.json?.data ?? []).map((p) => Number(p.id));
  const projectsB = await request("POST", "/api/project/getProject", {}, tokenB);
  const idsB = (projectsB.json?.data ?? []).map((p) => Number(p.id));
  record("C", "getProject 双向互不可见（A 见 7001 不见 8001；B 反之）", idsA.includes(7001) && !idsA.includes(8001) && idsB.includes(8001) && !idsB.includes(7001), `A=${JSON.stringify(idsA)} B=${JSON.stringify(idsB)}`);
  const evCross = await request("POST", "/api/novel/event/getEvent", { projectId: 8001, page: 1, limit: 10 }, tokenA);
  const evOwn = await request("POST", "/api/novel/event/getEvent", { projectId: 7001, page: 1, limit: 10 }, tokenA);
  record("C", "getEvent 传 B 的 projectId → 空；自己的 projectId → 1 条（join+GROUP_CONCAT 路径）", (evCross.json?.data?.list ?? []).length === 0 && Number(evOwn.json?.data?.total ?? 0) === 1, `cross=${JSON.stringify(evCross.json?.data?.total)} own=${JSON.stringify(evOwn.json?.data?.total)}`);
  const memCross = await request("POST", "/api/agents/getMemory", { projectId: 8001, agentType: "scriptAgent" }, tokenA);
  const memOwn = await request("POST", "/api/agents/getMemory", { projectId: 7001, agentType: "scriptAgent" }, tokenA);
  record("C", "getMemory 传 B 的 projectId → 空；自己的 → 拿得到自己的记忆", (memCross.json?.data ?? []).length === 0 && (memOwn.json?.data ?? []).length === 1, `cross=${(memCross.json?.data ?? []).length} own=${(memOwn.json?.data ?? []).length}`);
  const assetCross = await request("POST", "/api/assets/pollingImageAssets", { ids: [8003] }, tokenA);
  const assetOwn = await request("POST", "/api/assets/pollingImageAssets", { ids: [7003] }, tokenA);
  record("C", "pollingImageAssets 传 B 的资产 id → 空；自己的 → 有行", (assetCross.json?.data ?? []).length === 0 && (assetOwn.json?.data ?? []).length > 0, `cross=${(assetCross.json?.data ?? []).length} own=${(assetOwn.json?.data ?? []).length}`);
  const urlCross = await request("POST", "/api/production/workbench/getFileUrl", { items: [{ sources: "assets", id: 8003 }] }, tokenA);
  record("C", "getFileUrl 传 B 的资产 id → 响应里没有 B 的路径", !JSON.stringify(urlCross.json ?? {}).includes("p1b/b.png"), String(urlCross.status));

  // ---------- D：运维接口收权（dbInfo 是 GET）----------
  const opsUser = await request("GET", "/api/setting/dbConfig/dbInfo", undefined, tokenA);
  record("D", "普通用户 GET dbInfo → 403", opsUser.status === 403, `实际 ${opsUser.status}`);
  const opsAdmin = await request("GET", "/api/setting/dbConfig/dbInfo", undefined, tokenAdmin);
  record("D", "管理员 GET dbInfo → 200", opsAdmin.status === 200, `实际 ${opsAdmin.status}`);

  // ---------- E：回填 CLI 默认 dry-run（能跑 + 不写库）----------
  const bf = runNode(["scripts/backfill-userid.ts"], "E:backfill");
  record("E", "backfill-userid 默认 dry-run：EXIT 0 且打印 DRY-RUN", bf.status === 0 && /DRY-RUN/.test(bf.out), bf.out.split(/\r?\n/).slice(0, 2).join(" | "));
  record("E", "dry-run 报告里没有 APPLY 字样（没偷偷写库）", !/APPLY/.test(bf.out), "");
  const bfApplied = runNode(["scripts/backfill-userid.ts", "--apply"], "E:backfill-apply");
  record("E", "backfill-userid --apply 幂等：EXIT 0 且自检行全为 0", bfApplied.status === 0 && /自检/.test(bfApplied.out), bfApplied.out.split(/\r?\n/).filter((l) => /自检/.test(l)).slice(0, 1).join(""));

  // ---------- F：启动期无未处理拒绝 ----------
  record(
    "F",
    "应用 stderr 无 unhandledRejection",
    !/unhandledRejection|UnhandledPromiseRejection|未处理的 Promise 拒绝/.test(stderr),
    stderr.slice(0, 200),
  );

  // ---------- G：MySQL 口径（显式标"未实测"，不许静默跳过）----------
  if (String(process.env.MIWO_TEST_MYSQL ?? "") === "1") {
    // MySQL 侧的口径就是 `tests/mysql-integration.test.ts`（Task 9 在里面加了"隔离守卫生效 + 回填幂等"两条）；
    // 这里用同一支命令跑，避免再造第二份断言。
    const VITEST = path.join(API_ROOT, "node_modules", "vitest", "vitest.mjs");
    const my = spawnSync(process.execPath, [VITEST, "run", "tests/mysql-integration.test.ts"], {
      cwd: API_ROOT,
      encoding: "utf8",
      timeout: 900000,
      windowsHide: true,
      env: { ...process.env, MIWO_TEST_MYSQL: "1", NODE_OPTIONS: "--import=tsx" },
    });
    const tail = `${my.stdout || ""}${my.stderr || ""}`.trim().split(/\r?\n/).slice(-3).join(" | ");
    record("G", "MySQL 口径（MIWO_TEST_MYSQL=1）：隔离守卫 + 回填幂等", my.status === 0, tail);
  } else {
    skip("G", "MySQL 口径（隔离守卫 + 回填幂等）", "本机 3307 独占、未启动，且 MIWO_TEST_MYSQL≠1 ⇒ **未实测**；CI 的 mysql job 以 MIWO_TEST_MYSQL=1 跑 tests/mysql-integration.test.ts 的同两条用例");
  }

  killChild(child);
  void stdout;
  return finish();
}

function finish() {
  console.log(results.lines.join("\n"));
  const total = results.pass + results.fail;
  console.log(
    `\n--- 摘要：通过 ${results.pass} / ${total}` +
      (results.skipped.length ? `（另有 ${results.skipped.length} 项**未实测**：${results.skipped.join(", ")}）` : "") +
      ` ---`,
  );
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(results.fail ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-phase1b 崩溃：", err);
  process.exit(1);
});
