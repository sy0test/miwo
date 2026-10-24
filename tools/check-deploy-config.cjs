#!/usr/bin/env node
/**
 * 断言 deploy/ 与 env 模板不漂移（Task 10 + 修复轮 1 + Phase 1e Task 03）。
 * 用法：node tools/check-deploy-config.cjs
 *
 * 断言清单（任一失败即 exit 1，逐条打印原因）：
 *  1) apps/api/src/config.ts 读取的每个 MIWO_* 至少在一个模板里被**真实赋值**（非注释行）——F4；
 *  2) 模板里声明的 MIWO_* 名字必须被 config.ts 读取（防拼写漂移），编排专用变量走 COMPOSE_ONLY 白名单；
 *  3) docker-compose 引用的每个 MIWO_* 必须在 deploy/.env.example 里真实赋值；
 *  4) 5 个必填项在 deploy/.env.example 里真实赋值且非空；
 *  5) deploy/nginx.conf **按 location 切块**后逐块断言（位置无关）——F11；
 *     并逐处断言 `proxy_pass http://<host>:<port>` 的 port == MIWO_PORT、host == 127.0.0.1 —— F3；
 *     另：`/oss` 的 Range 必须是**真实指令** `proxy_set_header Range $http_range;`（裸子串 "Range" 会被
 *     If-Range 行误满足）—— Phase 0 ledger N2；
 *  6) 容器拓扑自洽：api 必须存在「宿主机 nginx 连得上」的可达路径 —— F1；
 *  7) deploy/Dockerfile：存在、被 compose 的 build 引用、基础镜像 22.12 <= v < 25（**上下界都查** ——
 *     Phase 0 ledger N4b）、`CMD`/`WORKDIR` 指向 data/serve/app.js、有一行**真实指令**（非注释）
 *     `COPY … .npmrc`（Phase 0 ledger N4a）；
 *  8) systemd 单元的 ExecStart 指向真实产物 data/serve/（不得再出现 dist/）—— F5；
 *     8b) worker 单元是**真单元**（Phase 1d）：ExecStart/WorkingDirectory/KillSignal/TimeoutStopSec(>25s)、
 *         不得写"占位"，且 `src/worker.ts` 与 `build.ts` 的 entry/outfile 必须同时在；
 *     8c) compose 的 `worker` 服务：与 api 同镜像/同 build/同 env、command 指向 worker.js、
 *         network_mode=host、不得有 ports、不得新增 MIWO_*；
 *     8d) `/assets` **有意不反代**（Phase 1c 未处置项 N4：会遮蔽 SPA 产物目录）—— 静默新增即红；
 *  9) 证书目录不进版本库（.gitignore 规则 + git 索引复查）—— F7；
 * 10) docker-compose.yml 可被 YAML 解析；
 * 11) nginx server 的静态 root == deploy/.env.example 的 MIWO_DATA_DIR + /web，且 systemd 使用文档化环境文件。
 *
 * ⚠ 为什么"真实赋值"必须是行级的（F4 的教训）：只做全文子串/变量名统计时，
 *   把 `MIWO_DB_HOST=mysql` **整行注释掉**、或把 `MIWO_STORAGE_DRIVER=local` 注释掉，
 *   旧脚本依然 0 failures —— 而 prod 下这会让进程启动即抛 ConfigError（假绿）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const failures = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { failures.push(`缺文件: ${rel}`); return ""; }
  return fs.readFileSync(p, "utf8");
}

/**
 * 行级解析 env 模板：
 *  - real：非注释行的 `NAME=值`（允许 `export ` 前缀）→ "该文件真的设置了它"
 *  - declared：real ∪ 注释形式 `# NAME=...`（只用于拼写漂移检测）
 * ⚠ 只有"行首就是赋值"才算赋值；正文/注释里提到变量名（哪怕后面跟着 =）不算。
 */
