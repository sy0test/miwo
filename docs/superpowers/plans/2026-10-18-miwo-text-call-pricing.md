# Miwo 文本模型按次计价实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为文本模型增加可切换的按次计价，并修正批量提示词任务的真实模型与单位预留估价。

**Architecture:** `o_price` 继续作为只追加的单价历史；在 token/call 两种文本单价之间，以最新生效时间决定当前模式，同一最新时间并列时 fail closed。Provider usage 根据选中模式记录一次 call 或真实 token 用量；批量提示词由 route 与 worker 共用输入构造函数，按真实 `universalAi` 模型与同一 Token 估算器计算预留。

**Tech Stack:** TypeScript、Express、Knex、Vue 3、Vitest、pnpm。

**Spec:** `docs/superpowers/specs/miwo-text-call-pricing.md`

## Global Constraints

- 不新增数据库列或迁移，不写入、删除或改写任何价格历史。
- 不添加 `character` 价格，也不把 JSON/文本原始字符数直接当作 Token 数；入队预留与 Provider 准入必须共用覆盖完整请求的 Token 估算器。
- `call` 只能由管理员价格 API 写入，其他未列举单位继续拒绝。
- 原有 token-only 文本模型继续按 token 计费；旧任务 payload 仍可由 worker 读取。
- 不改变模型授权、日调用额度、任务队列、任务冻结和账本语义。
- 不提交代码，不操作用户真实数据库。

## 文件职责映射

- `apps/api/src/billing/prices.ts`：集中解析 token/call 当前模式，复用现有生效时间和严格歧义策略。
- `apps/api/src/billing/usage.ts`：增加 call 用量测量，数量固定为 1，并允许保留 Token 分析字段。
- `apps/api/src/billing/estimate.ts`：增加针对文本模型模式和 Token/call 数量的估价入口。
- `apps/api/src/utils/ai.ts`：invoke/stream 根据真实文本模型价格模式记录 usage；导出 route 需要的模型解析与相同 Token 估算函数。
- `apps/api/src/jobs/handlers/promptBatch.ts`：抽出 route 与 worker 共用的提示词输入构造，保留旧队列 payload 兼容。
- `apps/api/src/routes/production/workbench/batchGeneratePrompt.ts`：用 `universalAi` 真实模型和每个轨道的实际文本输入/估算预留。
- `apps/api/src/routes/billing/admin/prices.ts`：严格 schema 接受 `call`。
- `apps/web/src/components/setting/components/vendorConfig/ModelAccessPricing.vue`：增加 call 价目显示和录入选项。
- `apps/api/tests/billing-prices.test.ts`、`billing-estimate.test.ts`、`billing-usage.test.ts`、`ai-wrapper-billing.test.ts`、`billing-routes.test.ts`、`job-routes.test.ts`：逐层验证模式、生效价、Provider 事件和批量入队。
- `apps/web/tests/billing.test.mjs`：验证 call 单位标签与选项；该测试文件已是 Web 包当前定价相关测试入口。

---

### Task 1: 文本价格模式与管理员录入

**Files:**
- Modify: `apps/api/src/billing/prices.ts`
- Test: `apps/api/tests/billing-prices.test.ts`
- Modify: `apps/api/src/routes/billing/admin/prices.ts`
- Test: `apps/api/tests/billing-routes.test.ts`
- Modify: `apps/web/src/components/setting/components/vendorConfig/ModelAccessPricing.vue`
- Test: `apps/web/tests/billing.test.mjs`

**Interfaces:**
- Produce `resolveTextPricingUnit(db: Knex, vendorId: string, model: string, at: Date): Promise<"token" | "call">`。
- 在 token/call 两种单位中选取最新生效的模式；同一 `effectiveFrom` 并列时抛出包含 `Ambiguous` 的错误；无有效文本价格时抛出包含 `price` 的错误。
- 管理价格 schema 接受 `call`，仍拒绝任意其他单位值。

- [x] **Step 1: 写模式解析失败测试。** 在 `billing-prices.test.ts` 增加：只有 token 时返回 token；同模型未来 call 价在其生效前仍返回 token；call 生效边界切换到 call；更晚 token 价切回 token；同一有效时间同时存在 token/call 时拒绝；无生效文本价时报缺价；同单位并列仍拒绝。
- [x] **Step 2: 运行红灯测试。** 在 `apps/api` 运行 `pnpm exec vitest run tests/billing-prices.test.ts`。预期新增 resolver 不存在或断言失败，其余原测试保持通过。
- [x] **Step 3: 写 resolver 并复测。** 查询 `o_price` 中该模型生效的 token/call 行，取最大的 `effectiveFrom`；同一最大时间命中两种单位则拒绝；返回该单位。保留 `resolvePrice` 处理同单位重复与价格数据校验。
- [x] **Step 4: 增加 API 和界面测试。** API 测试验证管理员 POST 的 `call` 创建成功、未知 unit 返回 400；前端验证选项含 `{ label: "每次调用", value: "call" }` 且历史通过同一选项显示该中文标签。
- [x] **Step 5: 跑红灯并实现。** 先运行 `pnpm exec vitest run tests/billing-routes.test.ts`（`apps/api`）及 `pnpm test`（`apps/web`）；再仅在严格 unit enum 与 `unitOptions` 中加入 `call`，重跑同命令。

