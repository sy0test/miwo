# 谜沃 / MirrorWorld（miwo）

多租户 AI 短剧生产平台。本仓库由上游项目 ToonFlow 复制改造而来（品牌与技术标识符已更名）。

**设计文档**：`../../docs/superpowers/specs/2026-10-12-miwo-saas-design.md`
**Phase 0 计划**：`../../docs/superpowers/plans/2026-10-12-miwo-phase0-repo-bootstrap.md`

## 目录

| 目录 | 内容 |
|---|---|
| `apps/api` | 后端（Express + knex） |
| `apps/web` | 前端（Vue 3 + Vite） |
| `packages/shared` | 前后端共享类型 —— ⚠ **Phase 1 计划新增，当前仓库里没有 `packages/` 目录**（`pnpm-workspace.yaml` 的 `packages/*` 目前匹配不到任何包） |
| `deploy` | docker-compose / nginx / systemd / 环境变量示例 |
| `tools` | 仓库级检查脚本 |

## 本机启动

```powershell
pnpm.cmd install
cd apps\api
pnpm.cmd dev
```

要求 Node **22.12–24**、pnpm 10。本机开发不需要 Docker。

> ⚠ **首次启动会跑迁移，而且"迁移完成才监听端口"**（Phase 1a / Task 4 起）。如果你手上是**旧的 dev 库**
> （`apps/api/data/db2.sqlite`，没有 `knex_migrations`），`pnpm dev` 会报 `table o_user already exists` ——
> **不是迁移写错**，处置见下面「[不支持"在老库上原地跑迁移"](#-不支持在老库上原地跑迁移症状--原因--怎么做)」。
> 想在空库上完整体验启动顺序（含"已应用迁移"日志）：`$env:MIWO_DATA_DIR="C:\Temp\miwo-boot"; pnpm.cmd dev`。
> ⚠ **升级一台已有数据的实例前先读 [`apps/api/README-auth.md`](apps/api/README-auth.md)**：
> Phase 1c 之后**库里一个能登录的账号都没有**（旧明文口令不迁移），第一件事是
> `pnpm.cmd run db:bootstrap-admin -- --username=<名字> --apply`，然后发邀请码让用户重新注册。

### 路由与配置（改动须知）

- **新增/改名 `apps/api/src/routes/**` 下的文件后，重启 `pnpm dev` 即可，`src/router.ts` 会自动重新生成**。
  生成链挂在两处：`apps/api/package.json` 的 `predev`（每次 `pnpm dev` 一次）与 `apps/api/nodemon.json` 的 `exec` 前缀
  （nodemon 每次重启都跑）。**只靠 `predev` 会漏掉"dev 会话内新增路由"**：nodemon 重启走 `exec`，不会再跑 predev，
  症状是新路由返回 404 而没有任何报错（所谓"幽灵 404"）。
  `src/router.ts` 是**提交在仓库里的构建产物**（构建期生成，不再由 `app.ts` 运行期重建）；空清单会被生成器直接拒绝覆盖。
- 配置入口是 `apps/api/src/config.ts`（`MIWO_*` 变量的唯一入口 + 启动期校验），开发期模板见 `apps/api/.env.example`。
  ⚠ **dev + 局域网/手机浏览器访问**时必须显式设 `MIWO_PUBLIC_BASE_URL`（否则远端浏览器把缺省的 `127.0.0.1` 当自己，媒体全挂）。
- **Phase 1c 收口（Task 10 起）：应用配置的唯一入口是 `apps/api/src/config.ts`**（启动期 fail-fast；
  `MIWO_ENV`/`MIWO_PORT`/`MIWO_HOST`/`MIWO_DATA_DIR`/`MIWO_JWT_SECRET`/`MIWO_DB_*`/`MIWO_PUBLIC_BASE_URL`/`MIWO_TRUST_PROXY`/
  `MIWO_STORAGE_DRIVER`/`MIWO_MEDIA_DIR`，以及本任务新增的 `MIWO_OSS_URL`/`MIWO_FFMPEG_PATH`/`MIWO_FFPROBE_PATH`/
  `MIWO_FFMPEG_TIMEOUT_MS`/`MIWO_REDRAW_PREP`/`MIWO_PROXY`）。
  `apps/api/src/**` 里**不得**再出现绕过 `config.ts` 的 `process.env.*` 读取 —— 由
  `node tools/check-config-single-source.cjs`（`pnpm.cmd run verify:config`，已进 CI）机械断言。
  **实测口径**：扫描 281 个 `.ts`，观测到 9 处 `process.env` 读取 = `config.ts` 内部 7 处 + 赋值左侧（写，非读）2 处；
  唯一的显式豁免是**四条标准代理变量** + 两条登记在案的例外（见下）。
- 历史遗留变量名 `TOONFLOW_PROXY` 已在 Phase 1c **重命名为 `MIWO_PROXY`**（旧名不再读取；`proxy.ts` 的日志与注释同步更新）。
  下表是这次收口的**逐条对账**（旧表里的 10 个非 `MIWO_` 变量 + 2 个额外项）：

  | 变量（旧名） | 原读取位置 | 现在归属 | 状态 |
  |---|---|---|---|
  | `ossURL` | `utils/oss.ts:73` | `config.ossUrl`（`MIWO_OSS_URL`，可选） | ✅ 已收进 config |
  | `FFMPEG_PATH` | `utils/ffmpeg.ts:15` | `config.ffmpeg.path`（`MIWO_FFMPEG_PATH`，缺省 `ffmpeg`） | ✅ 已收进 config（模块级常量改成函数内读 —— 唯一的结构改动） |
  | `FFPROBE_PATH` | `utils/ffmpeg.ts:16` | `config.ffmpeg.probePath`（`MIWO_FFPROBE_PATH`） | ✅ 已收进 config |
  | `FFMPEG_TIMEOUT` | `utils/ffmpeg.ts:19` | `config.ffmpeg.timeoutMs`（`MIWO_FFMPEG_TIMEOUT_MS`，缺省 600000） | ✅ 已收进 config，且**非法值改为 fail-fast**（旧写法 `Number("abc")` = NaN = 永不超时） |
  | `REDRAW_PREP` | `routes/redraw/analyzeSource.ts:33` | `config.redrawPrepScript`（`MIWO_REDRAW_PREP`） | ✅ 已收进 config（缺省值与原字面量**逐字一致**） |
  | `TOONFLOW_PROXY` | `proxy.ts:98` | `config.proxyUrl`（**`MIWO_PROXY`**） | ✅ 已**重命名**并收进 config |
  | `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` | `proxy.ts:99` | **保留原名** | ⛔ **不迁**：undici 的 `EnvHttpProxyAgent` 只认这四个标准名（改名即失效）；是门禁豁免表里的四条 |
  | `MIWO_DATA_DIR`（迁移脚本） | `db/migrations/003_vendor_asset_sync.ts:37` | **保留**（仍直读 env） | ⛔ 登记豁免：迁移文件由 knex 迁移器独立加载，不能依赖应用级 `config` 单例 |
  | `MIWO_GEN_DB_TYPES`（门控） | `utils/db.ts:41` | **保留**（仍直读 env） | ⛔ 登记豁免：它是"这次是哪个脚本在跑"的**门控变量**，不是可调配置；进 `config` 或 `.env.example` 都会改变语义 |
  | （额外）`process.env.NODE_ENV` | `config.ts:135`（**写**） | `config.ts` 派生写出 | ✅ 门禁只查"读取"，赋值左侧不算违规 |

  ⚠ `process.env.NODE_ENV` 已不再被业务代码用于决策：`utils/oss.ts` 原来读 `NODE_ENV === "development"`（与 `config.env === "dev"` 语义等价，
  是第 5 个决策点），Task 12 必做 5 已改为 `config.env === "dev"`。`NODE_ENV` 现在只由 `config.ts` **派生写出**，供 Express/knex 等生态代码读。
- 部署文件与容器 Node 版本要求见 [`deploy/README.md`](deploy/README.md)；一致性由 `node tools/check-deploy-config.cjs` 保证。

## 数据层手册（Phase 1a）

> 本节由 **Task 7** 起草（Task 12 定稿）。下面每一段输出都是**本机实测原文**（Windows / MySQL **8.4.11** / 端口 **3307**）。
> ⚠ 计划文本里写的 `apps/api/README-db.md` **全仓不存在**：数据层的登记落点一律是根 `README.md`（本节 + 下面「迁移纪律」「真实数据搬迁」「启动期副作用」「`db:repair-stuck`」几节）。

### 数据层（Phase 1a 起）

- **驱动**：knex + `mysql2`（MySQL）/ `better-sqlite3`（SQLite，回归网与 `verify-phase0` 用）；由 `MIWO_DB_DRIVER` 决定（缺省 `sqlite`）。
- **表结构**：唯一真相是 `apps/api/src/db/migrations/`（版本化迁移），**不再**由启动期的 `lib/initDB.ts` / `lib/fixDB.ts` 建/改（**这两个文件已在 Phase 1c Task 5 删除**；守它的门禁是 `tools/check-dead-ddl.cjs`）。
- **启动序列**：连接 → `migrate.latest()` → 监听端口；迁移失败即退出（见下面 §0 的图）。
- **手册**：本文件（`README.md`）的「数据层手册（Phase 1a）」一节（新增迁移 / 回滚 / 本机 MySQL / 老库搬迁 / 降级口径）。
- **验收**：`pnpm.cmd run verify:phase1a`；当前 baseline 见 §5（**60/60**，sqlite 与 MySQL 双口径）。
- **本阶段已知项**（不是 bug）：重启不再自动把 `state='生成中'` 改判失败（Phase 1d 的队列租约接管）；
  `userId` 列已建出但**未回填**（Phase 1b）；`o_skillList`/`o_skillAttribution` 已不再创建。
- **deferred 登记表**：文末「Phase 1a deferred 登记表」（**22 条**，每条点名归属 Phase 与依据；
  Task 12 定稿 16 条，必做修复轮按 **Ruling 45 / 58③+64 / 106 / 145 / 146 / 156** 补登记 6 条）。

### 0. 现在的启动序列（图）

```text
  进程启动
    |
    |  src/config.ts        loadConfig()   —— 模块级 fail-fast：缺 MIWO_ENV / MIWO_JWT_SECRET 等直接抛 ConfigError
    v
  src/utils/db.ts           createKnex()   —— client 由 config.db.driver 决定（sqlite | mysql）
    |                       export const dbReady = (async () => { await connect(); ... })()
    v
  src/db/connect.ts         connect()      —— 建连接 → 探活 `select 1` → knex migrate.latest()
    |                                        成功 → 返回 { applied }
    |                                        失败 → 抛（带可操作信息的报错，不是裸的 tarn 超时）
    v
  src/app.ts                await dbReady  —— **迁移完成之前不许 listen**（spec §3.3 的启动竞态）
    v
  server.listen(MIWO_PORT)  —— 只有走到这里，端口才开始接请求
```

`dbReady` 一旦 reject，`src/utils/db.ts` 的 `.catch()` 会 `console.error` 后 `process.exit(1)`
（**fail-fast**：不允许"看起来起来了、实际半残"）。所以生产上线顺序必须是「**备份 → 迁移 → 起服务**」，
而迁移本身由服务启动时自动执行（`migrate.latest()` 幂等）。

### 1. 本机 MySQL（免安装，不用 Docker）

| 项 | 实测值 |
|---|---|
| zip URL | `https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip`（HEAD **200**、`Content-Length: 281191914`、`Content-Type: application/zip`） |
| 下载体积 | **281,191,914 B**（sha256 `A492371D687D2BAB088B0062581144A0044B8964BAEFDF4FAA579292B423D25C`） |
| 版本 | `mysqld  Ver 8.4.11 for Win64 on x86_64 (MySQL Community Server - GPL)` |
| basedir | `D:\sy_workspace\.tools\mysql`（**仓库外**，`check-copy` 的体积/索引断言看不到它，也绝不会被误提交） |
| datadir | `D:\sy_workspace\.tools\mysql-data`（**仓库外**；绝不放进 `apps/api/data`，那会被打进 Docker 上下文） |
| tmpdir | `D:\sy_workspace\.tools\mysql-tmp`（**必须显式设**，见下） |
| 端口 | **3307**（避开 3306 可能被占） |
| 账号 | `root` **无口令**（`--initialize-insecure`，仅本机 127.0.0.1）+ 应用账号 `miwo`/`miwo` |
| 系统服务 | **无**。不注册 Windows 服务、**不开机自启**：`start` 起一个隐藏子进程，`stop` 关掉 |

⚠ **tmpdir 必须显式设**（本机实测）：用默认配置时 InnoDB 在 `%TEMP%` 建临时文件失败 ——
`[ERROR] [MY-012576] [InnoDB] Unable to create temporary file inside "C:\Users\…\AppData\Local\Temp"; errno: 13`
（该目录对本 shell 是可写的，所以这不是普通的权限问题）→ `--initialize-insecure` 直接中止。
把 `tmpdir` 指到我们自己的目录即可。

**一次性安装（幂等，已存在就跳过）**

> ⚠ 下面这段**必须**整段带着 `Test-Path` 守卫跑：解压出来的 `mysqld.exe` 已经在时**直接跳过**下载
> （zip 有 281 MB）。没有守卫的版本每次都会**重下 281 MB**，而且 `Move-Item` 到**已存在**的
> `$tools\mysql` 会直接失败（`Cannot create a file when that file already exists`）——
> 即"幂等"标签是假的。守卫判据用 `mysqld.exe` 而不是 `$tools\mysql` 目录本身：
> 上次失败留下的空目录/半解压目录不该被当成"装好了"。

```powershell
$ProgressPreference = 'SilentlyContinue'
$tools = "D:\sy_workspace\.tools"
$zip   = "$tools\mysql-8.4.11-winx64.zip"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
if (-not (Test-Path "$tools\mysql\bin\mysqld.exe")) {
  Invoke-WebRequest -Uri "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip" -OutFile $zip -TimeoutSec 1800
  Expand-Archive -LiteralPath $zip -DestinationPath "$tools\mysql-unzip" -Force
  Move-Item "$tools\mysql-unzip\mysql-8.4.11-winx64" "$tools\mysql"
  Remove-Item -Recurse -Force "$tools\mysql-unzip"
} else {
  Write-Host "already installed: $tools\mysql\bin\mysqld.exe"
}
& "$tools\mysql\bin\mysqld.exe" --version
```

⚠ `my.ini` **不在**上面这段里，必须**另行落盘**：`-Action init`（`--initialize-insecure`）会
`--defaults-file="$ini"` 读它，而 `mysql-local.ps1` 在文件不存在时**直接 throw**
（`options file not found: ...\my.ini`）。顺序是：先照下一节把 `D:\sy_workspace\.tools\my.ini` 写出来
（**纯 ASCII**，内容见下），再跑 `-Action init`。

**`D:\sy_workspace\.tools\my.ini`**（**纯 ASCII**；`mysql-local.ps1` 假定它已存在）

```ini
[mysqld]
port=3307
basedir=D:/sy_workspace/.tools/mysql
datadir=D:/sy_workspace/.tools/mysql-data
tmpdir=D:/sy_workspace/.tools/mysql-tmp
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone=+08:00
log-error=D:/sy_workspace/.tools/mysql-data/error.log
# local development: loopback only
bind-address=127.0.0.1
mysqlx=OFF

[client]
port=3307
default-character-set=utf8mb4
```

**起停 / 建库**（脚本在 `apps/api/scripts/mysql-local.ps1`；**纯 ASCII**，因为 PowerShell 5.1 按 ANSI 读 `.ps1`）

```powershell
cd D:\sy_workspace\code\miwo
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action init      # 只跑一次
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action start
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action status
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action createdb  # miwo_test + miwo + 账号
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action cli       # 交互式 mysql 客户端
powershell -ExecutionPolicy Bypass -File apps\api\scripts\mysql-local.ps1 -Action stop      # 跑完请停掉，别留常驻进程
```

实测输出：

```text
> -Action init      : initialize exit=0   （--console 把初始化日志打到终端；root@localhost is created with an empty password）
> -Action start     : mysql is listening on 127.0.0.1:3307
> -Action status    : listening=True
> -Action createdb  : createdb exit=0 ; db=miwo_test and miwo ; user=miwo
```

**本机 MySQL 的两种跑法**

```powershell
cd D:\sy_workspace\code\miwo\apps\api
$env:MIWO_ENV="dev"; $env:MIWO_PORT="10599"; $env:MIWO_HOST="127.0.0.1"
$env:MIWO_DATA_DIR="$PWD\data"; $env:MIWO_JWT_SECRET="dev-only-secret-at-least-32-bytes-long"
$env:MIWO_DB_DRIVER="mysql"; $env:MIWO_DB_HOST="127.0.0.1"; $env:MIWO_DB_PORT="3307"
$env:MIWO_DB_USER="miwo"; $env:MIWO_DB_PASSWORD="miwo"; $env:MIWO_DB_NAME="miwo_test"
pnpm.cmd run db:migrate:status
pnpm.cmd run db:migrate
```

⚠ **不新增任何 `MIWO_*` 连接变量**：上面这些变量在 `config.ts` 里**本来就有**；MySQL 的连接级不变式
（`charset=utf8mb4` / `timezone=+08:00` / `supportBigNumbers` / `bigNumberStrings` / `connectTimeout=5000`）
是**项目策略**、写死在 `src/db/connect.ts` 的 `DBCONFIG` 里，不开放成旋钮。

### 2. 迁移操作手册（**新增一条迁移**照这个顺序做）

> 这一节是 Task 12 定稿的**操作手册**：`db:generate` → 手工注册 → `up`/`down` → `status` → `migrate` → 回归。
> ⚠ 计划文本把它写成 `apps/api/README-db.md`，**该文件全仓不存在** —— 落点就是这里。

1. **生成骨架**：`pnpm.cmd run db:generate -- <kebab-case>` → 产 `src/db/migrations/NNN_<name>.ts`（序号自动取当前最大 +1）。
2. **手工注册**：把新文件 import 进 `src/db/migrations/index.ts` 的 `MIGRATIONS`，**追加到末尾** —— 脚本**不会**替你改。
   `MIGRATIONS` 的**数组顺序就是执行顺序**（knex 不排序，Task 2 已用断言钉住），`tests/migrations.test.ts` 断言"清单 ↔ 文件"一一对应。
3. **写 `up` / `down`**：`up` 只写结构；`down` 必须能**精确撤销** `up`（逐表逐列对称）。种子（若有）写"**只插不改**"，绝不写 `UPDATE`。
4. **看状态**：`pnpm.cmd run db:migrate:status` —— ⚠ 它**不是只读的**（见纪律 ②）。
5. **应用**：`pnpm.cmd run db:migrate`（幂等：已应用的条目靠 `knex_migrations` 跳过）。
6. **回归**：`pnpm.cmd exec vitest run tests/migrations.test.ts tests/migration-schema.test.ts tests/migration-ddl-mysql.test.ts`；
   有真 MySQL 时再加 `$env:MIWO_TEST_MYSQL="1"; pnpm.cmd exec vitest run` 与 `node scripts/verify-mysql-migration.cjs`（8/8）。

#### 迁移纪律（**四条** —— 违反会有人踩坑）

1. **"幂等"只到"迁移系统层面"**：靠 `knex_migrations` 跳过已执行条目，**不是** DDL 字面可重放。
   ⇒ **不要**给 `createTable` 加 `hasTable` 守卫（那会掩盖真实的**结构漂移**：dev 库被手工补过列、而迁移里没有）。
   只有对**老库**的兼容路径（退役表清理）才用真幂等守卫 `dropTableIfExists`。
2. **`--status` 也会写库**：`migrationStatus()` 先调 `migrate.list()`，它的 `ensureTable` 会建
   `knex_migrations` + `knex_migrations_lock` → **只读账号跑 `--status` 会失败**（knex 的行为，不是本项目的取舍）。
3. **`up(knex)` 拿到的那个 knex 必须用**：在 `up` 里改用外层 `db` 做 DDL 会与迁移事务争抢同一条连接/库锁，
   直到驱动超时失败（`MIWO_TEST_SLOW=1 pnpm test` 有一条 180s 的用例专门守这条约定）。
4. **schema 迁移只允许用 schema builder**（`knex.schema.createTable` / `dropTableIfExists` / `alterTable`），
   不得出现 `knex.raw` 或查询调用 —— `tests/migration-ddl-mysql.test.ts` 用一个"假 knex"收集编译出来的 DDL
   来断言 MySQL 合法性，而那条路径**只覆盖 schema builder**。另：**不许在 `up` 里 import app 的业务模块**
   （迁移要能在最小依赖下跑）。

⚠ 两条**运维必知**事实（超出四条纪律，但直接决定你还能不能回滚）：

- **库里出现清单外的迁移行时，`--status`/`--down`/`--redo` 全部硬报错**（knex `validateMigrationList`：
  `The migration directory is corrupt, the following files are missing: …`）
  → 回退代码版本后**连 `--down` 都不可用**（只能手改 `knex_migrations`，或先恢复代码版本再回滚）。
- **迁移清单是 prod 产物的一部分，不是磁盘目录**：prod 跑的是 esbuild 打出的单文件 `data/serve/app.js`，
  `MIGRATIONS` 被内存 `MigrationSource` 内联（磁盘迁移目录在容器里 ENOENT）⇒ **`knex migrate` CLI 不可用**是
  **有意取舍**，必须用 `db:migrate` / `db:migrate:status` / `db:migrate:down` / `db:generate` 这四个自建脚本。

#### prod 产物里的种子（`seed/` 必须跟产物一起走 —— 裁定 60）

`002_platform_seed` 用 `fs.readFileSync` 读 `seed/*.ndjson`（**不是 `import`**），所以 esbuild **不会**把它们打进 `app.js`。
该迁移的候选路径只有三条（`src/db/migrations/002_platform_seed.ts` 的 `SEED_DIR_CANDIDATES`）：

| # | 候选路径 | 谁来命中 |
|---|---|---|
| 1 | `path.join(__dirname, "seed")` → 产物旁 `data/serve/seed` | **不依赖 cwd**，容器里 `WORKDIR` 怎么设都命中 |
| 2 | `process.cwd()/src/db/migrations/seed` | **只有 dev**（cwd=`apps/api`）；容器里源码树不存在 |
| 3 | `process.cwd()/data/serve/migrations/seed` | cwd=仓库根时命中 |

⇒ `apps/api/scripts/build.ts` 在打包成功后会**两条都拷**（1 与 3），源目录缺失/为空则**直接 `exit 1`**
（在 `esbuild.build()` **之前**预检，连 `app.js` 都不产出 —— 不留"有产物、没种子"的半成品，那会在**生产才炸**）。
三条路径**一条都不命中时 `seedDir()` 抛错并指名尝试过的路径**（有意如此：绝不能静默地 seed 0 行）。

```powershell
cd apps\api
pnpm.cmd run build                                      # 日志会打印「已拷贝 seed/ → data/serve/migrations/seed/（4 个文件）」
Test-Path data\serve\migrations\seed\o_prompt.ndjson     # True
```

#### 回滚

- `pnpm.cmd run db:migrate:down`（回滚最近一批）
- `node --import=tsx scripts/db-migrate.ts --down --all`（全回滚；⚠ 必须在 `apps/api` 下跑，`tsx` 只装在 `@miwo/api`）
- ⚠ 回滚会 drop 表；先备份（`db:export` 或直接拷库）
- ⚠ **`--down --all` 不会删 `knex_migrations` / `knex_migrations_lock` 这两张基础设施表**（knex 自己的行为，
  不是本项目的遗漏）。所以"回滚干净"的判据是**业务表 0 张**，不是"库里一张表都没有"。
  本机真 MySQL 实测（Task 8 Step 5，三次 `SHOW TABLES`）：

  | 时点 | 表数 | 明细 |
  |---|---|---|
  | 迁移已应用 | **29** | 27 业务 + `knex_migrations` + `knex_migrations_lock` |
  | `--down --all` 之后 | **2** | 只剩那两张 `knex_*`（**业务表 0 张**） |
  | `db:migrate` 再 up 之后 | **29** | 27 业务 + 2 张 `knex_*` |

  → 下一个人看到"回滚后还有表"时**不要**手工 `DROP` 它们：那会让 `knex_migrations` 的记账与实际结构脱节
  （迁移系统会以为 001/002 从没跑过，而表已经建过 → 再 up 撞 `table already exists`）。
  另外：**回滚后重建的库里不会自动有老库数据** —— `--down` 是"撤销结构"，搬迁数据要靠
  `db:import --apply` 再灌一遍（顺序：`--down --all` → `db:migrate` → `db:import --apply` → `db:compare`）。

### 3. 老 sqlite 库怎么办（**不原地跑**；导出 → 导入 → 比对）

**不要在已有的 29 张表的老库上原地跑 `001_schema`** —— 它会 `createTable` 撞"表已存在"（症状与处置见下面「不支持在老库上原地跑迁移」一节）。
正确路径（Task 6 的工具链，**四条命令**）：

```powershell
cd apps\api
# ① 导出：只读源库 → NDJSON + manifest（含查重与 id 越界检查）。
#    ⚠ 输出目录**不得在仓库内**（默认拒绝）：o_setting.ndjson 里有真实 tokenKey（JWT 密钥）。
$out = "$env:TEMP\miwo-export"
pnpm.cmd run db:export -- --out=$out                                   # 推荐：产物落在仓库外
# 若确要在仓库内留产物：pnpm.cmd run db:export -- --out=<仓库内目录> --allow-repo-out（用完必须删）

# ② 目标库先迁移到最新（空库）：把 MIWO_DATA_DIR / MIWO_DB_* 指向目标
$env:MIWO_DATA_DIR="C:\Temp\miwo-target"; pnpm.cmd run db:migrate

# ③ 导入（默认 dry-run，先看报告；--apply 才写库）
pnpm.cmd run db:import -- --in=$out
pnpm.cmd run db:import -- --in=$out --apply

# ④ 比对（行数 + 均匀/边界两层抽样，逐行比全部列）
pnpm.cmd run db:compare -- --manifest=$out
```

回滚：`db:migrate:down --all`（或从 `D:\sy_workspace\.db-backups\` 恢复 sqlite 快照）。
上面的 5 个环节（导出/迁移/导入/比对/回滚）分别由 `scripts/export-sqlite.cjs`、`scripts/db-migrate.ts`、
`scripts/import-mysql.cjs`、`scripts/compare-db.cjs` 承担，核心逻辑在 `src/db/legacy/import.ts`。

> ⚠ **`db:export` 是"开发机工具"**（【Ruling 109/113/125】）：它靠 `tsx` + `001_schema` 推导长度上限，
> **不在生产镜像的运行路径上**（生产只跑 `data/serve/app.js`）。它的两大风险面都有硬护栏：
> ① 源库只读（前后 sha256 必须相等）；② **输出目录不得落在仓库内**（默认直接拒绝，除非命令行显式 `--allow-repo-out`）。

#### 数据库目标护栏（`apps/api/scripts/db-target-guard.cjs`）

会写库的命令行脚本（`db:migrate` / `db:migrate:down` / `db:repair-stuck` / `db:import` / `db:compare`）
都必须先过这道护栏。它有三条**故意不对称**的规则（全部是机制，不是提醒）：

| # | 规则 | 判别力（为什么会红） |
|---|---|---|
| ① | **意图用 MySQL 的脚本漏设 `MIWO_DB_DRIVER=mysql` → 立刻拒绝**，绝不静默回落 sqlite | 默认驱动是 `sqlite` + 默认数据目录是 `apps/api/data` ⇒ "根本没连 MySQL" 会被伪装成 "MySQL 有 bug"；Task 10 就因此写坏过 dev 库 |
| ② | **`up`/`down`/`rollback`/导入/比对默认不许打到仓库内 dev 库**（判据是**解析后的目标路径**，不是"你有没有写 `MIWO_DATA_DIR`"） | 显式写 `MIWO_DATA_DIR=./data` 解析出来**还是**那份 dev 库 —— 原来把它当豁免，等于"把同一件事多打了一遍" |
| ③ | **显式放行 = 显式承担 + 留下可恢复点**（【Ruling 139】）：给了 `--allow-repo-dev-db`（或 `MIWO_ALLOW_REPO_DEV_DB=1`）之后，护栏会先在**仓库外**备份目录（默认 `<仓库根>/../../.db-backups`，本机 = `D:\sy_workspace\.db-backups`）里找一份 **sha256 与当前 dev 库相同**的既有备份；找不到就现备一份并**校验拷贝的 sha256**。两条都做不到（目录建不出来 / 校验不一致）→ **仍然拒绝** | 本阶段 dev 库被误写 **3 次**（Task 10 一次、Task 11 两次：为做红绿，`--status` 真的把 29 表改成 31 表），三次都靠"**恰好**有 sha256 相同的备份"救回 —— 可恢复性不该交给运气。自证两端：无备份→先建可恢复点再放行；有备份→复用且不重复造；备份建不出来→拒绝 |

```powershell
cd apps\api
# ① 正常用法：把目标指向**仓库外**的一次性目录（无需任何放行开关）
$env:MIWO_DATA_DIR="$env:TEMP\miwo-target"; pnpm.cmd run db:migrate
# ② 确要动仓库内 dev 库：显式放行（护栏会先备份到 D:\sy_workspace\.db-backups\，并打印 sha256）
pnpm.cmd run db:migrate:status -- --allow-repo-dev-db
```

⚠ `--allow-repo-dev-db` / `MIWO_ALLOW_REPO_DEV_DB` 与 `--allow-repo-out` 都是**进程级一次性开关**，
**不是**新的 `MIWO_*` 配置变量（`config.ts` 不读它们、它们不影响任何配置派生）。

#### 手动点击测试：`pnpm.cmd run verify:manual-test`（Ruling 158 / 162 的落点）

> ✅ **Phase 1c Task 12 已修好这条通道**（Phase 1b deferred #16 关闭）。改前它在 HEAD 上**跑不起来**，
> 症状是拿旧快照当手动测试库（记账行只补到 `003_vendor_asset_sync`，于是 `migrate.latest()` 要跑
> `004_backfill_userid`，而那份快照缺 19 个 `userId` 列 ⇒ **`no such column: userId`** ⇒ 进程退出、不打印 URL）。
> 现在它是与 `verify:phase1b` 同口径的**正确形态**：
> **新库 `db:migrate`（001..006）→ `db:bootstrap-admin` 建一次性管理员 → 夹具种子 → 起服务 → 打印 URL**。
> ⚠ 它**不再导入**旧快照数据：旧数据搬迁是另一件事（见 `apps/api/README-auth.md` 的「升级顺序」；
> `db:import` 也拒绝往非空库里导）。它**从不打开** `apps/api/data/db2.sqlite`，并在第 [0/7] 步打印那个
> 文件的 sha256，好让"没碰它"这句话可核对。

阶段边界的验收口径是**"可以运行并且手动点击测试"**，不是"门禁绿"。这条命令就是那个口径的载体：
构建前端 → 接到后端站点目录 → 准备一份**可启动的数据库** → 起后端 → **打印可访问 URL + 四步人工清单**。

```powershell
# 仓库根运行；结束时按提示保留 URL，浏览器打开它
pnpm.cmd run verify:manual-test
# 停掉它自己起的那个进程（只停它记下的 PID，见下）
pnpm.cmd run verify:manual-test -- -Stop
# 换端口（默认 10688：10588 是 dev、18080 是局域网生产，占用它们会让就绪探测被别的进程回答）
pnpm.cmd run verify:manual-test -- -Port 10689
```

打开 URL 后按四步点（脚本末尾会**原文打印**这四步，含当次随机生成的管理员口令与邀请码）：

| 步 | 做什么 | 现在能不能成 |
|---|---|---|
| 1 | **登录**（管理员由 `db:bootstrap-admin` 当次建出，`mustChangePassword=1` ⇒ 先跳改密页） | ✅ 能（口令由脚本打印） |
| 2 | **注册第二个用户**（默认注册方式是 `invite` ⇒ 用脚本种下的邀请码） | ✅ 能 |
| 3 | **新建一个项目**（项目列表里另有脚本种下的示例项目 `id=900001`） | ✅ 能 |
| 4 | **看到媒体**（`oss/manual-test/demo.png` 的**签名直链**由脚本打印；同路径不带签名必须 403） | ✅ 能 |
| 附 | 刷新页面仍在线（HttpOnly refresh Cookie）/ 登出后旧 access 立即失效 | ✅ 能（API 级已由 `verify:phase1c` 的 D 组钉住） |

⚠ **如实登记：浏览器里"人点一遍"这件事本身仍未做**（Phase 1b 就登记过的 1b-16）：
本环境没有浏览器自动化框架，`apps/web` 也没有测试运行器。Task 12 做到的是
"**入口真的能起、页面真的能打开、清单真的可执行**"——"人在浏览器里点过"仍待人工执行。

脚本**打印的不只是 URL**：它还会 `GET /` 与构建产物里的每个 `.js`/`.css` 并逐条打印 HTTP 状态 ——
**"服务起来了"不等于"页面打得开"**，这一条是为了让"页面打得开"也有原文证据。

⚠ **两个必须知道的事实**（都是本机实测，脚本头注释里有完整理由）：

1. **手测跑的是仓库外一次性目录里的全新库，不是 `apps/api/data/db2.sqlite`。**
   那份 dev 库是**迁移时代之前的旧快照**（有真实数据、**没有 `knex_migrations`**），
   启动路径一跑 `migrate.latest()` 就会撞上 `table o_user already exists`，并把它写脏
   （这正是上面「不支持在老库上原地跑迁移」那条）。
   所以脚本在仓库外建一份全新库、跑完真迁移链，再用 `db:bootstrap-admin` 建当次管理员 ——
   **它根本不打开那份 dev 库**，sha256 全程不变。
   （历史：改前的手测口径是"拷一份旧快照 + 补 knex 记账行"，那条路在 `004` 上必死，已废。）
2. **`vite build` 必须让 `TMP`/`TEMP` 指向仓库外的自有目录**：用系统 `%TEMP%` 时 esbuild 会
   `remove C:\Users\…\Temp\esbuild-<hash>: Access is denied.` 而整个构建失败（同一个构建换个 TMP 就 exit 0）。
   脚本已自行处理；手动跑 `vite build` 遇到它按这条排查，不要当成前端代码坏了。

### 4. 本阶段已知的语义变化（不是 bug）

- 重启后**不再**把 `state='生成中'` 自动改判为失败（旧 `fixDB.ts` 已删除）→ Phase 1d 的队列租约超时接管；
  过渡期用 `pnpm.cmd run db:repair-stuck`。
- `o_prompt` 不再被启动期覆写（运营改动会保留）。
- `o_skillList` / `o_skillAttribution` 不再创建（迁移会 drop 掉老库里的这两张）。
- `userId` 列已建出但**未回填**（回填归 Phase 1b）。
- 全新库的 JWT 密钥来自配置 `MIWO_JWT_SECRET`（`o_setting.tokenKey` 不进新库）。
- **鉴权链路已改写**（Phase 1c Task 2+3）：`/api/auth/{register,login,refresh,logout,me,changePassword}` 上线，
  旧路径 `POST /api/login/login` **已在 Task 11 整体退役**（路由文件删除 + 白名单条目删除）：
  匿名打它 ⇒ **401**（`/api` 的鉴权在路由之前跑），带有效令牌打它 ⇒ **404**；
  **旧形状令牌（`{id,name}`）也已退役**（它不读 DB ⇒ 停用账号仍有效、`{id:1}` 恒为 admin）。
  令牌是 access(15min)+refresh(7d, HttpOnly Cookie)，
  口令是 argon2id，连续 5 次失败锁 15 分钟。验签密钥的优先级是 `o_setting.jwtSecret`（新）→
  `o_setting.tokenKey`（旧，仅兼容）→ `config.jwtSecret`（兜底），**每请求现读**（见 `apps/api/src/auth/secret.ts`）。

### 5. 测试（含**降级口径**与**验收基线**）

```powershell
cd apps\api
pnpm.cmd exec vitest run                 # 默认（无 MySQL）：所有 sqlite 用例；MySQL 集成用例**跳过**
$env:MIWO_TEST_MYSQL="1"; pnpm.cmd exec vitest run   # 真跑 MySQL（先 mysql-local.ps1 -Action start|createdb）
pnpm.cmd exec vitest run tests/mysql-integration.test.ts   # 只跑 MySQL 集成
$env:MIWO_TEST_SLOW="1"; pnpm.cmd exec vitest run          # 慢用例（约 60s）
```

**当前验收基线**（Phase 1c / Task 12 实测；口径数字若漂移请先查清是哪条断言变了，**不要**改数字了事）：

| 门禁 | 命令 | 期望 |
|---|---|---|
| 默认套件 | `pnpm.cmd exec vitest run`（`apps/api` 下） | **449 passed \| 10 skipped** |
| Phase 0 验收 | `node apps/api/scripts/verify-phase0.cjs` | **43/43** |
| Phase 1a 验收 | `pnpm.cmd run verify:phase1a` | **76/76**（本机口径；CI 用 `verify:phase1a:ci`） |
| Phase 1b 验收 | `pnpm.cmd run verify:phase1b` | **17/17**（另有 1 项 MySQL 口径**未实测**） |
| Phase 1c 媒体验收 | `pnpm.cmd run verify:phase1c-media` | **34/34** |
| **Phase 1c 验收** | `pnpm.cmd run verify:phase1c` | **45/45**（另有 1 项 MySQL 口径**未实测**、不计入通过数） |
| 生产构建 | `pnpm.cmd run verify:build` | EXIT 0（**`api build` 必须保持 0**；root 的 `pnpm run build` **不存在**，前端 47 条类型错误归 Phase 3） |

（上表在 Phase 1c / Task 12 逐条重测过。旧版本这里是 1a 的 140\|8 与 phase1a 60/60 ——
那些数字在 1b/1c 的十几个任务之后早已漂移；**数字必须来自实跑**，不要照抄。）

#### 降级口径：本机没有 MySQL 时怎么自证

不用装 MySQL 也能把**大部分**结论钉住（下面四条都不连服务端）：

1. **静态 DDL 断言**：`pnpm.cmd exec vitest run tests/migration-ddl-mysql.test.ts` —— 用"假 knex"（`knex({client:"mysql2"})`）
   把 `001_schema` 编译成 MySQL DDL 串，断言自增主键 / `varchar(191)` 主键 / 唯一键 / `tinyint` 等形状；
2. **类型装得下**：`pnpm.cmd exec vitest run tests/migration-column-fit.test.ts` —— 老库逐列实测值域
   （`tests/fixtures/legacy-column-stats.json`）vs 编译出的 MySQL 类型上界，判定复用生产函数 `outOfRangeValues` / `oversizeValues`；
3. **迁移机制**：`tests/migrations.test.ts` + `tests/migration-schema.test.ts`（在一次性 **sqlite** 库上真跑 up/status/down/幂等/退役表）；
4. **端到端验收**：`node apps/api/scripts/verify-phase1a.cjs`（A/B/D/E 组全在 sqlite 口径下成立；C 组跑导出→导入→比对，F 组才是真 MySQL）。
   ⚠ 它**证明不了**"全新 MySQL 库的结构对不对"：它建的是全新 **sqlite** 库，漏一列会两边**一致地错** —— 这正是上面 1/2 两条存在的原因。

**CI 的真 MySQL job 在哪**：`.github/workflows/ci.yml` 的 `mysql` job（**mysql:8.4 service container**，
`MIWO_TEST_MYSQL=1` + 独立库名，跑迁移往返 + 集成测试 + 搬迁链），结构由 `node tools/check-ci-yaml.cjs` 机械断言。
⚠ 如实登记：**真 GitHub runner 从未执行过它**（仓库无 remote），它目前只有"YAML 结构断言 + 本机等价命令"两层证据。

⚠ `MIWO_TEST_MYSQL` 是**测试门控**，不是应用配置：它**不进** `deploy/`，也**不能**写进 `apps/api/.env.example`
（**连注释行都不行**）—— `tools/check-deploy-config.cjs` 的规则 2 把「注释形式的声明」也算作"声明"，
而它不在 `config.ts` 里，于是 `pnpm.cmd run verify:deploy` 会报
「apps/api/.env.example 声明了 MIWO_TEST_MYSQL，但 config.ts 不读它」。（Task 12 实跑复现过；原文见 `task-12-report.md`。）

### 6. MySQL 特有行为（Task 7 首次真连的实测记录）

| 观察 | 实测输出 |
|---|---|
| 服务端字符集 / 排序规则 / 时区 | `utf8mb4` / `utf8mb4_0900_ai_ci` / `+08:00`（`@@version` 8.4.11） |
| `sql_mode` | `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`（**严格模式**：超长/越界会报错而不是静默夹断） |
| 表名大小写 | `@@lower_case_table_names = 1`（Windows）→ **表名按小写存储**：DDL 里是 `o_agentWorkData`，`information_schema` 回读 `o_agentworkdata`。Linux CI 上是 0。**比较表名要大小写归一** |
| `FLOAT(M,D)` 废弃 | `T.float()` → `float(8,2)`；建表时服务端给 `Warning 1681 Specifying number of digits for floating point data types is deprecated and will be removed in a future release.`（**只是 warning**，DDL 成功；库里现有 3 列：`o_segment.duration`/`videoDuration`、`o_shot.duration`） |
| 被索引的列不能是 TEXT | `t.text()` 在 mysql 是 `longtext`，**不能**出现在 primary key/index/unique 里（`ERROR 1170 ER_BLOB_KEY_WITHOUT_LENGTH`）→ 必须 `t.vstr()`（`varchar(191)`）。**静态 DDL 编译看不出这条**（SQL 串合法，是服务端语义校验）；`tests/migration-ddl-mysql.test.ts` 现在有一条机械断言兜它 |
| 保留字 | 本库列名与 MySQL 保留字的交集恰好 4 个：`DESC` / `DESCRIBE` / `INDEX` / `KEY`（= `o_agentDeploy.desc`、各表的 `key`）。knex 一律用反引号包裹 → 不受影响。裸写 `SELECT desc FROM o_agentDeploy` 报 `ERROR 1064` |
| `ALTER TABLE … ADD UNIQUE` 撞重复行 | `ERROR 1062 (23000) Duplicate entry '1791385147125-7-productionAgent' for key '…'`。**该 ALTER 是原子的**：唯一键没建出来、**两行都还在**（无部分写入）。所以"老库有重复行"必须在**导入前**查重拦下（Task 6 的 `preflightImport` 正是这么做的），而不是指望迁移报错 |
| `bigint unsigned` 读回的 JS 类型 | **`number`**（不是 string）—— `supportBigNumbers:true` + `bigNumberStrings:false` 生效，`o_project.id = 1791385147125` 原样往返；只对 **> 2^53-1** 的值不安全（本项目的 id 都是 `Date.now()` 毫秒值，离 2^53 很远） |
| 批量 insert 的 `insertId` | 单行 → `[1]`；两行 → `[2]`（**首行**的 id，sqlite 会是末行 3）。`tests/mysql-integration.test.ts` 把这条差异钉住了 |
| `knex_migrations*` | `knex_migrations`（`id int unsigned auto_increment`，knex 内部实现）+ `knex_migrations_lock` 是**两张基础设施表**，不在 27 张业务表里 → Phase 1b 的 `policies.ts` 必须显式声明它们，否则 fail-closed 的策略检查会在任何碰它们的代码上报错 |
| **`utf8mb4_0900_ai_ci` 下 SQL `=` 大小写不敏感**（合并审查修复 1 实测） | 服务端 collation 是 `utf8mb4_0900_ai_ci`（`ai`=accent-insensitive、`ci`=**case**-insensitive）。实测：`'EVENTEXTRACTION' = 'eventExtraction'` → **1**；`BINARY 'EVENTEXTRACTION' = 'eventExtraction'` → **0**。在真表上更能说明后果：`t` 为 `utf8mb4_0900_ai_ci` 的列里放 `'a'`/`'A'`/`'a '`，`WHERE t = 'a'` 命中 **2 行**（`'a'` 与 `'A'`）。→ **任何"用 SQL `=` 判两条记录是否同一形态"的代码都必须显式用 `BINARY`**（`002_platform_seed.down` 原来就是这样误删"只改了大小写"的种子行，现已加固）。附带事实：`WHERE t = 'a'` **不**匹配 `'a '`（0900 系列是 NO PAD，尾随空格在**列 vs 值**比较里是有意义的 —— 所以那条尾随空格的行在旧判据下**本来就会存活**）；但两个**字面量**相比（`'a ' = 'a'`）在本机 mysql CLI 上返回 1，因为那走**连接** collation `gbk_chinese_ci`（PAD SPACE）—— 别拿字面量实验当结论 |
| **`information_schema` 的 `AUTO_INCREMENT` 是缓存值**（合并审查修复 3 实测） | `@@information_schema_stats_expiry = 86400`（秒）。实测（本机 8.4.11）：`INSERT 3 行 → ALTER TABLE ai AUTO_INCREMENT = 4` 后查 `information_schema.tables` = **4**；再 `DELETE FROM ai; ALTER TABLE ai AUTO_INCREMENT = 1;` 后**仍然报 4**，而**真实**下一条插入的 `id` 是 **1**；`ANALYZE TABLE ai` 之后才刷新成 2。→ **断言不许读可能被缓存的元数据**：`tests/mysql-integration.test.ts` 原来用 `information_schema.tables.AUTO_INCREMENT >= 4` 断言"计数器被钉高"，近乎恒真；现在改成**读真实插入行为**（非空 + `ALTER=1` → 下一条 `id=4`；`del` + `ALTER=1` → `id=1`） |

## 租户隔离（Phase 1b 起）

### 1. 唯一入口：`u.db` 是守卫

- 拿不到 ctx 访问租户表 → **`TenantContextError`**（fail-closed：不返回空集、不静默放行）；表没在
  `apps/api/src/db/policies.ts` 声明策略 → **`PolicyNotFoundError`**。
- **自动注入**：主表的 `userId` 条件、join 的 ON 子句条件、`insert` 的 `userId`；显式写**别人的** `userId` → 抛
  （越权 `insert` 的抛错发生在**执行期**，不是构造期 —— 用例里要 `await expect(...).rejects`）。
- **会绕过注入的写法在租户查询上一律抛**：`orWhere*` 前缀 + `apps/api/src/db/tenant-guard.ts` 的
  `WIDENING_METHODS`（`with*/union*/having*/whereRaw/joinRaw/crossJoin` 等）。`raw` 只在"语句里**不含租户表名**"时放行
  （纯表达式，如 `GROUP_CONCAT(n.chapterIndex)`）；一旦语句提及租户表就抛。
- **表策略**（`node tools/check-tenant-policies.cjs` 会比对三方）：`tenant` **20 张**、`platform` **9 张**
  （读放行、写仅 admin）、`global`（读放行、写一律拒；本阶段没有表使用）；另有退役 2 张 + `knex_migrations*` 2 张
  显式声明为 platform（fail-closed 的必需项）。
- 平台写权限目前靠**临时桥接**：`userId === 1` 视为 admin（`o_user` 还没有 role 列；Phase 1c 换成 `o_user.role`）。

### 2. 唯一绕过口：`systemDb`

- `apps/api/src/utils/db.ts` 的**命名导出** `systemDb` 是裸 knex。使用者必须登记进
  `apps/api/src/db/tenant-exceptions.json` 的 `systemDbUsers`，否则 `pnpm verify:exceptions` 会红；判据与
  **specifier 形态解耦**（命名 / 别名 `as x` / 命名空间 `import * as m` + `m.systemDb` / 相对路径 / 动态
  `await import()` / `require()`）。
- 旧的裸 `import { db } from "@/utils/db"` 已删除，**出现即红**（`bareDbImports` 必须为空）。

### 3. `userId` / `memories` 键回填（`004_backfill_userid` + CLI）

```powershell
cd apps/api
New-Item -ItemType Directory -Force D:\tmp\miwo-backfill | Out-Null   # 目录必须先存在（sqlite 不会替你建目录）
$env:MIWO_DATA_DIR = "D:\tmp\miwo-backfill"          # ⚠ 仓库内 dev 库会被护栏拒绝；这是正确行为
node --env-file-if-exists=.env --import=tsx scripts/db-migrate.ts                               # 先把库迁到最新
node --env-file-if-exists=.env --import=tsx scripts/backfill-userid.ts                          # 默认 DRY-RUN（不写库）
node --env-file-if-exists=.env --import=tsx scripts/backfill-userid.ts --apply                  # 才写库；**幂等**（第二次 0 行）
node --env-file-if-exists=.env --import=tsx scripts/backfill-userid.ts --apply --assign-to=1    # 把孤儿显式归给 userId=1
```

> `--env-file-if-exists=.env` 是必需的：`src/config.ts` 是**模块级 fail-fast**（缺 `MIWO_ENV`/`MIWO_PORT`/`MIWO_JWT_SECRET`
> 等直接抛错）；`$env:MIWO_DATA_DIR` 这类**已存在的环境变量优先于 `.env`**，所以两者可以一起用。

- 20 张表的 `userId` 按归属链回填；`memories.isolationKey` 用**同一份** `buildIsolationKey` 改写成
  `${userId}:…`（唯一真相 = `apps/api/src/db/isolation-key.ts`，socket 侧也是 re-export 它）。
- **孤儿**（推不出归属，如项目 `userId` 为 NULL 的子行）默认**留 NULL** ⇒ 对任何租户都不可见；报告会点名，
  要归属必须显式 `--assign-to`。**多义**行（`o_event` 挂多个项目）不写。
- 运维步骤（备份 → dry-run → apply → 自检表怎么读）、`down` 为何是 no-op：见
  **[`apps/api/README-db.md`](apps/api/README-db.md)** §2/§8。

### 4. 门禁与验收（Phase 1b）

```powershell
pnpm verify:exceptions     # 特例清单 ↔ 代码（systemDb 形态 / 裸 db / 每条 phase1b 处置与证据）
pnpm verify:policies       # 策略表 ↔ 001_schema ↔ 回填目标/自检 三方一致（复用导出常量，无第三份清单）
pnpm verify:phase1b        # Phase 1b **唯一验收命令**（真 HTTP；带空转护栏；MySQL 口径显式标"未实测"）
node tools/tenant-redend.cjs   # 11 项红端可复现（隔离副本 + VCS 还原；观测不到就 exit 3）
```

- **MySQL 侧一律未实测**（本机 3307 独占、不启动）：`information_schema` 方言、`insertId` 语义、
  `GROUP_CONCAT` 截断、`afterCreate` 真被调用 —— 只能由 CI 的 mysql job（`MIWO_TEST_MYSQL=1`）作证。
  已落地的是**连接级** `group_concat_max_len`（`src/db/connect.ts` 的 `mysqlAfterCreate`，走 `conn.promise()`；
  callback 版 mysql2 直接 `await` 会抛 ⇒ 那曾是"MySQL 全路径不可用"的 P0）。
- 测试基线：`cd apps/api; pnpm exec vitest run` ⇒ **292 passed | 10 skipped**（10 条 skipped 里 8 条是既有门控、
  2 条是 MySQL 口径）。

### 5. 本阶段**未处置项**（明确交接，不是"已完成"）

| # | 未处置的事（现状） | 为什么本阶段不做 | 归属 |
|---|---|---|---|
| 1 | 运维接口的**"默认关闭 / 表名与列白名单 / 脱敏导出"三件套**：`clearTable` 只校验"表存在"、`importData` 无表名/列白名单、`exportData` 仍是**全量备份**（含 `o_user.password`、`o_vendorConfig.inputValues`） | 本阶段只做"立即 fail-closed 的子集"= **收权**（无 token 401 / 非 admin 403）；脱敏会破坏"恢复备份后登录/供应商配置"，属功能取舍 | Phase 1c |
| 2 | `routes/setting/agentDeploy/getAgentDeploy.ts` **尚未挂 `requireAdmin`** ⇒ 任意登录用户仍可读供应商配置（key 明文） | 该路由不在 Task 7 处置的 6 个运维接口里；platform 表不需要租户条件，缺的是授权 | Phase 1c |
| 3 | `POST /api/other/deleteAllData` 已**无条件停用**（501，连 admin 也打不动）；"修好（带审计/双人确认）vs 彻底删除"未定 | 修好 = 让最危险的操作从"坏的"变成"活的"；删除文件/挂载会让三个门禁一起漂 | Phase 1c/2 决策 |
| 4 | `check-tenant-exceptions` 的 `phase1b.evidence` **只校验测试文件存在**，不校验用例名（改名/删用例不会红） | 要校验用例名需解析测试文件；属门禁增强 | Phase 1c |
| 5 | `requireAdmin` 的**"无 ctx → 401"分支没有独立用例**（真实链路里无 token 先被鉴权 401 拦下） | 该分支只在"有 token 但没建 ctx"时可达；本阶段用中间件单测覆盖语义 | Phase 1c 补 |
| 6 | **没有真正的账号体系 / 审计**：`o_user` 无 `role`（admin 靠 `userId===1` 桥接）；`--assign-to` 与运维接口访问都**不写审计日志** | 需要 schema 变更（`o_user.role`、`o_auditLog`），超出"隔离"范围 | Phase 1c |
| 7 | 前端仍发送死的 `isolationKey` 字段 | 服务端已**完全忽略**它；清理属前端轮 | 前端轮清理 |
| 8 | `firstProjectIdInFlowData` 只认 **≥6 位**数字 | **刻意设计**：真实 id 是 13 位 `Date.now()`；放宽会误伤 `oss/300/a.png` 这类相对路径 | 不改（登记） |
| 9 | `o_vendorConfig.volcengine.enable` **不搬迁** | 预裁定（Phase 1a 账本 Ruling 103） | 已裁定，不做 |
| 10 | **媒体仍匿名可取**（`/oss` 在鉴权之前） | 本阶段闭合的是"经 API 越权拿到**数据**"，不是"猜到 URL 直接取文件" | Phase 1e |

### 6. 收尾修复轮（Phase 1b 终审后）与 deferred 更正

**已在本轮修掉（终审抓到的"本机绿、真实路径坏"第 4 例）：**

- **`order by \`rowid\` asc`（4 个生产路由）**：`rowid` 是 **SQLite 隐式列**，MySQL 没有 ⇒ `ER_BAD_FIELD_ERROR`，
  正好压在"分镜资产顺序 → 图片/视频提示词"核心链上（sqlite 全绿、MySQL 500）。
  已改为显式列 `assetId`（关联表只有 `(storyboardId, assetId, userId)`，没有 createTime/id ⇒ 这是唯一确定性排序）。
  **新增类别级门禁 `node tools/check-mysql-dialect.cjs`**（`pnpm verify:mysql-dialect`，已进 CI + `check-ci-yaml`）：
  `apps/api/src` 剥注释后出现 `rowid`/`_rowid_` 即红；`routes/**` 里 `select` 的裸列名必须落在 `groupBy` 里
  （含 `.raw(` 的文件只警告）。红端：注入 `orderBy("rowid")` ⇒ 红；注入未分组列 ⇒ 红。**未连真机**，只用 `toSQL()` 离线编译。
- **`routes/task/getProject.ts` 的 `select("id","name").groupBy("name")`** ⇒ MySQL 8 `ONLY_FULL_GROUP_BY` 是 `ER_1055`；
  已改成 `select("name").min("id as id").groupBy("name")`（保持"每个 name 一行"的原语义，且现在**确定**）。
- **`/api/setting/agentDeploy/*` 家族 6 个端点全部收权**（此前 6 个都没挂 `requireAdmin`，其中 `agentSetKey` 是**写供应商 key** 的接口）：
  无 token 401 / 普通 token 403 / admin 200，且普通 token 打完**直读数据一行未改**（`tests/ops-endpoints-auth.test.ts`）。
  红端：拿掉**读**端点的 `requireAdmin` ⇒ 普通 token 直接 **200 并吐出供应商模型配置**。
  ⚠ 注意判别力细节：6 个端点里**写**端点本来就会被守卫的 `platform` 写规则挡成 403（纵深防御），
  所以"拿掉 `requireAdmin` ⇒ 红"的**唯一可判据点**是**读**端点（`getAgentDeploy`/`getAgentUseMode`）。

**deferred 更正（此前登记有误/已过期）：**

| 原编号 | 更正 |
|---|---|
| #2（`getAgentDeploy` 未收权） | **已修**，且原描述不准：它只 `select o_agentDeploy.*`；真正的高危项是**同家族 6 个端点**，含 `agentSetKey`。见上。 |
| #11（媒体匿名可取） | **重标为"上线前安全项"**（不是"已处置"）：`/oss` 在鉴权之前 ⇒ 猜到 URL 就能取文件。归 **Phase 1e**。 |
| #14（`o_modelPrompt.{fileName,path}` 需改回 `text`） | **已过期**：HEAD 里两列都已是 `t.text`（MySQL → longtext）⇒ 已解决，永久忽略。 |
| #15（`o_agentWorkData.data` 是 `varchar(255)`） | **已过期**：HEAD 里已是 `t.text` ⇒ 已解决，永久忽略。 |
| 新增 #16 | ~~**`verify:manual-test` 当前跑不起来**~~ ⇒ ✅ **Phase 1c Task 12 已修**：`scripts/manual-test.ps1` 重写为"仓库外新库 `db:migrate` → `db:bootstrap-admin` → 夹具种子 → 起服务 → 打印 URL + 四步清单"，`node scripts/seed-manual-test.ts` 是它的夹具种子。**浏览器里人点一遍仍未做**（登录页那条失真提示文案也已在 T12 一并修掉）。 | T12 |
| 新增 #17 | **`o_assets2Storyboard` 缺少显式排序列**：本轮为了 MySQL 兼容，把"SQLite 插入序（rowid）"改成按 `assetId` 排 —— 语义上**不等价**。要恢复真正的"用户挂载顺序"需要加 `sortIndex` 列（迁移 + 写入端）⇒ **Phase 1c**。 |
| 新增 #18 | `apps/api/src/utils/getConfig.ts:42` 的 `u.db("t_config")` 是**死路径**（`t_config` 既不在策略表也不在 `001_schema`）⇒ 调用必抛 `PolicyNotFoundError`；本轮**只登记不改**（`src/utils/**` 不在 writeScopes），**Phase 1c** 删除或改接平台表。 |
| 新增 #19 | 并发隔离目前只有 20 路 `Promise.all` 的等价证据（`tests/tenant-isolation-http.test.ts` 的 U4 用例），**没有**压测/长连接/多进程证据 ⇒ 需要时在 Phase 1e 补。 |

## 迁移纪律（spec §5.2）

- 迁移清单是 `apps/api/src/db/migrations/index.ts` 的 `MIGRATIONS`（**顺序即执行顺序**），每条迁移对应同目录下一个
  `NNN_name.ts`（`apps/api/tests/migrations.test.ts` 断言"清单 ↔ 文件"一一对应）。已执行的条目**不要删、不要改名** ——
  名字会写进 `knex_migrations.name`，改名等于重跑。
- **`up(knex)` 拿到的那个 knex 必须用**：knex 默认把一条迁移包在事务里，在 `up` 里改用外层 `db` 做 DDL 会与迁移事务
  争抢同一条连接 / 库锁，直到驱动超时失败（`MIWO_TEST_SLOW=1 pnpm test` 有一条 180s 的用例专门守这条约定）。
- **schema 迁移只允许用 schema builder**（`knex.schema.createTable` / `dropTableIfExists` / `alterTable`），不得出现
  `knex.raw` 或查询调用 —— `apps/api/tests/migration-ddl-mysql.test.ts` 用一个"假 knex"收集编译出来的 DDL 来断言
  MySQL 合法性（本机没有 MySQL 服务端时的替代口径），而那条路径只覆盖 schema builder。
- **这里的"幂等"指"迁移系统层面幂等"**（靠 `knex_migrations` 跳过已执行条目），**不是** DDL 字面可重放：`createTable`
  在表已存在时会抛。**不要**给 `createTable` 加 `hasTable` 守卫 —— 那会掩盖真实的**结构漂移**（例如 dev 库被手工补过列、
  而迁移里没有）。只有对**老库**的兼容路径（退役表清理）才用真幂等守卫 `dropTableIfExists`。
- ⚠ 本机的 sqlite 回归网**证明不了**"全新 MySQL 库的结构对不对"：它建的是全新 sqlite 库，漏一列会两边**一致地错**。
  `apps/api/scripts/gen-schema-migration.cjs`（只读 dev 库、把"现状真有哪些列"打出来、不写任何文件）是防止手写迁移漏列的
  机械闸门；逐表核对口径与结论见 `.superpowers/sdd/2026-10-12-miwo-phase1a-mysql-migrations/task-3-report.md`。
- ⚠ 上一行的闸门只守"**列在不在**"，守不住"**类型装不装得下**"（`int` 列装 `Date.now()` 毫秒值、
  `varchar(255)` 装 10 万字符的 JSON —— 这两种在 sqlite 上都看不出来：严格模式直接 `Out of range` /
  `Data too long`，非严格模式**静默夹断**（写坏数据））。这条由 `apps/api/tests/migration-column-fit.test.ts`
  机械守：**老库逐列实测值域**（`apps/api/scripts/gen-legacy-column-stats.cjs` 只读记录到
  `apps/api/tests/fixtures/legacy-column-stats.json`，含源库 sha256；老库快照不入库，所以 CI 上判据仍然非空转）
  vs `001_schema` 编译出的 MySQL 类型上界 / 字符上限，判定复用生产函数 `outOfRangeValues` / `oversizeValues`。
  **加列 / 改类型 / 换老库快照时必须让它绿**；另外同名整数列（`projectId` / `userId` …）在整个 schema 里
  必须只有一种 mysql 类型 —— 否则"装同一批毫秒值"的列里必然有一张表装不下。理由与实据见
  `.superpowers/sdd/2026-10-12-miwo-phase1a-mysql-migrations/task-6-report.md` 的「修复轮 1」。
- 常用命令都在 **`apps/api` 下跑**（`tsx` 只装在 `@miwo/api` 的依赖里，在仓库裸跑会 `ERR_MODULE_NOT_FOUND`）：
  `pnpm.cmd run db:migrate` / `db:migrate:status` / `db:migrate:down`；`MIWO_DB_DRIVER=mysql` 时连 MySQL。
  ⚠ `--down` / `--redo` **会重建所有表、破坏数据**：先在一次性库上试（把 `MIWO_DATA_DIR` 指到 `%TEMP%` 下的空目录）。
- **启动路径（Phase 1a / Task 4 起）**：应用启动时先 **连接 → 跑迁移**，**迁移完成才监听端口**
  （`src/db/connect.ts` 的 `connect()` ← `src/utils/db.ts` 导出的 `dbReady` ← `src/app.ts` 在 `server.listen` 之前
  `await dbReady`）。旧实现的"未被 await 的 IIFE 里跑 `initDB` + `fixDB`"已删除；
  ⚠ **【Phase 1c Task 5 更新】`initDB.ts` / `fixDB.ts` / `core.ts` 已从仓库删除。**
  原文写"两个文件仍在仓库里，只为 `tools/check-copy.cjs:94` 的构件断言存在" —— 那两个文件与
  那条"必须存在"断言在同一个 Task 里一起删掉了（`check-copy` 的 `.ts` 下限同步 235 → 267）。
  ⚠ **【L1 更正】更早的原文写"只为 `verify-phase0.cjs` 的构件断言存在"—— 那也是过期的**：
  `verify-phase0.cjs:179` 早在 Phase 1a / Task 11 就换成了 `apps/api/src/db/migrations/index.ts`。
  这条不变式由门禁 **`node tools/check-dead-ddl.cjs`**（`pnpm.cmd run verify:dead-ddl`）守住：它从 `src/app.ts`
  出发走 import 图，链上出现 `initDB`/`fixDB` 的**代码级**引用就报红（Task 5 起豁免清单为**空**）。

### ⚠ 不支持"在老库上原地跑迁移"（症状 → 原因 → 怎么做）

- **症状**：在已有一套旧表（本机 `apps/api/data/db2.sqlite`，实测 30 张表、**没有** `knex_migrations`）的库上
  启动应用或跑 `db:migrate`，报 `table o_user already exists`（或任何 `already exists`）。
- **原因**：`001_schema` 用 `createTable` 建基线表结构，而迁移的"幂等"只靠 `knex_migrations` 跳过**已执行过**的条目 ——
  老库没有这张表，于是 `001_schema` 被当成"待执行"，一建表就撞名。这是**设计如此**，不是迁移写错
  （给 `createTable` 加 `hasTable` 守卫会掩盖结构漂移，见上一条）。
- **怎么做**：
  - a) **推荐（部署路径）**：把老库数据导入一个**空** MySQL 库 —— 先让迁移把表结构建出来，再灌数据
    （`scripts/export-sqlite.cjs` + `scripts/import-mysql.cjs`，Task 6 产出）。
  - b) **本机继续用 sqlite**：**不要**对 `apps/api/data/db2.sqlite` 跑启动路径/迁移。要留这套老库做回归就把它当只读样本；
    回归网（`apps/api/tests/**`）与 `verify-phase0.cjs` 用的都是**新建的一次性库**（后者把 `MIWO_DATA_DIR` 指到 `%TEMP%` 下的空目录，**不碰** dev 库）。
