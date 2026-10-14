# 谜沃任务队列手册（Phase 1d）

> 面向运维与接手开发者的**队列手册**。实现落在 `apps/api/src/jobs/**`（`store` / `worker` / `gate` /
> `reconcile` / `progressRelay` / `handlers/*`），验收入口是 `pnpm.cmd run verify:phase1d`。
>
> ⚠ **本机（Windows 开发机）没有 MySQL、没有 Docker**：凡涉及 MySQL 方言或容器路径的结论，本文一律标注
> **「未实测」**，并给出"本机能证明什么 / 不能证明什么"的替代口径（见 §7）。
> ⚠ 存储是 **MySQL 表驱动（`o_job` / `o_gate`），没有 Redis**；api 进程只入队 + 推事件，执行者是独立 worker 进程。

## 1. 状态机

`o_job.state` 有 **6 个状态**（`apps/api/src/jobs/types.ts` 是唯一声明处）：

```
queued ──claim──▶ running ──succeed──▶ succeeded   （终态）
   ▲                 │
   │                 ├──fail（还有重试额度）──▶ queued（带 nextAttemptAt 退避）
   │                 └──fail（额度用尽）────▶ dead（终态；可 --requeue 重投）
   └──reclaimExpired（租约到期）◀── running（持有者崩了）

queued / running ──cancel──▶ canceled（终态）
```

两条**全局不变式**（由 store 的 SQL 保证，类型层只声明语义）：

- **终态 ⇒ `dedupeActive` 必须已置 NULL**（否则同一个幂等键永远投不进新任务）；
- **活跃态（`queued`/`running`）⇒ `dedupeActive` = `dedupeKey`**（非空才参与唯一约束，幂等锁因此是原子的）。

**`dead` 为什么存在**（与 spec §9.2 枚举的差异）：spec §9.2 只列了 `queued/running/succeeded/failed/canceled`。
但"重试额度用尽"与"被取消"是**两类不同的事实**："用尽"需要人看一眼（`--requeue` 或查 `lastError`），
"取消"是运营的主观动作。合并进 `failed` 会让运维无法用一条 SQL 找出"需要人工重投的任务"，
所以 `dead` 是**终态里的一个独立格**，语义是"系统已放弃、等人决定"。

`failed` 只作为**中间失败**的记录口径存在（当前实现里失败会直接回 `queued` 或进 `dead`；
`failed` 保留在枚举与 `TERMINAL_STATES` 里，供对账器/迁移的旧数据与将来"手动标记失败"使用）。

## 2. 队列参数

**唯一落点是代码，不是环境变量**：`apps/api/src/jobs/policy.ts` 的 `JOB_POLICY`
与 `apps/api/src/jobs/gate.ts` 的 `GATE_LIMITS`。本阶段**不新增任何 `MIWO_*`**
（`pnpm run verify:deploy` 会断言 `docker-compose.yml` 没有引入新变量）。

