# 谜沃部署手册

> 本目录只产出部署文件，一致性由 `node tools/check-deploy-config.cjs`（`pnpm verify:deploy`）保证。
>
> ⚠⚠ **本机没有 Docker（Phase 1d 复测）：容器路径整体「未在真机验证」。**
> `docker compose build`、镜像构建、`network_mode: host` 的真实网络行为、**容器内 worker 启动** —— 一次都没有
> 在容器里跑过；本目录对它们只有**静态断言 + 文档标注**。**systemd（路径 A）是 Phase 1 主推路径**，
> 容器路径的验证归部署窗口（见 §3、§3.5 的未验证声明）。
>
> ⚠ **两条路径，可信度不同：**
>
> | 路径 | 状态 | 说明 |
> |---|---|---|
> | **A. 宿主机 systemd + 宿主机 nginx（Phase 1 主推）** | 文件/路径口径可核对，**推荐先走这条** | 后端直接跑在宿主机上，绑 127.0.0.1，nginx 反代它。产物路径 `data/serve/app.js` 与 `data/serve/worker.js` 都是实测存在的真实产物（`pnpm --filter @miwo/api build` 出两个）。 |
> | **B. Docker Compose** | **未经本机验证**（开发机没有 Docker）；Phase 1d 起 `docker-compose.yml` 里 `api` + **`worker`** 两个服务齐了 | 编排拓扑已按代码事实写成自洽形态（见下），但镜像能否构建成功、容器内能否起来，本机**无法验证**。 |
>
> 两条路径共用同一份 `deploy/nginx.conf`（都跑在**宿主机**上）、同一份 `deploy/.env.example`。

## 0. 拓扑为什么长这样（别改回去）

`apps/api/src/config.ts:84-86` 在 `MIWO_ENV=prod` 下**强制** `MIWO_HOST === "127.0.0.1"`（否则启动即抛 `ConfigError`），
而 `apps/api/src/app.ts:200` 用 `config.host` 作为 `server.listen` 的绑定地址 → **后端只监听回环**。

由此推出两个必须遵守的结论：

1. **nginx 跑在宿主机上**（`deploy/nginx.conf`，`proxy_pass http://127.0.0.1:<MIWO_PORT>`）。
   若非要把 nginx 放进容器，**必须**让 nginx 共享 api 的网络命名空间（`network_mode: "service:api"`），
   否则它永远连不上 api。
2. **容器路径下 api 用 `network_mode: host`**（见 `deploy/docker-compose.yml` 文件头）。
   "把容器端口 publish 到宿主机"对"只绑容器回环"的进程**无效**：Docker 的端口发布走 DNAT/docker-proxy，
   连接落在容器 eth0 上，绑在容器 lo 上的 socket 收不到。host 网络模式下 api 直接绑宿主机回环，才是可达的。
   `tools/check-deploy-config.cjs` 对这条拓扑有断言（只认上面两种写法），防止退回"`expose` 一下就算完"。
3. **前端静态根与后端数据根同源**：nginx 的 `root` 是 `${MIWO_DATA_DIR}/web`，默认 `/var/lib/miwo/data/web`；
   systemd 从 `/etc/miwo/env` 读取环境，该文件按步骤 6 从 `deploy/.env.example` 复制。构建后用
   `node apps/api/scripts/sync-web-build.cjs --src apps/web/dist --out /var/lib/miwo/data/web` 同步前端；
   若更改 `MIWO_DATA_DIR`，同步更新 nginx `root`。`node tools/check-deploy-config.cjs` 校验模板路径、nginx root 与 systemd 环境文件链路；
   它不读取真实主机上的 `/etc/miwo/env`，部署时仍需确认该文件中的值与 nginx 配置一致。

## 1. Node 版本要求

**Node `>=22.12 <25`**（根 `package.json` 与 `apps/api/package.json` 的 `engines.node`；`.nvmrc` = 22.12.0）。