function parseEnvTemplate(text) {
  const real = new Map();
  const declared = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^(?:export\s+)?(MIWO_[A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) {
      real.set(m[1], m[2].trim());
      declared.add(m[1]);
      continue;
    }
    m = line.match(/^#+\s*(?:export\s+)?(MIWO_[A-Z0-9_]+)\s*=/);
    if (m) declared.add(m[1]);
  }
  return { real, declared };
}

function unquote(v) {
  const s = String(v ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 按 `location <path> { ... }` 切块（花括号配平），返回 Map<path, 块内文本>。 */
function parseNginxLocations(text) {
  const blocks = new Map();
  const re = /location\s+(\/\S*)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      i += 1;
    }
    blocks.set(m[1], text.slice(re.lastIndex, i - 1));
  }
  return blocks;
}

function parseNginxServerBlocks(text) {
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      i += 1;
    }
    blocks.push(text.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return blocks;
}

const configTs = read("apps/api/src/config.ts");
const storageConfigTs = read("apps/api/src/storage/config.ts");
const nginx = read("deploy/nginx.conf");
const composeText = read("deploy/docker-compose.yml");
const dockerfile = read("deploy/Dockerfile");
const deployEnv = parseEnvTemplate(read("deploy/.env.example"));
const apiEnv = parseEnvTemplate(read("apps/api/.env.example"));
const templates = [
  { rel: "deploy/.env.example", real: deployEnv.real, declared: deployEnv.declared },
  { rel: "apps/api/.env.example", real: apiEnv.real, declared: apiEnv.declared },
];

const inCode = new Set(`${configTs}\n${storageConfigTs}`.match(/MIWO_[A-Z0-9_]+/g) ?? []);
// ⚠ 只认 `${...}` 插值（注释里写 `MIWO_DB_*` 这类说明文字不是"引用"）
const inCompose = new Set([...composeText.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));

// 1) config.ts 读取的变量必须至少在一个模板里被真实赋值
for (const v of [...inCode].sort()) {
  const where = templates.filter((t) => t.real.has(v)).map((t) => t.rel);
  if (!where.length) {
    failures.push(
      `config.ts 读取 ${v}，但没有任何模板**真实赋值**它（注释掉的行不算）：` +
        templates.map((t) => t.rel).join(" / "),
    );
  }
}

// 2) 模板里声明的变量名必须被代码读取（拼写漂移）；编排专用变量登记在白名单
const COMPOSE_ONLY = new Set(["MIWO_IMAGE_TAG"]);
for (const t of templates) {
  for (const v of [...t.declared].sort()) {
    if (!inCode.has(v) && !COMPOSE_ONLY.has(v)) {
      failures.push(`${t.rel} 声明了 ${v}，但 config.ts 不读它（疑似拼写错误）；确为编排专用请登记到本脚本 COMPOSE_ONLY`);
    }
  }
}

// 3) compose 引用的变量必须在 deploy/.env.example 里真实赋值
for (const v of [...inCompose].sort()) {
  if (!deployEnv.real.has(v)) {
    failures.push(`docker-compose 引用 ${v}，但 deploy/.env.example 没有**真实赋值**它（注释掉的行不算）`);
  }
}

// 4) 必填项必须真实赋值且非空
for (const v of ["MIWO_ENV", "MIWO_PORT", "MIWO_HOST", "MIWO_DATA_DIR", "MIWO_JWT_SECRET"]) {
  if (!deployEnv.real.has(v)) failures.push(`deploy/.env.example 缺少必填项 ${v}（必须是真实赋值行）`);
  else if (!unquote(deployEnv.real.get(v))) failures.push(`deploy/.env.example 的 ${v} 是空的`);
}

// 5) nginx：逐处 proxy_pass 的端口 == MIWO_PORT、主机 == 127.0.0.1（F3），并按块断言（F11）
// ⚠ 先剥掉整行 `#` 注释：注释里的示例（例如文件头那句"共 3 处 proxy_pass ..."）不是配置；
//   反过来这也让块内断言更强 —— 把某条 `proxy_set_header` **注释掉**同样算失败。
const nginxCode = nginx.replace(/^[ \t]*#.*$/gm, "");
const port = unquote(deployEnv.real.get("MIWO_PORT"));
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  failures.push(`deploy/.env.example 的 MIWO_PORT 不是 1..65535 的整数，实际 "${port}"`);
}
const proxied = [...nginxCode.matchAll(/proxy_pass\s+http:\/\/([^:/\s;]+):(\d+)/g)].map((m) => ({ host: m[1], port: m[2] }));
if (proxied.length < 3) {
  failures.push(`deploy/nginx.conf 里 proxy_pass 只有 ${proxied.length} 处（期望 /api、/oss、/socket.io 共 >=3 处）`);
}
for (const p of proxied) {
  if (p.port !== port) {
    failures.push(
      `deploy/nginx.conf 的 proxy_pass http://${p.host}:${p.port} 与 deploy/.env.example 的 MIWO_PORT=${port} 不一致` +
        `（改 MIWO_PORT 必须同步本文件全部 ${proxied.length} 处，否则反代全部打偏 → 502，而旧脚本会全绿）`,
    );
  }
  if (p.host !== "127.0.0.1") {
    failures.push(
      `deploy/nginx.conf 的 proxy_pass 主机是 "${p.host}"，应为 127.0.0.1：` +
        `nginx 跑在宿主机上，而 prod 下后端只监听回环（compose 服务名在宿主机上不可解析）`,
    );
  }
}

const nginxBlocks = parseNginxLocations(nginxCode);
function assertInBlock(prefix, needles) {
  const blk = nginxBlocks.get(prefix);
  if (!blk) { failures.push(`deploy/nginx.conf 缺少 location ${prefix} 块`); return; }
  for (const n of needles) {
    if (!blk.includes(n)) failures.push(`deploy/nginx.conf 的 location ${prefix} 块内缺少 "${n}"（本断言按块作用域检查，别处出现不算）`);
  }
}
assertInBlock("/api", ["proxy_pass", "X-Real-IP", "X-Forwarded-For", "X-Forwarded-Proto"]);
// N2（Phase 0 ledger）：原断言用子串 `"Range"`，而**同一块里的 `if-range` 行**就能满足它
//   （`proxy_set_header If-Range $http_if_range;` 里含 "Range" 的子串 "Range"）⇒ 把真正的
//   `proxy_set_header Range $http_range;` 删掉后断言**照样绿**，症状是"视频拖动进度条失效"。
//   修法：锚到**真实指令形态**（不再接受子串），并把 If-Range 也锚住。
assertInBlock("/oss", ["proxy_pass", "X-Forwarded-For", "X-Forwarded-Proto", "If-Range", "proxy_buffering off"]);
{
  const blk = nginxBlocks.get("/oss");
  if (blk && !/proxy_set_header\s+Range\s+\$http_range\s*;/i.test(blk)) {
    failures.push('deploy/nginx.conf 的 /oss 块必须写 `proxy_set_header Range $http_range;`（只查子串 "Range" 会被 If-Range 行误满足）');
  }
}
assertInBlock("/socket.io", ["proxy_pass", "Upgrade", "Connection"]);
if (!/gzip\s+on\s*;/.test(nginxCode)) failures.push('deploy/nginx.conf 缺少 "gzip on;"');

const dataDir = unquote(deployEnv.real.get("MIWO_DATA_DIR"));
if (!dataDir) {
  failures.push("deploy/.env.example 的 MIWO_DATA_DIR 没有真实赋值：nginx 的静态根无法与之绑定");
} else {
  const unitText = read("deploy/systemd/miwo-api.service");
  const envFile = unitText.match(/^EnvironmentFile=(\S+)\s*$/m);
  if (!envFile || envFile[1] !== "/etc/miwo/env") {
    failures.push("deploy/systemd/miwo-api.service 必须从 /etc/miwo/env 读取部署环境");
  }
  const readme = read("deploy/README.md");
  if (!readme.includes("install -m 600 deploy/.env.example /etc/miwo/env")) {
    failures.push("deploy/README.md 必须说明 deploy/.env.example 是 /etc/miwo/env 的模板来源");
  }
  const expectedRoot = path.posix.join(dataDir.replace(/\\/g, "/"), "web");
  const roots = parseNginxServerBlocks(nginxCode)
    .flatMap((block) => [...block.matchAll(/^\s*root\s+([^;]+);\s*$/gm)].map((m) => m[1].trim()));
  if (!roots.length) {
    failures.push("deploy/nginx.conf 的 server 块里没有 root 指令（静态站点必须有 root）");
  } else {
    for (const root of roots) {
      if (root !== expectedRoot) {
        failures.push(`deploy/nginx.conf 的 root 是 "${root}"，期望 "${expectedRoot}"（= MIWO_DATA_DIR + /web）`);
      }
    }
  }
}

// 6) 拓扑自洽（F1）：api 必须存在宿主机 nginx 连得上的可达路径
let YAML;
try { YAML = require("yaml"); } catch { failures.push("缺依赖 `yaml`（pnpm.cmd add -D -w yaml）"); }
let compose = null;
if (YAML && composeText) {
  try { compose = YAML.parse(composeText); } catch (e) { failures.push(`deploy/docker-compose.yml YAML 解析失败: ${e.message}`); }
}
const services = compose && typeof compose === "object" && compose.services ? compose.services : {};
const api = services.api;
if (!api) {
  failures.push("deploy/docker-compose.yml 缺少 api 服务");
} else {
  const netMode = String(api.network_mode ?? "").trim();
  const sharedNetns = services.nginx && String(services.nginx.network_mode ?? "").replace(/\s+/g, "") === "service:api";
  if (netMode !== "host" && !sharedNetns) {
    failures.push(
      "api 没有任何「宿主机 nginx 连得上」的可达路径（F1 部署阻断）：MIWO_ENV=prod 下 config.ts:84-86 强制 MIWO_HOST=127.0.0.1，" +
        "容器内 api 只绑容器回环 → compose 的 ports 发布 / expose 服务名都连不上。" +
        '请写 network_mode: host（宿主机 nginx 直连 127.0.0.1:MIWO_PORT），或让 nginx 服务共享 api 的网络命名空间（nginx 写 network_mode: "service:api"）',
    );
  }
  if (netMode === "host" && api.ports) {
    failures.push("api 同时写了 network_mode: host 与 ports：docker compose 会直接报错（端口发布对绑回环的进程本来就无效）");
  }

  // Docker 的静态站点由宿主机 nginx 读取；应用数据卷必须是同一路径的宿主机 bind mount。
  const apiCmd = JSON.stringify(api.command ?? "");
  if (!/scripts\/seed-data-dir\.cjs/.test(apiCmd)) {
    failures.push("deploy/docker-compose.yml 的 api command 缺少 scripts/seed-data-dir.cjs 启动前播种");
  }
  if (!/cp -a \/app\/apps\/api\/data\/web\/.+MIWO_DATA_DIR/.test(apiCmd)) {
    failures.push("api command 必须把镜像内的前端静态文件同步到 MIWO_DATA_DIR/web，供宿主机 nginx 读取");
  }
  if (!/exec\s+node data\/serve\/app\.js/.test(apiCmd)) {
    failures.push("api 的 command 必须最终 `exec node data/serve/app.js`（否则 sh 会占在 PID 1，docker stop 的信号走不到 node）");
  }
  const volumeMount = (api.volumes || []).map(String).find((volume) => volume.includes("MIWO_DATA_DIR"));
  const envDataDir = String(api.environment?.MIWO_DATA_DIR ?? "");
  if (!volumeMount || !envDataDir || volumeMount !== "${MIWO_DATA_DIR}:${MIWO_DATA_DIR}") {
    failures.push(
      `api 的卷必须把宿主机 MIWO_DATA_DIR bind mount 到相同容器路径（实际挂载 "${volumeMount || "无"}"，MIWO_DATA_DIR="${envDataDir}"），这样 1Panel nginx 可读取 web 静态目录`,
    );
  }
}
const mysql = services.mysql;
if (mysql) {
  failures.push("docker-compose.yml 不应再创建 mysql 服务：部署使用 1Panel 独立 MySQL");
}
for (const name of ["api", "worker"]) {
  if (services[name]?.depends_on?.mysql) {
    failures.push(`${name} 不应 depends_on Compose mysql；数据库由 1Panel 管理`);
  }
}

// 7) Dockerfile（F2）
if (dockerfile) {
  // 逐个 FROM 检查外部基础镜像；`FROM base AS build` 这类**内部阶段引用**跳过（阶段名按出现顺序登记）。
  const stageNames = new Set();
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)];
  if (!froms.length) failures.push("deploy/Dockerfile 里没有 FROM");
  for (const m of froms) {
    const img = m[1];
    const alias = m[2];
    if (stageNames.has(img.toLowerCase())) {
      if (alias) stageNames.add(alias.toLowerCase());
      continue;
    }
    const mm = img.match(/^node:(\d+)(?:\.(\d+))?/);
    if (!mm) {
      failures.push(`deploy/Dockerfile 的 FROM ${img} 不是 node 镜像（本项目要求 Node >=22.12）`);
    } else {
      const major = Number(mm[1]);
      const minor = mm[2] === undefined ? -1 : Number(mm[2]);
      if (minor < 0) {
        failures.push(`deploy/Dockerfile 的 FROM ${img} 未写次版本号，无法证明满足 engines ">=22.12 <25"（请写 node:22.12-...）`);
      } else if (major < 22 || (major === 22 && minor < 12)) {
        failures.push(`deploy/Dockerfile 的 FROM ${img} 低于 engines 要求的 Node >=22.12`);
      } else if (major >= 25) {
        // N4b（Phase 0 ledger）：engines 是 ">=22.12 <25"，只查下限会让 node:25+ 的镜像溜过
        //   （`node:25.x` 在 22.12 之上 ⇒ 旧断言全绿），而 25.x 从未验证过。
        failures.push(`deploy/Dockerfile 的 FROM ${img} 超出 engines 的上界（要求 <25）`);
      }
    }
    if (alias) stageNames.add(alias.toLowerCase());
  }
  if (!/^CMD\s+\["node",\s*"data\/serve\/app\.js"\]\s*$/m.test(dockerfile)) {
    failures.push('deploy/Dockerfile 的 CMD 必须是 ["node","data/serve/app.js"]（唯一真实产物，见 apps/api/scripts/build.ts:44）');
  }
  if (!/^WORKDIR\s+\/app\/apps\/api\s*$/m.test(dockerfile)) {
    failures.push("deploy/Dockerfile 的最终 WORKDIR 必须是 /app/apps/api（与 `node data/serve/app.js` 的相对路径、systemd 的 WorkingDirectory 同口径）");
  }
  // N4a（Phase 0 ledger）：原断言 `/COPY[^\n]*\.npmrc/` 会被**注释行**满足
  //   （`# COPY package.json … .npmrc`）⇒ 把真实那行删掉、只在注释里留一句，门禁照样绿，
  //   而构建就不跑 prebuild（产物里是陈旧的 router.ts）。修法：只认**真实指令行**（不以 # 开头）。
  {
    const hasNpmrcCopy = dockerfile.split(/\r?\n/).some((l) => /^\s*COPY\b/.test(l) && l.includes(".npmrc"));
    if (!hasNpmrcCopy) {
      failures.push("deploy/Dockerfile 必须有一行真实的 `COPY … .npmrc`（注释行不算）：缺它构建不跑 prebuild（router.ts 会陈旧）");
    }
  }
  if (!/^COPY --from=build \/app\/apps\/api\/scripts\/seed-data-dir\.cjs \.\/apps\/api\/scripts\/seed-data-dir\.cjs\s*$/m.test(dockerfile)) {
    failures.push("deploy/Dockerfile 必须把 scripts/seed-data-dir.cjs 复制进最终镜像（api command 启动时调用它）");
  }
  if (!/^COPY --from=build \/app\/apps\/api\/data\/web \.\/apps\/api\/data\/web\s*$/m.test(dockerfile)) {
    failures.push("deploy/Dockerfile 必须把前端静态目录复制进最终镜像，供 api 启动时同步给宿主机 nginx");
  }
  const webBuild = dockerfile.search(/^RUN pnpm --filter @miwo\/web run build-only \\\s*$/m);
  // 前端构建与后端构建**分成两条 RUN**（前端在前）：这样只改 app/api 源码时前端层仍命中缓存。
  // 早期是「COPY apps/api → COPY apps/web → 一条 RUN 跑前端+后端」，改一行后端也要重跑 10+ 分钟前端打包。
  const webSync = dockerfile.search(/^ && node apps\/api\/scripts\/sync-web-build\.cjs --src apps\/web\/dist --out apps\/api\/data\/web\s*$/m);
  const apiBuild = dockerfile.search(/^(?:RUN pnpm --filter @miwo\/api build| && pnpm --filter @miwo\/api build)\s*$/m);
  if (!/^COPY apps\/web apps\/web\s*$/m.test(dockerfile) || webBuild < 0 || webSync < 0 || apiBuild < 0 || webBuild > webSync || webSync > apiBuild) {
    failures.push("deploy/Dockerfile 的 build 阶段必须按序复制 apps/web 源码、构建 SPA、同步到 apps/api/data/web，再构建 API，避免依赖 Git 忽略的预生成文件");
  }
  const runtimeStage = dockerfile.split(/^FROM .* AS runtime\s*$/m)[1] || "";
  if (!/apt-get install[^\n]*ffmpeg/.test(runtimeStage)) {
    failures.push("deploy/Dockerfile 的 runtime 阶段必须安装 ffmpeg（同时提供 ffprobe）");
  }
  const packageManager = JSON.parse(read("package.json")).packageManager;
  const corepackInstall = dockerfile.indexOf("npm install --global corepack@0.31.0");
  const corepackEnable = dockerfile.indexOf("corepack enable", corepackInstall);
  const corepackPrepare = dockerfile.indexOf(`corepack prepare ${packageManager} --activate`, corepackEnable);
  if (corepackInstall < 0 || corepackEnable < corepackInstall || corepackPrepare < corepackEnable) {
    failures.push("deploy/Dockerfile 必须先安装含当前 pnpm 签名 key 的固定版 Corepack，再启用并准备 package.json 锁定的 pnpm");
  }
  const apiBuildConfig = services.api?.build;
  if (apiBuildConfig?.context !== ".." || apiBuildConfig?.dockerfile !== "deploy/Dockerfile") {
    failures.push("deploy/docker-compose.yml 的 api build context/Dockerfile 与根目录 .dockerignore 的位置契约不一致");
  }
  const dockerignore = read(".dockerignore");
  if (!/^apps\/api\/data\/web\/?\s*$/m.test(dockerignore)) {
    failures.push("仓库根 .dockerignore 必须排除 apps/api/data/web；该目录由 Docker build 阶段从 apps/web 源码生成");
  }
  const dockerignoreRules = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const envRules = ["**/.env", "**/.env.*", "!**/.env.example"];
  if (dockerignoreRules.slice(-envRules.length).join("\n") !== envRules.join("\n")) {
    failures.push("仓库根 .dockerignore 的最终三条规则必须按序排除真实 .env/变体并只放行 .env.example，防止后续规则覆盖");
  }
  if (fs.existsSync(path.join(ROOT, "deploy/.dockerignore"))) {
    failures.push("deploy/.dockerignore 不会用于根 context；请移除失效副本并维护仓库根 .dockerignore");
  }
  const deployReadme = read("deploy/README.md");
  if (/真实数据在 MySQL 卷里|宿主机回环上发布的 MySQL/.test(deployReadme)) {
    failures.push("deploy/README.md 仍包含 Compose 管理 MySQL 的旧部署/备份说明；数据库由 1Panel 管理");
  }

  /**
   * 7b) `COPY <src>… <dest>` 的宿主机源**必须存在**（Phase 1c Task 8 新增）。
   *
   * ── 为什么必须是一条独立断言 ──
   * Task 8 把供应商适配器从 `apps/api/data/vendor`（沙箱执行的资产）搬成编译期内置的
   * `apps/api/src/vendors/*.ts`，于是 `COPY --from=build /app/apps/api/data/vendor ./apps/api/data/vendor`
   * 变成了**指向已删除目录**的行。它的失败**不在本机**：开发机没有 Docker，`pnpm run build` 全绿、
   * 所有单测全绿，而 `docker compose build` 会在 COPY 那一步以
   * `failed to compute cache key: "/app/apps/api/data/vendor" not found` 直接失败 —— 也就是
   * "只在 CI/生产才炸"。这条断言把那个失败**搬到本机**（同一类判据，见 F2/F5 的动机）。
   *
   * ── 判据的边界（**实测改过两版，这一版的边界是被红端逼出来的**）──
   *   · 只校验**从构建上下文拷**的 COPY，即**不带 `--from=`** 的：`COPY --from=<stage> …` 的源在
   *     **别的 stage 的镜像**里（`/app/apps/api/data/vendor` 这种以 `/app/` 开头的路径在本机根本
   *     不该存在），拿本机文件系统去证明它存在只会**恒假红**。
   *     ⚠ 这是第一版的错：它把 `--from=` 的行整条 `continue` 掉了，于是**被删掉的那个
   *     `COPY --from=build …/data/vendor` 也一起被跳过** ⇒ 断言永远绿（假绿，比假红更坏）。
   *     正确口径 = 不跳过这些行，而是**只查它们的源是不是以 `/app/` 开头**（镜像内路径），
   *     不以 `/app/` 开头的（例如将来有人写 `COPY --from=build apps/api/data/vendor …`）
   *     一律按上下文路径校验。
   *   · 支持反斜杠续行（`COPY a \\\n b dest`）。
   *   · 每个上下文源 token 必须对应**仓库相对路径**上的一个真实文件/目录（相对 Dockerfile 的
   *     build context，即仓库根，与 `api.build.context: ..` 同口径）。
   *   · `--chown=`/`--chmod=` 之类的 flag 跳过；`["json","form"]` 形态顶层不做（本仓库用 shell 形态）。
   */
  {
    // 先拼**逻辑行**：把 `\` 续行接起来（否则带续行的 COPY 只会被看到第一段）
    const logicalLines = [];
    for (const raw of dockerfile.split(/\r?\n/)) {
      if (/\\\s*$/.test(raw) && logicalLines.length && logicalLines[logicalLines.length - 1].continued) {
        logicalLines[logicalLines.length - 1].text += " " + raw.replace(/\\\s*$/, "");
        logicalLines[logicalLines.length - 1].continued = /\\\s*$/.test(raw);
      } else {
        logicalLines.push({ text: raw, continued: /\\\s*$/.test(raw) });
      }
    }
    let checkedSources = 0;
    let checkedInImageSources = 0;
    let ctxOk = 0;
    const inImageSkipped = [];
    for (const { text } of logicalLines) {
      const m = text.match(/^\s*COPY\s+(.*)$/i);
      if (!m) continue;
      const tokens = m[1]
        .split(/\s+/)
        .filter((t) => t && !t.startsWith("--"));
      if (tokens.length < 2) {
        failures.push(`deploy/Dockerfile 的 \`${text.trim()}\` 不是合法的 COPY（至少要一个源与一个目标）`);
        continue;
      }
      const sources = tokens.slice(0, -1);
      for (const src of sources) {
        // `--from=` 的源在镜像里 ⇒ 只认「绝对镜像路径」这个形状（`/app/...`），本机不校验；
        // 其余一律按**构建上下文**（仓库相对）校验 —— 这样"从别的 stage 拷一个上下文目录"
        // 这种搬家写法照样会被抓住。
        const inImage = /--from=/i.test(m[1]) && src.startsWith("/");
        if (inImage) {
          checkedInImageSources += 1;
          inImageSkipped.push(src);
          continue;
        }
        checkedSources += 1;
        const abs = path.join(ROOT, src);
        if (fs.existsSync(abs)) ctxOk += 1;
        else {
          failures.push(
            `deploy/Dockerfile 的 COPY 源不存在：${src}（宿主机上 ${abs} 找不到）。` +
              `指向已删除的目录会让 \`docker compose build\` 在 COPY 步失败 —— 而本机没有 Docker，` +
              `这条**只会在容器里暴露**。请同步删掉该行，或改指真实路径。`,
          );
        }
      }
    }
    // 自证观测（Ruling 243 口径）：两边都没解析到 ⇒ 说明解析器失效，不许当"干净"
    if (checkedSources === 0 && checkedInImageSources === 0) {
      failures.push("deploy/Dockerfile 的 COPY 源解析没跑起来（0 个源被检查）—— 本断言等于不存在，请核对解析规则");
    }
    console.log(
      `   · Dockerfile COPY 源校验：构建上下文 ${checkedSources} 个（缺 ${checkedSources - ctxOk} 个）+ 镜像内 ${checkedInImageSources} 个（跳过，无法在本机证明）`,
    );
    console.log(`     - 跳过的镜像内源：${inImageSkipped.join(", ") || "（无）"}`);
  }
}
if (api && !api.build) {
  failures.push("deploy/docker-compose.yml 的 api 服务缺少 build:（否则 docker compose build 没有构建对象，up 会去 registry 拉不存在的 miwo-api 镜像）");
} else if (api && api.build) {
  const b = api.build;
  const ctx = typeof b === "string" ? b : b.context;
  const df = typeof b === "string" ? "Dockerfile" : b.dockerfile;
  if (!ctx) failures.push("api.build 缺少 context");
  if (!df) failures.push("api.build 缺少 dockerfile");
  if (ctx && df) {
    const abs = path.resolve(ROOT, "deploy", String(ctx), String(df));
    if (!fs.existsSync(abs)) failures.push(`api.build 指向的 Dockerfile 不存在: ${abs}`);
  }
}