| 参数 | 当前值 | 含义 |
|---|---|---|
| `leaseMs` | 60000 | 领取时写 `leaseUntil = now + leaseMs` |
| `heartbeatMs` | 15000 | 心跳续租间隔（不变式 `heartbeatMs * 4 <= leaseMs`，有断言守） |
| `globalMaxRunning` | 8 | **每个 worker 进程内**同时在跑的任务数 |
| `perUserMaxRunning` | 2 | 每用户额度；⚠ 多 worker 下是"每 worker 一份"（见 §8） |
| `claimBatch` | 64 | 一次领取最多扫多少条候选（按用户上限的过滤在 JS 侧） |
| `idlePollMs` / `busyPollMs` | 1000 / 200 | 队列空 / 有活但没空槽时的轮询间隔 |
| `maxPayloadBytes` | 65536 | payload 上限：只存引用 id，base64 一律不进队列 |
| `retryBaseMs` / `retryMaxMs` | 30000 / 600000 | 退避 `base * 2^(attempts-1)`，封顶 |
| `shutdownGraceMs` | 25000 | SIGTERM 后等在跑任务收尾的时间（必须 < systemd `TimeoutStopSec`） |
| `stuckGraceMs` | 1800000 | 对账器的宽限期（多少时间内的产物行不动） |
| `relayPollMs` / `relayBatch` | 1000 / 200 | api 侧进度 relay 的轮询间隔与每轮条数 |
| `gateWaitMs` / `gateLeaseMs` / `gatePollMs` | 120000 / 300000 / 200 | `o_gate` 槽位的等待上限 / 槽位租约 / 轮询 |
| `selftestSleepMs` | 1500 | `selftest.sleep` 的睡眠（运维冒烟与 chaos 用，不碰 AI/记忆） |
| `GATE_LIMITS["vendor:text"]` | 8 | vendor 文本池上限（跨进程，`o_gate` 租约） |
| `GATE_LIMITS["vendor:image"]` | 4 | vendor 图片池上限 |
| `GATE_LIMITS["vendor:video"]` | 2 | vendor 视频池上限 |
| `GATE_LIMITS.default` | 4 | 未列出的池名取它 |

**O10 口径怎么改**（spec §15：「100 并发」指注册用户 / 日活 / 同时在线 / 同时生成中的哪一种**未定**）：
当前这组数是按"100 = **注册用户**"取的**保守默认**。口径拍板后改**三个值**：
`globalMaxRunning`、`perUserMaxRunning`、`GATE_LIMITS` 的池上限 —— **不要**去加 `MIWO_*` 环境变量。
部署侧同一张表在 `deploy/README.md` §3.6。

## 3. 租约与心跳

- **领取**（`store.claim`）是**条件写**：`UPDATE o_job SET state='running', workerId=?, leaseUntil=?,
  heartbeatAt=?, attempts=attempts+1 WHERE id=? AND state='queued'` —— 影响行数 0 表示"被别人先领走了"。
  因此**两条独立连接**同时抢同一条任务时只有一条能拿到（`tests/job-store.test.ts` 用两条
  **独立 sqlite 连接**覆盖；单连接 20 路并发用例对"`claim` 少了 `state` 条件"**没有判别力**，两者都要留着）。
- **心跳**（`worker`）：每 `heartbeatMs` 续 `leaseUntil`，续租用条件写（`WHERE id=? AND workerId=?`）。
  续租失败 ⇒ **租约已被回收/被抢占** ⇒ worker 立刻 `abort` 该任务的 `ctx.signal`，
  并且**以后不再用这条过期租约覆盖任何行**。
- **回收**（`reclaimExpired`）：`state='running' AND leaseUntil < now` ⇒ 回 `queued`（`attempts` 保留），
  这条由 worker 主循环周期性执行，也由 `job:admin --reclaim` 手工触发。
- **为什么不会误杀正在跑的任务**：心跳间隔是租约的 1/4（15s vs 60s），一次长 GC 或一次慢查询
  不会吃掉四次心跳；真的吃到四次 ⇒ 那条任务本来也已经在做无用功。
- **为什么"租约丢失 ⇒ abort"必须由 handler 尊重**：`ctx.signal` 是**协作式**的 —— worker 只能
  abort 信号，不能强杀正在跑的 Promise。每个 handler 在长时间循环/厂商调用前后都要看
  `ctx.signal.aborted` 与 `ctx.progress()` 的返回值（返回 `false` = 租约已丢，必须立刻停）。

## 4. 幂等

三层对应关系，`dedupeActive` 是**唯一**的机械保证：

| 层 | 机制 | 保证什么 |
|---|---|---|
| ① 入队去重 | `o_job.dedupeActive` **可空唯一列**（活跃期 = `dedupeKey`，终态 = NULL） | 同一个 `dedupeKey` 在库层面**只可能有一条活跃任务**（`enqueueJob` 命中已有任务 ⇒ 返回 `{jobId, deduped:true}`，不新建） |
| ② 不重复执行 | 领取的**条件写** + 租约（§3） | 同一条 job 不会被两个 worker 同时跑 |
| ③ 重跑不重复写产物 | `dedupeKey` 由**业务 id** 组成；handler 的产物写入是"按 id 覆盖"而不是"追加" | 回收/重试后重跑同一任务，产物行不会翻倍 |

