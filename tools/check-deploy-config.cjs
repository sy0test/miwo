#!/usr/bin/env node
/**
 * 断言 deploy/ 与 .env.example 中出现的 MIWO_* 变量集合，
 * 与 apps/api/src/config.ts 里读取的变量集合一致（双向）。
 * 用法：node tools/check-deploy-config.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const failures = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); return ""; }
  return fs.readFileSync(p, "utf8");
}

const configTs = read("apps/api/src/config.ts");
const envExample = read("deploy/.env.example");
const compose = read("deploy/docker-compose.yml");
const nginx = read("deploy/nginx.conf");

const VAR_RE = /MIWO_[A-Z0-9_]+/g;
const setOf = (text) => new Set(text.match(VAR_RE) ?? []);

const inCode = setOf(configTs);
const inExample = setOf(envExample);
const inCompose = setOf(compose);

// 1) 代码里读取的变量必须都在 .env.example 里有说明
for (const v of inCode) if (!inExample.has(v)) failures.push(`.env.example 缺少 ${v}（config.ts 会读它）`);

// 2) .env.example 里不该有代码不认的变量（拼写漂移）
//    例外：编排专用变量（不进应用代码），在此白名单登记
const COMPOSE_ONLY = new Set(["MIWO_MYSQL_ROOT_PASSWORD", "MIWO_IMAGE_TAG"]);
for (const v of inExample) {
  if (!inCode.has(v) && !COMPOSE_ONLY.has(v)) failures.push(`.env.example 有 ${v}，但 config.ts 不读它（疑似拼写错误）`);
}

// 3) compose 引用的变量必须在 .env.example 里
for (const v of inCompose) if (!inExample.has(v)) failures.push(`docker-compose 引用 ${v}，但 .env.example 没有`);

// 4) 必填项必须在 .env.example 里出现且不能是空的
for (const v of ["MIWO_ENV", "MIWO_PORT", "MIWO_HOST", "MIWO_DATA_DIR", "MIWO_JWT_SECRET"]) {
  const re = new RegExp(`^\\s*${v}\\s*=\\s*(.+)$`, "m");
  const m = envExample.match(re);
  if (!m) failures.push(`.env.example 缺少必填项 ${v}`);
  else if (!m[1].trim()) failures.push(`.env.example 的 ${v} 是空的`);
}

// 5) nginx 必须透传 X-Forwarded-*
for (const h of ["X-Forwarded-For", "X-Forwarded-Proto"]) {
  if (!nginx.includes(h)) failures.push(`deploy/nginx.conf 未透传 ${h}`);
}

// 6) nginx 必须开着 gzip 与 /api、/oss 反代
for (const need of ["gzip on", "location /api", "location /oss"]) {
  if (!nginx.includes(need)) failures.push(`deploy/nginx.conf 缺少 "${need}"`);
}

// 7) YAML 必须可解析
let YAML;
try { YAML = require("yaml"); } catch { failures.push("缺依赖 `yaml`（pnpm.cmd add -D -w yaml）"); }
if (YAML) {
  for (const rel of ["deploy/docker-compose.yml"]) {
    try { YAML.parse(read(rel)); } catch (e) { failures.push(`${rel} YAML 解析失败: ${e.message}`); }
  }
}

if (failures.length) {
  console.error("check-deploy-config 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`check-deploy-config 通过（${inCode.size} 个 MIWO_* 变量一致）`);
