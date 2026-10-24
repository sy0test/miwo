# 谜沃设置与工作台清理实施计划

> **供代理执行者使用：** 必须逐任务执行本计划；建议使用 `subagent-driven-development`，也可用 `executing-plans`。任务用复选框跟踪。

**目标：** 按用户角色展示正确的设置菜单，清理工作台快捷入口和全部更新检查操作，并确保本次改动的默认界面文案为简体中文。

**架构：** 将角色可见菜单规则抽为纯函数并用 Node 测试；设置弹窗依据当前用户角色生成菜单。工作台移除反馈、GitHub 和更新轮询；保留管理员可用的静态「关于」信息，不删除数据库服务端 API。

**技术栈：** Vue 3、TypeScript、Pinia、vue-i18n、TDesign、Node.js 内置测试运行器、Vitest。

**规格：** `docs/superpowers/specs/miwo-settings-billing-redesign.md`

## 全局约束

- 本次新增或调整的页面功能、导航、按钮、状态提示和错误提示均以简体中文呈现。
- 普通用户设置菜单严格为「界面设置、计费账户、语言设置、登录配置、退出登录」，顺序不得改变。
- 管理员保留仍有用途的高级设置，但数据库操作和更新检查功能移除。
- 角色可见性只是界面边界；不得移除或放宽服务端权限校验。
- 仅因前端移除数据库设置，不删除无关数据库 API 路由或数据表。
- 不提交代码，除非用户另行要求。

---

### 任务 1：定义并测试角色设置菜单

**文件：**
- 新建：`apps/web/src/components/setting/settingsMenu.ts`
- 新建：`apps/web/tests/settings-menu.test.mjs`
- 修改：`apps/web/package.json`

**接口：**
- 产出 `getVisibleSettingsItems(role, items)`；`role` 为 `"user" | "admin"`，`items` 为包含 `key`、`label`、`icon` 的只读菜单项数组，返回只读菜单项数组。
- 普通用户只得到 `ui`、`billing`、`language`、`loginConfig`、`logoutConfig` 五项，保持传入的原始顺序。
- 管理员得到所有传入项目，但过滤 `dbConfig`；关于更新的 `about` 项由任务 2 改为静态信息页。

- [ ] **步骤 1：先写失败测试**

  在 `settings-menu.test.mjs` 中用三个菜单项数组覆盖：普通用户结果恰好为五个规定键且顺序正确；管理员结果保留高级项但移除 `dbConfig`；未知角色不被提升为管理员。测试导入 `../src/components/setting/settingsMenu.ts`。

- [ ] **步骤 2：确认测试失败**

  运行：`pnpm --filter @miwo/web exec node --experimental-strip-types --test tests/settings-menu.test.mjs`  
  预期：因模块或导出尚不存在而失败。

- [ ] **步骤 3：实现最小纯函数并接入测试脚本**

  在 `settingsMenu.ts` 定义菜单项类型及 `getVisibleSettingsItems`。未知角色按普通用户处理。将 web 的 `test` 脚本改为同时运行 `tests/billing.test.mjs` 和 `tests/settings-menu.test.mjs`。

- [ ] **步骤 4：运行测试与类型检查**

  运行：`pnpm --filter @miwo/web test` 和 `pnpm --filter @miwo/web type-check`。预期：新增菜单测试与既有计费数据测试通过，类型检查通过。

### 任务 2：按角色渲染设置并移除数据库操作页

**文件：**
- 修改：`apps/web/src/components/setting/index.vue`
- 删除：`apps/web/src/components/setting/components/dbConfig.vue`
- 修改：`apps/web/src/locales/language/zh-CN.json`
- 测试：`apps/web/tests/settings-menu.test.mjs`

**接口：**
- 设置组件从 `userStore().role` 取得当前角色，并通过 `getVisibleSettingsItems` 生成菜单。
- 点击 `billing` 继续跳转到 `/billing`；其余项目继续调用现有设置组件。

- [ ] **步骤 1：扩展菜单行为测试**

  测试断言普通用户菜单项恰好为五项，管理员菜单不含数据库配置，且计费项位于界面设置之后。角色过滤测试使用纯函数，不依赖 Vue 挂载环境。