- `dedupeKey` 为 `null` 的类型**不去重**（例如 `selftest.sleep`）。
- "可空唯一列"是必需的：终态必须能置 NULL，否则同键的第二条任务永远进不来。
  ⚠ **MySQL 下"唯一索引允许多个 NULL"** 属 MySQL 语义，本机只有 sqlite 侧证据 —— **未实测**（§7 U2）。
- 重试**同一** `dedupeKey` 时，`attempts` 累加（`maxAttempts` 由类型定义；`video.*` 类**不重试**，
  因为视频生成不幂等且费用高）。

## 5. 运维命令

**必须在 `cd apps/api` 下跑**（`tsx` 只装在 `@miwo/api`）。

```powershell
cd apps\api
pnpm.cmd run job:admin -- --stats                                  # 状态分布 + 在跑（全局/按用户）
pnpm.cmd run job:admin -- --list --state=dead --limit=20           # 列任务（默认只读）
pnpm.cmd run job:admin -- --requeue=<jobId>                        # dead → queued
pnpm.cmd run job:admin -- --cancel=<jobId> --reason="运营取消"      # → canceled
pnpm.cmd run job:admin -- --reclaim                                # dry-run：只列出会回收的行
pnpm.cmd run job:admin -- --reclaim --apply                        # 真回收
pnpm.cmd run job:admin -- --reconcile                              # dry-run（默认）
pnpm.cmd run job:admin -- --reconcile --apply                      # 真改判产物行
pnpm.cmd run job:admin -- --enqueue-selftest --count=3 --users=2   # 冒烟：投 N 条 selftest.sleep
```

- `--stats` 是**只读**；其余 6 个运维动作（`--list/--requeue/--reclaim/--reconcile/--enqueue-selftest/--cancel`）
  就是 Task 10 验收清单里说的"六个子命令"。
- **未知旗标一律 `EXIT 2`**（Phase 1a Ruling 25）：会改库的命令不许"静默走默认分支"。
- **写操作默认 dry-run**，`--apply` 才落库（`--reclaim` / `--reconcile`）。
- 本 CLI 是**系统级**工具（跨租户）：读 `o_job` 一律显式 `{scope:{all:true}}`（C 组复核轮 F5/N3 起
  `store.get/list` **必须显式声明作用域**，不给默认全量）。

```powershell
pnpm.cmd --filter @miwo/api run job:chaos        # 多进程混沌（K 个 worker + SIGKILL；需要 MySQL）
pnpm.cmd run verify:phase1d                      # Phase 1d 唯一验收（本机口径）
pnpm.cmd run verify:phase1d -- --require-mysql   # CI/MySQL 口径：该跑的没跑就是 FAIL
```

`job-chaos.cjs` 的 A–E 五条断言：**零丢失 / 发生过回收 / 无重叠执行 / 上限不破 / 无永久 running**。
⚠ 本机无 MySQL ⇒ 脚本 **`EXIT 2` 并说明"未连 MySQL"**（"观测不到 ≠ 通过"）。

## 6. 卡死恢复

Phase 1a 删掉的"启动时把生成中无条件改判失败"由本阶段两条机制接管：

| 机制 | 判据 | 触发 |
|---|---|---|
| **租约回收** | `state='running' AND leaseUntil < now` | worker 主循环 / `job:admin --reclaim --apply` |
| **产物对账**（`reconcile.ts`） | A：**死信/取消的 job**（终态）在宽限期后调该类型的 `onAbandon()`；B：`state='生成中'` 且**没有任何活跃 job**（`queued`，或 `running` 且**租约未过期**）的 payload 提到它的产物行 | `job:admin --reconcile --apply`（worker 不自动跑，避免多实例互相改判） |

