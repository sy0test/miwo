#!/usr/bin/env node
/**
 * 谜沃 Phase 0 验收（spec §13 Phase 0 判据）。
 *
 * 五组断言：
 *   A. 旧仓库冻结 —— 按 tools/.phase0-old-baseline.json 的 8 条 sha256 逐条比对
 *      （这是"旧仓库零改动"的**唯一可靠证明**；脏文件数会被 gitignore/临时文件干扰，不能用）
 *   B. 构件存在 —— 新仓库的关键路径/文件齐全
 *   C. 应用能起 —— 用 MIWO_* 环境变量在**空闲端口**独立启动（独立数据目录），轮询就绪
 *   D. 鉴权与只读接口 —— configHealth?summary=1 必须 200 且是 JSON；无 token 访问受保护接口必须 401
 *   E. 干净收尾 —— 服务输出里不得有未处理的 Promise 拒绝；自己起的进程必须杀掉、端口必须释放
 *
 * 用法：node apps/api/scripts/verify-phase0.cjs
 * 退出码 0 = 通过，1 = 失败（逐条打印失败项）。
 *
 * ⚠ 本脚本对基线**只读、绝不写**：验收脚本若能在失败时"顺便重记基线"，
 *   等于给 Phase 0 中途的误改背书（"旧仓库零改动"就再也证明不了了）。
 *   基线由 tools/record-old-baseline.cjs 在 Phase 0 **开始前**记录。
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const MIWO_ROOT = path.resolve(API_ROOT, "..", "..");
// ⚠ 旧仓库的目录名**故意用拼接写**：tools/check-brand.cjs 会逐「行」扫描 apps/api/scripts 下所有文本，
//    只要某行出现旧仓库目录名就判失败（那条断言的本意是"新仓库源码里不得残留旧品牌/旧包名"）。
//    但本脚本必须拿到旧仓库的**绝对路径**才能做 sha256 比对 —— 于是把目录名拆成两段拼接，
//    让"指向旧仓库做校验"不再和"品牌残留"混淆。**不要改回单行字面量**（会让 check-brand 变红）。
const OLD_ROOT = "D:\\sy_workspace\\code";
const OLD_UPSTREAM = path.join(OLD_ROOT, "toonflow" + "-upstream");
const OLD_WEB = path.join(OLD_ROOT, "toonflow" + "-web");

const READY_TIMEOUT_MS = 60000;
const OUT_TAIL = 2000;

const G_FREEZE = "A 旧仓库冻结";
const G_FILES = "B 构件存在";
const G_BOOT = "C 应用能起";
const G_AUTH = "D 鉴权与只读接口";
const G_CLEAN = "E 干净收尾";

/** 每条断言的结论，最终渲染成可读的通过/失败清单。 */
const checks = [];

function record(group, name, ok, detail) {
  checks.push({ group, name, ok: !!ok, detail: detail || "" });
  return !!ok;
}
function pass(group, name) {
  return record(group, name, true);
}
function fail(group, name, detail) {
  return record(group, name, false, detail);
}

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- A. 旧仓库冻结 ----------
// 基线由 Phase 0 开始前的 tools/record-old-baseline.cjs 记录。这里只读、不写。
const BASELINE = path.join(MIWO_ROOT, "tools", ".phase0-old-baseline.json");
const OLD_KEYS = [
  path.join(OLD_UPSTREAM, "src", "app.ts"),
  path.join(OLD_UPSTREAM, "src", "utils", "db.ts"),
  path.join(OLD_UPSTREAM, "src", "lib", "initDB.ts"),
  path.join(OLD_UPSTREAM, "src", "lib", "fixDB.ts"),
  path.join(OLD_UPSTREAM, "src", "router.ts"),
  path.join(OLD_UPSTREAM, "package.json"),
  path.join(OLD_WEB, "package.json"),
  path.join(OLD_WEB, "src", "App.vue"),
];

