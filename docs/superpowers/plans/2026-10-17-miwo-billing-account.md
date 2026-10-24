# 谜沃计费账户与充值流程实施计划

> **供代理执行者使用：** 必须逐任务执行本计划；建议使用 `subagent-driven-development`，也可用 `executing-plans`。任务用复选框跟踪。

**目标：** 确保新旧用户都有零余额账户，在工作台常驻显示可用余额，并为管理员提供中文、单次确认、原子且幂等的手动充值流程。

**架构：** API 追加仅补数据的 `013` 迁移，注册时在同一事务创建账户；充值在单一事务内写入已完成订单、账户余额和账本流水。前端以共享计费账户状态支持侧栏余额和计费页，管理表单使用稳定幂等键并复用服务端权威数据。

**技术栈：** TypeScript、Express、Knex、MySQL/SQLite 方言、Vitest、Vue 3、Pinia、TDesign、Node.js 内置测试运行器。

**规格：** `docs/superpowers/specs/miwo-settings-billing-redesign.md`

## 全局约束

- 可用余额为 `balanceMicro - frozenMicro`；金额用整数微人民币计算，不使用浮点数作为账本运算。
- 新账户初始余额和冻结金额均为零，不赠送额度；零余额用户不能提交计量任务。
- 充值订单、账户入账与账本流水必须在同一事务内完成；审计在事务成功后按现有尽力写入策略发出，不宣称审计与业务原子提交。
- 每次充值需使用并复用稳定幂等键；模型授权与账户充值相互独立。
- 本次新增或调整的计费页面、表单、操作反馈和错误状态默认使用简体中文；真实支付渠道不在范围内。
- 历史待处理订单不编辑、不删除；可保留现有确认 API 以处理历史记录，但新页面不得继续创建待处理充值单。
- 不提交代码，除非用户另行要求。

---

### 任务 1：新增账户初始化能力和旧用户回填迁移

**文件：**
- 修改：`apps/api/src/billing/accounts.ts`
- 新建：`apps/api/src/db/migrations/013_account_bootstrap.ts`
- 修改：`apps/api/src/db/migrations/index.ts`
- 测试：`apps/api/tests/billing-accounts.test.ts`
- 测试：`apps/api/tests/migration-billing.test.ts`
- 测试：`apps/api/tests/migrations.test.ts`

**接口：**
- 新增 `ensureAccountInTransaction(trx, userId): Promise<void>`，写入 `{ userId, balanceMicro: 0, frozenMicro: 0, version: 0, updatedAt: Date.now() }`，若已有账户则不改动任何字段。
- 新迁移名为 `013_account_bootstrap`，只为缺少 `o_account` 的 `o_user` 插入零余额行，不改动已有账户；`down` 是 no-op，避免错误删除已创建或已使用账户。

- [ ] **步骤 1：先写账户初始化失败测试**

  在 `billing-accounts.test.ts` 覆盖：缺失账户被创建且字段全为零；对已有非零账户再次调用不改余额、冻结额、版本和更新时间；非法用户 ID 被拒绝。

- [ ] **步骤 2：运行测试确认初始化函数缺失**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-accounts.test.ts`。预期：因新导出不存在而失败。

- [ ] **步骤 3：实现事务内幂等账户初始化**

  在 `accounts.ts` 实现 `ensureAccountInTransaction`，先校验正整数安全范围，再检查该用户账户；已有行立即返回，缺失时插入规定的零值字段。调用者必须传入当前业务事务。

- [ ] **步骤 4：添加账户回填迁移测试**

  在 `migration-billing.test.ts` 建立初始迁移库，在 `o_user` 插入两个用户，其中一个预先拥有非零账户；应用 `013_account_bootstrap` 后断言缺失者得到零余额账户，已有余额、冻结额、版本及更新时间完全不变。断言迁移名已加入 `MIGRATIONS` 且顺序递增。

- [ ] **步骤 5：实现并注册 `013` 迁移**

  新迁移通过 Knex 查询构造器选择缺少 `o_account` 行的 `o_user`，插入零值账户；不使用方言专用 SQL，不建立新表。将迁移追加到 `MIGRATIONS` 末尾，并在 `migrations.test.ts` 的迁移清单断言中加入名称及顺序。

- [ ] **步骤 6：运行迁移与账户测试**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-accounts.test.ts tests/migration-billing.test.ts tests/migrations.test.ts`。预期：SQLite 迁移、回填、保留既有余额和清单顺序测试通过。