- **B 的判据比旧的 `db:repair-stuck` 强**：后者只能按"超过 N 分钟没更新"猜，而"任务还在不在队列里/
  还有没有有效租约"是**队列状态**的事实。`o_image` **没有时间列**（`001_schema` 与现状库都没有）
  ⇒ 它的 age 判据**退化**，只靠 B 的"活跃引用"判据（宁漏修不误杀，已在代码里点名）。
- ⚠ **`db:repair-stuck` 已弃用**：脚本仍在（`pnpm.cmd --filter @miwo/api run db:repair-stuck`），
  但启动即打印弃用说明，**只作为最后手段**。正式口径是 `job:admin --reconcile`。
  删除它归 **Phase 1c 的 deferred 表**（与根 README「`db:repair-stuck`」一节一致）。
- **何时该人工介入**：① `--reconcile --apply` 的 `failedTables` 非空（某张表改判失败，看 `lastError`）；
  ② `--stats` 里 `dead` 持续增长（看 `lastError` 决定 `--requeue` 还是修数据）；
  ③ `--reclaim` 反复回收同一条（说明某个 worker 一直崩，看它的日志）。
- **对账报告有两个不同的数**：`wouldAbandonRows`（判定要改多少）与 `abandonedRows`（**真的写成功**多少，
  = `UPDATE` 的 affected 之和；dry-run 下恒为 0）。这是复核轮 F9 的修正 —— 旧实现会把"判定数"当"写入数"，
  让 `--apply` **夸大**改判量。

## 7. 降级口径：本机无法验证项（U1–U7）

> 本机（Windows 开发机）**不启动 MySQL（3307 独占）、没有 Docker**。下表是"能证明什么 / 不能证明什么"的
> 如实口径 —— CI 的 `mysql` job（`MIWO_TEST_MYSQL=1`）是唯一真跑环境。

| # | 无法在本机验证的事 | 本机的替代证据 | 真跑环境 |
|---|---|---|---|
| **U1** | MySQL 方言正确性（条件 UPDATE 而非 upsert、`GROUP BY` 严格模式、毫秒列宽度） | `verify:phase1d` **B 组**：mysql2 客户端上 `toSQL()` 的静态 SQL 文本 + 毫秒列清单（**标注未实测**） | CI mysql job |
| **U2** | `dedupeActive` "**可空唯一列允许多个 NULL**"（MySQL 8 语义） | sqlite 侧唯一约束用例（`tests/job-store.test.ts`）；MySQL 侧用例已写好但本机 **SKIP** | CI mysql job（`job-mysql-integration.test.ts`） |
| **U3** | `for update skip locked` 真执行 | 无（本机没有 MySQL 可锁） | CI mysql job |
| **U4** | 多进程混沌 A–E 的真实输出（零丢失/发生回收/无重叠/上限不破/无永久 running） | `job-chaos.cjs` 已实现；本机 **`EXIT 2` 并说明未连 MySQL** | CI mysql job |
| **U5** | CI 本身在真 GitHub runner 上执行 | `check-ci-yaml` 的结构断言 + 本机跑**同样的命令** | 有 remote 之后的第一次 CI |
| **U6** | 容器路径：镜像构建、`network_mode: host` 的真实行为、容器内 worker 启动 | `verify:deploy` 静态断言 + `deploy/README.md` §3.5 的标注（本机无 Docker） | 部署窗口 |
| **U7** | `verify:phase1d --require-mysql` 的 "SKIP ⇒ FAIL" 分支本身；以及**浏览器端到端** | 分支已实现但**未实跑**（本机无 MySQL）；前端目前**没有** `job:update`/`jobIds` 消费方 ⇒ 无浏览器级验收 | CI mysql job（前者）/ Phase 1e（后者） |

## 8. 已知限制

