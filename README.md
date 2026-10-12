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
3. **回滚语义**：`002_platform_seed` 的 `down` 只删"与仓库种子**逐字节相同**"的行 ——
   - 002 插的、此后没人改过的行 → 被删；**导入进来的行 → 保留**；
   - 所以"先跑 002 → 再导入 → 再 rollback"**不会误删任何导入数据**，但留下的也不是"空库"：
     平台表里会剩导入的那几行。要重做一遍，就让目标库回到"迁移刚建好 + 002 已跑"的状态，
     **不要**为了"回滚干净"手工 `TRUNCATE` 平台表；
   - 反向顺序（**先导入、后跑 002**）：002 按身份键跳过已导入的同键行、只补缺失的键；
     这些被跳过的行在 `down` 时**不会**被删（内容不同）—— 这正是修复 3 要的方向。
   - 回归网：`apps/api/tests/migration-seed.test.ts` 的「down 不误伤 Task 6 先导入的同键老数据」；
     `apps/api/tests/legacy-import.test.ts` 的种子表用例。改动导入策略时它们会红。
4. ⚠ **本机没有 MySQL 服务端**：导入/比对逻辑在 sqlite↔sqlite 上全覆盖，但
   "真 MySQL 的类型/字符集/严格模式行为"**未验证**（由 Task 8 的 MySQL 集成测试补端到端证据）。
   与方言相关的判断（超长值是否阻断）被抽成纯函数 `oversizeBlocks()` 单独断言。


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