### 任务 2：在用户注册事务中创建账户

**文件：**
- 修改：`apps/api/src/auth/service.ts`
- 修改：`apps/api/tests/auth-service.test.ts`
- 测试：`apps/api/tests/e2e-register-login-isolation.test.ts`

**接口：**
- `registerWithInvite` 成功创建 `o_user` 后、同一事务提交前调用 `ensureAccountInTransaction(trx, newUserId)`。
- 注册返回值和登录协议不变。

- [ ] **步骤 1：添加注册建账失败测试**

  在服务注册测试中使用真实 `registerWithInvite` 成功创建新用户后，按返回用户 ID 查询 `o_account`，断言余额、冻结额和版本为零。该断言确保建账与注册同一成功路径。

- [ ] **步骤 2：运行注册测试确认缺少账户**

  运行：`pnpm --filter @miwo/api exec vitest run tests/auth-service.test.ts`。预期：现有注册成功而账户行不存在，新增断言失败。

- [ ] **步骤 3：把账户初始化放入注册事务**

  在 `service.ts` 导入 `ensureAccountInTransaction`；取得新用户 ID 后，在原事务中初始化账户，然后才返回 ID。若账户插入失败，整笔注册事务回滚。

- [ ] **步骤 4：运行认证与端到端隔离测试**

  运行：`pnpm --filter @miwo/api exec vitest run tests/auth-service.test.ts tests/e2e-register-login-isolation.test.ts`。预期：注册、登录、租户隔离及零余额账户断言通过。

### 任务 3：一次性、原子且幂等的管理员手动充值 API

**文件：**
- 修改：`apps/api/src/routes/billing/admin/recharges.ts`
- 修改：`apps/api/tests/billing-routes.test.ts`
- 参考但不改：`apps/api/src/billing/ledger.ts`、`apps/api/src/utils/audit.ts`

**接口：**
- 新充值请求仍使用 `POST /api/billing/admin/recharges`，请求字段为 `{ userId, amount, note, idempotencyKey }`；`idempotencyKey` 是客户端为一次操作生成的 UUID，并在同次重试中复用。
- 响应直接返回已完成的充值订单、目标用户和账户余额，不返回待处理订单。
- `POST /api/billing/admin/recharges/:id/confirm` 保留给历史待处理记录使用；新页面不再调用。

- [ ] **步骤 1：编写新充值 API 失败测试**

  在 `billing-routes.test.ts` 添加用例，断言管理员请求一次返回已完成订单、账户增加精确微元、产生一条对应账本流水且不要求外部交易号；相同管理员、目标用户与幂等键重试返回原订单且账户与流水不重复；幂等键用于不同目标或不同金额时返回冲突；普通用户仍收到 403；缺失账户的目标用户可在同一事务内补建并完成充值；订单写入失败时账户和账本均不改变。把原先“通过新 API 建 pending 再确认”的用例改为先直接插入一条历史 pending 订单，再验证兼容确认端点；把目标用户隔离/审计测试改为断言单次直充后目标账户与操作人审计记录正确。

- [ ] **步骤 2：运行路由测试确认新协议失败**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-routes.test.ts`。预期：当前路由因不接受幂等键且仍返回 pending 订单而失败。

- [ ] **步骤 3：实现单事务直接入账**

  校验管理员、目标用户存在、正数金额、微元精度和 I64 范围；校验幂等键格式与最大长度。使用管理员 ID 和幂等键生成确定性的 `outTradeNo`，让订单唯一索引成为请求去重约束。事务中锁定目标用户，确保账户存在；若相同订单已存在，校验目标、金额、原因一致后返回原结果；否则调用 `creditInTransaction` 写账本并更新余额，同时插入 `status: "paid"`、`channel: "manual_admin"`、`type: "recharge"`、`paidAt` 非空、`externalTradeId: null` 的订单。任何步骤失败都回滚。事务成功后按现有 best-effort 策略调用审计 helper。

- [ ] **步骤 4：运行充值、权限与账本回归测试**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-routes.test.ts tests/billing-ledger.test.ts tests/billing-submit.test.ts`。预期：新充值幂等、旧确认流程、用户权限和现有账本提交测试均通过。