### Task 2: Provider call 用量记录与双模式结算

**Files:**
- Modify: `apps/api/src/billing/usage.ts`
- Test: `apps/api/tests/billing-usage.test.ts`
- Modify: `apps/api/src/utils/ai.ts`
- Test: `apps/api/tests/ai-wrapper-billing.test.ts`

**Interfaces:**
- Extend `UsageMeasure` with `{ unit: "call" }`; this measure always yields `quantity: "1"` and can carry optional safe integer `inTokens` / `outTokens` for analytics.
- `Ai.Text.invoke` and `Ai.Text.stream` both select a single text billing unit before dispatch, and pass that same unit to the admission and final usage record.
- A call-mode provider error after dispatch records `usageStatus: "uncertain"` with `{ unit: "call" }`; pre-dispatch authorization/price rejection creates no usage event.

- [x] **Step 1: 写 usage 失败测试。** 在 `billing-usage.test.ts` 增加 call usage 以数量 1 乘 call 单价计费、带 Token 指标仍按数量 1 计价、token 单价不参与、幂等记录可重放且不能把 quantity 改成 2、call 有效价格缺失时报错。
- [x] **Step 2: 运行红灯测试。** `pnpm exec vitest run tests/billing-usage.test.ts`（`apps/api`）；预期 call 输入类型或测量行为失败。
- [x] **Step 3: 最小实现用量测量。** 在 `measure` 中校验可选 token 指标，返回 `unit: "call"`、`quantity: "1"`、其余非适用媒体指标为空。让现有 `buildPreparedUsage` 用 call 的精确价格行与 quantity 1 计算费用。
- [x] **Step 4: 写 wrapper 失败测试。** mock 模式 resolver，分别覆盖 invoke 和 stream 的 call 入场/成功记录为 quantity 1，token 模式仍入场 estimated token quantity、实际 token usage 覆盖估算，以及 Provider 抛错时 call 模式记录 uncertain call 一次、token 模式仍记录 uncertain unknown；另断言 `system` 内容会计入 token 入场估算。
- [x] **Step 5: 运行红灯测试。** `pnpm exec vitest run tests/ai-wrapper-billing.test.ts`（`apps/api`）；预期 call 模式选择与失败 usage 断言失败。
- [x] **Step 6: 接入 wrapper。** 先创建一次 `at = new Date()`，用 `resolveModelName` 得到的真实 vendor/model 与该 `at` 调用 `resolveTextPricingUnit`；把同一个 `at` 传给 `beginProviderCall`，确保模式选择、准入和最终 usage 使用同一价目边界。共享输入估算必须覆盖 `system` 与 `messages`（或 `prompt`），避免漏计 system 指令。token 模式保留实际 tokenMeasure，call 模式以 `{ unit: "call" }` 入场并在成功时附上可用 token 分析指标；call 模式 catch 记录 uncertain call 后原样抛错。stream 走同一规则并维持 `trackAiBillingTask` 屏障。
- [x] **Step 7: 回归两组测试。** 重跑 `pnpm exec vitest run tests/billing-usage.test.ts tests/ai-wrapper-billing.test.ts`；确认双模式都通过且没有重复记 usage。

### Task 3: 文本预留估价与提示词构造复用

**Files:**
- Modify: `apps/api/src/billing/estimate.ts`
- Test: `apps/api/tests/billing-estimate.test.ts`
- Modify: `apps/api/src/utils/ai.ts`
- Modify: `apps/api/src/jobs/handlers/promptBatch.ts`
- Modify: `apps/api/src/routes/production/workbench/batchGeneratePrompt.ts`
- Test: `apps/api/tests/job-routes.test.ts`

**Interfaces:**
- Produce `resolveTextSubmissionEstimate(db, modelRef, tokenQuantity, callQuantity, at): Promise<bigint>`; it resolves text mode using `resolveTextPricingUnit` and sends the matching unit/quantity through existing `resolveSubmissionEstimate`.
- Export `resolveAiModelName(value: "universalAi"): Promise<`${string}:${string}`>` using existing `resolveModelName`, and `estimateTextInvocationTokens(input): Promise<number>` using the same shared request estimator plus configured/default max output token budget as wrapper admission. The shared estimator must account for `system` and `messages` (or `prompt`) so it does not omit system instructions.
- Export `loadPromptBatchContext(projectId, model, mode)` and `buildPromptBatchInput(context, track)` from `promptBatch.ts`. The latter returns the exact `{ system, messages }` passed to `Ai.Text("universalAi").invoke`; both route estimation and worker execution call this function. Context contains the resolved template, project style guide, and parsed video model name.

