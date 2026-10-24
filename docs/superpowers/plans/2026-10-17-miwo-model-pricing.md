# 模型分组与模型定价入口实施计划

> **执行说明：** 每项先测试失败，再实现并复测；不提交代码。

**目标：** 在服务商模型配置页管理模型组和模型价格，移除计费账户中的价格配置入口。

**架构：** 服务商配置中的具体模型是模型身份的唯一来源；模型行详情维护模型组成员以及价格历史。模型组 API 由管理员用户/分组计划提供；价格历史 API 从既有 `o_price` 读取，追加价格仍复用现有定价写入端点。

**技术栈：** Vue 3、TypeScript、TDesign、Express、Knex、Vitest。

**规格：** `docs/superpowers/specs/miwo-billing-admin-groups.md`

## 全局约束

- 不修改 `o_price` 的追加式历史、有效时间选择及计费计算语义。
- 模型组条目只引用已配置的 `vendorId + model`；价格单价仍转换为整数微元。
- 模型组 CRUD 和价格历史读取/写入均只允许管理员。
- 所有管理文案使用简体中文；不得把全局价格管理暴露到用户个人账户。
- `apps/api/src/router.ts` 必须通过 `apps/api/scripts/generate-router.ts` 生成。

---

### 任务 1：模型价格历史读取 API

**文件：**
- 修改：`apps/api/src/routes/billing/admin/prices.ts`
- 修改：`apps/api/src/billing/prices.ts`（新增模型价格历史查询函数）
- 生成：`apps/api/src/router.ts`
- 测试：`apps/api/tests/billing-routes.test.ts`
- 测试：`apps/api/tests/billing-prices.test.ts`

**接口：**
- `GET /api/billing/admin/prices?vendorId=<id>&model=<id>` 返回该模型所有 unit 的历史定价，按 `unit ASC, effectiveFrom DESC, id DESC` 排序；响应不回传无关供应商密钥。
- 继续使用现有 `POST /api/billing/admin/prices` 写入接口及严格 schema。

- [ ] **步骤 1：先增加 API 测试**：用户请求 GET/POST 均拒绝；管理员无筛选或缺少筛选字段时收到 400；管理员可按 vendor/model 读取完整、稳定排序的价格历史；POST 仍追加并由当前用户审计。
- [ ] **步骤 2：运行红灯测试**：`pnpm exec vitest run tests/billing-prices.test.ts tests/billing-routes.test.ts`（工作目录 `apps/api`）。
- [ ] **步骤 3：实现 GET 查询**：校验必需 ID、限制长度；仅选择价格表列；固定排序；使用现有 route error 和 `requireAdmin` 处理。
- [ ] **步骤 4：生成路由并回归**：运行 `pnpm exec tsx scripts/generate-router.ts`，再运行 `pnpm exec vitest run tests/billing-prices.test.ts tests/billing-routes.test.ts tests/router-generation.test.ts`（`apps/api`）。

### 任务 2：模型详情中的价格与模型组编辑器

**文件：**
- 新建：`apps/web/src/components/setting/components/modelAccessPricing.vue`
- 修改：`apps/web/src/components/setting/components/vendorConfig.vue`
- 修改：`apps/web/src/views/billing/index.vue`
- 测试：`apps/web/tests/model-access-pricing.test.mjs`
- 修改：`apps/web/tests/billing.test.mjs`

**接口：**
- 子组件接收 `{ vendorId: string, model: string, role: "user" | "admin" }`，调用 `GET /api/billing/admin/prices`、既有 `POST /api/billing/admin/prices`、管理员模型组 API。
- 组件呈现选中模型的历史价格与 unit；追加表单以当前模型锁定 vendor/model，只允许选择 unit、单价和生效时间；模型组编辑支持选择已有模型组或创建模型组并切换当前模型成员状态。

- [ ] **步骤 1：先写前端纯函数/结构测试**：模型选择变更时清空上一个模型的旧数据；单价输入转换为精确微元；时间本地值转换为合法 epoch；价格表单不允许更换当前 vendor/model；已存在模型组成员可被正确勾选；billing 源码不再显示管理员价格入口。
- [ ] **步骤 2：运行红灯测试**：`pnpm test`（工作目录 `apps/web`）。
- [ ] **步骤 3：实现模型详情组件**：在 `vendorConfig.vue` 每个模型项提供“模型价格与分组”入口；打开详情后并行加载该模型价格历史和模型组；提供加载、空、错误、提交状态；历史按 unit 分组、最新生效价格标识清楚，新增只追加不覆盖。
- [ ] **步骤 4：管理员可见性**：仅 admin 显示该管理入口与提交操作；非 admin 不触发管理 API。服务端仍强制验证角色。
- [ ] **步骤 5：移除旧价格表单并回归**：从 `billing/index.vue` 删除价格 tab、表单状态与 `createPrice`；运行 `pnpm test`、`pnpm run type-check`（`apps/web`）。

### 任务 3：跨层验收

- [ ] **步骤 1：确认模型分组映射、模型价格历史/新增及管理员校验分别有 API 测试和 UI 数据测试。**
- [ ] **步骤 2：运行 API `pnpm test` 与 `pnpm run typecheck`，工作目录 `apps/api`。**
- [ ] **步骤 3：运行 Web `pnpm test` 与 `pnpm run type-check`，工作目录 `apps/web`。**
- [ ] **步骤 4：运行仓库根 `git diff --check`，检查 `router.ts` 生成结果及与规格对应的界面入口。**