// 8) systemd 单元（F5）：ExecStart 必须是真实产物
const units = [
  ["deploy/systemd/miwo-api.service", read("deploy/systemd/miwo-api.service")],
  ["deploy/systemd/miwo-worker.service", read("deploy/systemd/miwo-worker.service")],
];
for (const [rel, text] of units) {
  const ex = text.match(/^ExecStart=(.*)$/m);
  if (!ex) { failures.push(`${rel} 缺少 ExecStart`); continue; }
  if (/\bdist\//.test(ex[1])) {
    failures.push(`${rel} 的 ExecStart 指向 dist/：仓库里不存在以 dist 为 outfile 的构建（真实产物是 data/serve/app.js）`);
  }
  if (!/data\/serve\//.test(ex[1])) {
    failures.push(`${rel} 的 ExecStart 必须指向 data/serve/ 下的产物，实际 "${ex[1].trim()}"`);
  }
}
if (!/^ExecStart=\/usr\/bin\/node\s+data\/serve\/app\.js\s*$/m.test(units[0][1])) {
  failures.push("deploy/systemd/miwo-api.service 的 ExecStart 必须是 /usr/bin/node data/serve/app.js");
}
if (!/^WorkingDirectory=\/opt\/miwo\/apps\/api\s*$/m.test(units[0][1])) {
  failures.push("deploy/systemd/miwo-api.service 的 WorkingDirectory 必须是 /opt/miwo/apps/api");
}