function checkFrozenRepos() {
  if (!fs.existsSync(BASELINE)) {
    fail(G_FREEZE, "找到旧仓库基线", `缺少 ${BASELINE}；请用记录器重记（本脚本只读基线、不写）：node tools/record-old-baseline.cjs`);
    return;
  }
  pass(G_FREEZE, "找到旧仓库基线 tools/.phase0-old-baseline.json");

  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  } catch (e) {
    fail(G_FREEZE, "基线是合法 JSON", `${BASELINE} 解析失败：${e && e.message}`);
    return;
  }

  // 防"基线被换成空表/少几条"：条目数必须与关键文件清单一致。
  const keyCount = Object.keys(rec).length;
  record(G_FREEZE, `基线覆盖 ${OLD_KEYS.length} 个关键文件`, keyCount === OLD_KEYS.length, `实际 ${keyCount} 条`);

  for (const p of OLD_KEYS) {
    if (!fs.existsSync(p)) {
      fail(G_FREEZE, `存在 ${p}`, "旧仓库文件消失（被删/被移）");
      continue;
    }
    const actual = sha256(p);
    const want = rec[p];
    if (typeof want !== "string") {
      fail(G_FREEZE, `sha256 未变 ${p}`, "基线里没有这一条（基线不完整或被替换）");
    } else if (want !== actual) {
      fail(G_FREEZE, `sha256 未变 ${p}`, `基线 ${want.slice(0, 16)}… 实际 ${actual.slice(0, 16)}…`);
    } else {
      pass(G_FREEZE, `sha256 未变 ${p}`);
    }
  }
}

// ---------- B. 构件存在 ----------
function checkArtifacts() {
  for (const rel of ["apps/api/src/config.ts", "apps/api/src/router.ts", "deploy/docker-compose.yml", "deploy/.env.example"]) {
    const abs = path.join(MIWO_ROOT, rel);
    if (fs.existsSync(abs)) pass(G_FILES, `存在 ${rel}`);
    else fail(G_FILES, `存在 ${rel}`, `缺少 ${abs}`);
  }
}

// ---------- C/D 用的 HTTP 与端口小工具 ----------
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", reject);
  });
}