- [x] **Step 1: 写 estimate 失败测试。** 在 `billing-estimate.test.ts` 增加 token-only、call-only 和 token-to-call 切换下的数量估价；在同一最新有效时间有 token/call 时预估拒绝；小数与超范围仍沿用既有数量校验。
- [x] **Step 2: 运行红灯测试。** `pnpm exec vitest run tests/billing-estimate.test.ts`（`apps/api`）；预期新 estimate helper 不存在。
- [x] **Step 3: 实现共用 estimate helper。** 以同一 `at` 解析价格模式，token 模式选 `tokenQuantity`、call 模式选 `callQuantity`，传入现有 `resolveSubmissionEstimate`；校验两个候选数量均为正数且保持现有精度/舍入。
- [x] **Step 4: 写 prompt route 回归测试。** 更新 `job-routes.test.ts`：为 `universalAi` 实际解析到的文本模型种 token/call 价格；删除 `test-model/character` 作为预估前置；断言批量提示词入队成功、冻结金额按该文本模型 call 价乘轨道数或 token 价乘共享输入/输出估算；确保没有 Seedance character 查价错误；增加空 `trackData` 返回 400 且不创建 job/冻结金额的断言。
- [x] **Step 5: 运行红灯测试。** `pnpm exec vitest run tests/job-routes.test.ts`（`apps/api`）；预期旧路由仍查所选视频模型的 character 价，因此该回归失败。
- [x] **Step 6: 抽取共用提示词输入 builder。** 将 `loadPromptTemplate` 与项目数据/styleGuide 加载集中到 `loadPromptBatchContext(projectId, model, mode)`；将 handler 中每轨素材/分镜查询与 content/system/messages 拼装提取为 `buildPromptBatchInput(context, track)`。worker 每轨仍先做 abort 与终态检查，再调用该 builder；route 在入队前使用相同 context/builder 估算。保留现有 payload `{projectId, model, mode, trackData}`，旧 queued job 无需迁移或重写。
- [x] **Step 7: 导出共享文本估算。** 在 `ai.ts` 导出真实模型解析函数和 Token invocation estimate 函数；更新共享输入估算，使其对 `system` + `messages`（或 `prompt`）按同一既有估算法估算，不再仅估 `messages/prompt`；输出预算为模型 `maxOutputTokens` 或 4096。用不同 `system` 长度的测试证明 input 估算随完整请求变化。
- [x] **Step 8: 修正 route 估价。** 将请求 schema 改为 `trackData: z.array(...).min(1)`；加载 `loadPromptBatchContext`，对每轨调用 `buildPromptBatchInput` 并以 `estimateTextInvocationTokens` 累计 Token 预估；用 `resolveAiModelName("universalAi")` 得到实际计价模型；一次捕获 `estimateAt`，调用 `resolveTextSubmissionEstimate(db, actualModelRef, totalTokenEstimate, trackData.length, estimateAt)`。删除 `JSON.stringify(trackData).length` 与硬编码 `character` 估价，保留 `submitBilledJob` 和原队列 payload。
- [x] **Step 9: 重跑 route 与 estimate 测试。** `pnpm exec vitest run tests/billing-estimate.test.ts tests/job-routes.test.ts`（`apps/api`）；确认按次/Token 两模式金额与实际 payload 均符合断言。

### Task 4: 跨层验证与差异审查

**Files:**
- Validate only: 所有上述 API/Web 文件；不触碰无关 dirty changes。

- [x] **Step 1: 运行 API 相关测试。** `pnpm exec vitest run tests/billing-prices.test.ts tests/billing-estimate.test.ts tests/billing-usage.test.ts tests/ai-wrapper-billing.test.ts tests/billing-routes.test.ts tests/job-routes.test.ts`（工作目录 `apps/api`）。
- [x] **Step 2: 运行 API 类型检查。** `pnpm run typecheck`（`apps/api`）；若仓库脚本名称不匹配，先读 `apps/api/package.json`，再运行其中声明的类型检查脚本，不修改无关配置。
- [x] **Step 3: 运行 Web 测试与类型检查。** `pnpm test` 与 `pnpm run type-check`（工作目录 `apps/web`）。测试 32/32 通过；类型检查已执行但仓库现有多处类型/依赖错误导致失败（exit 2），错误未指向本次定价组件。
- [x] **Step 4: 检查 scoped diff。** 在仓库根运行 `git diff --check`，并逐一审阅本计划涉及文件的 diff；确认没有新迁移、没有 Seedance character 价、没有 token+call 双计费、没有修改其他已有用户改动。
- [x] **Step 5: 交付结论。** 汇报实现的模式时间规则、批量预留估价路径、通过的测试与任何未能运行的验证；不提交代码。