// 8b) worker 单元（Phase 1d 起不再是占位）：ExecStart/WorkingDirectory/停机信号 + **源入口与构建配置必须同时在**
//     —— 否则"单元指向一个永远不会被产出的文件"，症状是 systemd 起不来 + Restart=always 循环（Phase 0 的 F5 同类）。
const workerUnit = units[1][1];
if (!/^ExecStart=\/usr\/bin\/node\s+data\/serve\/worker\.js\s*$/m.test(workerUnit)) {
  failures.push("deploy/systemd/miwo-worker.service 的 ExecStart 必须是 /usr/bin/node data/serve/worker.js");
}
if (!/^WorkingDirectory=\/opt\/miwo\/apps\/api\s*$/m.test(workerUnit)) {
  failures.push("deploy/systemd/miwo-worker.service 的 WorkingDirectory 必须是 /opt/miwo/apps/api（与 ExecStart 的相对路径同口径）");
}
if (!/^KillSignal=SIGTERM\s*$/m.test(workerUnit) || !/^TimeoutStopSec=\d+\s*$/m.test(workerUnit)) {
  failures.push("deploy/systemd/miwo-worker.service 必须有 KillSignal=SIGTERM 与 TimeoutStopSec（worker 的优雅停机靠它）");
} else {
  // 停机窗口必须真的够长：worker 收到 SIGTERM 后在 JOB_POLICY.shutdownGraceMs（默认 25s）内收尾，
  //   `TimeoutStopSec ≤ shutdownGraceMs` 会让 systemd 提前 SIGKILL ⇒ 在跑的任务只能靠租约回收重跑。
  const grace = Number((/TimeoutStopSec=(\d+)/.exec(workerUnit) ?? [])[1]);
  if (!(grace > 25)) {
    failures.push(`deploy/systemd/miwo-worker.service 的 TimeoutStopSec=${grace} 必须 > shutdownGraceMs(默认 25s)：否则 systemd 提前 SIGKILL，优雅停机名存实亡`);
  }
}
if (/占位|placeholder/i.test(workerUnit)) {
  failures.push('deploy/systemd/miwo-worker.service 不得再写"占位/placeholder"：Phase 1d 起它是真单元');
}
if (!fs.existsSync(path.join(ROOT, "apps/api/src/worker.ts"))) {
  failures.push("缺少 apps/api/src/worker.ts：miwo-worker.service 指向的 data/serve/worker.js 没有构建入口");
}
const buildTs = read("apps/api/scripts/build.ts");
if (!/src\/worker\.ts/.test(buildTs) || !/data\/serve\/worker\.js/.test(buildTs)) {
  failures.push("apps/api/scripts/build.ts 里没有 worker 的 entry/outfile：miwo-worker.service 的 ExecStart 将指向不存在的文件");
}