1. **按用户上限在多 worker 下是"每 worker 一份"**：`perUserMaxRunning` 在**每个 worker 进程**里各算一次
   ⇒ 起 2 个 worker 时某用户理论上可同时跑 4 条。真正的全局按用户配额要等 **Phase 3 的集中调度**
   （或再加一张按用户的槽位表）。systemd 与 compose 的 worker **二选一**，不要同时起（见 `deploy/README.md` §3.5）。
2. **`job:admin --reclaim` / `--reconcile` 默认 dry-run**，`--apply` 才写库；`--stats` / `--list` 会**读库**。
   沿用 **Phase 1a Ruling 27** 的运维提示体例：**用只读账号跑 `--stats` 会失败**（它要读 `o_job`），
   而 `--apply` 需要写权限。别把运维命令塞进只读监控账号的定时任务里。
3. **迁移清单损坏时 `db:migrate*` 会硬报错**（Phase 1a Ruling 27）：`MIGRATIONS` 与目录文件必须一一对应
   （`tests/migrations.test.ts` 守）。CLI 在迁移链完成前不会动手（`job-admin` 会 `await dbReady`），
   所以"迁移坏了"的表现是 **CLI 直接报错**，不是"队列悄悄不工作"。
4. **`--list` 只有 `--state` / `--limit` 两个过滤**：没有按用户/类型/时间范围的过滤（需要更细的排查时用 SQL）。
5. **进度事件要等 `userId` 真的进 socket 房间才可用**：relay 把 `job:update` 投到 `user:{userId}` room；
   若某条任务 `userId` 为 `NULL`（平台任务），**不推**（避免广播）。前端消费方见 U7。
6. **7 个"请求内同步等模型"入口仍未入队**（spec §9.1）：它们加了 vendor 闸门与 `concurrentCount ≤ 8`，
   但仍是同步返回（P95 仍受模型时延影响）。"建记录 → 入队 → 返回 id"要前端一起改，见附录 B 第 1 条。
7. **厂商调用超时只做到任务级**（worker 的 `def.timeoutMs`）；厂商 HTTP 层的显式 timeout
   （spec §9.3 的文本 120s / 图片 300s / 视频轮询退避）仍在 Phase 1c Tier 1 #13。
8. **`o_tasks`（UI 日志）没有和 `o_job` 合并**：排查时要看两张表。
9. **`deploy/.env.example` 的 `MIWO_DB_HOST=127.0.0.1` 耦合无法断言**：host 网络模式下 MySQL 必须发布在
   宿主机回环，而 `.env` 是 gitignored ⇒ 门禁只能断言 `.env.example`（Phase 0 ledger N3）。部署时手工核对。

## 附录 A：deferred 登记表（从 Phase 0 / 1a 账本落进 Phase 1d 的条目）

