#!/usr/bin/env node
/**
 * 下载 / 校验本地 ASR 模型（spec §5.5；模型文件**不进 git**）。
 *
 * 用法：
 *   node scripts/fetch-asr-model.cjs --model medium --revision <commit> [--out <dir>]
 *   node scripts/fetch-asr-model.cjs --check [--model medium] [--out <dir>]
 *
 * 设计要点（为什么不是一个 curl）：
 *  1. **固定 revision**：模型仓在 HF 上，main 会漂。第一次下载必须显式给 --revision（commit），
 *     下载后写进 manifest.json；之后 --check / 重新下载都以 manifest 里的 revision 为准。
 *     本脚本**不内置猜来的 commit**（写死一个没验证过的 hash 比不写更糟）。
 *  2. **SHA256 以 HF 的 tree API 为准**：lfs.oid 就是文件内容的 sha256，下载后逐文件比对；
 *     manifest 也记下它，--check 完全离线（部署机/CI 不联网也能验）。
 *  3. 模型目录缺省 = MIWO_ASR_MODEL_DIR（与 config.ts 的 asr.modelDir 同源），
 *     再缺省 <MIWO_DATA_DIR>/asr-models。
 *
 * 退出码：0 成功/校验通过；1 校验失败；2 用法或环境错误。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// faster-whisper 官方 CTranslate2 转换仓（scripts 层读 env 是允许的：门禁只扫 apps/api/src）
const REPOS = {
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
  "large-v3": "Systran/faster-whisper-large-v3",
};

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  if (hit) return hit.slice(("--" + name + "=").length);
  const i = process.argv.indexOf("--" + name);
  if (i >= 0) {
    const next = process.argv[i + 1];
    return next && !next.startsWith("--") ? next : "";
  }
  return "";
}

function fail(code, msg) {
  console.error("[fetch-asr-model] " + msg);
  process.exit(code);
}

const model = argOf("model") || process.env.MIWO_ASR_MODEL || "medium";
const outDir =
  argOf("out") ||
  process.env.MIWO_ASR_MODEL_DIR ||
  (process.env.MIWO_DATA_DIR ? path.join(process.env.MIWO_DATA_DIR, "asr-models") : path.join(process.cwd(), "asr-models"));
const checkOnly = process.argv.includes("--check");
const force = process.argv.includes("--force");
const manifestPath = path.join(outDir, model, "manifest.json");
const modelDir = path.join(outDir, model);

if (!REPOS[model]) fail(2, "不支持的模型档位 " + model + "（支持：small / medium / large-v3）");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/** 离线校验：文件齐全、大小/哈希与 manifest 一致。 */
function check() {
  const manifest = readManifest();
  if (!manifest) fail(1, "找不到 manifest：" + manifestPath + "（先用 --revision 下载一次）");
  const problems = [];
  for (const [name, meta] of Object.entries(manifest.files || {})) {
    const file = path.join(modelDir, name);
    if (!fs.existsSync(file)) {
      problems.push("缺文件 " + name);
      continue;
    }
    const size = fs.statSync(file).size;
    if (meta.size != null && size !== meta.size) problems.push(name + " 大小不符（期望 " + meta.size + "，实际 " + size + "）");
    const digest = sha256File(file);
    if (meta.sha256 && digest !== meta.sha256) problems.push(name + " sha256 不符（期望 " + meta.sha256 + "，实际 " + digest + "）");
  }
  if (problems.length) {
    for (const p of problems) console.error("  - " + p);
    fail(1, "模型校验失败（" + problems.length + " 项）：" + modelDir);
  }
  console.log(
    "[fetch-asr-model] 校验通过：" + model + " @ " + (manifest.revision || "?") + "（" + Object.keys(manifest.files).length + " 个文件，目录 " + modelDir + "）"
  );
  return 0;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "miwo-fetch-asr-model" } });
  if (!res.ok) throw new Error("GET " + url + " → " + res.status + " " + res.statusText);
  return await res.json();
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "miwo-fetch-asr-model" } });
  if (!res.ok || !res.body) throw new Error("下载失败 " + url + " → " + res.status);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function main() {
  if (checkOnly) return check();

  const existing = readManifest();
  const revision = argOf("revision") || process.env.MIWO_ASR_MODEL_REVISION || existing?.revision || "";
  if (!revision) {
    fail(
      2,
      "首次下载必须固定 revision（模型仓 main 会漂，不可复现）。例：\n" +
        "  node scripts/fetch-asr-model.cjs --model " + model + " --revision <huggingface commit sha>\n" +
        "（也可用 MIWO_ASR_MODEL_REVISION 环境变量；下载后 revision 会写进 manifest.json）"
    );
  }

  console.log("[fetch-asr-model] " + model + " @ " + revision + " → " + modelDir);
  const treeUrl = "https://huggingface.co/api/models/" + REPOS[model] + "/tree/" + revision + "?recursive=true";
  const tree = await fetchJson(treeUrl);
  const files = (Array.isArray(tree) ? tree : []).filter((e) => e && e.type === "file" && e.path);
  if (!files.length) fail(1, "tree API 没返回任何文件：" + treeUrl);

  const manifestFiles = {};
  for (const entry of files) {
    const dest = path.join(modelDir, entry.path);
    const expected = entry.lfs && entry.lfs.oid ? entry.lfs.oid : null;
    const expectedSize = entry.lfs && entry.lfs.size != null ? Number(entry.lfs.size) : entry.size != null ? Number(entry.size) : null;
    // 已存在且哈希对得上就不重下（构建层缓存友好）
    if (!force && fs.existsSync(dest) && expected && sha256File(dest) === expected) {
      console.log("  = " + entry.path + "（已存在，跳过）");
      manifestFiles[entry.path] = { size: expectedSize, sha256: expected };
      continue;
    }
    const url = "https://huggingface.co/" + REPOS[model] + "/resolve/" + revision + "/" + entry.path;
    console.log("  + " + entry.path + (expectedSize ? "（" + expectedSize + " bytes）" : ""));
    await download(url, dest);
    const digest = sha256File(dest);
    if (expected && digest !== expected) {
      fail(1, entry.path + " sha256 不符（HF tree 期望 " + expected + "，实际 " + digest + "）—— 下载内容被篡改或 revision 漂移");
    }
    manifestFiles[entry.path] = { size: fs.statSync(dest).size, sha256: digest };
  }

  const manifest = { model, repo: REPOS[model], revision, fetchedAt: new Date().toISOString(), files: manifestFiles };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("[fetch-asr-model] 完成：" + Object.keys(manifestFiles).length + " 个文件，manifest " + manifestPath);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => fail(1, e && e.stack ? e.stack : String(e)));