// 8c) compose 的 worker 服务（Phase 1d）：与 api **同镜像/同 build/同 env**，只换启动命令。
//     缺它 ⇒ 容器路径下只起 api ⇒ 队列里只有入队没有消费者（任务永远 pending，且没有任何报错）。
{
  const worker = services.worker;
  if (!worker) {
    failures.push("deploy/docker-compose.yml 缺少 worker 服务：只起 api 时队列只有入队、没有消费者（任务永远 pending 且不报错）");
  } else {
    if (!/^\[\s*"node"\s*,\s*"data\/serve\/worker\.js"\s*\]$/.test(JSON.stringify(worker.command ?? null))) {
      failures.push(`deploy/docker-compose.yml 的 worker 服务 command 必须是 ["node","data/serve/worker.js"]（与 systemd 单元同口径），实际 ${JSON.stringify(worker.command)}`);
    }
    if (String(worker.network_mode ?? "").trim() !== "host") {
      failures.push("deploy/docker-compose.yml 的 worker 服务必须与 api 同样写 network_mode: host（同一镜像/同一 env 口径）");
    }
    if (worker.ports) {
      failures.push("deploy/docker-compose.yml 的 worker 服务不得写 ports：worker 没有任何端口，且 network_mode: host 与 ports 不能并存");
    }
    if (api) {
      if (String(worker.image ?? "") !== String(api.image ?? "")) {
        failures.push(`worker 与 api 必须是**同一个镜像**（spec §4.1「共用镜像、不同启动命令」）：worker=${JSON.stringify(worker.image)} api=${JSON.stringify(api.image)}`);
      }
      const wEnv = Object.keys(worker.environment ?? {}).sort();
      const aEnv = new Set(Object.keys(api.environment ?? {}));
      const extra = wEnv.filter((k) => !aEnv.has(k));
      if (extra.length) {
        failures.push(`worker 服务的 environment 比 api 多出 ${extra.join(", ")}：本阶段**不新增任何 MIWO_* 变量**（口径只在 policy.ts / GATE_LIMITS 里改）`);
      }
    }
    if (!Array.isArray(worker.env_file) || !worker.env_file.includes(".env")) {
      failures.push("deploy/docker-compose.yml 的 worker 服务必须 env_file: [.env]（与 api 同一份环境文件）");
    }
    if (!Array.isArray(worker.volumes) || !worker.volumes.some((v) => String(v) === "${MIWO_DATA_DIR}:${MIWO_DATA_DIR}")) {
      failures.push("deploy/docker-compose.yml 的 worker 服务必须把同一个宿主机 MIWO_DATA_DIR bind mount 到相同容器路径");
    }
    if (!fs.existsSync(path.join(ROOT, "apps/api/src/worker.ts"))) {
      failures.push("缺少 apps/api/src/worker.ts：compose 的 worker 服务 command 指向的产物没有构建入口");
    }
  }
}

