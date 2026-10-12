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

### 路由与配置（改动须知）

- **新增/改名 `apps/api/src/routes/**` 下的文件后，重启 `pnpm dev` 即可，`src/router.ts` 会自动重新生成**。
  生成链挂在两处：`apps/api/package.json` 的 `predev`（每次 `pnpm dev` 一次）与 `apps/api/nodemon.json` 的 `exec` 前缀
  （nodemon 每次重启都跑）。**只靠 `predev` 会漏掉"dev 会话内新增路由"**：nodemon 重启走 `exec`，不会再跑 predev，
  症状是新路由返回 404 而没有任何报错（所谓"幽灵 404"）。
  `src/router.ts` 是**提交在仓库里的构建产物**（构建期生成，不再由 `app.ts` 运行期重建）；空清单会被生成器直接拒绝覆盖。
- 配置入口是 `apps/api/src/config.ts`（`MIWO_*` 变量的唯一入口 + 启动期校验），开发期模板见 `apps/api/.env.example`。
  ⚠ **dev + 局域网/手机浏览器访问**时必须显式设 `MIWO_PUBLIC_BASE_URL`（否则远端浏览器把缺省的 `127.0.0.1` 当自己，媒体全挂）。
- ⚠ **但"配置唯一入口是 `config.ts`、只认 `MIWO_*`"目前并不成立**：`apps/api/src` 另有 **10 个非 `MIWO_` 前缀**的环境变量被**直接读**
  （复核命令：`git grep -n "process\.env" -- apps/api/src`）。它们绕过了启动期校验，多数没有门禁覆盖，**Phase 1c 逐个迁进 `config.ts`**：

  | 变量 | 读取位置 | 作用 | 迁移状态 |
  |---|---|---|---|
  | `ossURL` | `utils/oss.ts:73` | **会改媒体 URL**：非空时媒体 URL 以它作基地址（效果上覆盖 `MIWO_PUBLIC_BASE_URL`） | ⚠ **未文档化、无门禁覆盖** —— Phase 1c 迁进 `MIWO_*` |
  | `FFMPEG_PATH` | `utils/ffmpeg.ts:15` | ffmpeg 可执行文件（缺省 `ffmpeg`，走 PATH） | Phase 1c |
  | `FFPROBE_PATH` | `utils/ffmpeg.ts:16` | ffprobe 可执行文件（缺省 `ffprobe`） | Phase 1c |
  | `FFMPEG_TIMEOUT` | `utils/ffmpeg.ts:19` | 单次 ffmpeg 超时（缺省 10 分钟） | Phase 1c |
  | `REDRAW_PREP` | `routes/redraw/analyzeSource.ts:33` | 外部分镜预处理脚本路径（**缺省值是本机绝对路径** `D:/sy_workspace/tools/redraw-prep/...`，容器里必须显式覆盖） | Phase 1c |
  | `TOONFLOW_PROXY` | `proxy.ts:98` | 出网代理地址（显式指定） | **重命名/迁移已排 Phase 1c**（Task 12 必做 7 记载） |
  | `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` | `proxy.ts:99` | 标准代理环境变量（生态约定，供回退） | **不迁**（标准名，改了会与 curl/undici 生态不一致） |

  ⚠ `process.env.NODE_ENV` 已不再被业务代码用于决策：`utils/oss.ts:77` 原来读 `NODE_ENV === "development"`（与 `config.env === "dev"` 语义等价，
  是第 5 个决策点），Task 12 必做 5 已改为 `config.env === "dev"`。`NODE_ENV` 现在只由 `config.ts:135` **派生写出**，供 Express/knex 等生态代码读。
- 部署文件与容器 Node 版本要求见 [`deploy/README.md`](deploy/README.md)；一致性由 `node tools/check-deploy-config.cjs` 保证。

## 数据层手册（Phase 1a）