- **`apps/api/data/db2.sqlite` 的 sha256 是一条硬约束**：任何验收/回归都不许改写它（本 Task 前后实测一致）。
- ⚠ **`verify-phase0.cjs` 现在跑的是"空库 + 迁移"**（Phase 1a / Task 5 起）：它在一次性目录里先 `db:migrate`
  （`001_schema` 建表 + `002_platform_seed` 种平台数据），然后**就地只读断言**种子真的落地
  （迁移名册、`o_prompt` 4 行、`o_agentDeploy` 19 行、`o_setting` 只有平台键、`o_vendorConfig` 8 个空模板），
  最后才起应用、轮询、收尾。
  - 它**不再需要** Task 4 那段临时脚手架（`apps/api/scripts/verify-phase0-seed-min.ts`）—— 该文件与其调用点
    已随 Task 5 删除（断言**只增不减**：27/27 → 31/31 → **36/36**（Task 5）→ 41/41（Task 10）→ **43/43**（Task 11），
    用"种子四张表都落地 + 库里没有 tokenKey"取代了原来的"种了 tokenKey 就能起服务"）。
    当前口径见 §5 的「当前验收基线」表。
  - ⚠ `o_setting.tokenKey` **不进新库**（`002_platform_seed` 有一条显式断言兜住它）：JWT 密钥取自配置
    `MIWO_JWT_SECRET`。把密钥从库里搬进配置正是 spec §6.2 / Phase 1c 的方向，所以"新库里没有 tokenKey"
    是**预期状态**。⚠ **Phase 1c Task 3 更新**：链路抽到 `apps/api/src/auth/secret.ts`（HTTP 与 socket 共用），
    优先级 = `o_setting.jwtSecret`（新位置，显式轮换用）→ `o_setting.tokenKey`（旧位置，老库/夹具仍可能有）→
    `config.jwtSecret`（兜底）；`tests/auth-token-key.test.ts` 的 R1/R2/R3 把这三档逐条钉住。

