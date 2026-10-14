#!/usr/bin/env node
/**
 * **Phase 1c Task 7 的判别力验收**：媒体移到鉴权之后 + HMAC 签名 URL + Range + 缓存。
 *
 *   cd D:\sy_workspace\code\miwo && node apps/api/scripts/verify-phase1c-media.cjs
 *   node apps/api/scripts/verify-phase1c-media.cjs --app=<app.ts 路径> --port=10613
 *
 * ── 为什么必须"真进程 + 真 HTTP" ──
 * 本 Task 的验收口径是"用户**看得到媒体**、别人**拿不到**"。中间件形状的单测（`tests/media-sign.test.ts`）
 * 证明不了"整条链的装配顺序对不对"（`/oss` 在两处 `authenticate` 之后？SPA 壳还匿名吗？），
 * 所以这里起**真正的 `src/app.ts`**（`node --import=tsx`），打真端口，读真响应头。
 *
 * ── A 组就是 1b-11 的"改前/改后"两端 ──
 * "改前"不是一个记忆里的说法，它由**两条可复核的证据**钉住：
 *   ① `git show <改前提交>:apps/api/src/app.ts` 里 `/oss` 挂载点的原文（老形状：裸 `express.static`，
 *      没有任何守卫，且在 `app.use(authenticate)` **之前**注册）；
 *   ② 一个**按那份老形状装配**的实例（老形状 app.js 在同一份 `oss` 目录上起一个端口）：
 *      匿名 `GET /oss/<文件>` ⇒ **200 + 文件内容**（这条就是漏洞本体）。
 * 然后把同一个请求打到新实例 ⇒ **403**。两端都是**本次运行的原文**，不是引用。
 *
 * 组别：
 *   A 改前/改后两端（老形状 200 vs 新形状 403）+ 猜测路径 + 跨用户
 *   B 签名的四端（正确 200 / 无签名 403 / 篡改 403 / 过期 403）
 *   C Range（206 + Content-Range / 416）与缓存（Cache-Control / ETag / 304 / 过期不走 304）
 *   D 分界依据：SPA 壳匿名 200、`/skills` 匿名 200、`/api/*` 无 token 仍 401
 *   E 错误脱敏（403/404 响应体不含绝对路径/表名/堆栈）+ 签名不进日志
 *   F 装配顺序的源码断言（`/oss` 在 `authenticate` 之后）+ 自证观测
 *
 * 退出码：0 = 全绿；1 = 有失败。**任何一组"观测不到"都算失败**（不能假绿）。
 */
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const API_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");

const argOf = (name, dflt) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  // ⚠ 切片长度必须是 `prefix.length`（含 `=`）：用 `name.length + 3` 会让取到的值**多一个前导 `=`**
  //   ⇒ `Number("=3")` = NaN ⇒ `exp=NaN` ⇒ 守卫 403（实测踩到，A/B/C 三组整片假红）。
  return hit ? hit.slice(prefix.length) : dflt;
};
const APP_TS = path.resolve(argOf("app", path.join(API_ROOT, "src", "app.ts")));
const PORT = Number(argOf("port", "10613"));
/** 老形状对照实例的端口（+1；`--port` 只影响新实例，用户的命令不用改）。 */
const OLD_PORT = PORT + 1;
const TTL_SEC = Number(argOf("ttl", "3")); // 只给"过期后失效"那条用；默认 TTL 是 24h
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534 || !Number.isFinite(TTL_SEC) || TTL_SEC < 1) {
  console.error(`参数不合法：port=${JSON.stringify(argOf("port", "10613"))} ttl=${JSON.stringify(argOf("ttl", "3"))}`);
  process.exit(1);
}
const SECRET = "phase1c-task7-media-verify-secret-32b!";
const SIGN_DOMAIN = "miwo:media:";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-p1c-media-"));
const OSS_DIR = path.join(DATA_DIR, "oss");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const WEB_DIR = path.join(DATA_DIR, "web");

const results = { pass: 0, fail: 0, lines: [] };
const record = (group, name, ok, detail) => {
  results[ok ? "pass" : "fail"]++;
  results.lines.push(`${ok ? "✔" : "✘"} [${group}] ${name}${detail ? " —— " + detail : ""}`);
};
/** 原文块（响应行 + 关键头 + body 片段）：报告要贴的是**实跑原文**，不是复述。 */
const raw = [];
const rawBlock = (title, lines) => raw.push(`----- ${title} -----\n${lines.join("\n")}`);