- [ ] **步骤 2：运行测试确认过滤行为失败**

  运行：`pnpm --filter @miwo/web exec node --experimental-strip-types --test tests/settings-menu.test.mjs`。预期：未实现的过滤规则导致失败。

- [ ] **步骤 3：接入当前角色并删除数据库设置组件入口**

  在 `index.vue` 引入 `userStore` 与 `getVisibleSettingsItems`，把静态 `menuItems` 包装成 `computed`；删去 `dbConfig` 的 import、模板分支和菜单项；移除对应前端组件文件。管理员其余高级选项保持现状。普通用户菜单只保留规范要求的五项。

- [ ] **步骤 4：补齐简体中文菜单文案并运行检查**

  在 `zh-CN.json` 校验或补齐「界面设置、计费账户、语言设置、登录配置、退出登录」对应键值。运行 `pnpm --filter @miwo/web test` 与 `pnpm --filter @miwo/web type-check`；预期全部通过。

### 任务 3：移除工具栏快捷入口和更新流程

**文件：**
- 修改：`apps/web/src/pages/workbench/index.vue`
- 修改：`apps/web/src/components/setting/index.vue`
- 修改：`apps/web/src/components/setting/components/about.vue`
- 修改：`apps/web/src/stores/setting.ts`
- 删除：`apps/api/src/routes/setting/about/checkUpdate.ts`
- 生成：`apps/api/src/router.ts`（通过路由生成脚本更新，不手工编辑）
- 测试：`apps/web/tests/settings-menu.test.mjs`
- 修改：`apps/api/tests/billing-routes.test.ts`

**接口：**
- 设置 Pinia store 不再导出 `needUpdate`。
- 「关于」页保留版本、仓库和许可信息，不执行更新检查、下载或安装。
- 删除 `POST /api/setting/about/checkUpdate` 的路由挂载和实现；不改动其他设置 API。

- [ ] **步骤 1：添加更新检查移除的回归断言**

  在 `billing-routes.test.ts` 的真实应用 router 测试中，以管理员令牌请求 `POST /api/setting/about/checkUpdate` 并断言返回 404；前端测试加入源码边界断言，确认工作台不再调用 `checkUpdate`，设置 store 不再导出 `needUpdate`。

- [ ] **步骤 2：运行回归测试确认当前行为触发断言**

  运行：`pnpm --filter @miwo/api exec vitest run tests/billing-routes.test.ts` 与 `pnpm --filter @miwo/web exec node --experimental-strip-types --test tests/settings-menu.test.mjs`。预期：当前更新路由及状态仍存在，新增断言失败。

- [ ] **步骤 3：移除工作台入口、轮询及更新徽标**

  在 `workbench/index.vue` 删除反馈、GitHub 两项模板、`openFeedback`/`jumpGithub`、axios 更新请求、通知逻辑、两分钟 `setInterval` 及相关生命周期钩子。移除 `setting/index.vue` 更新徽标，并从 `setting.ts` 删除 `needUpdate`。

- [ ] **步骤 4：将关于页收敛为静态信息**

  在 `about.vue` 删除手动检查、版本比较、下载、更新确认、更新源和自动更新相关界面与逻辑；仅保留产品版本、仓库地址和许可证信息。保留的标题、标签、按钮和提示使用简体中文。

- [ ] **步骤 5：移除服务端更新检查端点并验证构建**

  删除仅服务更新检查的 `checkUpdate.ts`，再运行 `pnpm --filter @miwo/api exec tsx scripts/generate-router.ts` 更新生成的 `router.ts`，不要手工改生成文件。在 `billing-routes.test.ts` 请求旧更新路径并断言返回 404。运行该 API 路由测试、`pnpm --filter @miwo/api typecheck`、`pnpm --filter @miwo/web test`、`pnpm --filter @miwo/web type-check` 和 `pnpm --filter @miwo/web build`。预期检查通过，更新端点不可访问。

## 计划自审

- 规格覆盖：普通用户五项设置、管理员高级菜单、数据库页面移除、反馈/GitHub 移除、自动与手动更新检查移除、管理员静态关于信息、服务端角色校验保留，均由任务 1–3 覆盖。
- 中文要求：明确覆盖 `zh-CN.json`、关于页文案及默认可见菜单。
- 数据库 API 和表：明确保持不变。
- 类型一致性：菜单函数的 `role`、`items` 与返回值在测试和设置组件中共用同一类型。
