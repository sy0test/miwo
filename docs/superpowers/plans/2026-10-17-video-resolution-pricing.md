# 视频分辨率计价实施计划

> **执行约定：**按步骤先写失败测试，再实现；每一步完成后检查差异并运行对应测试。不得修改运行时数据库、执行迁移或重启 API。

**目标：**视频按请求分辨率选择每秒价格，支持 480p/720p；预估冻结和 Provider 实际用量使用相同的生效时间及选价规则。

**设计基线：**`docs/superpowers/specs/miwo-video-resolution-pricing.md`。仅当请求为 480p/720p、且在计价时刻还没有任何分辨率专属价生效时，才回退到 `video_second`。一旦任一专属价生效，两档请求都必须命中自己的专属价，否则失败关闭。其他分辨率继续用 `video_second`。不新增数据库列或迁移；历史 `o_price` 数据保持不变。

**执行方式：**在 `code/miwo` 仓库根目录执行；测试使用 API Vitest 配置隔离的仓库外测试数据目录，不连接或改写运行时数据库。

## 步骤 1：共享视频单价解析与估价

**修改文件：**
- `apps/api/src/billing/prices.ts`
- `apps/api/src/billing/estimate.ts`
- `apps/api/tests/billing-prices.test.ts`
- `apps/api/tests/billing-estimate.test.ts`

- [x] **先写失败测试：**在 `billing-prices.test.ts` 覆盖以下时点与结果：
  - 只有 `video_second` 时，480p、720p 都返回通用价。
  - 尚未到任何分辨率专属价的 `effectiveFrom` 时，继续返回通用价。
  - 480p 专属价生效后，480p 返回该价；720p 缺价时拒绝，即使存在通用价。
  - 720p 专属价先于 480p 生效时，480p 缺价同样拒绝；不能仅检查请求档位是否有价。
  - 两档专属价均配置时各自命中；普通/未知分辨率映射并使用通用价。
  - 生效边界遵守 `effectiveFrom <= at`；同档重复的最新生效时间仍由现有解析器拒绝。
- [x] **先写失败估价测试：**在 `billing-estimate.test.ts` 验证 tier unit 的费用和 `billing-prices` 选价一致，并验证启用任意专属价后缺失档位的估价拒绝；原有非视频估价及仅通用视频价估价继续通过。
- [x] **实现共享 API：**在 `prices.ts` 定义 `VideoPriceUnit`（`video_second`、`video_second_480p`、`video_second_720p`）、`videoPricingUnit(resolution)` 和 `resolveVideoPrice(db, vendorId, model, requestedUnit, at)`。只有 480p/720p 请求需要先查询该模型在 `at` 时刻是否已有任一专属价生效；没有则精确回退通用价，有则调用 `resolvePrice` 解析请求档位，缺失/歧义均抛错。通用分辨率直接解析 `video_second`。
- [x] **接入估价：**`resolveSubmissionEstimate` 在 unit 属于视频计价单位时调用 `resolveVideoPrice`，其余单位继续调用 `resolvePrice`；保留现有参数兼容性、精确数量运算和向上取整。
- [x] **验证：**运行 `pnpm --filter @miwo/api exec vitest run tests/billing-prices.test.ts tests/billing-estimate.test.ts`，确认先前新增测试由失败转为通过。

## 步骤 2：管理端价格配置

**修改文件：**
- `apps/api/src/routes/billing/admin/prices.ts`
- `apps/api/tests/billing-routes.test.ts`
- `apps/web/src/components/setting/components/vendorConfig/ModelAccessPricing.vue`
- `apps/web/tests/billing.test.mjs`

- [x] **先写失败测试：**在 `billing-routes.test.ts` 的管理员价格 API 用例中验证两种新 unit 均可追加并出现在历史列表；普通用户仍被拒绝；不支持的 unit 仍返回 400。测试创建的数据按现有 TAG/清理方式限定并清理。
- [x] **先写失败 UI 守卫：**在 `apps/web/tests/billing.test.mjs` 增加轻量源码契约断言，确认价格配置选项中显示“每秒视频 480p”“每秒视频 720p”，且分别提交 `video_second_480p`、`video_second_720p`。仓库当前没有该 Vue 组件的挂载测试设施，不新增测试框架。
- [x] **实现 API 配置：**将两个 tier unit 加入 POST schema 白名单，不改变价格历史查询、权限或唯一性约束。
- [x] **实现前端配置：**在模型定价选项中追加两个清晰中文名称，使选择、追加价格和历史表格的单位展示都使用同一映射；保留原有单位及默认项。
- [x] **验证：**运行 `pnpm --filter @miwo/api exec vitest run tests/billing-routes.test.ts` 和 `pnpm --filter @miwo/web test`。

## 步骤 3：Provider 实际用量按分辨率记价