- 为什么下限是 **22.12**：依赖链里的 `is-path-inside@4.0.0` 是**纯 ESM**（`"type":"module"`）且不在
  `apps/api/scripts/build.ts` 的 `external` 列表里，打包产物中会留下字面 `require(ESM)`；
  Node 直到 **22.12** 才默认允许 `require()` 加载同步 ESM（更早的版本直接抛错）。
- 自建镜像（`FROM node:22.x-...`）与系统包（Debian/Ubuntu 的 `nodejs`）都必须 >=22.12；
  `deploy/Dockerfile` 固定用 `node:22.12-bookworm-slim`。Dockerfile 会先固定升级到 Corepack 0.31.0，修复该基础镜像内置 Corepack 缺少 pnpm 当前签名 key 的问题，再准备根 `package.json` 锁定的 pnpm。
- **`.npmrc` 里开了 `engine-strict=true`**：Node 不满足 `engines` 时 `pnpm install` **直接失败**，
  不会留下"能装完但运行期崩"的产物。
- 上限 `<25`：本机实测 v24.21 通过；25.x 未验证，先挡在门外。

## 2. 路径 A：宿主机 systemd 部署（Phase 0 主推）

前置条件：Node >=22.12、pnpm（`corepack enable`）、nginx、`git`。

```bash
# 1) 取代码
git clone <repo> /opt/miwo && cd /opt/miwo

# 2) 装依赖（engine-strict 会拦 Node <22.12）
pnpm install

# 3) 构建后端 —— ★ 产物是 apps/api/data/serve/app.js
#    （apps/api/scripts/build.ts:44 的 outfile；仓库里**没有**任何以 dist/ 为 outfile 的构建）
pnpm --filter @miwo/api build

# 4) 构建前端 —— ★ 不做这步，nginx 的 `/` 没有任何内容（/api、/oss 不受影响）
pnpm --filter @miwo/web build        # 产出 apps/web/dist（不入库，见 .gitignore）

# 5) 数据目录：skills/modelPrompt 必须真实存在，否则技能/提示词功能会**静默失效**
#    vendor/ 不再需要：供应商适配器随 API 构建期内置。
install -d -o miwo -g miwo /var/lib/miwo/data
node apps/api/scripts/seed-data-dir.cjs --src apps/api/data --out /var/lib/miwo/data --dry-run
node apps/api/scripts/seed-data-dir.cjs --src apps/api/data --out /var/lib/miwo/data

# 6) 环境变量（含 JWT 密钥，权限收紧）
install -d -m 700 /etc/miwo
install -m 600 deploy/.env.example /etc/miwo/env    # 然后编辑：务必改 MIWO_JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 7) 证书（★ 私钥不要进仓库：deploy/certs/ 与 *.pem / *.key 已被 .gitignore 忽略）
install -d -m 700 /etc/nginx/certs
cp fullchain.pem privkey.pem /etc/nginx/certs/

# 8) nginx（同一份 deploy/nginx.conf；按需改 `root` 的宿主机路径）
cp deploy/nginx.conf /etc/nginx/conf.d/miwo.conf
nginx -t && systemctl reload nginx

# 9) 服务用户与单元
useradd --system --home /var/lib/miwo --shell /usr/sbin/nologin miwo   # 已存在则跳过
cp deploy/systemd/miwo-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now miwo-api

# 10) 验证
curl -sS http://127.0.0.1:<MIWO_PORT>/api/other/configHealth?summary=1
curl -I https://<域名>/
```

> **worker 单元自 Phase 1d 起是真单元**（`data/serve/worker.js` 由 `pnpm --filter @miwo/api build` 产出，
> 现在 `enable` 就能起来）—— 安装步骤、日志、与容器形态的二选一、优雅停机口径见 **§3.5**。

## 3. 路径 B：Docker Compose + 1Panel MySQL

> 本机没有 Docker，无法执行 Ubuntu 上的真实镜像构建和容器启动。本地会检查 Compose YAML、Dockerfile 源路径和部署断言；
> 请在服务器首次启动后检查 API、worker 日志和健康接口。1Panel 继续管理 MySQL 与 Nginx，Compose 只运行 API/worker。