### 真实数据搬迁（导出 → 导入 → 比对）与**回滚语义**

> 登记落点就是本节（根 `README.md`）**与** `apps/api/src/db/legacy/import.ts` 的文件头 ——
> 这条约束必须随代码走：`.superpowers/` 里的计划文本是 git-ignored 的，不能作为唯一载体。
> 三个脚本挂在 `apps/api/package.json`（`tsx` 只装在 `@miwo/api`，根 `package.json` 里跑不了 `--import=tsx`）。

```powershell
cd apps\api
# ⚠ 输出目录**不得落在仓库内**（Task 12 / Ruling 113·125 起默认直接拒绝）：产物含真实 tokenKey。
$out = "$env:TEMP\miwo-export"
pnpm.cmd run db:export -- --out=$out                                        # SQLite → $out/*.ndjson + manifest.json
$env:MIWO_DATA_DIR="C:\Temp\miwo-target"; pnpm.cmd run db:import -- --in=$out              # dry-run（默认不写）
$env:MIWO_DATA_DIR="C:\Temp\miwo-target"; pnpm.cmd run db:import -- --in=$out --apply      # 真的写
pnpm.cmd run db:compare -- --manifest=$out                                  # 行数 + 抽样单元格深比较
# 确要在仓库内留产物（会留 tokenKey）：加 --allow-repo-out，用完**必须**删掉并 `Test-Path` 复核 False
```