// ---------- 一次性媒体树 ----------
fs.mkdirSync(path.join(OSS_DIR, "u7"), { recursive: true });
fs.mkdirSync(path.join(OSS_DIR, "u8"), { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(WEB_DIR, { recursive: true });

/** 700 字节确定性字节流：够 `Range: bytes=0-99`（100B）与"不可满足的 Range"两端。 */
function makeBytes(len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * 37 + 11) % 251;
  return b;
}
const OWN_BYTES = makeBytes(700);
const OTHER_BYTES = Buffer.concat([Buffer.from("OTHER-USER-SECRET-"), makeBytes(300)]);
fs.writeFileSync(path.join(OSS_DIR, "u7", "own.bin"), OWN_BYTES);
fs.writeFileSync(path.join(OSS_DIR, "u8", "other.bin"), OTHER_BYTES);
fs.writeFileSync(path.join(ASSETS_DIR, "ending.bin"), makeBytes(64));
fs.writeFileSync(path.join(SKILLS_DIR, "icon.png"), makeBytes(32));
fs.writeFileSync(path.join(WEB_DIR, "index.html"), "<html>miwo shell</html>");
fs.writeFileSync(path.join(WEB_DIR, "app.js"), "console.log('shell');\n");

// ---------- 签名（与 src/utils/mediaSign.ts 同算法，独立实现一遍）----------
/** 域分离：媒体密钥 = HMAC-SHA256(key="miwo:media:"（**作为 HMAC 密钥**）, msg=MIWO_JWT_SECRET)。
 *  ⚠ 与 `src/utils/mediaSign.ts` 的 `mediaSignKey()` 必须逐字一致（两边各自独立实现，互相验证）。 */
const mediaKey = crypto.createHmac("sha256", SIGN_DOMAIN).update(SECRET).digest();
const normalize = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
const sign = (rel, exp) => crypto.createHmac("sha256", mediaKey).update(`${SIGN_DOMAIN}${normalize(rel)}|${exp}`).digest("base64url").slice(0, 43);
const DEFAULT_TTL_SEC = 24 * 3600; // = src/utils/mediaSign.ts 的 MEDIA_TTL_SEC
const query = (rel, ttlSec = DEFAULT_TTL_SEC) => {
  // ⚠ `ttlSec` 必须给默认值：漏传时 `undefined * 1000` = NaN ⇒ `exp=NaN` ⇒ 守卫一律 403
  //   （实测踩到：A/B/C 三组整片假红，而 D 组 200 掩盖了它）。
  const exp = String(Date.now() + ttlSec * 1000);
  if (!/^\d+$/.test(exp)) throw new Error(`签名 exp 非法：${exp}（ttlSec=${ttlSec}）`);
  return `exp=${exp}&sig=${sign(rel, exp)}`;
};

/**
 * 手搓一个 HS256 的**旧形状** JWT（`{id,name}`，无 `typ`）—— 给 D 组"带 Bearer 取媒体"那条用。
 *
 * ⚠ 为什么不用 `jsonwebtoken`：本脚本是 `apps/api/scripts/` 下的 `.cjs`，而 `jsonwebtoken` 在
 *   `apps/api/node_modules` 里（能解析到），但**少一个依赖就少一处"脚本自己坏了"的可能**；
 *   而旧形状的载荷就是两个字段，HS256 就是 base64url(header).base64url(payload).base64url(HMAC)。
 *   ⚠ 载荷**必须没有 `typ`/`tv`**：`verifyLegacyToken` 的判据是"**恰好**是旧形状才认"
 *   （有 `typ` 就走新路径 ⇒ 新路径要查 DB 复核 tokenVersion ⇒ 这条 e2e 不再是"只测鉴权开关"）。
 *   `authenticate` 的 legacy 分支会把 userId 经 `roleOfUserId` 桥接成 role，不读 DB 的 tokenVersion。
 */
function legacyBearerJwt(userId, name, secret) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ id: userId, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// ---------- HTTP ----------
const request = (port, method, pathName, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathName, method, timeout: 8000, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        resolve({ status: res.statusCode, headers: h, body: buf.toString("utf8"), bytes: buf.length, raw: buf });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

/** 一行的"实跑原文"（响应行 + 关心的头 + body 片段）。 */
const asText = (r, keys) =>
  [
    `HTTP ${r.status} (${r.bytes} bytes)`,
    ...(keys || []).filter((k) => r.headers[k] !== undefined).map((k) => `${k}: ${r.headers[k]}`),
    `body: ${JSON.stringify(r.body.length > 220 ? r.body.slice(0, 220) + "…" : r.body)}`,
  ].join("\n");

// ---------- 起/停子进程 ----------
function childEnv(port) {
  return {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_HOST: "127.0.0.1",
    MIWO_PORT: String(port),
    MIWO_DATA_DIR: DATA_DIR,
    MIWO_DB_DRIVER: "sqlite",
    MIWO_JWT_SECRET: SECRET,
    NODE_OPTIONS: "--import=tsx",
  };
}
function spawnTsx(entry, port) {
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", entry], {
    cwd: API_ROOT,
    env: childEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  return { child, out };
}
function killChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
}
async function waitReady(port, timeoutMs, probePath = "/api/other/configHealth?summary=1", want = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request(port, "GET", probePath);
      if (r.status === want) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---------- 老形状对照实例（**按改前那版 app.ts 的挂载形状**：裸 express.static，无守卫）----------
let OLD_EXPRESS_PATH = "";
try {
  OLD_EXPRESS_PATH = require.resolve("express", { paths: [API_ROOT] });
} catch (err) {
  console.error("无法从 apps/api 解析 express（老形状对照实例起不来）:", String(err));
  process.exit(1);
}
const OLD_APP_JS = `
// ⚠ express 用**绝对盘符路径** require（不是 file:// URL —— CJS 的 require 不认 URL 形态，实测
//   "Cannot find module 'file:///D:/…'"；也不是裸 specifier —— 这个临时脚本在 %TEMP% 下，
//   裸 specifier 会沿着 %TEMP% 的父目录找 node_modules 而找不到）。
const express = require(${JSON.stringify(OLD_EXPRESS_PATH)});
const app = express();
const ossDir = ${JSON.stringify(OSS_DIR)};
const assetsDir = ${JSON.stringify(ASSETS_DIR)};
const skillsDir = ${JSON.stringify(SKILLS_DIR)};
const webDir = ${JSON.stringify(WEB_DIR)};
app.use("/oss", express.static(ossDir, { acceptRanges: false }));
app.use("/skills", (req, res, next) => (/\\\\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end()), express.static(skillsDir, { acceptRanges: false }));
app.use("/assets", express.static(assetsDir, { acceptRanges: false }));
app.use(express.static(webDir, { acceptRanges: false }));
app.listen(${OLD_PORT}, "127.0.0.1", () => console.log("old-shape listening"));
`;
const OLD_APP_FILE = path.join(DATA_DIR, "old-shape-app.cjs");

// ---------- 装配顺序的源码断言 ----------
function sourceOrderFacts() {
  const text = fs.readFileSync(APP_TS, "utf8");
  const lines = text.split(/\r?\n/);
  const idx = (re) => lines.findIndex((l) => re.test(l));
  /**
   * 找 `target.use(` 之后 **≤8 行内、且不跨过该调用的右括号**出现某个挂载点字面量的那一行。
   *
   * ⚠ 为什么不能只搜 `"/oss"` 字样：实测它会命中 JSDoc 里那句
   *   `` `/oss` 与 `/assets` 的入口守卫 ``（行号比 authenticate 还小 ⇒ 断言**假红**）。
   * ⚠ 为什么不能只搜 `target.use("/oss"`：`/oss` 那一条是**多行**调用
   *   （`target.use(\n "/oss",\n mediaAuthGuard, …`）⇒ 同一行匹配不到（实测 oss=-1）。
   * ⚠ 为什么还要判"右括号"：`/assets` 是**单行**调用，紧随其后 2 行就是 `/skills` —— 不划边界的话
   *   `mountAt('"/skills"')` 会命中 **assets 那一行**（实测 skills 与 assets 同号）。
   */
  const mountAt = (literal) => {
    for (let i = 0; i < lines.length; i++) {
      if (!/target\.use\(/.test(lines[i])) continue;
      let depth = 0;
      for (let j = i; j < Math.min(lines.length, i + 8); j++) {
        if (lines[j].includes(literal)) return i;
        for (const ch of lines[j]) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        if (depth <= 0) break; // 这一条 `target.use(...)` 已闭合
      }
    }
    return -1;
  };
  return {
    auth: idx(/app\.use\("\/api",\s*\(req, res, next\)\s*=>\s*authenticate/),
    oss: mountAt('"/oss"'),
    assets: mountAt('"/assets"'),
    skills: mountAt('"/skills"'),
    limiter: idx(/app\.use\(apiLimiter\)/),
    mount: idx(/mountStaticAssets\(app\)/),
    files: lines.length,
  };
}

async function main() {
  // ================= 0. 夹具自证（"什么都比不出来"也会通过 ⇒ 必须先证夹具在）=================
  const ownLen = fs.statSync(path.join(OSS_DIR, "u7", "own.bin")).size;
  record(
    "0",
    "★ 空转护栏：一次性媒体树上真有文件（否则后面所有 200/403 都可能是「文件不存在」的 404）",
    ownLen === OWN_BYTES.length && fs.existsSync(path.join(OSS_DIR, "u8", "other.bin")),
    `own.bin=${ownLen}B other.bin=${OTHER_BYTES.length}B`,
  );

  // ================= 老形状（"改前"那端）=================
  fs.writeFileSync(OLD_APP_FILE, OLD_APP_JS, "utf8");
  // ⚠ 老形状实例用**干净环境**起（去掉 NODE_OPTIONS=--import=tsx）：它是个纯 CJS 最小 express，
  //   带上 tsx 的 loader 会让 `require("express")` 走 ESM 解析器并 ERR_MODULE_NOT_FOUND（实测踩到）。
  const oldEnv = { ...childEnv(OLD_PORT) };
  delete oldEnv.NODE_OPTIONS;
  const oldInst = spawn(process.execPath, [OLD_APP_FILE], { env: oldEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let oldStderr = "";
  let oldStdout = "";
  oldInst.stderr.on("data", (d) => (oldStderr += d));
  oldInst.stdout.on("data", (d) => (oldStdout += d));
  // ⚠ 老形状实例**没有** `/api/*`（它只是个静态文件服务）⇒ 就绪探针要打它真有的那条路径：
  //   匿名 `GET /oss/u8/other.bin` == 200 **本身就是**"改前可取"那一端的第一份证据。
  const oldReady = await waitReady(OLD_PORT, 20000, "/oss/u8/other.bin");

  // ================= 新形状（真 app.ts）=================
  const inst = spawnTsx(path.relative(API_ROOT, APP_TS), PORT);
  const ready = await waitReady(PORT, 60000);

  try {
    record("F", "真 `src/app.ts` 进程在 60s 内就绪（configHealth?summary=1 ⇒ 200）", ready, ready ? `app=${path.relative(REPO_ROOT, APP_TS)}` : inst.out.stderr.slice(-400));
    record("F", "老形状对照实例就绪（同一份 oss 目录、无任何守卫）", oldReady, oldReady ? `port=${OLD_PORT}` : oldStderr.slice(-300));
    if (!ready || !oldReady) return;

    // ================= A. 改前/改后两端（1b-11 的原始漏洞）=================
    // ① 改前源码原文（git：Task 7 的实现提交之前那版）
    const prevRev = spawnSync("git", ["rev-parse", "af3cffe^"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
    const oldSrc = spawnSync("git", ["show", `${prevRev}:apps/api/src/app.ts`], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).stdout;
    const oldSrcLines = oldSrc.split(/\r?\n/);
    const oldOssAt = oldSrcLines.findIndex((l) => /app\.use\(\s*$/.test(l) && /"\/oss"/.test(oldSrcLines[oldSrcLines.indexOf(l) + 1] || ""));
    const oldAuthAt = oldSrcLines.findIndex((l) => /app\.use\(authenticate\)/.test(l));
    const oldStaticAt = oldSrcLines.findIndex((l) => /express\.static\(ossDir, \{ acceptRanges: false \}\)/.test(l));
    record(
      "A",
      `★ 改前源码原文（git ${prevRev.slice(0, 7)}:apps/api/src/app.ts）：\`/oss\` 是**裸 express.static**（无守卫）且注册在 authenticate **之前**`,
      oldOssAt >= 0 && oldStaticAt > 0 && oldAuthAt > oldStaticAt,
      `oss 挂载行=${oldOssAt + 1}、acceptRanges:false 行=${oldStaticAt + 1}、app.use(authenticate) 行=${oldAuthAt + 1}（行号大 = 更晚注册）`,
    );
    rawBlock(
      `A-① 改前源码（git show ${prevRev.slice(0, 7)}:apps/api/src/app.ts，节选）`,
      oldSrcLines.filter((l, i) => i + 1 >= oldOssAt + 1 && i + 1 <= oldOssAt + 3).concat(["（…）", `L${oldAuthAt + 1}: ${oldSrcLines[oldAuthAt]}`]),
    );

    const oldGuess = await request(OLD_PORT, "GET", "/oss/u8/other.bin");
    record(
      "A",
      "★ 改前（老形状实例）：匿名 `GET /oss/u8/other.bin`（**猜测路径、零凭据**）⇒ 200 且吐出别人的文件内容",
      oldGuess.status === 200 && oldGuess.body.includes("OTHER-USER-SECRET-"),
      `HTTP ${oldGuess.status}`,
    );
    rawBlock("A-② 改前两端之『改前可取』（老形状实例，无凭据）", [asText(oldGuess, ["content-type", "content-length", "accept-ranges"])]);

    const newGuess = await request(PORT, "GET", "/oss/u8/other.bin");
    record(
      "A",
      "★★ 改后（真 app.ts）：**同一个请求** ⇒ 403（1b-11 的原始漏洞已堵）",
      newGuess.status === 403,
      `HTTP ${newGuess.status}`,
    );
    rawBlock("A-③ 改后两端之『改后不可取』（真 app.ts，无凭据）", [asText(newGuess, ["content-type", "cache-control"])]);

    // ② A 不能拿 B 的媒体（真 HTTP 两端）：A 自己的 200 + B 的对象被拒
    const aSigned = query("u7/own.bin");
    const own = await request(PORT, "GET", `/oss/u7/own.bin?${aSigned}`);
    record("A", "★ A 自己的媒体（带 A 的签名）⇒ 200 且内容正确（正向对照，防「永远拒绝」的假绿）", own.status === 200 && own.bytes === OWN_BYTES.length, `HTTP ${own.status} ${own.bytes}B`);
    const stolen = await request(PORT, "GET", `/oss/u8/other.bin?${aSigned}`);
    record("A", "★ 把 A 的签名贴到 B 的路径上 ⇒ 403（签名覆盖路径）", stolen.status === 403, `HTTP ${stolen.status}`);
    rawBlock("A-④ 跨用户两端（同一把 A 的签名，换路径就失效）", [asText(own, ["content-length", "cache-control"]), asText(stolen, ["content-type"])]);

    // ================= B. 签名的四端 =================
    const good = query("u7/own.bin");
    const bGood = await request(PORT, "GET", `/oss/u7/own.bin?${good}`);
    record("B", "合法签名 ⇒ 200（内容长度一致）", bGood.status === 200 && bGood.bytes === OWN_BYTES.length, `HTTP ${bGood.status} ${bGood.bytes}B`);

    const bNone = await request(PORT, "GET", "/oss/u7/own.bin");
    record("B", "无签名 ⇒ 403", bNone.status === 403, `HTTP ${bNone.status}`);

    const expForTamper = String(Date.now() + 3600_000);
    const sigForTamper = sign("u7/own.bin", expForTamper);
    const flipped = (sigForTamper[0] === "A" ? "B" : "A") + sigForTamper.slice(1);
    const bTampered = await request(PORT, "GET", `/oss/u7/own.bin?exp=${expForTamper}&sig=${flipped}`);
    record("B", "★ 篡改签名（改一个字符，长度不变）⇒ 403", bTampered.status === 403, `HTTP ${bTampered.status}`);

    const past = String(Date.now() - 1000);
    const bExpired = await request(PORT, "GET", `/oss/u7/own.bin?exp=${past}&sig=${sign("u7/own.bin", past)}`);
    record("B", "★ 过期（exp 在过去，签名按旧 exp 算）⇒ 403", bExpired.status === 403, `HTTP ${bExpired.status}`);

    // ---------- B-⑤ 非 ASCII sig（Phase 1c Task 10 修的**可远程触发 500**）----------
    // 改前：`verifyMediaSig` 用 `String.length`（UTF-16 码元）比长度，而 `crypto.timingSafeEqual`
    //   比的是 **Buffer 字节长度** ⇒ 43 个字符 / 45 字节的 sig **绕过**长度检查 ⇒ `timingSafeEqual`
    //   抛 `RangeError: Input buffers must have the same byte length` ⇒ 守卫里没有 try/catch
    //   ⇒ 冒到错误处理器 ⇒ **HTTP 500**。`sig` 是攻击者完全可控的 query 参数，且这是每张图都走的热路径。
    // 改后：两把尺子都对齐到 UTF-8 字节数 + 整段 try/catch ⇒ **403**。
    // ⚠ 本组用 `encodeURIComponent` 把非 ASCII 送出去（否则请求行里的裸非 ASCII 字节会被 Node 拒绝）。
    const nonAsciiSig = "A".repeat(42) + "€"; // 43 个字符 / 45 字节 —— 改前正是这个形状抛 RangeError
    const nonAsciiExp = String(Date.now() + 3600_000);
    const bNonAscii = await request(
      PORT,
      "GET",
      `/oss/u7/own.bin?exp=${nonAsciiExp}&sig=${encodeURIComponent(nonAsciiSig)}`,
    );
    record(
      "B",
      "★★ 非 ASCII sig（43 字符 / 45 字节）⇒ **403**（改前是 **500**：timingSafeEqual 抛 RangeError 冒到错误处理器）",
      bNonAscii.status === 403,
      `HTTP ${bNonAscii.status}${bNonAscii.status === 500 ? " ← 500 = 改前的症状，必须修掉" : ""}`,
    );
    // 反向对照：同一路径的**合法 ASCII** 签名仍必须 200（否则上面那条只是"整条守卫坏了/永远 403"）
    const asciiControl = await request(PORT, "GET", `/oss/u7/own.bin?${query("u7/own.bin")}`);
    record(
      "B",
      "★ 反向对照：同一路径的合法 ASCII 签名 ⇒ 200（证明上面那条不是「守卫整个失效」）",
      asciiControl.status === 200,
      `HTTP ${asciiControl.status}`,
    );

    // 短 TTL 的"真过期"：签一个 3 秒有效的链接，先 200，等它过期再打 ⇒ 必须 403
    const shortLived = query("u7/own.bin", TTL_SEC);
    const before = await request(PORT, "GET", `/oss/u7/own.bin?${shortLived}`);
    await new Promise((r) => setTimeout(r, TTL_SEC * 1000 + 1200));
    const after = await request(PORT, "GET", `/oss/u7/own.bin?${shortLived}`);
    record(
      "B",
      `★★ 过期后失效（真时钟，不注入）：TTL=${TTL_SEC}s 的链接 ${TTL_SEC + 1.2}s 后 ⇒ 403（过期前是 200）`,
      before.status === 200 && after.status === 403,
      `过期前 ${before.status} → 过期后 ${after.status}`,
    );
    rawBlock(
      "B 组原文（合法 / 无签名 / 篡改 / 过期 / 真过期）",
      [
        "① 合法签名：" + asText(bGood, ["cache-control", "etag", "content-length"]).split("\n")[0],
        "② 无签名：" + asText(bNone, ["content-type"]),
        "③ 篡改签名：" + asText(bTampered, ["content-type"]),
        "④ 过期(exp 在过去)：" + asText(bExpired, ["content-type"]),
        `⑤ 真过期：过期前 HTTP ${before.status} → ${TTL_SEC + 1.2}s 后 HTTP ${after.status}`,
      ],
    );

    // ================= C. Range 与缓存 =================
    const cq = query("u7/own.bin");
    const ranged = await request(PORT, "GET", `/oss/u7/own.bin?${cq}`, { Range: "bytes=0-99" });
    const wantRange = `bytes 0-99/${OWN_BYTES.length}`;
    record(
      "C",
      "★★ Range: bytes=0-99 ⇒ 206 + Content-Range 长度正确（Tier 0 #8；旧实现 acceptRanges:false 只回 200 全量）",
      ranged.status === 206 && ranged.headers["content-range"] === wantRange && ranged.bytes === 100,
      `HTTP ${ranged.status} content-range=${ranged.headers["content-range"]} body=${ranged.bytes}B`,
    );
    const badRange = await request(PORT, "GET", `/oss/u7/own.bin?${cq}`, { Range: "bytes=999999-1000000" });
    record("C", "★ 不可满足的 Range ⇒ 416（+ `bytes */长度`）", badRange.status === 416 && badRange.headers["content-range"] === `bytes */${OWN_BYTES.length}`, `HTTP ${badRange.status} content-range=${badRange.headers["content-range"]}`);
    rawBlock("C-① Range 两端原文", [asText(ranged, ["content-range", "accept-ranges", "content-length"]), asText(badRange, ["content-range"])]);

    const cached = await request(PORT, "GET", `/oss/u7/own.bin?${cq}`);
    const cc = cached.headers["cache-control"] || "";
    const etag = cached.headers["etag"];
    record(
      "C",
      "★ 缓存头：Cache-Control 含 max-age=3600、**不含 immutable**、且有 ETag（签名 URL 会过期 ⇒ 不能声明 immutable）",
      /max-age=3600/.test(cc) && !/immutable/.test(cc) && Boolean(etag),
      `cache-control=${cc} etag=${etag}`,
    );
    const notModified = await request(PORT, "GET", `/oss/u7/own.bin?${cq}`, { "If-None-Match": String(etag) });
    const staleExp = String(Date.now() - 1000);
    const stale304 = await request(PORT, "GET", `/oss/u7/own.bin?exp=${staleExp}&sig=${sign("u7/own.bin", staleExp)}`, { "If-None-Match": String(etag) });
    record(
      "C",
      "★★ 「签名 TTL 与缓存共存」：合法签名 + If-None-Match ⇒ 304；**过期签名 + 同一个 If-None-Match ⇒ 403（不是 304）**",
      notModified.status === 304 && stale304.status === 403,
      `304=${notModified.status}（${notModified.bytes}B body）、过期+INM=${stale304.status}`,
    );
    rawBlock("C-② 缓存两端原文（max-age 1h < 签名 TTL 24h，所以缓存永远不会长过签名寿命）", [
      asText(cached, ["cache-control", "etag", "last-modified"]),
      `带 If-None-Match: ${etag} ⇒ ` + asText(notModified, ["etag"]).split("\n")[0],
      `过期签名 + 同一个 If-None-Match ⇒ ` + asText(stale304, ["content-type"]).split("\n")[0],
    ]);

    // ================= D. 三档访问口径的分界 =================
    const shell = await request(PORT, "GET", "/index.html");
    const shellJs = await request(PORT, "GET", "/app.js");
    const rootPath = await request(PORT, "GET", "/");
    record(
      "D",
      "★ 前端外壳**匿名可访问**：`/`、`/index.html`、`/app.js` 全部 200（否则用户连登录页都打不开）",
      shell.status === 200 && shellJs.status === 200 && shell.body.includes("miwo shell"),
      `/=${rootPath.status} /index.html=${shell.status} /app.js=${shellJs.status}`,
    );
    const skills = await request(PORT, "GET", "/skills/icon.png");
    const skillsBad = await request(PORT, "GET", "/skills/readme.md");
    record(
      "D",
      "★ `/skills` 保持公开（匿名 200），非图片扩展名仍 403（原有行为不回退）",
      skills.status === 200 && skillsBad.status === 403,
      `icon.png=${skills.status} readme.md=${skillsBad.status}`,
    );
    const api = await request(PORT, "GET", "/api/project/getProject");
    record("D", "★ `/api/*` 的鉴权语义未变：无 token ⇒ 401（不是 403、更不是 200）", api.status === 401, `HTTP ${api.status}`);
    const assetsSigned = await request(PORT, "GET", `/assets/ending.bin?${query("ending.bin")}`);
    const assetsUnsigned = await request(PORT, "GET", "/assets/ending.bin");
    record(
      "D",
      "★ `/assets` 与 `/oss` 同一口径：合法签名 200、无签名 403（用户产物也不许裸奔）",
      assetsSigned.status === 200 && assetsUnsigned.status === 403,
      `签名=${assetsSigned.status} 无签名=${assetsUnsigned.status}`,
    );
    rawBlock("D 组分界原文", [
      asText(rootPath, ["content-type"]),
      asText(shell, ["content-type", "cache-control"]),
      asText(skills, ["content-type"]),
      asText(skillsBad, ["content-type"]),
      asText(api, ["content-type"]),
      asText(assetsSigned, ["content-length"]),
      asText(assetsUnsigned, ["content-type"]),
    ]);

    // ---------- D-② 带 Bearer 取媒体（Phase 1c Task 10 修的"文档与实现不符"）----------
    // 改前：`authenticate` 只挂 `/api` ⇒ `req.ctx` 在 `/oss` 上永远 undefined ⇒
    //   守卫里"已有 ctx 就放行"那条分支**永远走不到** ⇒ **带 Bearer 取媒体一律 403**，
    //   而 `app.ts` 的挂载表、`mediaSign.ts` 注释、报告、本脚本**四处都宣称 Bearer 可用**。
    // 现在：`/oss`、`/assets` 之前挂了 `optionalMediaAuth`（有 Authorization 就建 ctx，没有就 next()）。
    // ⚠ 两端都必须有：带 Bearer **无签名** ⇒ 200；无 Bearer **无签名** ⇒ 403。
    //   只测 200 的话，"守卫整个失效"也会绿；只测 403 的话，这条修复本身测不到。
    const bearer = `Bearer ${legacyBearerJwt(7, "u7", SECRET)}`;
    const ossBearer = await request(PORT, "GET", "/oss/u7/own.bin", { Authorization: bearer });
    const assetsBearer = await request(PORT, "GET", "/assets/ending.bin", { Authorization: bearer });
    record(
      "D",
      "★★ 带 Bearer 取媒体（**无签名**）⇒ 200：`/oss` 与 `/assets` 两端都可达（Task 10 修的分支曾永远走不到）",
      ossBearer.status === 200 && ossBearer.bytes === OWN_BYTES.length && assetsBearer.status === 200,
      `/oss HTTP ${ossBearer.status} (${ossBearer.bytes}B)、/assets HTTP ${assetsBearer.status}`,
    );
    const ossNoCred = await request(PORT, "GET", "/oss/u7/own.bin");
    record(
      "D",
      "★ 反向对照：同一个请求**不带** Bearer、也不带签名 ⇒ 403（否则上面那条可能只是『守卫失效了』）",
      ossNoCred.status === 403,
      `HTTP ${ossNoCred.status}`,
    );
    const ossBadBearer = await request(PORT, "GET", "/oss/u7/own.bin", { Authorization: "Bearer not-a-jwt" });
    record(
      "D",
      "★ 坏 Bearer ⇒ 401（**不静默降级成匿名**）：『令牌坏了』必须区别于『没带令牌』，否则前端不知道该刷新还是该重登",
      ossBadBearer.status === 401,
      `HTTP ${ossBadBearer.status}`,
    );
    // 自证观测（Ruling 243）：Bearer 那一条必须**真的带着 Authorization 头**打出去过 ——
    // 否则"200"可能只是"守卫没在跑"。进程日志里 morgan 不打印头，所以这里用"三态齐备"作自证：
    // 200 / 403 / 401 三种结果**互不相同**，只有"分支真的按凭据分流"才可能同时出现。
    record(
      "D",
      "★ 自证观测：Bearer 有/无/坏 三种输入得到**三个不同**的状态码（200 / 403 / 401）—— 观测不到就是没分流",
      new Set([ossBearer.status, ossNoCred.status, ossBadBearer.status]).size === 3,
      `bearer=${ossBearer.status} 无凭据=${ossNoCred.status} 坏 bearer=${ossBadBearer.status}`,
    );
    rawBlock("D-② 带 Bearer 取媒体两端原文", [
      `带 Bearer（无签名）GET /oss/u7/own.bin ⇒ ` + asText(ossBearer, ["content-length", "cache-control"]).split("\n")[0],
      `带 Bearer（无签名）GET /assets/ending.bin ⇒ ` + asText(assetsBearer, ["content-length"]).split("\n")[0],
      `无 Bearer 无签名 GET /oss/u7/own.bin ⇒ ` + asText(ossNoCred, ["content-type"]).split("\n")[0],
      `坏 Bearer GET /oss/u7/own.bin ⇒ ` + asText(ossBadBearer, ["content-type"]).split("\n")[0],
    ]);

    // ================= E. 错误脱敏 + 签名不进日志 =================
    const leak403 = await request(PORT, "GET", "/oss/u7/own.bin");
    const leak404 = await request(PORT, "GET", `/oss/u7/no-such-file.bin?${query("u7/no-such-file.bin")}`);
    const bodies = `${leak403.body}\n${leak404.body}`;
    const absPath = DATA_DIR.replace(/\\/g, "\\\\");
    record(
      "E",
      "★ 失败响应脱敏：403/404 的响应体不含数据目录绝对路径 / 盘符 / 表名（o_setting 等）/ 堆栈",
      !new RegExp(absPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(bodies) &&
        !/[A-Za-z]:[\\/]/.test(bodies) &&
        !/o_setting|o_user|oss\\|\bat \w/.test(bodies),
      `403 body=${JSON.stringify(leak403.body)} / 404 body=${JSON.stringify(leak404.body)}`,
    );
    rawBlock("E-① 失败响应原文（脱敏）", [asText(leak403, ["content-type"]), asText(leak404, ["content-type"])]);

    const logs = `${inst.out.stdout}\n${inst.out.stderr}`;
    const anySig = /sig=[A-Za-z0-9_-]{20,}/.test(logs);
    record(
      "E",
      "★★ 签名不进日志：真进程 stdout/stderr 里**没有** `sig=<值>`（只有 `sig=***`）—— 且观测到进程确实打了请求日志",
      !anySig && /GET \/oss\//.test(logs),
      anySig ? "日志里出现了完整签名！" : `日志行数=${logs.split(/\r?\n/).length}，含 GET /oss/ 行=${/GET \/oss\//.test(logs)}`,
    );
    rawBlock(
      "E-② 进程日志原文（节选：只看 /oss 行）",
      logs
        .split(/\r?\n/)
        .filter((l) => /\/oss\//.test(l))
        .slice(0, 6)
        .map((l) => l.trim()),
    );

    // ================= F. 装配顺序的源码断言 =================
    const f = sourceOrderFacts();
    record(
      "F",
      "★★ 静态资源**在鉴权之后**：`mountStaticAssets(app)` 的调用行 > `authenticate` 挂载行 > `apiLimiter` 行",
      f.auth > 0 && f.mount > f.auth && f.limiter > 0 && f.limiter < f.auth,
      `apiLimiter=${f.limiter + 1} authenticate=${f.auth + 1} mountStaticAssets(app)=${f.mount + 1}（共 ${f.files} 行）`,
    );
    record(
      "F",
      "★ `mountStaticAssets` 内部的三个挂载点顺序：`/oss` → `/assets`（都要守卫）→ `/skills`（公开）；三者都在函数体内",
      f.oss > 0 && f.assets > f.oss && f.skills > f.assets,
      `oss=${f.oss + 1} assets=${f.assets + 1} skills=${f.skills + 1}`,
    );
    // 自证观测（Ruling 243 口径）：这些行号必须真的取到了 —— 取不到就说明源码断言没跑起来
    record(
      "F",
      "★ 自证观测：上面每个行号都 > 0（取不到 = 断言空转 ⇒ 直接判失败）",
      f.limiter > 0 && f.auth > 0 && f.oss > 0 && f.assets > 0 && f.skills > 0 && f.mount > 0,
      `limiter=${f.limiter} auth=${f.auth} oss=${f.oss} assets=${f.assets} skills=${f.skills} mount=${f.mount}`,
    );
    record("F", "老形状对照实例 stderr 为空（它只是一个最小 express，不该报错）", oldStderr.trim() === "", oldStderr.trim().slice(0, 200));
    const keyLines = [f.limiter, f.auth, f.mount, f.oss, f.assets, f.skills];
    rawBlock(
      "F-① 装配顺序原文（src/app.ts 关键行）",
      require("fs").readFileSync(APP_TS, "utf8").split(/\r?\n/).filter((_l, i) => keyLines.includes(i)).map((l, i) => `L${keyLines[i] + 1}: ${l.trim()}`),
    );
  } finally {
    killChild(inst.child);
    killChild(oldInst);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

function finish(code) {
  console.log(results.lines.join("\n"));
  console.log(`\n--- 摘要：通过 ${results.pass} / ${results.pass + results.fail}（失败 ${results.fail}） ---`);
  // 失败时**总是**打印原文（否则人只看到"✘"没法定位）；`--raw` 时全绿也打印
  // （报告要贴的"两端口原文"就靠它：`node … --raw > 报告附录`）。
  if (results.fail || process.argv.includes("--raw")) {
    console.log("\n下面是本轮的**实跑原文**（报告直接引用这一段）：\n\n" + raw.join("\n\n"));
  }
  process.exit(code ?? (results.fail ? 1 : 0));
}

main()
  .then(() => finish())
  .catch((err) => {
    console.error("verify-phase1c-media 崩溃：", err);
    finish(1);
  });