### 任务 4：在工作台侧栏显示共享可用余额

**文件：**
- 新建：`apps/web/src/stores/billing.ts`
- 修改：`apps/web/src/pages/workbench/index.vue`
- 修改：`apps/web/src/views/billing/billingData.ts`
- 修改：`apps/web/tests/billing.test.mjs`

**接口：**
- Pinia store 暴露 `account`、`loading`、`error` 与 `refreshAccount(): Promise<void>`。
- `availableBalanceMicro` 使用 `BigInt(balanceMicro) - BigInt(frozenMicro)`；金额格式化复用现有 `formatMicroToCny`。
- `loadBillingAccount(state, fetchAccount): Promise<void>` 是 `billingData.ts` 导出的纯加载器：state 为 `{ account: BillingAccount | null, loading: boolean, error: string }`；成功时更新账户并清错，失败时保留明确错误状态且初次加载不得显示零余额，finally 清除 loading。store 的 `refreshAccount()` 以此加载器包装 API 请求。
- 请求失败时保持错误状态；共享状态在计费页成功刷新后立即更新。

- [ ] **步骤 1：添加余额格式与 store 状态测试**

  扩展 `billing.test.mjs`，断言可用余额扣除冻结金额并保留整数精度；调用纯函数 `loadBillingAccount` 覆盖成功加载、加载失败和再次刷新后替换账户状态。将假的 `fetchAccount` 回调传入加载器，不导入 Pinia 或启动 Vue 应用。

- [ ] **步骤 2：运行测试确认共享账户 store 缺失**

  运行：`pnpm --filter @miwo/web exec node --experimental-strip-types --test tests/billing.test.mjs`。预期：`loadBillingAccount` 尚未导出且可用余额行为未实现，新增断言失败。

- [ ] **步骤 3：实现共享账户状态与工作台余额入口**

  创建 Pinia billing store，以 `/billing/account` 获取登录用户账户；由 `billingData.ts` 计算可用微元余额并格式化。工作台工具栏底部显示中文「可用余额」及金额，点击进入 `/billing`。加载时显示中文加载状态，错误时显示中文错误状态和可进入计费页的入口，不显示伪造的零余额。进入工作台及路由切换后刷新账户。

- [ ] **步骤 4：运行前端数据测试与类型检查**

  运行：`pnpm --filter @miwo/web test` 和 `pnpm --filter @miwo/web type-check`。预期：余额计算、加载/错误状态、菜单测试和类型检查通过。

### 任务 5：中文个人账户页和管理员直充界面

**文件：**
- 修改：`apps/web/src/views/billing/index.vue`
- 修改：`apps/web/src/views/billing/billingData.ts`
- 修改：`apps/web/src/locales/language/zh-CN.json`
- 修改：`apps/web/tests/billing.test.mjs`

**接口：**
- 计费页使用共享 billing store 的账户状态；页面现有 `/billing/ledger`、`/billing/usage`、`/billing/orders` 数据继续由服务端获取。
- 管理充值表单以 `{ userId, amount, note, idempotencyKey }` 调用 API。
- `getRechargeAttempt(input, previous, createKey)` 接收 `{ userId, amount, note }`、上次 `{ fingerprint, idempotencyKey } | null` 和可注入的 UUID 生成器，返回新的或可复用的 `{ fingerprint, idempotencyKey }`；相同表单内容复用键，任一字段变化生成新键。成功后清空本次尝试。
- 充值成功后刷新账户、账本、订单和侧栏共享状态。

- [ ] **步骤 1：扩展前端行为测试**

  在 `billing.test.mjs` 覆盖：普通用户不可管理；账户加载、错误、空流水状态彼此区分；旧待处理记录不作为新充值入口；`getRechargeAttempt` 对相同表单复用幂等键、表单变更生成新键；金额与冻结余额精确计算。