- **搬迁链三步**：`scripts/export-sqlite.cjs`（只读源库 → NDJSON + manifest）→
  `scripts/import-mysql.cjs`（默认 dry-run；`--apply` 才写）→ `scripts/compare-db.cjs`（比对）。
  导入的核心逻辑在 `src/db/legacy/import.ts`（可单测，见 `tests/legacy-import.test.ts`）。
- ⚠ **导出对源库只读**：脚本以 `{ readonly: true }` 打开 SQLite，并断言**导出前后源库 sha256 相等**、
  未新出现 `-wal`/`-shm`/`-journal` 伴随文件；不满足就退出码 1。
  `apps/api/data/db2.sqlite` 的 sha256 是硬约束，任何验收都不许改写它。
- ⚠ **用户机真实库（`%APPDATA%\ToonFlow\data\db2.sqlite`）不在搬迁范围**：脚本对它**硬拒绝**
  （连只读打开都不做）。搬迁只针对仓库里的 dev 库快照。
- ⚠ **导出物是机密**：`o_setting.ndjson` 里有老库那一行**真实 `tokenKey`（JWT 密钥）**、
  `o_vendorConfig.ndjson` 的 `inputValues` 里存着真 API key。所以
  **① 输出目录默认不许落在仓库内**（Task 12 / 【Ruling 113·125】：`export-sqlite.cjs` 解析出目标在仓库内就
  **直接拒绝**，除非命令行显式 `--allow-repo-out`；本阶段已经因为"产物残留在仓库里"出过一次事故）；
  **② `apps/api/.tmp-migrate/` 已被 gitignore**（见 `.gitignore` 的说明），但它**不是加密** —— 用完即删，
  删完用 `Test-Path` 复核 False（只写"已清"不算证据）。
