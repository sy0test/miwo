# apps/api 数据库运维口径（回填 / 迁移 / 诊断）

> 这份文档记录**会改数据**的命令怎么安全地跑，以及几条**踩过就会静默坏**的纪律。
> 迁移的整体纪律见根 `README.md` 的「迁移纪律」；这里是它的**操作附录**。

## 1. 目标库护栏（先记住这条）

所有 `db:*` CLI 与**应用启动路径**都会过同一道护栏（`scripts/db-target-guard.cjs`，Ruling 131）：

- 目标解析成 `<仓库>/apps/api/data/db2.sqlite` 且**没有显式放行** ⇒ **拒绝执行**；
- 放行只有两条路：`MIWO_DATA_DIR=<仓库外的目录>`（推荐，一次性目录），或显式
  `--allow-repo-dev-db` / `MIWO_ALLOW_REPO_DEV_DB=1`（后者还会先要求/建立仓库外的可恢复点）。

想拿一次性库试跑：`MIWO_DATA_DIR=D:\tmp\miwo-try`。**不要**为了方便去放宽这条护栏。

## 2. `004_backfill_userid`：`userId` 回填 + `memories` 旧键改写

### 2.1 它解决什么（不跑它就是功能坏的）
- `productionAgent`（视频策划）**连不上**：连接期的归属校验要 `o_script.userId` 属于当前用户，
  而真实库上这一列**全是 NULL** ⇒ 每次连接都被拒。
- `memories` 的 `isolationKey` 是**旧格式**（`projectId:agentType[:episodesId]`，没有 `userId` 前缀）
  ⇒ 新代码（`${userId}:…`）**读不到它们，而且不报错**（记忆面板空白，看起来像"socket 没生效"）。

### 2.2 运维步骤（顺序别换）
```powershell
cd apps/api
# ① 先备份（仓库外；.db-backups 是约定的备份目录）
Copy-Item <目标库> D:\sy_workspace\.db-backups\<目标库名>.before-backfill.sqlite -Force

# ② 先 dry-run 看计划（不写库）
node --import=tsx scripts/backfill-userid.ts

# ③ 确认报告后写库（-apply 才会写）
node --import=tsx scripts/backfill-userid.ts --apply

# ④ 可选：把"推不出归属"的孤儿显式归给某个用户
node --import=tsx scripts/backfill-userid.ts --apply --assign-to=1
```
- **未知旗标一律 exit 1**（Ruling 25 同款纪律）：`--aply` 这种拼错**不会**静默降级成 dry-run。
- **幂等**：只处理 `userId IS NULL` 的行 + 键不合规的行 ⇒ 连跑两次第二次"处理 0 行"。
- **孤儿默认留 NULL**（谁都看不见）：要归属必须显式 `--assign-to`；工具**绝不**猜一个用户。
  - 典型孤儿：归属链断的行（例：`o_project.userId` 为 NULL 的项目，其所有子行）、
    `o_event` 挂到多个项目的**多义**行（报告里单列"多义"）。
- 应用启动/`db:migrate` 会自动跑 004（迁移链里的 001–004）；**004 不允许 `--assign-to`**，
  自动迁移只做"能推出来的部分"。

### 2.3 报告怎么读（自检表）
每次跑完打印三张关键表的自检（审查输入 D/E）。下面是**格式示例**（不是任何真实库的实测值，
真实数字以你自己那次输出为准；e2e 用例的真实输出见 Task 6 报告）：
```
表：table / 总行 / 回填前 NULL / 本次处理 / 孤儿 / 多义
  o_script: 8 / 8 / 8 / 0 / 0
自检：table / userId IS NULL（实际 / 应剩）/ 键首段违规
  o_script: 0 / 0 / 0
  o_project: 1 / 1 / 0
  memories: 0 / 0 / 0
```
- **`实际 / 应剩` 必须相等**：不等 = "有行该填没填"（工具会**抛错并 exit 1**）。
- **`键首段违规` 必须为 0**：`memories` 里"键的首段 ≠ 该行 `userId`"的条数。不为 0 说明键没改写对，
  那些行**读不到**（dry-run 时它只是"待修复量"，不抛）。
- 一句话判据：**"记忆面板空白"永远先看 `memories` 的这两列，再看 socket。**