1. 在 1Panel 创建 MySQL 数据库和专用用户，字符集使用 `utf8mb4`，并授予该库的迁移/读写权限。备份现有库后再首次启动，API 会自动运行版本化迁移。
2. 上传 ZIP 并解压到 `/opt`（ZIP 顶层目录为 `miwo/`，项目路径因此是 `/opt/miwo`）。镜像构建阶段会从 `apps/web` 源码构建 SPA 并同步到镜像运行目录，服务器无需额外安装 Node 或预先生成 `apps/api/data/web`。
   **另外要单独放 Embedding 模型**（`data/models` 属于运行时数据，不进 ZIP/镜像）：视频策划、记忆检索会用到
   `all-MiniLM-L6-v2`，缺了会报 `Embedding 模型文件不存在: <MIWO_DATA_DIR>/models/all-MiniLM-L6-v2/onnx/model_fp16.onnx`。
   从开发机把整个目录传上去（开发机上在 `apps/api/data/models/`）：

   ```bash
   # 在开发机执行（Windows 自带 tar/ssh）
   tar -C <仓库>/apps/api/data/models -cf - all-MiniLM-L6-v2 \
     | ssh root@<服务器IP> "mkdir -p /var/lib/miwo/data/models && tar -C /var/lib/miwo/data/models -xf -"
   ```

   校验：`ls /var/lib/miwo/data/models/all-MiniLM-L6-v2/onnx/model_fp16.onnx`（约 43MB）。无需重启，用到时按需加载。
3. 配置私有环境文件：

```bash
cd /opt/miwo/deploy
cp .env.example .env
chmod 600 .env
nano .env
```

填写 `MIWO_JWT_SECRET`、`MIWO_PUBLIC_BASE_URL` 和 `MIWO_DB_NAME` / `MIWO_DB_USER` / `MIWO_DB_PASSWORD`。`MIWO_DB_HOST`、`MIWO_DB_PORT` 必须指向 1Panel MySQL 在宿主机上可达的地址和端口；默认 `127.0.0.1:3306`，以 1Panel 实际映射为准。不要把 `.env` 上传或加入 ZIP。

4. 在 1Panel Nginx 配置中保留现有 TLS 与域名设置，并确认静态 root 为 `/var/lib/miwo/data/web`、`/api`、`/oss`、`/socket.io` 反代到 `127.0.0.1:10588`。如修改 `MIWO_DATA_DIR` 或 `MIWO_PORT`，同步修改 Nginx 路径/端口。
5. 构建并启动 API 与 worker：

```bash
cd /opt/miwo/deploy
docker compose build          # 首次约 5-10 分钟
docker compose up -d
docker compose ps
docker compose logs --tail=100 api worker
```

> 构建阶段要跑 `vite build`（前端单文件内联打包，峰值内存约 3.4GB）。`deploy/Dockerfile` 的 build 阶段已用
> `NODE_OPTIONS=--max-old-space-size=4096` 抬高 Node 堆上限；**构建机至少要有 4GB 可用内存**（不足会 OOM，
> 可先加 4GB swap：`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`）。

6. 检查服务与页面：

```bash
curl -fsS http://127.0.0.1:10588/api/other/configHealth?summary=1
curl -I https://<域名>/
```

Compose 使用 host 网络连接 1Panel MySQL，并将 `${MIWO_DATA_DIR}` bind mount 到同一路径；首次 API 启动会播种 skills/modelPrompt 并把镜像中的 web 静态文件复制到该目录，宿主机 Nginx 可直接读取。worker 与 API 使用同一镜像、环境文件和数据目录。

> 仓库根 `.dockerignore` 与 Compose 根构建上下文对齐，排除 `node_modules`、`.git`、真实 `.env`、用户媒体数据、构建输出和生成目录 `apps/api/data/web`；只允许 `.env.example` 进入 context。镜像构建阶段从 `apps/web` 源码生成静态站点并同步到 `/app/apps/api/data/web`，而 `apps/api/data/{skills,modelPrompt}` 作为首次启动素材保留。这样 ZIP 不依赖 Git 忽略的本机生成物，也不会把 Windows `node_modules` 软链接或部署密钥发送给 Docker builder。