> 本节由 **Task 7** 起草（Task 12 定稿）。下面每一段输出都是**本机实测原文**（Windows / MySQL **8.4.11** / 端口 **3307**）。
> ⚠ 计划文本里写的 `apps/api/README-db.md` **全仓不存在**：数据层的登记落点一律是根 `README.md`（本节 + 下面「迁移纪律」「真实数据搬迁」「启动期副作用」「`db:repair-stuck`」几节）。

### 0. 现在的启动序列

连接 → `migrate.latest()` → 监听端口。**迁移失败即 fail-fast 退出**（`utils/db.ts` 的 `dbReady` 是唯一消费者，`src/db/connect.ts` 的 `connect()` 在探活失败时给出可操作的报错）。

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

### 2. 迁移操作手册

#### 新增一条迁移
1. `pnpm.cmd run db:generate -- <kebab-case>`（生成 `NNN_<name>.ts`）
2. 把新文件 import 进 `src/db/migrations/index.ts` 的 `MIGRATIONS`（**必须手工加、且必须追加到末尾** —— 脚本不会替你改；
   `MIGRATIONS` 的顺序就是执行顺序，`tests/migrations.test.ts` 只断言了清单↔文件一一对应）
3. `up` 只写结构；种子写"只插不改"
4. `down` 必须能精确撤销 `up`
5. `pnpm.cmd run db:migrate:status` 看状态 → `db:migrate` 应用

#### 迁移纪律（违反会有人踩坑）
- **幂等**：迁移系统层面靠 `knex_migrations` 跳过；`createTable` 不要加 `hasTable` 守卫（会掩盖结构漂移）。
  但"清理老库"的动作（`dropTableIfExists`）必须用 `*IfExists` 形式。
- **`up` 必须用传入的 `trx`**，不能用外层 `db`（实测会 `KnexTimeoutError`）。
- **schema 迁移只允许用 schema builder**（不能 `raw`、不能查表）—— 这样 mysql 侧的静态断言才能收集到完整 DDL。
- **种子里绝不写 UPDATE。**
- **不许在 `up` 里 import app 的业务模块**（迁移要能在最小依赖下跑）。
- ⚠ **`--status` 也会写库**：`migrationStatus()` 先调 `migrate.list()`，它的 `ensureTable` 会建
  `knex_migrations` + `knex_migrations_lock` → 只读账号跑 `--status` 会失败。
- ⚠ **库里出现清单外的迁移行时，`--status`/`--down`/`--redo` 全部硬报错**
  （knex 的 `validateMigrationList`：`The migration directory is corrupt, the following files are missing: …`）
  → 回退代码版本后**连 `--down` 都不可用**（只能手改 `knex_migrations` 或先恢复代码）。

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

### 3. 老 sqlite 库怎么办

**不要在已有的 29 张表的老库上原地跑 `001_schema`** —— 它会 `createTable` 撞"表已存在"（症状与处置见下一节）。
正确路径（Task 6 的工具链）：

1. `scripts/export-sqlite.cjs`（导出 NDJSON + manifest，含查重与 id 越界检查）
2. 目标库先跑迁移到最新（空库）
3. `scripts/import-mysql.cjs --apply`（进空库校验 + 列交集 + id 保真）
4. `scripts/compare-db.cjs`（行数 + 抽样比对）
5. 回滚：`db:migrate:down --all`（或从 `.db-backups` 恢复 sqlite）

### 4. 本阶段已知的语义变化（不是 bug）

- 重启后**不再**把 `state='生成中'` 自动改判为失败（旧 `fixDB.ts` 已删除）→ Phase 1d 的队列租约超时接管；
  过渡期用 `pnpm.cmd run db:repair-stuck`。
- `o_prompt` 不再被启动期覆写（运营改动会保留）。
- `o_skillList` / `o_skillAttribution` 不再创建（迁移会 drop 掉老库里的这两张）。
- `userId` 列已建出但**未回填**（回填归 Phase 1b）。
- 全新库的 JWT 密钥来自配置 `MIWO_JWT_SECRET`（`o_setting.tokenKey` 不进新库）。