**修改文件：**
- `apps/api/src/billing/usage.ts`
- `apps/api/src/utils/ai.ts`
- `apps/api/tests/billing-usage.test.ts`
- `apps/api/tests/ai-wrapper-billing.test.ts`

- [x] **先写失败用量测试：**在 `billing-usage.test.ts` 对 480p/720p usage 验证：专属价生效时 `PreparedProviderUsage.unit` 保留请求档位、`priceId` 指向该档价格、费用正确；只有通用价时两档都记录 tier unit 但使用通用价；任一 tier 生效且请求档缺价时 `prepareProviderUsage` 拒绝，不生成 admission/usage；其他分辨率仍使用 `video_second`。验证实际记录的历史行保留 tier unit 与所选 `priceId`。
- [x] **先写失败包装器测试：**在 `ai-wrapper-billing.test.ts` 调用 `Ai.Video(...).run({ resolution: "480p"/"720p", ... })`，断言 admission 与记录阶段收到相同的 tier unit、时长和 `providerCallId`；非 tier 分辨率仍为通用 unit。
- [x] **实现用量模型：**扩展 `UsageMeasure` 的视频 unit 类型，并令 `measure` 对三种 video unit 执行同一时长校验和存储映射。解析价格时 tier unit 统一经过 `resolveVideoPrice`；记录与重放身份比较沿用已测量 unit，避免把实际请求档位折叠成通用单位。只在旧通用调用路径仍显式传 `video_second` 时保留通用 unit。
- [x] **实现 AI 包装器：**`AiVideo.run` 根据 `input.resolution` 通过 `videoPricingUnit` 生成计价 unit，并在 `beginProviderCall`、成功后的 `finishProviderCall` 两处使用相同 unit；供应商请求对象不变。
- [x] **验证：**运行 `pnpm --filter @miwo/api exec vitest run tests/billing-usage.test.ts tests/ai-wrapper-billing.test.ts`，包括现有未知用量、精度、重复回放与不确定状态用例。

## 步骤 4：单条/批量视频提交估价

**修改文件：**
- `apps/api/src/routes/production/workbench/generateVideo.ts`
- `apps/api/src/routes/production/workbench/batchGenerateVideo.ts`
- `apps/api/tests/job-routes.test.ts`

- [x] **先写失败路由测试：**扩展现有隔离测试数据和 HTTP 用例：分别提交 480p、720p，验证预冻结金额按各自专属单价乘以秒数；批量任务按所有条目时长之和使用同一请求分辨率单价。验证 tier 缺价但另一 tier 已生效时请求失败且不入队/不创建视频；无 tier 价时沿用通用价。检查已排队 payload 的 resolution 形状不变。
- [x] **实现路由估价：**单条路由把已验证的 `resolution` 转成 `videoPricingUnit(resolution)` 后估价；批量路由对总时长使用同一个转换及估价入口。保持作业 payload、幂等键、返回结构和冻结事务行为不变。
- [x] **验证：**运行 `pnpm --filter @miwo/api exec vitest run tests/job-routes.test.ts`；确认 Vitest 使用 `apps/api/vitest.config.ts` 指定的仓库外 `MIWO_DATA_DIR`，不使用运行时数据目录。

## 步骤 5：整体回归与差异复核

**检查文件：**步骤 1–4 修改的全部文件。

- [x] 运行 API 目标测试：`pnpm --filter @miwo/api exec vitest run tests/billing-prices.test.ts tests/billing-estimate.test.ts tests/billing-usage.test.ts tests/ai-wrapper-billing.test.ts tests/billing-routes.test.ts tests/job-routes.test.ts`（6 files, 72 tests passed）。
- [x] 运行 API 类型检查：`pnpm --filter @miwo/api typecheck`。
- [ ] 运行 Web 测试与类型检查：Web 测试 29/29 通过；`pnpm --filter @miwo/web type-check` 仍因既有项目类型问题失败（lodash 声明、Themes 联合类型、Electron/Monaco/Vite 声明及其他组件类型错误）。
- [ ] Web 构建：此前两次因 esbuild 临时目录清理 `Access is denied` 失败；本轮不重试，构建仍未验证。
- [ ] 复核差异：`git diff --check` 通过；代码范围复核及独立审查进行中。此前确认本功能不新增 schema/migration，测试仅使用仓库外隔离测试库。
- [x] 向用户汇报测试结果、涉及文件和未覆盖风险；未提交 git commit。

## 覆盖检查

- 需求“新增 480p/720p 每秒价格”：步骤 2、3。
- 单条、批量预估与冻结：步骤 4。
- Provider 实际用量费用和价格身份：步骤 3。
- 旧通用价过渡：步骤 1、3、4。
- 任一 tier 生效后缺少请求档位即失败：步骤 1、3、4。
- 其他分辨率继续使用通用视频价：步骤 1、3。
- 历史时点、价格记录身份及精确用量：步骤 1、3。
- 无数据库迁移且不改运行时数据：全程执行约定与步骤 5。