- **导入的四条硬闸门**（任一不满足即拒绝，见 `import.ts` 的 `preflightImport`）：
  ① manifest 的 `duplicates` / `badIds` 必须为空；② 目标库必须已有全部表；
  ③ 目标库的**业务表必须全空**（四张平台种子表例外，见下）；④ **目标列表示不了的值**在 MySQL 目标下阻断。
- ⚠ **两条"只在真 MySQL 暴露"的真实缺口**（Task 6 实跑体检结果；**`001_schema` 本 Task 不改**）：
  1. **超长文本**：老库 `o_agentWorkData.data`（productionAgent 的 JSON）**最大 103,624 字符 / 5 行超 255**、
     `o_tasks.relatedObjects` **最大 614 字符 / 2 行超 255**，而 `001_schema` 里这两列是 `varchar(255)` ——
     sqlite 不强制长度所以看不出问题，**真 MySQL 严格模式会 `Data too long for column`**。
  2. **越界数值**：`o_segment.projectId` / `o_shot.projectId` 在 `001_schema` 里是 `int`，
     而老库这两列存的是 `o_project.id`（= `Date.now()` 毫秒值，实测 **1791385147125**）——
     MySQL 的 `int` 上限 2147483647 → 严格模式 `Out of range value`，非严格模式**静默夹断**（数据损坏）。
     sqlite 的 INTEGER 是 64 位，本机永远看不出问题。
  3. `memories.isolationKey` 收窄到 `varchar(191)`（老库 TEXT）：实测最大 31 字符 → **安全**。
  - ⚠⚠ **Task 12 更正（这段文字记录的是 Task 6 当时的状态，后来已被修复轮改掉）**：上面第 1、2 条
    **已经不在 `001_schema` 里成立了** —— 现在 `o_agentWorkData.data` / `o_tasks.relatedObjects` 是 `t.text()`
    （MySQL `longtext`）、`o_segment.projectId` / `o_shot.projectId` 是 `t.u64()`（MySQL `bigint unsigned`）。
    机械守卫：`tests/migration-column-fit.test.ts` 的判据 B/C（老库实测值域 vs 编译出的目标类型，
    当前实测 `扫描 27 张表 / 226 列 → 越界 0 / 超长 0`）与 `tests/migration-schema.test.ts`。
    **这段"缺口"保留在文档里是因为 preflightImport 的两条闸门（`oversize-value` / `numeric-overflow`）仍然存在且必须存在** ——
    换一列、换一次老库快照就会重新有值可报，闸门不该随"当前恰好没有超长值"而删。
  - 这两类都在**写入之前**由 `preflightImport` 报出来（`oversize-value` / `numeric-overflow`）：
    sqlite 目标只登记（不阻断），MySQL 目标阻断。`--allow-oversize` 是"已确认可丢"的显式开关
    —— **整行丢弃并逐条登记，绝不截断、绝不夹断**（`expectedAbsent` 里可逐条复核）。

