# 管理员用户与分组授权实施计划

> **执行说明：** 实施时按任务逐项完成，每项先写失败测试、确认失败原因，再实现并复测。此计划不要求提交代码。

**目标：** 建立管理员用户管理、用户组/模型组授权和兼容旧授权迁移，并将 `/billing` 收敛为个人账户界面。

**架构：** 模型组和模型条目为平台级配置；用户组与模型组多对多关联；用户到用户组的成员关系按租户保存。计量准入从当前用户的有效组关系解析授权，Agent key 继续用现有授权表。

**技术栈：** Vue 3、TypeScript、TDesign、Express、Knex、SQLite/MySQL、Vitest。

**规格：** `docs/superpowers/specs/miwo-billing-admin-groups.md`

## 全局约束

- 余额及每日调用额度仍以整数微元和按用户/服务商/模型/UTC 日计数。
- `agentKey` 授权继续走 `o_modelGrant`，不迁移、不改变其解析规则。
- 旧服务商/模型授权迁移后保留历史记录，但只能由组关系授权模型调用。
- 所有新管理 API 必须执行 `requireAdmin`，用户列表不得返回密码哈希或凭据。
- 新增表必须登记到 `apps/api/src/db/policies.ts` 与迁移/租户策略测试。
- `apps/api/src/router.ts` 由 `apps/api/scripts/generate-router.ts` 生成，不手动维护。
- 所有新增用户界面文案使用简体中文。

---

### 任务 1：分组表、迁移和服务端授权解析

**文件：**
- 新建：`apps/api/src/db/migrations/014_access_groups.ts`
- 修改：`apps/api/src/db/migrations/index.ts`
- 修改：`apps/api/src/db/policies.ts`
- 修改：`apps/api/src/types/database.d.ts`
- 新建：`apps/api/src/billing/grants.ts`
- 修改：`apps/api/src/billing/usage.ts`
- 测试：`apps/api/tests/migration-access-groups.test.ts`
- 测试：`apps/api/tests/billing-grants.test.ts`
- 修改：`apps/api/tests/billing-usage.test.ts`
- 修改：`apps/api/tests/tenant-policies.test.ts`

**接口：**
- 产出 `resolveModelGrant(db, userId, vendorId, model): Promise<{ dailyLimit: number }>`；当无有效模型组授权时抛出带用户/模型标识的准入错误。
- 产出 `resolveAgentGrant(db, userId, agentKey): Promise<{ dailyLimit: number | null }>`；保持旧 Agent 授权语义。
- 数据表：`o_modelGroup`、`o_modelGroupItem`、`o_userGroup`、`o_userGroupModelGroup` 为 `platform`；`o_userGroupMembership` 为 `tenant`。

- [ ] **步骤 1：先写授权解析失败测试**，覆盖无组拒绝、单组授权、禁用条目拒绝、重复组授权限额取最小非空值、所有限额为空、Agent 授权保持旧行为。
- [ ] **步骤 2：运行红灯测试**：`pnpm exec vitest run tests/billing-grants.test.ts tests/billing-usage.test.ts`（工作目录 `apps/api`）；确认失败在缺少分组解析实现，而不是测试环境或类型错误。
- [ ] **步骤 3：写迁移测试**：建立临时 SQLite 数据库和既有 `o_modelGrant` 样例，执行完整迁移，断言每用户历史用户组/模型组、模型条目、enabled、dailyLimit 和用户关系准确；重复执行迁移实现并确认无重复关系；断言 Agent 行原样保留。
- [ ] **步骤 4：运行迁移红灯测试**：`pnpm exec vitest run tests/migration-access-groups.test.ts`（`apps/api`）。
- [ ] **步骤 5：实现迁移和授权解析**：追加 014 迁移；历史模型 grant 按 userId 建立专属 `历史授权（用户ID）` 用户组与模型组；新增唯一约束防止同组重复模型/关联；注册迁移并登记表策略/类型；按全部启用组成员取模型并集，同模型多个有限限额取最小值。
- [ ] **步骤 6：接入计量准入并回测**：`usage.ts` 对带 `agentKey` 的请求仍先解析 Agent grant；普通模型请求改用组关系。运行 `pnpm exec vitest run tests/billing-grants.test.ts tests/billing-usage.test.ts tests/migration-access-groups.test.ts tests/tenant-policies.test.ts`（`apps/api`），均通过后再开始任务 2。

### 任务 2：管理员用户/分组 API

**文件：**
- 新建：`apps/api/src/routes/billing/admin/users.ts`
- 新建：`apps/api/src/routes/billing/admin/groups.ts`
- 修改：`apps/api/src/routes/billing/admin/grants.ts`（若生成迁移后此 API 仅适用于 Agent，则限制为 Agent 授权或停用直接模型 grant 写入）
- 生成：`apps/api/src/router.ts`（通过生成脚本）
- 测试：`apps/api/tests/billing-admin-groups.test.ts`
- 测试：`apps/api/tests/billing-routes.test.ts`