| # | deferred 项 | 账本依据 | 归属 | 本计划的落点 |
|---|---|---|---|---|
| 1 | 重启后 `state='生成中'` 不再自动改判失败 → 由租约超时接管 | Phase 1a ledger **deferred #10** | **Phase 1d（已落地）** | `reclaimExpired` + `reconcile.ts` + 租约心跳 |
| 2 | `db:repair-stuck` 是**过渡手段** | Phase 1a ledger 裁定 2 / deferred #10 | **Phase 1d（已落地）** | 改为弃用别名（启动即打印弃用说明）指向 `job:admin --reconcile`；**删除留 Phase 1c** |
| 3 | 容器路径整体未验证 + **全仓无 `.dockerignore`**（"Phase 1d 准入前必修"） | Phase 0 ledger Task 10 minor **N1**；Phase 1a ledger deferred #16 | **Phase 1d（已落地）** | `deploy/.dockerignore`（保留 `data/{vendor,skills,modelPrompt}`） |
| 4 | `/oss` 的 Range 断言会被 `If-Range` 满足 | Phase 0 ledger Task 10 minor **N2** | Phase 1d（已落地） | `check-deploy-config.cjs` 锚 `proxy_set_header Range $http_range;` |
| 5 | host 模式下 `MIWO_DB_HOST=127.0.0.1` 只有注释没有断言 | Phase 0 ledger Task 10 minor **N3** | Phase 1d（部分）/ 部署窗口 | **`.env` 是 gitignored，门禁无法断言它** ⇒ 登记在本手册 §8 第 9 条 + `deploy/README.md` |
| 6 | `COPY .npmrc` 的检查可被注释行满足；`FROM` 只查下限不查 `<25` | Phase 0 ledger Task 10 minor **N4** | Phase 1d（已落地） | `check-deploy-config.cjs`：真实指令行 + 上界检查 |
| 7 | compose 注释口径：`MYSQL_PWD` 只消除 ps/argv 泄露，根口令仍在容器 Env | Phase 0 ledger Task 10 minor **N5** | Phase 1d（文档） | `deploy/docker-compose.yml` 注释已按此口径写明 |
| 8 | 容器内 `${MIWO_DATA_DIR}/{vendor,skills,modelPrompt}` 必须首次播种 | Phase 0 ledger 部署 Ruling（systemd 主推） | Phase 1d（文档） | `deploy/README.md` §3.5：与 api 同一卷、同样需要播种 |
| 9 | `apps/api/data/models` 不存在 → 任何验证不得依赖 embedding/记忆 | Phase 0 ledger Task 4 Ruling | 全阶段约束 | `job:admin --enqueue-selftest` 与 `job-chaos` 只用 `selftest.sleep`，不碰 AI/记忆 |
| 10 | `MIWO_TEST_SLOW=1` 未接进 CI | Phase 1a ledger **Ruling 26** | Phase 1d（已落地） | CI 的 mysql job 步骤带上 `MIWO_TEST_SLOW: "1"` |
| 11 | `knex_migrations`/`knex_migrations_lock` 需要策略声明 | Phase 1a ledger deferred #4 | Phase 1b | 不在本阶段；`o_job`/`o_gate` 两行已加，两张 knex 表**已核对**在 `policies.ts` 里声明 |
| 12 | 35 处 insert 的 `insertId` 语义复核（MySQL 首行 vs SQLite 末行） | Phase 1a ledger deferred #6 | Phase 1b | 队列侧已规避（`enqueue` 只插一行） |
| 13 | `o_agentWorkData.data` 仍是 `varchar(255)` | Phase 1a ledger deferred #11 | 观察项 | **本条已过期**（HEAD 里是 `t.text`）；对账器只改 `state`/`errorReason`，不写该表 |
| 14 | 三条"只在真 MySQL 暴露"的风险（`float(8,2)` 废弃 / collation / `o_agentWorkData` 唯一键） | Phase 1a ledger **Ruling 34** | Phase 1a Task 8 + 本计划 CI | 归入本手册 §7 U1–U3 的同类口径 |
| 15 | 列收窄不得回归（`o_modelPrompt.fileName/path` 等） | Phase 1a ledger **Ruling 35** | Phase 1a 修复轮 | 本阶段**只放宽**（`int → bigint unsigned`），不收窄任何列 |
| 16 | `await hasTable` 的恒真陷阱 | Phase 1a ledger **Ruling 31** | 全阶段约束 | 迁移与 worker 的 `hasTable` 全部 await |
| 17 | 不要在根 `package.json` 加 `tsx`；`node --import=tsx` 必须在 `apps/api` 下 | Phase 1a ledger **Ruling 23** | 全阶段约束 | 本手册 §5 的每条命令都写 `cd apps\api` |
| 18 | CLI 未知旗标必须拒绝 | Phase 1a ledger **Ruling 25** | 全阶段约束 | `job-admin` 白名单 + `EXIT 2` 验收 |
| 19 | `--status` 会写库；迁移清单损坏时 `--down` 也硬报错 | Phase 1a ledger **Ruling 27** | 全阶段文档 | 本手册 §8 第 2、3 条 |
| 20 | `MIGRATIONS` 顺序必须递进、只许追加 | Phase 1a ledger **Ruling 24** | 全阶段约束 | `tests/migrations.test.ts` 的既有断言 |
| 21 | `check-brand` 已改全仓扫描 + 显式豁免，不得"改文案绕规则" | Phase 0 ledger 终审 + Ruling | 全阶段约束 | 本阶段新增文档只用 miwo / 谜沃 / MirrorWorld |
| 22 | `build.ts` 的 `external` 里 `"electron"` 必须保留 | Phase 0 ledger Task 7 Ruling（C1） | 全阶段约束 | 未动 `external`；worker 与 api 共用同一份配置 |
| 23 | 旧仓库冻结覆盖不足（基线只有 8 个文件，287 个已脏文件隐形） | Phase 0 ledger 终审 | 观察项 | 沿用 `verify:legacy-freeze`；结论不因本阶段改变 |
| 24 | CI 从未在真 GitHub runner 上跑过（仓库无 remote） | Phase 0 ledger Task 11 残留风险 | 观察项 | 本手册 §7 **U5** |
| 25 | spec §9.1 的 7 个同步入口入队（响应形态变更） | 本计划新发现（与 spec §9.1 的显式偏差） | **Phase 1e** | 附录 B 第 1 条（本阶段先把闸门与 `concurrentCount ≤ 8` 补上） |
| 26 | `o_image`/`o_storyboard` 的孤儿判据若缺时间列 → 降级为"仅活跃引用" | 本计划新发现 | Phase 1d 实现时确认 | **已确认**：`o_image` 无时间列 ⇒ `timeCol: null`（见 §6） |
| 27 | 毫秒时间列宽度缺陷（`001_schema.ts` 用 `T.integer` 建时间列） | 本计划新发现（种子数据 `1774447310118` 实据） | **Phase 1d（已落地）** | `00N+2_time_ms_bigint`：15 列/12 表，只对 mysql 发 alter，sqlite no-op |