### 5. 测试

- 默认（无 MySQL）：`pnpm test` —— 所有 sqlite 用例 + **MySQL 集成用例 skip**
- 真 MySQL：先 `mysql-local.ps1 -Action start|createdb`，然后
  `$env:MIWO_TEST_MYSQL="1"; pnpm test`（或只跑 `pnpm.cmd exec vitest run tests/mysql-integration.test.ts`）
- 慢用例（约 60s）：`$env:MIWO_TEST_SLOW="1"`

⚠ `MIWO_TEST_MYSQL` 是**测试门控**，不是应用配置：它**不进** `apps/api/.env.example`、
**不进** `deploy/`、也不在 `tools/check-deploy-config.cjs` 的白名单里（`check-deploy-config` 会红）。

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
  `await dbReady`）。旧实现的"未被 await 的 IIFE 里跑 `initDB` + `fixDB`"已删除；`initDB.ts` / `fixDB.ts`
  两个文件**仍在仓库里但已不在启动链上**（只为 `verify-phase0.cjs` 的构件断言存在，删除归 Phase 1c），
  这条不变式由门禁 **`node tools/check-dead-ddl.cjs`**（`pnpm.cmd run verify:dead-ddl`）守住：它从 `src/app.ts`
  出发走 import 图，链上出现 `initDB`/`fixDB` 的**代码级**引用就报红（4 个用户触发的运维路由逐条豁免、附理由）。

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
    已随 Task 5 删除（断言只增不减：31/31 → **36/36**，用"种子四张表都落地 + 库里没有 tokenKey"取代了
    原来的"种了 tokenKey 就能起服务"）。
  - ⚠ `o_setting.tokenKey` **不进新库**（`002_platform_seed` 有一条显式断言兜住它）：JWT 密钥取自配置
    `MIWO_JWT_SECRET`（`src/app.ts` 的鉴权中间件在库里没有 `tokenKey` 行时回退到它）。把密钥从库里搬进配置
    正是 spec §6.2 / Phase 1c 的方向，所以"新库里没有 tokenKey"是**预期状态**。

### 真实数据搬迁（导出 → 导入 → 比对）与**回滚语义**

> 登记落点就是本节（根 `README.md`）**与** `apps/api/src/db/legacy/import.ts` 的文件头 ——
> 这条约束必须随代码走：`.superpowers/` 里的计划文本是 git-ignored 的，不能作为唯一载体。
> 三个脚本挂在 `apps/api/package.json`（`tsx` 只装在 `@miwo/api`，根 `package.json` 里跑不了 `--import=tsx`）。

```powershell
cd apps\api
pnpm.cmd run db:export                              # SQLite → .tmp-migrate/export/*.ndjson + manifest.json
$env:MIWO_DATA_DIR="C:\Temp\miwo-target"; pnpm.cmd run db:import            # dry-run（默认不写）
$env:MIWO_DATA_DIR="C:\Temp\miwo-target"; pnpm.cmd run db:import -- --apply # 真的写
pnpm.cmd run db:compare                             # 行数 + 抽样单元格深比较
```

- **搬迁链三步**：`scripts/export-sqlite.cjs`（只读源库 → NDJSON + manifest）→
  `scripts/import-mysql.cjs`（默认 dry-run；`--apply` 才写）→ `scripts/compare-db.cjs`（比对）。
  导入的核心逻辑在 `src/db/legacy/import.ts`（可单测，见 `tests/legacy-import.test.ts`）。
- ⚠ **导出对源库只读**：脚本以 `{ readonly: true }` 打开 SQLite，并断言**导出前后源库 sha256 相等**、
  未新出现 `-wal`/`-shm`/`-journal` 伴随文件；不满足就退出码 1。
  `apps/api/data/db2.sqlite` 的 sha256 是硬约束，任何验收都不许改写它。