**接口：**
- `GET /api/billing/admin/users?search=&limit=&offset=` 返回 `{ id, username, role, status, balanceMicro, frozenMicro, groupIds, groupNames }[]` 和分页总数。
- `GET /api/billing/admin/groups` 返回用户组、绑定模型组及模型成员摘要；`POST/PATCH/DELETE /api/billing/admin/groups/user-groups` 维护用户组；相应 `model-groups` 端点维护模型组和成员。
- `PUT /api/billing/admin/users/:userId/groups` 接收 `{ groupIds: number[] }`，在目标用户租户上下文内原子替换成员关系。

- [ ] **步骤 1：先写集成测试**：普通用户请求所有管理端点返回拒绝；管理员可搜用户名/ID并分页；响应中不含 `passwordHash`、token；管理员可创建/修改用户组、模型组、模型条目及映射；不存在的服务商模型、重复映射、无效 limit 被拒绝；切换用户组后目标用户获得新权限、其他用户不变。
- [ ] **步骤 2：运行红灯测试**：`pnpm exec vitest run tests/billing-admin-groups.test.ts`（`apps/api`）。
- [ ] **步骤 3：实现管理 API**：按现有 billing route、`requireAdmin` 和目标租户上下文模式编写校验、事务、唯一冲突错误映射；用户搜索只投影必要列并通过账号关联汇总余额/分组。
- [ ] **步骤 4：生成路由并回归**：在 `apps/api` 执行 `pnpm exec tsx scripts/generate-router.ts`，随后运行 `pnpm exec vitest run tests/billing-admin-groups.test.ts tests/billing-routes.test.ts tests/router-generation.test.ts tests/tenant-policies.test.ts`。

### 任务 3：管理员用户管理界面和账户页收敛

**文件：**
- 新建：`apps/web/src/views/admin/users/index.vue`
- 新建：`apps/web/src/views/admin/users/userManagement.ts`
- 新建：`apps/web/src/views/admin/users/userGroups.vue`
- 修改：`apps/web/src/router/index.ts`
- 修改：`apps/web/src/pages/workbench/index.vue`
- 修改：`apps/web/src/views/billing/index.vue`
- 修改：`apps/web/tests/billing.test.mjs`
- 新建：`apps/web/tests/user-management.test.mjs`

**接口：**
- 用户页调用任务 2 定义的用户列表、组列表、用户组替换和既有 `POST /api/billing/admin/recharges`。
- `userGroups.vue` 维护用户组名称及其模型组映射；模型组本身和模型成员在任务 2 的模型配置面板维护。
- `userManagement.ts` 导出搜索参数规范化、用户组更新输入校验和充值幂等 attempt 构造函数；组件仅负责视图和请求编排。

- [ ] **步骤 1：先写页面/纯函数测试**：admin 菜单/路由允许访问，普通用户无菜单且访问路由转回工作台；搜索 trim 和空值处理稳定；用户组替换不得重复 ID；用户组编辑能创建/重命名组并保存模型组映射；充值对象使用选中用户而不是手输 ID；充值金额、原因变更后产生新 idempotencyKey；billing 页面不含管理员充值、逐用户授权表单。
- [ ] **步骤 2：运行红灯测试**：`pnpm test`（工作目录 `apps/web`）。
- [ ] **步骤 3：实现页面**：新增“用户”和“用户组”视图；用户页为可搜索、分页用户表，行详情抽屉显示角色/状态/账户余额（只读）、多选用户组与带原因的充值表单；充值提交前二次确认。用户组页新增/重命名/删除用户组，并配置其关联模型组；API 明确阻止删除仍有用户成员或模型组关联的用户组；模型组被用户组引用时同样拒绝删除。两页均提供异常、空数据和加载状态。
- [ ] **步骤 4：实现管理员入口及路由守卫**：仅在 `userStore().role === "admin"` 显示用户管理菜单；`/admin/users` 非管理员直达时重定向 `/workbench`，后端仍为最终授权边界。
- [ ] **步骤 5：清理 `/billing` 管理区并验证**：删除管理员充值、单用户 grant、价格配置表单和相关状态函数，保留个人账户、用量、订单、账本以及既有 `/:id/confirm` 兼容；运行 `pnpm test`、`pnpm run type-check`（`apps/web`）。

### 任务 4：跨层验收

**文件：**本计划前三项触及文件。

- [ ] **步骤 1：重读本规格验收标准**，逐条对应迁移、权限、UI 和服务端测试证据。
- [ ] **步骤 2：运行 API 测试与类型检查**：`pnpm test`、`pnpm run typecheck`（`apps/api`）。
- [ ] **步骤 3：运行 Web 测试与类型检查**：`pnpm test`、`pnpm run type-check`（`apps/web`）。
- [ ] **步骤 4：运行变更检查**：从仓库根执行 `git diff --check`；确认 `router.ts` 可从生成脚本重现；核对工作区差异，不改动无关的预存修改。