## 附录 B：本阶段完成后**仍未**具备的能力（如实登记）

1. **spec §9.1 的另外 7 个"请求内同步等模型"入口没有入队** —— 它们加了 vendor 闸门与
   `concurrentCount ≤ 8`，但仍是同步返回。真正的"建记录 → 入队 → 返回 id"需要前端一起改。
2. **100 并发压测（spec T7）没有在生产规模上跑过** —— 本机无 MySQL / 无 Docker。替代口径是
   sqlite 单进程并发用例 + MySQL 多进程 chaos（3 worker / 30 job / 杀 1 个）+ 结构断言 + CI 真跑。
   **没有**"P95 < 1s 在 100 并发下成立"的实测数据。
3. **按用户并发上限在多 worker 下只是"每 worker 一份"**（§8 第 1 条）。
4. **容器路径仍未在真机验证**（§7 U6）：只有静态断言 + 文档；systemd 是 Phase 1 主推。
5. **进度事件要等 Phase 1c 的握手把 `userId` 交给 socket 才真正可用** —— 若未落，relay 会空转
   （代码有断言，不报错但不推）。
6. **厂商调用超时只做到任务级**（§8 第 7 条）。
7. **`o_tasks`（UI 日志）仍是观测口径**，没有和 `o_job` 合并（§8 第 8 条）。
8. **`db:repair-stuck` 只是被取代（弃用别名），没有删除** —— 删除归 Phase 1c。

## 相关文档

- 部署与并发口径：`deploy/README.md`（§3.5 worker / §3.6 O10 参数表 / §3.7 媒体路由）
- 鉴权与媒体签名：`apps/api/README-auth.md`
- 根 `README.md` 的「任务队列（Phase 1d 起）」一节与「`db:repair-stuck`（已弃用）」一节
- 验收：`pnpm.cmd run verify:phase1d`（A 结构 / B 静态方言 / C sqlite 端到端 / D MySQL / E 门禁+既有 verify）