## 3.5 worker 进程（Phase 1d 起是**真进程**）

队列的执行者是**独立进程**（api 只入队 + 推事件 `job:update`），产物与 api 同目录 `data/serve/`：

| 形态 | 启动方式 | 说明 |
|---|---|---|
| **systemd（主推）** | `deploy/systemd/miwo-worker.service` | 与 api 同一套前置（`pnpm install` + `pnpm --filter @miwo/api build`），只是 `ExecStart` 换成 `data/serve/worker.js` |
| **容器** | `deploy/docker-compose.yml` 的 `worker` 服务 | 与 api **同镜像/同 build/同 env/同数据目录 bind mount**，只换 `command`（spec §4.1） |
| **本机开发** | `pnpm.cmd --filter @miwo/api run dev` 同时启动 API 与 worker；仅 worker 用 `run worker` | tsx + nodemon 热重载，不需要 build |

安装（路径 A 第 9 步之后）：

```bash
cp deploy/systemd/miwo-worker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now miwo-worker
journalctl -u miwo-worker -f          # 领取 / 心跳 / 优雅停机的日志都在这
systemctl status miwo-worker
```

- ⚠ **与 compose 的 `worker` 服务二选一，不要同时起**：两条进程抢同一队列**不会重复执行**（领取是条件写 +
  租约），但 `JOB_POLICY.perUserMaxRunning` 是"**每 worker 一份**" ⇒ 同时起会让实际并发口径**翻倍**。
- **优雅停机**：worker 收到 `SIGTERM` 后在 `JOB_POLICY.shutdownGraceMs`（默认 25s）内等在跑任务收尾，再 abort。
  单元里 `TimeoutStopSec=45 > 25` 是**必须的** —— `tools/check-deploy-config.cjs` 会断言这个不等式；
  否则 systemd 提前 `SIGKILL`，在跑的任务只能靠租约回收（`reclaimExpired`）重跑一遍（次优路径）。
- **数据卷**：与 api 共用 `${MIWO_DATA_DIR}`；缺 `{skills,modelPrompt}` 时 worker 照常起、技能/提示词**静默失效**
  （与 api 同一个坑，播种见 §2 第 5 步 / §3 第 5 步）。Phase 1c Task 8 起**没有** `vendor/` 要播种。

## 3.6 并发口径（O10）：参数表与**唯一落点**

**不下沉到环境变量**：本阶段**不新增任何 `MIWO_*`**（新增要同时改 `deploy/.env.example`、
`apps/api/.env.example` 与 `tools/check-deploy-config.cjs` 的白名单，收益为零；门禁会断言 compose 没有引入新变量）。
**改口径 = 改 `apps/api/src/jobs/policy.ts` 的 `JOB_POLICY` 与 `apps/api/src/jobs/gate.ts` 的 `GATE_LIMITS`，
不是改环境变量。**

| 参数 | 落点 | 当前值 | 含义 |
|---|---|---|---|
| `globalMaxRunning` | `policy.ts` | 8 | 每个 worker 进程内同时在跑的任务数 |
| `perUserMaxRunning` | `policy.ts` | 2 | 每用户额度；⚠ 多 worker 下是"**每 worker 一份**"，全局按用户上限属 Phase 3 |
| `leaseMs` / `heartbeatMs` | `policy.ts` | 60000 / 15000 | 租约与心跳（不变式 `heartbeatMs*4 <= leaseMs`） |
| `claimBatch` / `idlePollMs` / `busyPollMs` | `policy.ts` | 64 / 1000 / 200 | 领取批量与轮询节奏 |
| `maxPayloadBytes` | `policy.ts` | 65536 | payload 只存引用 id（base64 一律不进队列） |
| `retryBaseMs` / `retryMaxMs` | `policy.ts` | 30000 / 600000 | 退避 `base*2^(n-1)`，封顶 |
| `shutdownGraceMs` | `policy.ts` | 25000 | SIGTERM 后的收尾窗口（必须 < 单元的 `TimeoutStopSec`） |
| `stuckGraceMs` | `policy.ts` | 1800000 | 对账器（`job:admin --reconcile`）的宽限期 |
| `relayPollMs` / `relayBatch` | `policy.ts` | 1000 / 200 | api 侧进度 relay |
| `gateWaitMs` / `gateLeaseMs` / `gatePollMs` | `policy.ts` | 120000 / 300000 / 200 | `o_gate` 槽位的等待/租约/轮询 |
| `selftestSleepMs` | `policy.ts` | 1500 | 运维冒烟（`job:admin --enqueue-selftest`）与 chaos 的睡眠 |
| `GATE_LIMITS` `vendor:text` / `vendor:image` / `vendor:video` / `default` | `gate.ts` | 8 / 4 / 2 / 4 | vendor 分池上限（**跨进程**，`o_gate` 租约） |