**导入与回滚的语义（Task 5 交接条款，改导入策略前先读这里）**

1. **导入必须"跳过已存在"，不得 upsert / replace / 清表重灌。**
   四张平台表（`o_prompt` / `o_agentDeploy` / `o_setting` / `o_vendorConfig`）在 `002` 之后
   **已经有行**：同身份键（`type` / `key` / `key` / `id`）的行一律跳过 —— 包括内容不同的那些
   （导入报告会给出 `skippedDifferent` 计数，**不静默**）。
   `o_agentWorkData`（唯一键）与 `o_segment`（唯一键）在导入前必须查重，重复即拒绝。
2. **`o_setting.tokenKey` 绝不导回目标库**：老库那一行留在老库里（见上一条的断言）。
3. **回滚语义**：`002_platform_seed` 的 `down` 只删"**仍是本仓库种子那一行**"的记录 ——
   判据是种子行的**全部列逐列精确相等**，且**与 collation 无关**（mysql 侧 `BINARY ?? = ?`、
   sqlite 侧 `?? COLLATE BINARY = ?`，见 `002_platform_seed.ts` 的 `whereExact()`）。
   ⚠ 这里**不能**写成"逐字节相同"：非文本列走的是数值比较（`BINARY intcol = 4` 在 MySQL 里
   仍是数值相等）。而"必须与 collation 无关"不是洁癖 —— 本机 collation 是
   **`utf8mb4_0900_ai_ci`**，SQL `=` **大小写不敏感**：加固前"只把大小写改掉"的种子行会被
   `down` **删掉**（真实的数据丢失路径；实测红案见 §6 的第一条新行）。加固后它**存活**。
   - 002 插的、此后没人改过的行 → 被删；**导入进来的行 → 保留**；
   - 所以"先跑 002 → 再导入 → 再 rollback"**不会误删任何导入数据**，但留下的也不是"空库"：
     平台表里会剩导入的那几行。要重做一遍，就让目标库回到"迁移刚建好 + 002 已跑"的状态，
     **不要**为了"回滚干净"手工 `TRUNCATE` 平台表；
   - 反向顺序（**先导入、后跑 002**）：002 按身份键跳过已导入的同键行、只补缺失的键；
     这些被跳过的行在 `down` 时**不会**被删（内容不同）—— 这正是修复 3 要的方向。
   - 回归网：`apps/api/tests/migration-seed.test.ts` 的「down 不误伤 Task 6 先导入的同键老数据」；
     `apps/api/tests/legacy-import.test.ts` 的种子表用例。改动导入策略时它们会红。
     ⚠ "只改大小写必须存活"那条**判别力用例在 `tests/mysql-integration.test.ts`**（门控真 MySQL）：
     sqlite 的 TEXT `=` 本身就是 BINARY 语义，同一用例在 sqlite 上加固前后**都绿**（零判别力），
     写在 sqlite 文件里只会是一条假门禁。
   - ⚠ **`--down --all` 会连 `001_schema.down` 一起跑，而它是 `dropTableIfExists` 27 张业务表** ——
     所以"全回滚后一行都不剩"**证明不了**上面那条"精确相等"判据。要验它必须**单独**跑 `002.down`
     （Task 8 Step 5 就是这么做的，本机真 MySQL 12 条判据全 PASS：被改过的种子行存活、
     未改动的 7 行被删、`002.up` 也不覆写它）。
4. **⚠ "跳过已存在"的那几行会留下一个"老库状态没搬过去"的格子**（Task 8 全量搬迁实测命中）：
   老库 `o_vendorConfig.id='volcengine'` 是 `enable=1`，而 `002` 的模板是 `enable=0`
   → 导入按本条款"跳过已存在"，目标库里那一格**永久保留种子值 0**。这不是数据丢失，是**设计如此**，
   但必须看得见，所以：
   - 导入侧**逐条**登记 `expectedAbsent`（新原因 `skipped-different-seed` / `skipped-pk-conflict-seed`，
     **并带上是哪几列不同**），并在 `--apply` 时逐行打印
     `⚠ … 与种子同身份键但内容不同 → 保留种子值（差异列：…）`；
   - 比对侧把它归到 `compare-report.json` 的 **`accountedMismatches`**（带 `accountedBy`），
     **不判红**但**照列**（`compare-db` 会打印 `⚠ 按设计未搬 <列> @ …`）。判红会把"设计如此"说成缺陷；
     不报就是**静默**——两条都不行，所以走这条第三条路。
   - ⚠ **豁免粒度是 (行, 列)，不是整行**：登记里带 `columns`（= 导入那一刻算出来的差异列集合），
     比对阶段**逐列**查它。整行豁免会把**同一行里别的列**的真实差异一起吃掉 ——
     实测判别力：把 `o_vendorConfig` 那一行的 `models` 改坏（未被登记的列）→ 照样判红
     （`tests/legacy-import.test.ts` 的种子表用例里有这条断言）。
   - 处置需要拍板：要么接受"种子值优先"，要么 Phase 1b 给一次性对齐脚本（**不要**改成 upsert）。
   - ⚠ 这条也是"抽样必须抽边界"的实证：均匀抽样抽不中 `volcengine` 那一行（8/13 的偏移都没命中），
     是 Task 8 新加的**边界抽样**把它抓出来的。
5. ⚠ **本机现在的 MySQL 现状（Task 7 起）**：真 MySQL 8.4.11 已装在本机（`D:\sy_workspace\.tools\mysql`，
   端口 3307，见上面「1. 本机 MySQL」）。导入/比对逻辑在 sqlite↔sqlite 上全覆盖，
   **真 MySQL 的端到端往返由 `apps/api/tests/mysql-integration.test.ts` 守**（`MIWO_TEST_MYSQL=1`
   时真跑：`up → down → up` 往返、自增 `id` 全是 `bigint unsigned`、批量 insert 的 insertId 是首行、
   dev 库 → MySQL 全量搬迁的逐表行数 + 分层抽样逐列一致）。与方言相关的判断
   （超长值是否阻断）另被抽成纯函数 `oversizeBlocks()` 单独断言。

**分层抽样：为什么"27 张表全绿"不等于"数据一致"（Task 8 Step 1 的实测教训）**

`compare-db.cjs` 的抽样是**两层**，两层抽中的行都写进 `source-samples.json`，逐行比**全部列**：

| 层 | 怎么取 | 漏在哪儿（第一层的实测缺陷） |
|---|---|---|
| 1. 均匀 | 主键排序后"首 / 中 / 末 + N 个均匀分布点" | 抽不中**边界**：老库 `o_agentWorkData.data` 最长 **103,624 字符**、`o_tasks.relatedObjects` 614、`o_project.id` 是 `Date.now()` 毫秒值、`o_shot.duration` 是 `float(8,2)` |
| 2. 边界 | **每一列**的最长文本行 + 数值最大/最小行（`extremeRowPicks()`） | —— |

- **实测差距**：只跑第一层时 27 张表全绿；加上第二层立刻红了 1 处
  （`o_vendorConfig.enable @ {"id":"volcengine"}`，见下面第 4 条）。所以"全绿"必须读成
  "**抽到的**行一致"，不是"数据一致"。
- 边界查询只 `SELECT` 主键 + 那一列（不能把 10 万字符的行 ×**207** 列整行拉回来），
  抽中的行再按主键回源库取**整行**，与均匀层同口径（整行、逐列）。
  - ⚠ **这里的 207 是"搬迁范围"口径**（【Ruling 93 + 138】）—— 两套机械口径都逐条登记，不许再有"无人覆盖的数字"：

    | 口径 | 怎么算出来的 | 表 | 列 | 行 |
    |---|---|---|---|---|
    | **搬迁范围** | `export-sqlite.cjs` / `import.ts` 的 27 张表白名单（**边界抽样扫的就是这一套**） | **27** | **207** | **2373** |
    | **整库** | `gen-legacy-column-stats.cjs` 全扫 `sqlite_master` → `tests/fixtures/legacy-column-stats.json` | **29** | **219** | **2408** |

    差**恰好**是退役的两张表（`o_skillList` + `o_skillAttribution` = **12 列 / 35 行**：`219−207=12`、`2408−2373=35`），
    已钉成断言：`apps/api/scripts/verify-phase1a.cjs` 的 C 组**现算**这两个口径并逐项对账（fixture 与导出物双向）。
  - ⚠ 本行**原文写的是"×226 列"**（沿用 Task 6 报告里的一个数）。它不属于上面任何一套口径，
    而是在**第三套口径 —— 目标 schema** 上成立的数：`001_schema` 建出的 27 张表共 **226** 列
    （机械钉在 `apps/api/tests/migration-column-fit.test.ts:268` 的 `expect(totalTargetColumns).toBe(226)`；
    它比**源库**同样这 27 张表的 207 列多 19 列 —— 目标结构里有源库没有的列，本阶段新增的 `userId` 等）。
    **"源库 207 列"与"目标 226 列"是两个方向，不能混用**：本行讲的是"从**源库**按列取极值时不要把整行拉回来"，
    所以口径是 **207**（整库口径则是 219）。
    （同一处口径也写在代码注释里：`apps/api/scripts/extreme-picks-runner.ts` 的文件头。）
- 比对口径 `equivalentForCompare()`：先跑 `valuesEqual()`（**不 trim、不忽略大小写**，
  【Ruling 77】），只在判不等时回退到 `String(a) === String(b)`（容忍 `0`/`"0"`、`null`/`undefined`）。
  所以 `"a "` vs `"a"`、`"A"` vs `"a"` **仍然报差异**，而 `"0"` vs `0` 不算差异。