// 8d) 媒体路由（Phase 1c 旧账 N2/N4 的 deploy 侧）
//   · `/oss` 的反代口径由上面 5) 的锚定断言守着（含 Range/If-Range/proxy_buffering off）—— 浏览器拖进度条靠它。
//   · `/assets` **有意不反代**：Vite 的默认 `assetsDir` 就是 `assets`，`location /assets` 一旦加上，
//     SPA 的 `/assets/*.js|css` 会被打到后端签名守卫 ⇒ 无签名 403 ⇒ **整页白屏**（比"用户片尾素材取不到"更严重）。
//     这一条**不是**"永远不许加"，而是"加它之前必须先拍板 N4"：见根 README「已知问题 §2 · N4」。
//     所以这里对**静默新增**做机械拦截（去掉这条断言 = 骗自己；改决定必须同时改本断言与两份文档）。
if (nginxBlocks.has("/assets")) {
  failures.push(
    "deploy/nginx.conf 出现了 location /assets：这会遮蔽 SPA 产物目录（Vite 默认 assetsDir=assets）⇒ /assets/*.js 被签名守卫 403 ⇒ 白屏。" +
      "N4（Phase 1c 登记）要求先与前端 build.assetsDir 一起拍板：见根 README「已知问题 §2 · N4」与 deploy/README.md「媒体路由」一节。" +
      "确要改这一决定，请同时更新本断言与那两处文档（不许静默新增）。",
  );
}

// 9) 证书不进版本库（F7）
const gitignore = read(".gitignore");
if (!/^deploy\/certs\/?\s*$/m.test(gitignore)) {
  failures.push(".gitignore 必须忽略 deploy/certs/：否则按 README 放进去的证书私钥会被 `git add -A` 提交");
}
try {
  const tracked = execFileSync("git", ["ls-files", "--", "deploy/certs", "*.pem", "*.key"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (tracked) {
    failures.push(`这些证书/私钥文件已被 git 跟踪（必须从索引移除）：\n      ${tracked.split("\n").join("\n      ")}`);
  }
} catch {
  /* git 不可用时跳过（仓库其它门禁已依赖 git，这里只做额外保险） */
}

if (failures.length) {
  console.error("check-deploy-config 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(
  `check-deploy-config 通过（${inCode.size} 个 MIWO_* 变量一致；` +
    `nginx ${proxied.length} 处 proxy_pass 端口 == MIWO_PORT=${port}；` +
    `静态根 == MIWO_DATA_DIR/web = ${dataDir || "?"}；` +
    `模板 ${templates.map((t) => t.rel).join(" + ")}）`,
);