- ⚠ **用户机真实库（`%APPDATA%\ToonFlow\data\db2.sqlite`）不在搬迁范围**：脚本对它**硬拒绝**
  （连只读打开都不做）。搬迁只针对仓库里的 dev 库快照。
- ⚠ **导出物是机密**：`o_vendorConfig.inputValues` 里存着真 API key。所以导出目录
  `apps/api/.tmp-migrate/` 被 gitignore（见 `.gitignore` 的说明），用完即删。
- **导入的四条硬闸门**（任一不满足即拒绝，见 `import.ts` 的 `preflightImport`）：
  ① manifest 的 `duplicates` / `badIds` 必须为空；② 目标库必须已有全部表；
  ③ 目标库的**业务表必须全空**（四张平台种子表例外，见下）；④ **目标列表示不了的值**在 MySQL 目标下阻断。
- ⚠ **两条"只在真 MySQL 暴露"的真实缺口**（Task 6 实跑体检结果，处置需拍板；`001_schema` 本 Task 不改）：
  1. **超长文本**：老库 `o_agentWorkData.data`（productionAgent 的 JSON）**最大 103,624 字符 / 5 行超 255**、
     `o_tasks.relatedObjects` **最大 614 字符 / 2 行超 255**，而 `001_schema` 里这两列是 `varchar(255)` ——
     sqlite 不强制长度所以看不出问题，**真 MySQL 严格模式会 `Data too long for column`**。
  2. **越界数值**：`o_segment.projectId` / `o_shot.projectId` 在 `001_schema` 里是 `int`，
     而老库这两列存的是 `o_project.id`（= `Date.now()` 毫秒值，实测 **1791385147125**）——
     MySQL 的 `int` 上限 2147483647 → 严格模式 `Out of range value`，非严格模式**静默夹断**（数据损坏）。
     sqlite 的 INTEGER 是 64 位，本机永远看不出问题。
  3. `memories.isolationKey` 收窄到 `varchar(191)`（老库 TEXT）：实测最大 31 字符 → **安全**。
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
- 边界查询只 `SELECT` 主键 + 那一列（不能把 10 万字符的行 ×226 列整行拉回来），
  抽中的行再按主键回源库取**整行**，与均匀层同口径（整行、逐列）。
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

> 登记落点：本表 + `apps/api/src/db/migrations/001_schema.ts` 的 `up` 开头 + `apps/api/src/lib/fixDB.ts` 顶部"已停用"横幅
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

## Phase 0 验收的执行边界（两条必须知道的口径）

1. **`pnpm run verify:phase0` 是「本机门禁」，CI 跑不了它。**
   它的 **A 组**（旧仓库 8 条 sha256 冻结）依赖 `tools/.phase0-old-baseline.json`，而该文件被 `.gitignore` 忽略
   （里面记的是本机旧仓库的**绝对路径**，属机器特定凭证）⇒ 无此文件的机器（含 CI，全新克隆）A 组必然失败（EXIT 1）。
   这是设计而非缺陷：验收脚本对基线**只读、绝不重记**。所以请在**本机**（有旧仓库与基线文件的机器）运行它；
   CI 只跑 `.github/workflows/ci.yml` 里的那些门禁（`check-copy` / `check-brand` / `check-eol` / `check-natives` / `verify:deploy` / typecheck / test / build）。
2. **「旧系统仍能在 10588 启动」是人工/独立确认项，不由本脚本断言。**
   Phase 0 计划的 Step 4 要求起旧仓库 10588（需 `NODE_ENV=prod`，否则 dev 模式会向旧仓库写 `src/router.ts`）来确认旧系统仍可用；
   `verify-phase0.cjs` **刻意不执行也不断言**它 —— 执行它会向旧仓库写 `version.txt`、留下进程与监听端口，
   与 Phase 0 的硬约束（绝不修改旧仓库、不留残留进程）直接冲突。
   ⇒ 这一条由人按 Step 4 手工确认，脚本不代劳。