⚠ **O10 未定**（spec §15：「100 并发」指**注册用户 / 日活 / 同时在线 / 同时生成**中的哪一种）。
上表是按"100 = **注册用户**"取的**保守默认**（最不容易把服务器与厂商配额打挂）；口径一旦拍板，
只需改 `globalMaxRunning` / `perUserMaxRunning` / 池上限这三个值。

## 3.7 媒体路由：`/oss` 反代 vs `/assets` **有意不反代**（Phase 1c 旧账 N2/N4）

- **N2（Bearer / 签名取媒体）**：`/oss` 与 `/assets` 在后端都挂了 `optionalMediaAuth`（有
  `Authorization: Bearer` 就建 ctx）+ `mediaAuthGuard`（短时签名），两端都可达 —— 由
  `pnpm verify:phase1c-media` 的真进程 + 真 HTTP 用例守着（`★★ 带 Bearer 取媒体（无签名）⇒ 200`）。
  nginx 侧则必须让**媒体字节真的流过去**：`location /oss` 的 `proxy_set_header Range $http_range;` /
  `If-Range` / `proxy_buffering off` 是拖进度条的前提。`tools/check-deploy-config.cjs` 现在**锚真实指令**断言
  （裸子串 `"Range"` 会被同一块里的 `If-Range` 行误满足 ⇒ 把真指令注释掉后门禁照样绿，这就是 Phase 0 ledger 的 N2）。
- **N4（`/assets` 会遮蔽将来的 SPA 产物目录）**：`/assets` **有意没有** `location` 反代。
  Vite 的默认 `assetsDir` 正是 `assets` ⇒ 一旦加 `location /assets` 把它打到后端签名守卫，
  `apps/web/dist/assets/*.js|css` 会无签名 **403** ⇒ **整页白屏**（症状比"用户片尾素材在 nginx 路径上取不到"更严重）。
  这是一条**必须与前端 `build.assetsDir` 一起拍板**的取舍，归属 **Phase 3**（根 README「已知问题 §2 · N4」、
  `apps/api/README-auth.md` 第 11 条）。两个方向都不是"永远不许动"：`tools/check-deploy-config.cjs` 对
  `/assets` 的**静默新增**直接报红并指向本节 —— 改决定必须同时改断言与文档。

## 4. `MIWO_PORT` 与 nginx 的联动（改端口必读）

`deploy/nginx.conf` 里有 **3 处** `proxy_pass http://127.0.0.1:<MIWO_PORT>`（`/api`、`/oss`、`/socket.io`）。

**改 `MIWO_PORT` 必须同步改这 3 处**，否则反代全部打偏 → 502（后端其实活着）。
`tools/check-deploy-config.cjs` 会**逐处**断言"nginx 的端口 == `deploy/.env.example` 的 `MIWO_PORT`"，
不一致直接失败（旧脚本对这种情况完全免疫，是全绿的）。

## 5. 证书与 `.gitignore`

- 证书私钥放 `deploy/certs/`（或更推荐的 `/etc/nginx/certs/`）即可 —— **`deploy/certs/`、`*.pem`、`*.key`
  已在 `.gitignore` 中忽略**：本仓工作流是 `git add -A`，没这条规则私钥会被直接提交。
- 一致性脚本还会用 `git ls-files -- deploy/certs *.pem *.key` 复查一遍索引，已跟踪的证书/私钥会让门禁红。
- `.crt` 等公开文件不忽略。

