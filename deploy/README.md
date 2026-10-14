# 谜沃部署手册

> 本目录只产出部署文件，一致性由 `node tools/check-deploy-config.cjs`（`pnpm verify:deploy`）保证。
>
> ⚠ **两条路径，可信度不同（Phase 0 的硬事实）：**
>
> | 路径 | 状态 | 说明 |
> |---|---|---|
> | **A. 宿主机 systemd + 宿主机 nginx（Phase 0 主推）** | 文件/路径口径可核对，**推荐先走这条** | 后端直接跑在宿主机上，绑 127.0.0.1，nginx 反代它。产物路径 `data/serve/app.js` 是实测存在的真实产物。 |
> | **B. Docker Compose** | **未经本机验证**（开发机没有 Docker），是 **Phase 1d 的目标形态** | 编排拓扑已按代码事实写成自洽形态（见下），但镜像能否构建成功、容器内能否起来，本机**无法验证**，Phase 0 不做断言。 |
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

## 1. Node 版本要求

**Node `>=22.12 <25`**（根 `package.json` 与 `apps/api/package.json` 的 `engines.node`；`.nvmrc` = 22.12.0）。

- 为什么下限是 **22.12**：依赖链里的 `is-path-inside@4.0.0` 是**纯 ESM**（`"type":"module"`）且不在
  `apps/api/scripts/build.ts` 的 `external` 列表里，打包产物中会留下字面 `require(ESM)`；
  Node 直到 **22.12** 才默认允许 `require()` 加载同步 ESM（更早的版本直接抛错）。
- 自建镜像（`FROM node:22.x-...`）与系统包（Debian/Ubuntu 的 `nodejs`）都必须 >=22.12；
  `deploy/Dockerfile` 固定用 `node:22.12-bookworm-slim`。
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

# 5) 数据目录：{skills,modelPrompt} 必须真实存在，否则技能/提示词功能会**静默失效**
#    ⚠ Phase 1c Task 8 起**不再需要 vendor/**：供应商适配器是编译期内置的（apps/api/src/vendors/*.ts），
#      已经随 `pnpm --filter @miwo/api build` 打进 apps/api/data/serve/app.js。
install -d -o miwo -g miwo /var/lib/miwo/data
cp -a apps/api/data/skills apps/api/data/modelPrompt /var/lib/miwo/data/

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

> `deploy/systemd/miwo-worker.service` 是 **Phase 1d 占位**（`data/serve/worker.js` 尚不存在），现在 enable 会启动失败，这是刻意的。

## 3. 路径 B：Docker Compose（**未经本机验证**，Phase 1d 目标形态）

> ⚠⚠ **本机没有 Docker，以下步骤一次都没有在容器里跑过**：`docker compose build`、镜像构建、容器启动、
> 卷播种全部**未验证**。`deploy/Dockerfile` 与 `deploy/docker-compose.yml` 只做到"与代码事实自洽 + 过一致性断言"。
> Phase 1d 接手机器上必须重新验证一遍（尤其是 `deploy/Dockerfile` 的两个 `pnpm install` 阶段）。

```bash
git clone <repo> /opt/miwo && cd /opt/miwo

# 1) 前端在**宿主机**上构建（容器里只跑后端）
pnpm install && pnpm --filter @miwo/web build

# 2) 环境变量
cp deploy/.env.example deploy/.env        # 填 MIWO_JWT_SECRET / MIWO_PUBLIC_BASE_URL / 各口令

# 3) nginx 与证书都在宿主机上（同路径 A 的第 7、8 步）

# 4) 构建并启动（mysql + api；api 用 host 网络 → 绑宿主机 127.0.0.1:<MIWO_PORT>）
cd deploy && docker compose build && docker compose up -d

# 5) ★ 首次必须把运行时素材播种进 miwo-data 卷（卷为空时 skills/modelPrompt 都不存在，
#    应用照常启动但技能/提示词会静默失效）
#    ⚠ Phase 1c Task 8：供应商适配器已编译期内置（打进 app.js），**没有** vendor/ 要播种。
docker compose run --rm --no-deps --entrypoint sh api \
  -c 'cp -a /app/apps/api/data/. "$MIWO_DATA_DIR"/'

# 6) 验证
curl -sS http://127.0.0.1:<MIWO_PORT>/api/other/configHealth?summary=1
curl -I https://<域名>/
```

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
- 因此**真实数据在 MySQL 卷里**（`mysql-data`），**不再是** `${MIWO_DATA_DIR}/db2.sqlite`。
  `MIWO_DATA_DIR` 在 mysql 分支下只用于媒体/技能等本地文件，**sqlite 分支才在那里建 `db2.sqlite`**。
  ⚠ 升级/备份/回滚的**主对象是 MySQL**（`mysqldump` 或卷快照）。
  若你的部署**仍**显式设了 `MIWO_DB_DRIVER=sqlite`（例如迁移过渡期），那才需要一并备份
  `${MIWO_DATA_DIR}/db2.sqlite`；**默认的 `deploy/.env.example` 是 mysql**。
- `deploy/.env.example` 里的 `MIWO_DB_DRIVER=mysql` 与 `MIWO_DB_HOST=127.0.0.1` 是**当前生效的配置**
  （容器拓扑下 api 走 host 网络，所以连的是宿主机回环上发布的 MySQL），不是"未来的接入目标"。
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
6. 容器拓扑自洽（api 必须是 `network_mode: host` 或与 nginx 共享网络命名空间；不得同时写 `ports`）；
   mysql 只发布到 `127.0.0.1`、healthcheck 不把口令放命令行；
7. `deploy/Dockerfile` 存在且被 compose 的 `build:` 引用、基础镜像 >=22.12、`CMD`/`WORKDIR` 指向 `data/serve/app.js`、COPY 了 `.npmrc`；
8. systemd 单元的 `ExecStart` 指向 `data/serve/` 真实产物（写 `dist/` 会红），worker 单元必须标注 Phase 1d 占位；
9. 证书不进版本库（`.gitignore` 规则 + git 索引复查）；
10. `docker-compose.yml` 可被 YAML 解析。

## 11. 与旧系统共存

旧 ToonFlow 走 Windows `启动ToonFlow服务器.bat`（18080 端口），与本目录无关，互不影响。