- ⚠ 边界层**只加严、不放松**：它是新增的一层，不改任何既有判据的阈值。

**Task 8 全量搬迁实测（dev sqlite → 本机真 MySQL 8.4.11，逐表行数）**

`apps/api/data/db2.sqlite`（sha256 `44716850…c4ef2`，导出前后一致，只读打开）→ `miwo_test`：
**27 张表 / 2,373 行，`compare exit=0`，行数差异 0，抽样 197 行（均匀 134 + 边界 63）逐列一致**。
差异只有两处**按设计**的：

| 表 | 源 | 目标 | 差异归因 |
|---|---|---|---|
| `o_setting` | 12 | 11 | `tokenKey` **绝不导回**（JWT 密钥，见上面第 2 条） |
| `o_vendorConfig` | 13 | 13 | 行数相同，但 `volcengine.enable` 保留种子值（`accountedMismatches`，见上面第 4 条） |

逐表行数（源 → 目标，全部一致；0 行的表略）：`o_user 1→1`、`o_project 8→8`、`o_agentDeploy 19→19`、
`o_setting 12→11`、`o_tasks 61→61`、`o_prompt 4→4`、`o_script 8→8`、`o_assets 108→108`、`o_image 58→58`、
`o_storyboard 116→116`、`o_agentWorkData 8→8`、`o_video 1→1`、`o_videoTrack 110→110`、`o_vendorConfig 13→13`、
`o_imageFlow 1→1`、`o_assets2Storyboard 520→520`、`o_scriptAssets 116→116`、`memories 92→92`、
`o_segment 57→57`、`o_shot 134→134`、`o_shotAssets 926→926`。

抽样覆盖到的"长 / 宽 / 边界"字段（边界层每张表每列都点名，共 63 行）：

| 类别 | 实测字段（例） |
|---|---|
| 超长文本（`longtext`） | `o_agentWorkData.data` **103,624 字符**、`o_tasks.relatedObjects` **614 字符**（这两列在 Task 7 前是 `varchar(255)`，正是"只在真 MySQL 爆炸"的那两列） |
| 万字文本 | `memories.content`、`o_script.content`、`o_storyboard.prompt` / `data`、`o_segment.data` / `reason` |
| `Date.now()` 毫秒大整数（`bigint unsigned`） | `o_project.id 1791385147125`、各表 `projectId` / `videoTrackId` / `trackId`、`o_segment.projectId` / `o_shot.projectId`（Task 6 修复轮 2 从 `int` 改成 `u64` 的那两列） |
| 浮点（MySQL `float(8,2)`，**只有真连才看得见尾数**） | `o_segment.duration` / `videoDuration`、`o_shot.duration` |
| 窄列上限 | `memories.isolationKey`（`varchar(191)`，实测最长 31）、`o_agentWorkData.key`（`varchar(255)`） |
| 复合主键（没有 `id` 列、游标分页会静默丢行的那 4 张） | `o_assets2Storyboard`、`o_scriptAssets`、`o_shotAssets`、`o_assetsRole2Audio` |

（【Ruling 86】的三条 Task 7 实测结论 —— `bigint unsigned` 回读是 JS `number`（无需 `Number()` 归一化）、
103,624 字符 longtext 往返逐字节一致、分镜表文本完整读回 —— 本次全量搬迁**真的比到了这些字段**，
不再重复证明。）


### 启动期副作用的两条语义变化（Phase 1a / Task 4 盖章登记）

删掉旧 `fixDB` 在**每次启动**时做的两件无条件副作用后，行为**有意**变成：

| # | 旧行为（每次启动） | 现在 | 影响 / 替代 |
|---|---|---|---|
| 1 | 把 6 类 `state='生成中'` 的行**无条件**改判失败（`o_novel.eventState=0`、`o_script.extractState=0`、`o_assets.promptState`、`o_image.state`、`o_storyboard.state`、`o_video.state`） | **不再自动改判** | 重启后残留的"生成中"会**一直留在那里**（这正是删除的收益：多实例不再互踩、不再误杀正在跑的任务）。正式替代是 **Phase 1d 的队列租约超时**（spec §9.2）；在 1d 落地前，人工清除用 **`pnpm.cmd run db:repair-stuck`**（下节） |
| 2 | **无条件覆写** `o_prompt.data` 全文 | **不再覆写** | **收益**：运营改过的提示词不再每次重启被冲掉。新库的提示词由 `002_platform_seed`（Task 5）**只插不改** |

> 登记落点：本表 + `apps/api/src/db/migrations/001_schema.ts` 的 `up` 开头（`lib/fixDB.ts` 的
> "已停用"横幅已随该文件在 Phase 1c Task 5 删除，此处不再作为登记落点）
> + `.superpowers/sdd/2026-10-12-miwo-phase1a-mysql-migrations/task-4-report.md`。

### `db:repair-stuck`（人工清除"卡在生成中"的残留行）

> **这是 Phase 1d 队列租约超时落地之前的临时手段**，不是长期机制。
> **登记落点就是本节**（根 `README.md`）：脚本挂在 `apps/api/package.json`
> （`tsx` 只装在 `@miwo/api`，根 `package.json` 里跑不了 `--import=tsx`）。
> ⚠ 计划文本里写的 `apps/api/README-db.md` **全仓不存在**，旧引用一律以本节为准。

```powershell
cd apps\api
pnpm.cmd run db:repair-stuck                          # 默认 dry-run；默认只列"超过 1 小时没更新"的行
pnpm.cmd run db:repair-stuck --apply                  # 真的改判成"生成失败"，并写失败原因
pnpm.cmd run db:repair-stuck -- --older-than=30m      # 改窗口（30m / 6h / 2d / 3600000）
pnpm.cmd run db:repair-stuck -- --older-than=2026-10-12T00:00:00Z   # ⚠ 绝对时间**就是** cutoff 本身
pnpm.cmd run db:repair-stuck -- --older-than=3600000 # 也可以直接给毫秒窗口（= 1h）
```

- **默认 dry-run**（只打印 表名/id/state/时间，不写库），`--apply` 才写；**幂等**（改判过的行不再是"生成中"，再跑是 0 行）。
- **默认只动超过 1 小时**没有时间戳更新的行 —— 避免误杀正在跑的任务。
- ⚠ `o_image` **没有时间列**（现状库与 `001_schema` 都没有），所以它**不在 age 判定的可修范围**内：
  脚本会打印"该表有 N 行生成中但没有可用时间列 → 不按 age 修"，而不是无差别改判。这条限制**是有意的**
  （宁可漏修，也不要误杀）。要给 `o_image` 补时间列属结构变更，排 Phase 1c/1d。
- ⚠ 不动 `apps/api/data/db2.sqlite`：先 `MIWO_DATA_DIR` 指向一次性库再试（env 优先于 `.env` 文件）。

## 已知问题 / Known issues

### 1. `apps/web` 的类型检查不干净：47 条真实类型错误（**Phase 3 前端重绘的前置清单项**）

- 复现：`pnpm --filter @miwo/web run type-check`（= `vue-tsc --build --force`）→ **EXIT 2**。
- 规模（实测：TypeScript 5.6.3 / vue-tsc，**汇总 47 条 / 17 个文件**）：
  - 错误码分布：`TS2322` ×18、`TS2339` ×18、`TS2307` ×5、`TS2769` ×2、`TS7016` ×2、`TS2739` ×1、`TS7006` ×1。
  - 分类分布：**①缺类型/环境声明 9 条**、**②UI 库枚举或重载签名不兼容 20 条**、**③Vue 泛型组件推断 18 条**（见下表）。
- ⚠ 前置条件：`src/types/{auto-imports,components}.d.ts` 被 `.gitignore` 忽略、由 vite 插件在构建时生成。
  **先生成它们（跑一次 `pnpm --filter @miwo/web run build-only`）再跑 `vue-tsc` 是 47 条；不先生成则是 961 条 / 85 个文件**
  （缺 `ref`/`onMounted`/`storeToRefs` 这类全局自动导入）。任何"数目对不上"的复测都要先确认这一点。
- **全部是上游继承缺陷**（迁移前的原前端仓库是同一份继承代码，同样的写法、同样不可用），不是本仓复制走样。

| 类别 | 数量 | 典型位置与症状 |
|---|---|---|
| ① 缺类型/环境声明 | 9 | `lodash` 无声明文件（`TS7016` ×2，`src/App.vue:15`）；`monaco-editor/...?worker` 无法解析（`TS2307` ×5，`src/utils/monacoWorkers.ts:15-19`）；`ImportMeta.glob` 不存在（`src/utils/providersLogo.ts:2`）；`Window.$electron` 不存在（`src/pages/error/404.vue:16`）——根因是 `vite/client` 类型未被引入、`@types/lodash` 未声明 |
| ② UI 库枚举 / 重载签名不兼容 | 20 | md-editor-v3 的 `Themes` 不接受 `'auto'｜'light'｜'dark'`（`TS2322` ×10：`editMdPreivew.vue:16`、`skillManagement.vue:24,39`、`vendorConfig.vue:44`、`script.vue:9,28`、`scriptPlan.vue:11,29`、`storyboardTable.vue:11,45`）；`track.vue` 的 `Type 'number' is not assignable to type '0'`（×3）；`modeMenu.vue:87` / `video.vue:90` 的 `TS2769` 重载不匹配等 |
| ③ Vue 泛型组件推断 | 18 | `Property 'model'/'mode'/'audio'/'resolution'/'duration' 不存在于类型 'T'`（`modeMenu.vue` 12 条）、`Property 'videoList'/'id' 不存在`（`video.vue` 4 条）、`video.vue:132` 回调参数隐式 `any`、`production/index.vue:49` 的 `WorkbenchData` 缺属性（`TS2739`） |

**为什么不现在修**：`apps/web` 是 **Phase 3「前端重绘」要整体替换**的对象，现在投人修这 47 条属"投入将被丢弃的工作"。
**恢复条件（Restore condition）**：上表 **47 条清零**（复测口径 = 先生成 `src/types/*.d.ts` 再跑 `vue-tsc --build --force`，见上），
**并且**把 CI web job 的 `build-only` 换回 `vue-tsc`；两者同时满足，web 类型门禁才算恢复（`node tools/check-ci-yaml.cjs` 会断言本小节里 47/17 与「恢复条件」都在）。
**代价与追踪**：Phase 0 的 CI **web job 不跑 `vue-tsc`，只跑 `vite build`（`build-only`）+ `check-no-shadow`**
（理由与代价同样写在 `.github/workflows/ci.yml` 的文件头注释里，并由 `node tools/check-ci-yaml.cjs` 断言：
必须存在 `build-only`、不得出现 `vue-tsc`）。
⇒ **Phase 3 前端重绘的前置清单项之一：上表 47 条清零，并把 CI web job 的 `build-only` 换回 `vue-tsc`，类型门禁才算恢复。**

### 2. Phase 1c Task 10 登记的两项「未处置项」（**明确交接，不是"已完成"**）

| # | 未处置的事（现状 · 实测） | 为什么本轮不做 | 归属 |
|---|---|---|---|
| **N3** | 媒体 URL 的「24h TTL + `Cache-Control: public`」整体**偏宽**：`/oss`、`/assets` 的签名链接一签 24 小时有效，且 `public` 允许中间缓存留副本。**硬约束仍成立**：`max-age(1h) < TTL(24h)` ⇒ 缓存最多把链接续 1 小时，永远不会长过签名寿命（e2e C 组的"过期签名 + `If-None-Match` ⇒ **403 而不是 304**"就是这条的判据）。所以这不是漏洞，是**口径选择**。 | 收紧（TTL 降到分钟级 + `Cache-Control: private`）会改变链接寿命与缓存语义，属**行为变更**，不属"配置外置收口"这一轮的范围；而且它需要前端配合（链接刷新策略）。 | Phase 2（媒体/存储层）|
| **N4** | `/assets` 挂载点**将来会遮蔽 SPA 产物目录**：Vite 的默认 `assetsDir` 正是 `assets` ⇒ 若 Phase 3 的前端产物输出到 `web/assets/`，则 `/assets/*.js|css` 会先命中**用户产物的签名守卫** ⇒ 无签名 **403** ⇒ **白屏**（症状是"接口全正常、只有 JS/CSS 403"，与 1b-11 的"图片全裂"同族）。**现在没炸**：`data/web` 目前只有 `index.html`。 | 修它要么改前端构建输出（`build.assetsDir`，属 `apps/web/**`，本轮硬约束零改动），要么让 `/assets` 让位于 SPA（那等于让用户产物裸奔，是 1b-11 的本体）。**两条都需要 Phase 3 的决策**，不该在这一轮猜。 | Phase 3（前端重绘）|

- 两处在代码里都留了**点名注释**（注释是允许的）：`apps/api/src/utils/mediaSign.ts` 文件头的「未处置项 N3」、`apps/api/src/app.ts` 的 `/assets` 挂载点上方「未处置项 N4」。
- 两处**都没有**进任何门禁（它们不是"必须为真"的断言，而是"必须被记住"的交接项）—— 这正是本表存在的理由。

## Phase 0 验收的执行边界（两条必须知道的口径）