## 6. 数据文件在哪（**MySQL 已是唯一目标库**）

- **【已更正·Ruling 8+16】`MIWO_DB_*` 整组变量现在真的被应用消费。**
  旧版本这里写着"Phase 1a 之前，`MIWO_DB_*` 整组变量不被应用消费，而 `apps/api/src/utils/db.ts`
  的 knex client 仍**硬编码 `better-sqlite3`**" —— **那两句现在都是假的**：
  Phase 1a / Task 4 起启动路径是 `utils/db.ts` 的 `dbReady` → `src/db/connect.ts` 的 `connect()`，
  而 `createKnex()` **按 `config.db.driver` 选 client**（`sqlite` → `better-sqlite3`，
  `mysql` → `mysql2`，见 `connect.ts` 的 `clientConfig()` / `createKnex()`）。
  `MIWO_DB_HOST/PORT/USER/PASSWORD/NAME` 由 `config.ts` 读入后经 `connectionConfig()` 交给 mysql2。
  ⇒ **设了 `MIWO_DB_DRIVER=mysql` 就是在用 MySQL**，不再是"接入目标"。
- 因此真实业务数据在 **1Panel 管理的 MySQL** 中；Compose 不创建 MySQL 服务，也没有 `mysql-data` 卷。
  `MIWO_DATA_DIR` 在 MySQL 模式下只保存媒体和运行时文件；只有显式配置 `MIWO_DB_DRIVER=sqlite` 时，
  才会在该目录使用 `db2.sqlite`。
- 升级前通过 **1Panel 的 MySQL 备份功能**备份对应数据库，或使用可连接实例的 `mysqldump`；不要依赖 Compose 卷快照。
  若显式使用 SQLite，则另行备份 `${MIWO_DATA_DIR}/db2.sqlite`。默认 `deploy/.env.example` 配置为 MySQL。
- `MIWO_DB_HOST=127.0.0.1` 表示 api/worker 通过 host 网络访问宿主机回环上的 MySQL 监听端口，
  不是 Compose 发布的端口。若 1Panel MySQL 只监听其他宿主机地址或映射端口，请按实际可达地址修改 `MIWO_DB_HOST` / `MIWO_DB_PORT`。
- ⚠ **启动路径带数据库目标护栏**（【裁定 A】）：若解析出的 sqlite 目标是**仓库内的真实 dev 库**
  （`apps/api/data/db2.sqlite`）且没有显式放行，应用启动会**响亮失败**而不是静默写坏它。
  容器里 `MIWO_DATA_DIR` 指向卷、且驱动是 mysql，所以**不受影响**；这条只挡"本机默认配置误连 dev 库"。


## 7. 环境变量：`MIWO_PUBLIC_BASE_URL` 的使用条件

| 场景 | 要不要显式设 | 说明 |
|---|---|---|
| `MIWO_ENV=prod`（本目录默认） | **必须** | 不设启动即抛 `ConfigError`。媒体走相对路径，本变量只用于生成对外绝对链接。 |
| dev + **只在本机浏览器**访问 | 可不设 | 缺省 `http://<MIWO_HOST>:<MIWO_PORT>`，即 `http://127.0.0.1:10588`。 |
| dev + **局域网/手机浏览器**访问 | **必须显式设本机局域网地址** | 例如 `MIWO_PUBLIC_BASE_URL=http://192.168.1.12:10588`。Task 9 删掉了 `oss.ts` 里"回退到第一个非回环 IPv4"的 `lanMediaBase()`，缺省值里的 `127.0.0.1` 会被远端浏览器当成本机 → **媒体（`/oss`）全部加载失败**（后端进程本身照常启动，症状很隐蔽）。 |

## 8. 升级

```bash
cd /opt/miwo && git pull

# 路径 A（systemd）
pnpm install && pnpm --filter @miwo/api build && pnpm --filter @miwo/web build
systemctl restart miwo-api

# 路径 B（容器）
cd deploy && docker compose build && docker compose up -d
# 数据库迁移在 Phase 1a 起由容器入口执行
```

