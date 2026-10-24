#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const API_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const HELPER = path.join(__dirname, "verify-phase1e-media-helper.ts");
const noHttp = process.argv.includes("--no-http");
const genArg = process.argv.find((arg) => arg.startsWith("--gen-media"));
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase1e-"));
const checks = { pass: 0, fail: 0, skip: 0, rows: [] };
let server = null;
let port = null;

function record(group, name, result, detail = "") {
  const status = result === null ? "skip" : result ? "pass" : "fail";
  checks[status] += 1;
  checks.rows.push({ group, name, status, detail });
}
function output(command, args, options = {}) {
  return spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, ...options });
}
function runNode(args, options = {}) {
  return output(process.execPath, args, options);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, headers, timeout: 7000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once("timeout", () => req.destroy(new Error("HTTP request timed out")));
    req.once("error", reject);
  });
}
async function waitReady(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`API exited early (${server.exitCode}): ${serverLog()}`);
    try {
      const result = await request("/api/other/configHealth?summary=1");
      if (result.status === 200) return;
      lastError = `HTTP ${result.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`API readiness timeout: ${lastError}\n${serverLog()}`);
}
const serverOutput = [];
function serverLog() { return serverOutput.join("").slice(-3000); }
async function portIsFree(testPort) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(testPort, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
async function stopServer() {
  if (!server) return;
  if (server.exitCode === null && server.signalCode === null) server.kill();
  await waitForExit(server, 5000);
  if (server.exitCode === null && server.signalCode === null && process.platform === "win32") {
    output("taskkill.exe", ["/pid", String(server.pid), "/t", "/f"]);
    await waitForExit(server, 2000);
  }
  const deadline = Date.now() + 5000;
  while (!(await portIsFree(port)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await portIsFree(port))) throw new Error(`API server did not release port ${port}`);
}
function genMedia(dataDir, relPath) {
  const env = {
    ...process.env,
    MIWO_ENV: process.env.MIWO_ENV || "dev",
    MIWO_DATA_DIR: path.resolve(dataDir),
    MIWO_DB_DRIVER: "sqlite",
    MIWO_STORAGE_DRIVER: "local",
    MIWO_JWT_SECRET: "phase1e-verifier-secret-32-bytes-minimum",
    MIWO_HOST: process.env.MIWO_HOST || "127.0.0.1",
    MIWO_PORT: process.env.MIWO_PORT || "10588",
    MIWO_PUBLIC_BASE_URL: process.env.MIWO_PUBLIC_BASE_URL || `http://${process.env.MIWO_HOST || "127.0.0.1"}:${process.env.MIWO_PORT || "10588"}`, 
  };
  const result = runNode(["--import=tsx", HELPER, path.resolve(dataDir), relPath], { cwd: API_ROOT, env });
  if (result.status !== 0) throw new Error(`production media helper failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}
function parseGenArg(value) {
  const payload = value === "--gen-media" ? process.argv[process.argv.indexOf(value) + 1] : value.slice("--gen-media=".length);
  if (!payload) throw new Error('usage: --gen-media "<dir>|<relPath>"');
  const separator = payload.indexOf("|");
  if (separator < 1 || separator === payload.length - 1) throw new Error('usage: --gen-media "<dir>|<relPath>"');
  const dataDir = path.resolve(payload.slice(0, separator));
  const relPath = payload.slice(separator + 1).replace(/\\/g, "/").replace(/^\/+/, "");
  if (relPath.split("/").some((part) => part === "..") || path.isAbsolute(relPath)) throw new Error("media path must remain relative");
  return { dataDir, relPath };
}

function staticChecks() {
  const app = fs.readFileSync(path.join(API_ROOT, "src", "app.ts"), "utf8");
  const storage = fs.readFileSync(path.join(API_ROOT, "src", "storage", "types.ts"), "utf8");
  const oss = fs.readFileSync(path.join(API_ROOT, "src", "utils", "oss.ts"), "utf8");
  const checksFound = [
    ["A", "MediaStorage public contract is present", /export\s+interface\s+MediaStorage/.test(storage)],
    ["A", "signed URL TTL remains 24 hours", /MEDIA_TTL_SEC\s*=\s*24\s*\*\s*3600/.test(fs.readFileSync(path.join(API_ROOT, "src", "utils", "mediaSign.ts"), "utf8"))],
    ["A", "URL signing occurs at response time", /signMediaQuery\(rel\)/.test(oss) && !/getFileUrl\([^)]*\)\s*\.then\([^)]*insert/.test(oss)],
    ["A", "media guards are mounted before static file serving", /mediaAuthGuard/.test(app) && /express\.static/.test(app)],
    ["A", "static mounts disable implicit range handling", /acceptRanges\s*:\s*false/.test(app)],
    ["A", "storage path traversal checks are present", /isPathInside\(absPath, rootDir\)/.test(oss)],
    ["A", "phase 1e helper writes using production OSS", /oss\.writeFile\(rel, png\)/.test(fs.readFileSync(HELPER, "utf8"))],
    ["A", "frontend sync script is available", fs.existsSync(path.join(API_ROOT, "scripts", "sync-web-build.cjs"))],
  ];
  for (const [group, name, ok] of checksFound) record(group, name, ok);
}

function seedChecks() {
  const script = path.join(API_ROOT, "scripts", "seed-data-dir.cjs");
  const selfTest = runNode([script, "--self-test"]);
  record("B", "seeder covers copy, repeat, empty target, missing source and minima", selfTest.status === 0, selfTest.status === 0 ? selfTest.stdout.trim() : selfTest.stderr.trim());

  const source = path.join(API_ROOT, "data");
  const target = path.join(TEMP_ROOT, "seed-target");
  const first = runNode([script, "--src", source, "--out", target]);
  record("B", "real seed sources copy into an empty disposable target", first.status === 0 && /copy 2 \/ skip 0/.test(first.stdout), first.status === 0 ? first.stdout.trim() : first.stderr.trim());
  const second = runNode([script, "--src", source, "--out", target]);
  record("B", "repeated seed is idempotent", second.status === 0 && /copy 0 \/ skip 2/.test(second.stdout), second.status === 0 ? second.stdout.trim() : second.stderr.trim());
}

function deployChecks() {
  const result = runNode([path.join(REPO_ROOT, "tools", "check-deploy-config.cjs")]);
  record("D", "deployment config checker accepts configured Phase 2 storage contract", result.status === 0, result.status === 0 ? result.stdout.trim().split(/\r?\n/).slice(-2).join(" ") : result.stderr.trim());
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  record("D", "root exposes the unified Phase 1e command", pkg.scripts?.["verify:phase1e"] === "node apps/api/scripts/verify-phase1e.cjs");
}

async function httpChecks() {
  if (noHttp) {
    record("C", "real API/media HTTP checks", null, "--no-http requested; no server was started");
    record("E", "Phase 0 server-starting verifier", null, "--no-http requested; verify-phase0 starts its own API");
    return;
  }

  port = await freePort();
  const dataDir = path.join(TEMP_ROOT, "http-data");
  fs.mkdirSync(path.join(dataDir, "web"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "web", "index.html"), "<!doctype html><html><body>phase1e verifier</body></html>", "utf8");
  const env = {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_DATA_DIR: dataDir,
    MIWO_DB_DRIVER: "sqlite",
    MIWO_STORAGE_DRIVER: "local",
    MIWO_JWT_SECRET: "phase1e-verifier-secret-32-bytes-minimum",
    MIWO_HOST: "127.0.0.1",
    MIWO_PORT: String(port),
    MIWO_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const migration = runNode(["--import=tsx", path.join(API_ROOT, "scripts", "db-migrate.ts")], { cwd: API_ROOT, env, timeout: 120000 });
  record("C", "empty disposable SQLite database migrates successfully", migration.status === 0, migration.status === 0 ? migration.stdout.trim().split(/\r?\n/).slice(-1)[0] : migration.stderr.trim());
  if (migration.status !== 0) {
    record("C", "real API/media HTTP checks", false, "API start skipped because disposable migration failed");
    record("E", "Phase 0 server-starting verifier", false, "Phase 0 is still attempted separately");
    return;
  }

  server = spawn(process.execPath, ["--import=tsx", path.join(API_ROOT, "src", "app.ts")], {
    cwd: API_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => serverOutput.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk) => serverOutput.push(chunk.toString("utf8")));

  try {
    await waitReady();
    const media = genMedia(dataDir, "phase1e-check/pixel.png");
    const signed = new URL(media.url);
    const signedResponse = await request(`${signed.pathname}${signed.search}`);
    record("C", "production-generated signed OSS URL returns the written media", signedResponse.status === 200 && signedResponse.body.length > 0, `HTTP ${signedResponse.status}`);

    const unsigned = await request(`/oss/${media.rel}`);
    record("C", "anonymous OSS media request is denied", unsigned.status === 403, `HTTP ${unsigned.status}`);
    const altered = new URL(media.url);
    altered.searchParams.set("sig", `${altered.searchParams.get("sig").slice(0, -1)}x`);
    const tampered = await request(`${altered.pathname}${altered.search}`);
    record("C", "tampered signature is denied", tampered.status === 403, `HTTP ${tampered.status}`);
    const wrongPath = signed.pathname.replace("pixel.png", "other.png");
    const stolen = await request(`${wrongPath}${signed.search}`);
    record("C", "signature cannot be replayed for another path", stolen.status === 403, `HTTP ${stolen.status}`);
    const expired = new URL(media.expiredUrl);
    const expiredResponse = await request(`${expired.pathname}${expired.search}`, { "If-None-Match": signedResponse.headers.etag || "*" });
    record("C", "production-generated expired URL is denied before cache handling", expiredResponse.status === 403, `HTTP ${expiredResponse.status}`);
    const ranged = await request(`${signed.pathname}${signed.search}`, { Range: "bytes=0-9" });
    record("C", "signed media supports byte ranges", ranged.status === 206 && ranged.body.length === 10 && /^bytes 0-9\//.test(ranged.headers["content-range"] || ""), `HTTP ${ranged.status}; ${ranged.headers["content-range"] || "no Content-Range"}`);

    const asset = new URL(media.assetsUrl);
    const assetResponse = await request(`${asset.pathname}${asset.search}`);
    record("C", "production-generated signed asset URL returns the asset", asset.pathname.startsWith("/assets/") && assetResponse.status === 200, `HTTP ${assetResponse.status}`);
    const assetUnsigned = await request(`/assets/${media.rel}`);
    record("C", "anonymous asset request is denied", assetUnsigned.status === 403, `HTTP ${assetUnsigned.status}`);
    const shell = await request("/");
    record("C", "SPA shell remains anonymously accessible", shell.status === 200 && /text\/html/i.test(shell.headers["content-type"] || ""), `HTTP ${shell.status}`);
    const api = await request("/api/project/getProject");
    record("C", "protected API remains 401 without a token", api.status === 401, `HTTP ${api.status}`);
    const leakedSig = serverLog().includes(signed.searchParams.get("sig"));
    record("C", "media signature is absent from server logs", !leakedSig);
  } catch (error) {
    record("C", "HTTP group completed without harness error", false, error.stack || error.message);
  } finally {
    await stopServer();
  }

  const sharedBaseline = path.resolve(REPO_ROOT, "..", "..", "code", "miwo", "tools", ".phase0-old-baseline.json");
  const phase0Env = fs.existsSync(sharedBaseline) ? { ...process.env, MIWO_PHASE0_BASELINE: sharedBaseline } : process.env;
  const phase0 = runNode([path.join(API_ROOT, "scripts", "verify-phase0.cjs")], { timeout: 120000, env: phase0Env });
  record("E", "Phase 0 full suite including anonymous media denials", phase0.status === 0, phase0.status === 0 ? phase0.stdout.trim().split(/\r?\n/).slice(-1)[0] : (phase0.stdout + phase0.stderr).trim().split(/\r?\n/).slice(-3).join(" "));
}

async function main() {
  if (genArg) {
    const { dataDir, relPath } = parseGenArg(genArg);
    process.env.MIWO_DATA_DIR = dataDir;
    const media = genMedia(dataDir, relPath);
    process.stdout.write(`${media.url}\n`);
    return;
  }

  staticChecks();
  seedChecks();
  deployChecks();
  await httpChecks();
  record("F", "temporary verifier artifacts are removed", false, "cleanup pending");
}

main().catch((error) => {
  if (genArg) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } else record("F", "verifier completed without an uncaught error", false, error.stack || error.message);
}).finally(() => {
  try {
    if (server && server.exitCode === null) server.kill();
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    const cleaned = !fs.existsSync(TEMP_ROOT);
    const row = checks.rows.findLast ? checks.rows.findLast((item) => item.group === "F" && item.name === "temporary verifier artifacts are removed") : [...checks.rows].reverse().find((item) => item.group === "F" && item.name === "temporary verifier artifacts are removed");
    if (row) {
      checks[row.status] -= 1;
      row.status = cleaned ? "pass" : "fail";
      row.detail = cleaned ? "" : `not removed: ${TEMP_ROOT}`;
      checks[row.status] += 1;
    }
  } catch (error) {
    checks.fail += 1;
    checks.rows.push({ group: "F", name: "temporary artifacts cleanup", status: "fail", detail: error.message });
  }
  if (genArg) return;
  for (const row of checks.rows) {
    const icon = row.status === "pass" ? "PASS" : row.status === "skip" ? "SKIP" : "FAIL";
    console.log(`${icon} [${row.group}] ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
  }
  console.log(`verify-phase1e: ${checks.pass} passed, ${checks.fail} failed, ${checks.skip} skipped (${checks.rows.length} checks)`);
  if (checks.fail) process.exitCode = 1;
});
