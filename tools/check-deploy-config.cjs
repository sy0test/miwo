#!/usr/bin/env node
/**
 * 断言 deploy/ 与 env 模板不漂移（Task 10 + 修复轮 1）。
 * 用法：node tools/check-deploy-config.cjs
 *
 * 断言清单（任一失败即 exit 1，逐条打印原因）：
 *  1) apps/api/src/config.ts 读取的每个 MIWO_* 至少在一个模板里被**真实赋值**（非注释行）——F4；
 *  2) 模板里声明的 MIWO_* 名字必须被 config.ts 读取（防拼写漂移），编排专用变量走 COMPOSE_ONLY 白名单；
 *  3) docker-compose 引用的每个 MIWO_* 必须在 deploy/.env.example 里真实赋值；
 *  4) 5 个必填项在 deploy/.env.example 里真实赋值且非空；
 *  5) deploy/nginx.conf **按 location 切块**后逐块断言（位置无关）——F11；
 *     并逐处断言 `proxy_pass http://<host>:<port>` 的 port == MIWO_PORT、host == 127.0.0.1 —— F3；
 *  6) 容器拓扑自洽：api 必须存在「宿主机 nginx 连得上」的可达路径 —— F1；
 *  7) deploy/Dockerfile：存在、被 compose 的 build 引用、基础镜像 >= 22.12、CMD/WORKDIR 指向 data/serve/app.js —— F2；
 *  8) systemd 单元的 ExecStart 指向真实产物 data/serve/（不得再出现 dist/）—— F5；
 *  9) 证书目录不进版本库（.gitignore 规则 + git 索引复查）—— F7；
 * 10) docker-compose.yml 可被 YAML 解析。
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

const configTs = read("apps/api/src/config.ts");
const nginx = read("deploy/nginx.conf");
const composeText = read("deploy/docker-compose.yml");
const dockerfile = read("deploy/Dockerfile");
const deployEnv = parseEnvTemplate(read("deploy/.env.example"));
const apiEnv = parseEnvTemplate(read("apps/api/.env.example"));
const templates = [
  { rel: "deploy/.env.example", real: deployEnv.real, declared: deployEnv.declared },
  { rel: "apps/api/.env.example", real: apiEnv.real, declared: apiEnv.declared },
];

const inCode = new Set(configTs.match(/MIWO_[A-Z0-9_]+/g) ?? []);
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
const COMPOSE_ONLY = new Set(["MIWO_MYSQL_ROOT_PASSWORD", "MIWO_IMAGE_TAG"]);
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
assertInBlock("/oss", ["proxy_pass", "X-Forwarded-For", "X-Forwarded-Proto", "Range", "If-Range", "proxy_buffering off"]);
assertInBlock("/socket.io", ["proxy_pass", "Upgrade", "Connection"]);
if (!/gzip\s+on\s*;/.test(nginxCode)) failures.push('deploy/nginx.conf 缺少 "gzip on;"');

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
}
const mysql = services.mysql;
if (!mysql) {
  failures.push("deploy/docker-compose.yml 缺少 mysql 服务");
} else {
  const ports = Array.isArray(mysql.ports) ? mysql.ports.map((p) => String(p)) : [];
  if (!ports.length) failures.push(`mysql 未发布端口：host 网络模式下的 api 要靠 127.0.0.1:${port || "MIWO_DB_PORT"} 连它`);
  for (const p of ports) {
    if (!/^127\.0\.0\.1:(\$\{MIWO_DB_PORT\}|\d+):\d+$/.test(p)) {
      failures.push(`mysql 端口 "${p}" 不是「仅宿主机回环」形式（应形如 127.0.0.1:\${MIWO_DB_PORT}:3306，宿主端口与 MIWO_DB_PORT 同源）`);
    }
  }
  if (!/MYSQL_PWD/.test(JSON.stringify(mysql.environment ?? {}))) {
    failures.push("mysql 服务缺少 MYSQL_PWD 环境变量：healthcheck 靠它取口令（F13 不把口令放命令行）");
  }
  const hc = JSON.stringify(mysql.healthcheck ?? {});
  if (/--password|-p\$\{|MIWO_MYSQL_ROOT_PASSWORD/.test(hc)) {
    failures.push("mysql healthcheck 仍把口令放在命令行里（F13：改用 MYSQL_PWD 环境变量，避免 docker inspect / ps 泄露）");
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
  if (!/COPY[^\n]*\.npmrc/.test(dockerfile)) {
    failures.push("deploy/Dockerfile 必须 COPY .npmrc：仓库把 enable-pre-post-scripts=true 放在那里，缺了它构建不跑 prebuild（router.ts 会陈旧）");
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
   * ── 判据的边界（刻意收窄，避免假红）──
   *   · 只看 `COPY`，跳过 `COPY --from=<stage>`（源在**镜像**里，本机文件系统无法证明它存在）；
   *   · 支持反斜杠续行（`COPY a \\\n b dest`）；
   *   · 每个源 token 必须对应**仓库相对路径**上的一个真实文件/目录（相对 Dockerfile 的 build context，
   *     即仓库根，与 `api.build.context: ..` 同口径）；
   *   · `--chown=`/`--chmod=` 之类的 flag 跳过；`["json","form"]` 形态顶层不做（本仓库用的是 shell 形态）。
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
    for (const { text } of logicalLines) {
      const m = text.match(/^\s*COPY\s+(.*)$/i);
      if (!m) continue;
      if (/--from=/i.test(m[1])) continue; // 源在镜像里，本机不可判
      const tokens = m[1]
        .split(/\s+/)
        .filter((t) => t && !t.startsWith("--"));
      if (tokens.length < 2) {
        failures.push(`deploy/Dockerfile 的 \`${text.trim()}\` 不是合法的 COPY（至少要一个源与一个目标）`);
        continue;
      }
      const sources = tokens.slice(0, -1);
      for (const src of sources) {
        checkedSources += 1;
        const abs = path.join(ROOT, src);
        if (!fs.existsSync(abs)) {
          failures.push(
            `deploy/Dockerfile 的 COPY 源不存在：${src}（宿主机上 ${abs} 找不到）。` +
              `指向已删除的目录会让 \`docker compose build\` 在 COPY 步失败 —— 而本机没有 Docker，` +
              `这条**只会在容器里暴露**。请同步删掉该行，或改指真实路径。`,
          );
        }
      }
    }
    // 自证观测（Ruling 243 口径）：一个 COPY 源都没解析到 ⇒ 说明解析器失效，不许当"干净"
    if (checkedSources === 0) failures.push("deploy/Dockerfile 的 COPY 源解析没跑起来（0 个源被检查）—— 本断言等于不存在，请核对解析规则");
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
if (!/Phase 1d/.test(units[1][1])) {
  failures.push("deploy/systemd/miwo-worker.service 必须注明它是 Phase 1d 占位（产物 data/serve/worker.js 尚不存在）");
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
    `模板 ${templates.map((t) => t.rel).join(" + ")}）`,
);