1. **`pnpm run verify:phase0` 是「本机门禁」，CI 跑不了它。**
   它的 **A 组**（旧仓库 8 条 sha256 冻结）依赖 `tools/.phase0-old-baseline.json`，而该文件被 `.gitignore` 忽略
   （里面记的是本机旧仓库的**绝对路径**，属机器特定凭证）⇒ 无此文件的机器（含 CI，全新克隆）A 组必然失败（EXIT 1）。
   这是设计而非缺陷：验收脚本对基线**只读、绝不重记**。所以请在**本机**（有旧仓库与基线文件的机器）运行它；
   CI 只跑 `.github/workflows/ci.yml` 里的那些门禁。

   > ⚠⚠ **【裁定 B·必做】`verify:phase1a` 有同样的边界，因此分成两个口径。**
   > CI 上跑的是 **`pnpm run verify:phase1a:ci`**（= 同一个脚本 + `--ci`），**不是**本机口径。
   > 该脚本里有两条**本机专属**检查，在全新树（`git archive HEAD`）上**必然失败**：
   >   ① 旧仓库 sha256 冻结（同上，读被 gitignore 的 `tools/.phase0-old-baseline.json`）；
   >   ② `verify:legacy-freeze --check` 需要**仓库外**两个旧仓（`code/toonflow-upstream` / `code/toonflow-web`），
   >      无 remote 的 runner 上不可能有 —— `record-legacy-freeze.cjs` 自己就写明"**缺仓库不算通过**"。
   > 实跑证据：全新树里跑本机口径 = **EXIT 1**（这正是"CI 强制跑一条本机专属命令"的必然后果）。
   > `--ci` 把这两条**显式记为「CI 不适用」**（`[信息]` 前缀、**不计入** `通过 N / M`），
   > 并逐条打印"少了什么、为什么、本机该跑哪条命令"——**不是静默跳过，也没有削弱任何断言**：
   > 它们在本机口径下照旧是真判据。
   >
   > | 口径 | 命令 | 期望 |
   > |---|---|---|
   > | **本机**（有旧仓与基线） | `pnpm.cmd run verify:phase1a` | 全部判据都跑（见 §5 基线表） |
   > | **CI**（全新树） | `pnpm.cmd run verify:phase1a:ci` | **EXIT 0**；两条本机专属项记为「CI 不适用」 |
   >
   > `tools/check-ci-yaml.cjs` 同时钉住两件事：api job **必须**有 `verify:phase1a:ci`、
   > **不得**出现本机口径的 `verify:phase1a`（否则全新树必红）。

2. **「旧系统仍能在 10588 启动」是人工/独立确认项，不由本脚本断言。**
   Phase 0 计划的 Step 4 要求起旧仓库 10588（需 `NODE_ENV=prod`，否则 dev 模式会向旧仓库写 `src/router.ts`）来确认旧系统仍可用；
   `verify-phase0.cjs` **刻意不执行也不断言**它 —— 执行它会向旧仓库写 `version.txt`、留下进程与监听端口，
   与 Phase 0 的硬约束（绝不修改旧仓库、不留残留进程）直接冲突。
   ⇒ 这一条由人按 Step 4 手工确认，脚本不代劳。

## Phase 1a deferred 登记表（Task 12 定稿；必做修复轮补登记至 22 条）

> **性质**：Phase 1a 结束时**仍未具备**的能力与**有意不做**的事，逐条登记"归属 Phase"与"依据"。
> 每条的"依据"都指向 Phase 0/1a 的具体条目（spec 章节 / Ruling / 实测报告），不是泛泛而谈。
> ⚠ 本表是**决策登记**，不是 TODO 池：没被登记的"以后再说"等于没做决定。

| # | deferred 项 | 归属 | 依据 / 说明 |
|---|---|---|---|
| 1 | `o_imageFlow` 的 `userId` **回填** | Phase 1b | 本阶段已给结论（tenant）+ 加列；回填依据 `o_imageFlow.id = o_assets.flowId → o_assets.projectId → o_project.userId`（实测 `flowData` 里的图片路径形如 `{projectId}/role/...`，与 `uploadImage.ts:40` 同源） |
| 2 | `o_event.userId` 回填（经 `o_eventChapter → o_novel → o_project`） | Phase 1b | spec 附录 A「`o_event` 无任何归属列」；本阶段只加列 |
| 3 | 其余 16 张租户表的 `userId` 回填 | Phase 1b | spec §6.2 / §14 R5 |
| 4 | `knex_migrations` / `knex_migrations_lock` 的策略声明 | Phase 1b | 本阶段实测这两张表会被 knex 创建（Task 7 Step 4）；`policies.ts` 是 fail-closed 的，**必须显式声明**否则将来碰它们就报错 |
| 5 | `o_project.id` 去掉 `Date.now()` | Phase 1b | spec §5.3（同批改 `addProject.ts:29`） |
| 6 | 35 处 `insert` 的 `insertId` 语义复核 | Phase 1b | spec §5.3；本阶段已在 Task 3 Step 9 与 Task 7 Step 6 把差异钉成断言 |
| 7 | 删除 `lib/initDB.ts` / `lib/fixDB.ts`（+ 把 `check-copy` 的 `.ts` 下限再降） | **Phase 1c Task 5 已完成** | 本阶段已摘除启动路径 + 删掉危险分支；删文件撞的是 **`tools/check-copy.cjs`** 的"必须存在"清单与 `.ts` 下限（**已一并处理**：清单条目删除、下限 235 → 实测 267；`check-brand` 的 `idRefFiles` 改锚 `db/legacy/vendor-merge.ts`，`check-tenant-exceptions` 的 `KNOWN_DIRECT_DB` 与清单同时收敛，`check-dead-ddl` 豁免清空）。⚠ **【L1 更正】更早原文写"撞 `verify-phase0` 的构件清单"—— 过期了**：`verify-phase0.cjs:179` 在 Phase 1a / Task 11 就已换成 `db/migrations/index.ts` |
| 8 | `o_user` 重建（argon2id / role / tokenVersion / 删 `admin/admin123`） | Phase 1c | spec §7.1；本阶段按现状建表（`bigint unsigned` 无自增） |
| 9 | `o_setting` 的 `tokenKey` 彻底移出 DB + 7 个用户级键迁 `o_userSetting` | Phase 1c | spec §6.2；本阶段的 `002_platform_seed` **不 seed** `tokenKey` 与用户级键（且有断言禁止 `tokenKey` 入新库） |
| 10 | 重启后"生成中"不再自动改判失败 | **Phase 1d** | spec §5.2 ② 要求删除那 6 条 UPDATE；替代机制是队列租约超时（§9.2）。**中间窗口的语义变化已在 Task 4 Step 6 盖章** |
| 11 | ~~`o_agentWorkData.data` 是 `varchar(255)`~~ **【M1 更正·该项已作废】** | — | **原文是假的**：实测 `001_schema.ts:296` 对该列用的是 `t.text(T, "data")`（mysql `longtext`），`migration-ddl-mysql.test.ts` 有一条断言把它的长度钉成 `MAX_LENGTH`（见 `001_schema.ts:293-295` 的注释：现状库声明 varchar(255) 但实际最长 **103,624 字符**，收窄会静默夹断分镜 JSON）。本文件 §5 的「超长文本」段（`:508-514`）自己已写明"**已经不在 `001_schema` 里成立了**"——两段自相矛盾，以 `001_schema.ts` 为准。**该观察项已由 Task 7 修复轮 2 关闭**，1b 不必再评估 |
| 12 | `MIWO_TEST_MYSQL` **不能**写进 `apps/api/.env.example`（**连注释行都不行**） | 有意（**Task 12 实测更正**） | 计划原写"以注释形式出现即可，`check-deploy-config` 允许注释声明"——**实跑证伪**：`check-deploy-config.cjs` 规则 2 把注释形式的 `# NAME=` 也算作"声明"，而它不在 `config.ts` 里 ⇒ `verify:deploy` 变红。它是 **vitest 的门控**，用法见 §5；实跑原文见 `task-12-report.md` |
| 13 | `data/vendor/*.ts` 的 13 个适配器与 `vendor.json` 模板的对账结果 | 观察项 | Task 10 Step 5 的输出；本阶段只报告不写盘（`003_vendor_asset_sync` 的 `up` 只登记不写文件） |
| 14 | `apps/api/LICENSE`、`data/vendor/*.ts` 的 `author` 字段（写着**旧品牌名**）、前端 i18n 品牌残留 | Phase 1c / Phase 3 | Phase 0 ledger 的既有 deferred 裁定（本阶段不动，`check-brand` 有**逐条带理由**的豁免机制） |
| 15 | `NOTICES.txt` 仍列 electron 系许可证 | Phase 1c | Phase 0 ledger（用 `pnpm license` 重生成） |
| 16 | `deploy/` 的容器路径整体未验证 + 无 `.dockerignore` | Phase 1d 准入前必修 | Phase 0 ledger **N1**；`seed/*.ndjson` 在容器里也要能读到 —— **代码侧**由 `002_platform_seed` 的三条候选路径处理，**产物侧**由 Task 12 Step 4（裁定 60）的构建拷贝处理（源目录缺失即 `exit 1`，不静默） |
| 17 | **4 个运维路由的租户处置**（`deleteAllData.ts` / `clearData.ts` / `importData.ts` / `getSwitchAiDevTool.ts`，共 7 处在 import 图上） | Phase 1b | **【L3 补登记·Ruling 45】** 本阶段摘的是"**每次启动无条件执行**"的调用；这 4 处是**用户请求时的 handler**，已逐条豁免 + 理由（带"必须真实命中否则报红"的活性断言）。`check-dead-ddl.cjs` 的豁免一旦不再命中就会逼人清理清单。**1b 必须把这 4 个 handler 纳入隔离处置的明确范围** |
| 18 | **全新库 `login` 仍 400**；`app.ts:167` 的 **444 分支已不可达** | Phase 1c | **【L3 补登记·Ruling 58③ + Ruling 64】** ① `login`/socket 三处仍读库里的 `o_setting.tokenKey`，而 `002` **不 seed** 它 ⇒ **全新库上登录仍 400**。**不得宣称"全新库完整可用"**。② `config.ts` 的模块级 `loadConfig()` 对 `MIWO_JWT_SECRET` 是 fail-fast（≥32B）⇒ `config.jwtSecret` **恒非空** ⇒ `app.ts:167` 的 `if (!tokenKey) return 444` **不可达**，全仓无测试覆盖它（已就地标注 unreachable + 原因，不删）。本阶段已补"库值优先 / 配置兜底"的优先级回归网（`tests/auth-token-key.test.ts`） |
| 19 | **无 id 的 4 张关联表用全列 `OFFSET` 分页（O(n²)）** | Phase 1b / 1e（搬迁工作） | **【L3 补登记·Ruling 106】** `importTable` 对无 id 表按全列 `OFFSET` 分页；老库这 4 张最大 926 行看不出来。**真实库若远超此量级，建议先单独压测再做正式搬迁**（否则搬迁耗时随行数**平方**增长，可能从分钟级变成小时级） |
| 20 | **`db:export --allow-repo-out` 的"用完删产物"仍靠人** | Phase 1c | **【L3 补登记·Ruling 145】** 护栏只能放行/拒绝；产物（`o_setting.ndjson`）**含真实 `tokenKey`**。本阶段的纪律是"用完删 + `Test-Path` 复核 False"（人肉）。建议 1c 让 `db:export` 支持"用完自清"或**默认输出到 `%TEMP%`** |
| 21 | **`.tmp-migrate/` 每次跑门禁都会重现生成的 runner，且无自清机制** | Phase 1c | **【L3 补登记·Ruling 146】** `verify:phase1a` 会生成 `compare-runner.ts` / `import-runner.ts`（实测 **0 行含 `tokenKey`**）。这是**门禁自身的产物**、不是实现者遗留 ⇒ "验收后 `Test-Path` 为 False"**只在清理后成立**，报告须写明，免得下一个人误判为漏清。建议 1c 补自清或把临时 runner 落到 `%TEMP%` |
| 22 | **裁定落地核对（Ruling 156 的机制）本身仍需人维护清单** | 持续 / Phase 1b 起 | **【L3 补登记·Ruling 156】** `verify:phase1a` 新增「裁定落地核对」一节：账本里每条标为"**必做**"的裁定各附一条**可执行的机械断言**（见该节）。⚠ **边界**：新裁定要**人手**加一条断言进去 —— 本节只能防"已登记的必做裁定被忘掉"，防不了"根本没登记"。**1b 起每加一条必做裁定，必须同时在本节加一条断言**（否则它又会变成"账本自我安慰"） |

### 本阶段完成后**仍未**具备的能力（P2 汇总，如实登记）

1. **`userId` 没有回填** —— **20 张租户表**的 `userId` 都是 NULL（除 `o_project` 原有的 7 行）；隔离策略与回填在 Phase 1b。
   ⚠ **【M2 更正】原写"18 张"，实际是 20 张**：**19 张**是本阶段新增 `userId` 的（spec §6.2），
   外加 **`o_project`（已有该列）** ⇒ 19 + 1 = **20**。
   **1b 若照 18 回填会漏 2 张表**。机械口径：`001_schema.ts` 里 `t.u64(T, "userId")` 共 **20 处调用**，
   逐处对应一张表（`o_project` 那处注释已标"已有列"）。
2. **重启后"生成中"不再自动改判失败** —— 在 Phase 1d 的队列租约落地前，界面上可能有永久"生成中"的残留行；
   过渡期用 `pnpm.cmd run db:repair-stuck`（默认 dry-run）。
3. **MySQL 的 CI 证据来自 YAML 结构断言 + 本机等价命令**，真 GitHub runner 从未执行过（仓库无 remote）。
4. **`deploy/` 的容器路径仍未验证**（本机无 Docker）。
5. ~~**`o_agentWorkData.data` 仍是 `varchar(255)`**（中文长 JSON 有截断风险，Phase 1b 评估）。~~
   **【M1 更正】这一条是假的，已删除。** 实测 `001_schema.ts:296` 是 `t.text(T, "data")`（mysql `longtext`），
   `migration-ddl-mysql.test.ts` 断言它就是 `MAX_LENGTH` —— 老库那列声明 varchar(255) 却装着最长
   **103,624 字符**，正是"只在真 MySQL 爆炸"的那一列，Task 7 修复轮 2 已把它放宽到 `longtext`。
   （同文件 deferred #11 与 §5「超长文本」段已一并更正，三处口径统一。）
6. **老 sqlite 库不能"原地迁移"** —— 必须先导出再导入一个空目标库（见「⚠ 不支持"在老库上原地跑迁移"」一节）。