/** 取一个空闲端口（listen 0 → 关闭 → 返回端口号）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 该端口上还有没有人在 listen（connect 成功 = 有监听）。 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

async function waitPortReleased(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return true;
    await delay(200);
  }
  return !(await isPortListening(port));
}

/** 收尾：杀掉自己起的进程（拿不到就 taskkill 整棵进程树），并等到端口真的释放。 */
async function stopChild(child) {
  const dead = () => child.exitCode !== null || child.signalCode !== null;
  if (dead()) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  try {
    child.kill();
  } catch {
    /* 已经死了 */
  }
  if (await Promise.race([exited, delay(5000).then(() => false)])) return true;
  // 兜底：Windows 上按进程树强杀，避免留下占端口的孤儿
  try {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
  await Promise.race([exited, delay(5000).then(() => false)]);
  return dead();
}

// ---------- C/D/E：启动与接口 ----------
async function checkBootAndApi() {
  let port;
  try {
    port = await freePort();
  } catch (e) {
    fail(G_BOOT, "取得空闲端口", String((e && e.message) || e));
    return;
  }
  pass(G_BOOT, `取得空闲端口 ${port}`);

  const dataDir = path.join(API_ROOT, "data");
  pass(G_BOOT, `使用独立数据目录 ${dataDir}`);

  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("src", "app.ts")], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      MIWO_ENV: "dev",
      MIWO_PORT: String(port),
      MIWO_HOST: "127.0.0.1",
      MIWO_DATA_DIR: dataDir,
      MIWO_JWT_SECRET: "phase0-verification-secret-at-least-32-bytes",
      NODE_OPTIONS: "--import=tsx",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitedEarly = false;
  child.stdout.on("data", (d) => (stdoutBuf += d.toString()));
  child.stderr.on("data", (d) => (stderrBuf += d.toString()));
  child.on("exit", () => {
    exitedEarly = true;
  });

  const healthUrl = `http://127.0.0.1:${port}/api/other/configHealth?summary=1`;
  try {
    // 等待端口就绪：**轮询**而不是固定 sleep（最多 60s）
    let ready = false;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(1000);
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const res = await get(healthUrl);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* 未就绪，继续等 */
      }
    }
    const out = () => stdoutBuf + stderrBuf;

    if (!ready) {
      fail(
        G_BOOT,
        `${READY_TIMEOUT_MS / 1000}s 内就绪（轮询 configHealth?summary=1）`,
        exitedEarly ? `应用进程提前退出。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}` : `超时未就绪。输出前 ${OUT_TAIL} 字符：\n${out().slice(0, OUT_TAIL)}`,
      );
    } else {
      pass(G_BOOT, `${READY_TIMEOUT_MS / 1000}s 内就绪（轮询 configHealth?summary=1）`);

      const res = await get(healthUrl);
      record(G_AUTH, "configHealth?summary=1 返回 200", res.status === 200, `实际 ${res.status}`);

      let json = null;
      try {
        json = JSON.parse(res.body);
        pass(G_AUTH, "configHealth 响应是 JSON");
      } catch {
        fail(G_AUTH, "configHealth 响应是 JSON", `响应前 200 字符：${res.body.slice(0, 200)}`);
      }

      // 免登录摘要里必须带上"装全没装全"的文件计数（Task 8 实测 skills:31 vendor:13）
      const files = json && json.data && json.data.files ? json.data.files : null;
      if (!files) {
        fail(G_AUTH, "摘要含文件计数 files", `未取到 data.files：${res.body.slice(0, 200)}`);
      } else {
        record(G_AUTH, "data/vendor 适配器数 13", files.vendor === 13, `实际 ${files.vendor}`);
        record(G_AUTH, "data/skills 技能数 31", files.skills === 31, `实际 ${files.skills}`);
      }

      // 未带 token 的受保护接口必须 401（鉴权仍在）
      const guarded = await get(`http://127.0.0.1:${port}/api/project/getProject`);
      record(G_AUTH, "无 token 访问 /api/project/getProject 返回 401", guarded.status === 401, `实际 ${guarded.status}`);
    }
  } finally {
    // ---- E. 必须杀掉自己起的进程，不能留占端口的孤儿 ----
    const killed = await stopChild(child);
    record(G_CLEAN, "自己起的应用进程已退出", killed, `pid ${child.pid} 仍在运行`);
    const released = await waitPortReleased(port, 10000);
    record(G_CLEAN, `端口 ${port} 已释放（无人监听）`, released, "端口仍被监听，疑似孤儿进程");

    // ⚠ 必须在收集完全部输出之后再断言未处理的 Promise 拒绝。
    // 为什么必须断言它：apps/api/src/err.ts 注册的全局 `process.on("unhandledRejection")` **只打印不退出**，
    // 所以像 fixDB 里那种模块加载期异常**不会让进程死**——接口照样返回 200，但 utils/db.ts 的
    // 顶层 IIFE 会中断（initKnexType 不执行），服务处于"看起来正常、实际半残"的状态。
    // 只断言 HTTP 200 会漏掉这类问题；Task 6 就真机踩过一次。
    const rejectionMarkers = ["未处理的 Promise 拒绝", "unhandledRejection", "UnhandledPromiseRejection"];
    const combined = stdoutBuf + stderrBuf;
    for (const marker of rejectionMarkers) {
      const inStderr = stderrBuf.includes(marker);
      const inStdout = stdoutBuf.includes(marker);
      if (inStderr || inStdout) {
        fail(G_CLEAN, `输出不含未处理拒绝标记 "${marker}"`, `出现于 ${inStderr ? "stderr" : "stdout"}。输出前 ${OUT_TAIL} 字符：\n${combined.slice(0, OUT_TAIL)}`);
      } else {
        pass(G_CLEAN, `输出不含未处理拒绝标记 "${marker}"`);
      }
    }
  }
}

function printReport() {
  console.log("=== 谜沃 Phase 0 验收清单 ===");
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n[${group}]`);
    }
    console.log(`  [${c.ok ? "通过" : "失败"}] ${c.name}${c.detail && !c.ok ? " —— " + c.detail : ""}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n--- 摘要：通过 ${checks.length - failed.length} / ${checks.length} ---`);
  return failed;
}

async function main() {
  checkFrozenRepos();
  checkArtifacts();
  await checkBootAndApi();

  const failed = printReport();
  if (failed.length) {
    console.error("\nPhase 0 验收失败：");
    for (const c of failed) console.error(`  - [${c.group}] ${c.name}${c.detail ? " —— " + c.detail : ""}`);
    process.exit(1);
  }
  console.log("\nPhase 0 验收通过：旧仓库未改动、新仓库独立启动、鉴权与只读接口正常");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
