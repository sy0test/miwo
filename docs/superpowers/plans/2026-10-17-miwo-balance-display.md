# 余额两位小数展示实施计划

> **执行说明：** 使用整数微元构造红灯测试，验证精确舍入后再调整现有格式化函数；不提交代码。

**目标：** 所有用户可见的人民币余额统一显示两位小数，同时保持 API、账本及计费逻辑的微元精度。

**架构：** 在现有 `billingData.ts` 统一格式化边界，使用 BigInt 将微元精确舍入为分；各余额展示复用同一函数，不转换存储值或提交值。

**技术栈：** TypeScript、Vue 3、Node test runner。

**规格：** `docs/superpowers/specs/miwo-billing-admin-groups.md`

## 全局约束

- 余额存储和 API 值继续为整数微元字符串。
- 1 元为 1,000,000 微元；1 分为 10,000 微元；两位展示按最接近分四舍五入。
- 金额格式化只影响显示，充值输入、账本排序、价目精度与计费计算不改。
- 格式化须支持大于 Number.MAX_SAFE_INTEGER 的字符串，禁止经过浮点 Number 损失精度。

---

### 任务 1：精确人民币两位显示和全页面复用

**文件：**
- 修改：`apps/web/src/views/billing/billingData.ts`
- 修改：`apps/web/src/pages/workbench/index.vue`
- 修改：`apps/web/src/views/billing/index.vue`
- 修改：`apps/web/src/views/admin/users/index.vue`（由管理员用户计划新增）
- 测试：`apps/web/tests/billing.test.mjs`

**接口：**
- `formatMicroToCny(value: string | number | bigint): string` 保留签名，输出固定两位小数。
- 通过整数微元取绝对值并计算 `(absMicro + 5000n) / 10000n` 得到分；不足半分不进位，半分及以上进一分；舍入为零时输出 `0.00` 而非 `-0.00`。

- [ ] **步骤 1：先修改格式化测试**：覆盖 `1234567890123456789012345 -> 1234567890123456789.01`、`1 -> 0.00`、`4999 -> 0.00`、`5000 -> 0.01`、`-5000 -> -0.01`、`-4999 -> 0.00`、`999999 -> 1.00`、安全整数错误及固定两位小数。
- [ ] **步骤 2：运行红灯测试**：`pnpm test`（工作目录 `apps/web`）；确认失败原因是现有 formatter 输出六位而非环境错误。
- [ ] **步骤 3：最小实现 formatter**：仅在 `formatMicroToCny` 做 BigInt 精确舍入；不更改 `parseCnyToMicro`（仍支持最多六位输入）与所有 API 类型。
- [ ] **步骤 4：运行格式化和 billing 回归**：`pnpm test`（`apps/web`）。
- [ ] **步骤 5：核对工作台、账户和管理余额展示**：确认这些组件都调用 `formatMicroToCny`；用户管理列表/详情同样调用该函数，价格微元若在组件中显示也不得误把六位显示策略改回余额显示。
- [ ] **步骤 6：类型与构建验证**：运行 Web `pnpm run type-check` 和 `pnpm run build-only`；记录构建失败的明确环境原因，不用权限绕过方式重试。

### 任务 2：规格与差异复核

- [ ] **步骤 1：逐项检查**工作台可用余额、用户账户余额、冻结额、充值账本余额前值和用户管理余额均为两位显示。
- [ ] **步骤 2：确认**测试仍证明 `parseCnyToMicro` 保留六位输入精度，账本/API 值不被显示 formatter 改写。
- [ ] **步骤 3：运行仓库根 `git diff --check` 并核对改动只涉及本计划显示面及新增管理员列表依赖。**