## 9. 回滚

- **代码/镜像**：路径 A 用 `git checkout <上一个 tag>` 后重新 `pnpm --filter @miwo/api build` 并 `systemctl restart miwo-api`；
  路径 B 按 `MIWO_IMAGE_TAG` 固定镜像，回滚 = 改回上一版本的 tag 后 `docker compose up -d`。
- **数据**：`${MIWO_DATA_DIR}/db2.sqlite`（见 §6）必须一起回滚；**MySQL 迁移的回滚在 Phase 1a 定义**（每个迁移必须有 down）。

## 10. 一致性检查覆盖什么

`pnpm verify:deploy`（= `node tools/check-deploy-config.cjs`）断言：

1. `apps/api/src/config.ts` 读取的每个 `MIWO_*` 至少在一个模板里被**真实赋值**（只有非注释行的 `NAME=...` 才算，注释掉即失败）；
2. 模板里声明的变量名必须被代码读取（防拼写漂移，编排专用变量在白名单）；
3. `docker-compose.yml` 用 `${...}` 引用的变量必须在 `deploy/.env.example` 里真实赋值；
4. 5 个必填项（`MIWO_ENV/MIWO_PORT/MIWO_HOST/MIWO_DATA_DIR/MIWO_JWT_SECRET`）必须真实赋值且非空；
5. `nginx.conf` **按 location 切块**后逐块断言（`/api`、`/oss`、`/socket.io` 各自要有的头不能"挂在别处"），
   并逐处断言 `proxy_pass` 的端口 == `MIWO_PORT`、主机 == `127.0.0.1`；
   `/oss` 的 Range 必须写成**真实指令** `proxy_set_header Range $http_range;`（裸子串 `"Range"` 会被
   同一块里的 `If-Range` 行误满足）—— Phase 0 ledger N2；
6. 容器拓扑自洽（api 必须是 `network_mode: host` 或与 nginx 共享网络命名空间；不得同时写 `ports`）；
   Compose 不得创建 MySQL 服务，数据库由 1Panel 独立管理；
7. `deploy/Dockerfile` 存在且被 compose 的 `build:` 引用、基础镜像 **22.12 <= v < 25**（**上下界都查**，
   只查下限会让 `node:25+` 溜过 —— Phase 0 ledger N4b）、`CMD`/`WORKDIR` 指向 `data/serve/app.js`、
   有一行**真实指令（非注释）**`COPY … .npmrc`（注释行不算 —— Phase 0 ledger N4a）；
8. systemd 单元的 `ExecStart` 指向 `data/serve/` 真实产物（写 `dist/` 会红）；
   8b. **worker 单元是真单元**：`ExecStart=/usr/bin/node data/serve/worker.js`、`WorkingDirectory=/opt/miwo/apps/api`、
   `KillSignal=SIGTERM`、`TimeoutStopSec` **> 25s**（`shutdownGraceMs`）、不得写"占位/placeholder"，
   且 `apps/api/src/worker.ts` 与 `build.ts` 的 entry/outfile 必须**同时在**（否则单元指向永远不产出的文件）；
   8c. compose 的 **`worker` 服务**：与 api 同镜像/同 build/同 env（不得新增 `MIWO_*`）、`command` 指向
   `data/serve/worker.js`、`network_mode: host`、不得写 `ports`、必须挂与 api 相同的宿主机数据目录；
   8d. `/assets` **有意不反代**（Phase 1c 未处置项 N4：会遮蔽 SPA 产物目录）—— 静默新增 `location /assets` 即红；
9. 证书不进版本库（`.gitignore` 规则 + git 索引复查）；
10. `docker-compose.yml` 可被 YAML 解析。

> 判据的红/绿两端（篡改 ⇒ 红、逐字节还原 ⇒ 绿）逐条记录在
> `.superpowers/sdd/2026-10-12-miwo-phase1d-job-queue/groupD-report.md` 的 Task 11 一节。

## 11. 与旧系统共存

旧 ToonFlow 走 Windows `启动ToonFlow服务器.bat`（18080 端口），与本目录无关，互不影响。