- [ ] **步骤 2：运行测试确认旧页面行为被测试发现**

  运行：`pnpm --filter @miwo/web exec node --experimental-strip-types --test tests/billing.test.mjs`。预期：当前两阶段充值数据/确认辅助行为与新界面测试不匹配。

- [ ] **步骤 3：分离个人账户区和管理员管理区**

  重整 `index.vue`：所有用户先看可用余额、冻结金额和账户活动；管理员另外看到管理区域，并用 TDesign 标签页分开展示「手动充值、模型授权、价格配置」，避免无关表单连续堆叠。普通用户不渲染管理区域。删除新建待处理订单表单、管理员待处理订单队列和外部交易号确认控件；订单表继续展示历史待处理记录及其状态，但不得编辑或丢弃。

- [ ] **步骤 4：增加直接充值确认和幂等重试**

  管理员填写目标用户、人民币金额和必填原因，提交前显示包含三项内容的中文确认对话框。确认后生成 UUID 并发送单次 API 请求；若网络错误，重试保持同一 UUID。成功后调用 store 的 `refreshAccount()` 并重载账本、用量、订单和余额。

- [ ] **步骤 5：将本次计费界面文案改为简体中文**

  把刷新、账户不可用、余额不足、空状态、表格列、订单状态、价格配置、模型授权、金额、操作原因、确认和错误提示全部改为 `zh-CN.json` 中的中文键值。账户请求失败和无流水需使用不同状态。不得在页面显示外部支付渠道或要求填写交易号。

- [ ] **步骤 6：运行 web 测试、类型检查和生产构建**

  运行：`pnpm --filter @miwo/web test`、`pnpm --filter @miwo/web type-check`、`pnpm --filter @miwo/web build`。预期：所有检查通过，生产构建产物成功生成。

### 任务 6：端到端回归与最终验证

**文件：**
- 测试：`apps/api/tests/billing-routes.test.ts`
- 测试：`apps/api/tests/auth-service.test.ts`
- 测试：`apps/api/tests/migration-billing.test.ts`
- 测试：`apps/web/tests/billing.test.mjs`
- 验证：`apps/api/src/billing/submit.ts`

- [ ] **步骤 1：运行 API 目标测试集合**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-accounts.test.ts tests/billing-routes.test.ts tests/billing-ledger.test.ts tests/billing-submit.test.ts tests/migration-billing.test.ts tests/migrations.test.ts tests/auth-service.test.ts tests/e2e-register-login-isolation.test.ts`。预期：迁移、注册、账户隔离、充值一次入账、权限和零余额拒绝计量均通过。

- [ ] **步骤 2：运行 web 测试、类型检查和构建**

  运行：`pnpm --filter @miwo/web test`、`pnpm --filter @miwo/web type-check`、`pnpm --filter @miwo/web build`。预期：所有命令退出码为 0。

- [ ] **步骤 3：运行 API 类型检查与完整构建验证**

  运行：`pnpm --filter @miwo/api typecheck` 和仓库根目录 `pnpm typecheck`。预期：无类型错误；保留账本 `Insufficient available balance` 的现有拒绝行为，不允许通过零余额或账户缺失绕过预扣。

## 计划自审

- 规格覆盖：旧用户账户回填、新用户建账、侧栏可用余额、加载失败状态、普通用户活动、管理员价格/授权/充值、零余额限制、权限、中文文案、外部交易号移除和历史待处理订单兼容，均有任务覆盖。
- 原子性与审计：订单、账户和流水在同一事务；审计仅在业务事务成功后 best-effort 发出，未声称审计原子性。
- 幂等性：稳定请求键派生唯一 `outTradeNo`；账本仍由 `creditInTransaction` 的既有用户级幂等键约束保护。
- 类型一致性：前端 store 的账户字段与现有 API `balanceMicro`、`frozenMicro` 字符串一致；用户角色沿用 `"user" | "admin"`。
- 迁移安全：仅追加 `013_account_bootstrap`，迁移清单不重排；`down` 不删除账户数据。