### 2.4 `down` 为什么是 no-op
`004.down()` **不回滚数据**，三条理由：
1. 回填是"给已有行补归属"，不是新增事实；置回 NULL 只会让所有行对任何租户都不可见（fail-closed）；
2. `memories.isolationKey` 的前缀已被改写，**凭空无法还原**成"当时的形状"；
3. 真要回退是 `001_schema.down`（删列/删表）的路径，那是 Phase 1a 的 down。

与 `003_vendor_asset_sync`（只报告不写盘、down 为 no-op）同一取舍。

## 3. 诊断：agent 到底连得上吗

`productionAgent` 连不上的**唯一**已知原因是 `o_script.userId` 未回填。诊断命令（**只读**）：
```powershell
MIWO_DATA_DIR=<数据目录> node --import=tsx scripts/probe-agent-connect.ts --project=<id> --script=<id> --user=<id>
```
它复用**真实**的连接逻辑（验签 → 归属校验 → 服务端推导 `isolationKey` → 绑定 handler），
只把 transport 换成假 socket，最后打印一行 `PROBE_RESULT=<JSON>`：
- `disconnected=true` + `scriptCheckRejected=true` ⇒ 目标集不在当前用户名下（或 `o_script.userId` 未回填）；
- `disconnected=false` + `handlers=["updateContext","chat",…]` ⇒ 连接链路正常，问题在别处。

## 4. 开发纪律：`runWithTenant` 里**必须**在里面 await

**硬规则（Task 6 实测发现，已登记）**：凡在 `runWithTenant(ctx, …)` 里发起 DB 操作，
回调必须是 `async` 且**在里面 `await`**；不许"返回 thenable、到外面再 await"。

- **坏形态**（实测报错原文）：
  ```ts
  await runWithTenant(ctx, () => guarded("memories").where({ ... }).first());   // ✗
  // → TenantIsolationError: 执行期复核失败：SQL 提及 1 张租户表（memories），
  //   但只有 1 处 userId 条件 / 0 个 ctx.userId 绑定 —— 已阻断（fail-closed）
  ```
  原因：守卫的"执行前复核"在**执行时**读 `getCtx()`；把 builder/thenable 拿到 `run()` 外面 await，
  查询是在**没有 ctx** 的上下文里启动的 ⇒ 复核看不到 ctx。
- **好形态**：
  ```ts
  await runWithTenant(ctx, async () => await guarded("memories").where({ ... }).first());   // ✓
  ```
- 对照用例：`tests/backfill-userid.test.ts` 的「★★ ALS 纪律」一条把两端都钉住了。
- ⚠ 注意 `runWithTenant(ctx, () => next())`（Express 链）与 socket 的
  `runWithTenant(ctx, () => handler(...args))` 是**可以**的：它们的下游是在**同步段**里被调用的，
  查询仍在 `run()` 内启动（Task 4/5 有端到端证据）。真正危险的是"到外面 await"。

## 5. 键格式的唯一真相

`isolationKey` 的形状只在一处定义：**`src/db/isolation-key.ts`** 的 `buildIsolationKey`
（`${userId}:${projectId}:${agentType}[:episodesId]`；集号按**值**判定，正整数才采用）。
`@/socket/tenant` 把它**再导出**给 socket/HTTP 用；回填工具也走同一份实现
（`src/db/legacy/backfill-userid.ts`）。**别在别处拼串**——那正是"读写键静默错开"的来源。

> 为什么它不在 `socket/tenant.ts`：那里顶层 `import u from "@/utils"` → `@/utils/db` → `@/db/connect`，
> 而 `db/migrations/004` 在**启动链**上被加载 —— 从迁移链 import 它会构成加载期循环
> （实测 `TypeError: createKnex is not a function`）。

## 6. 未验证项

- **MySQL 方言未实测**：004 与 CLI **零 raw SQL**（纯 knex query builder），sqlite 上完整回归；
  但"批量 `whereIn(...).update()`"在 MySQL 上的行为、以及 `memories.isolationKey` 前缀匹配的
  大小写敏感性**没有**实测数据。
- **真实库上的回填未跑**（`apps/api/data/db2.sqlite` 是只读快照；一切实验都在 `%TEMP%` 一次性副本上）
  ⇒ 真实库的**行级结果**只能由运维按 §2.2 跑完后用 §2.3 的自检表核对。
