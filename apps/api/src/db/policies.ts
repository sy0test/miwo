/**
 * 租户隔离的**唯一策略真相**（spec §6.2 / 附录 A / §6.3）。
 *
 * 设计要点（每一条都有代价，写在下面）：
 *  1. **未声明的表 → 抛错**。这是 spec §6.2 的核心机制："把漏改从越权变成当场报错"。
 *     代价：新增表的人必须先来这里登记，否则第一次访问就 500（响亮、可查，不会静默越权）。
 *  2. **退役表单独一组**（DROPPED_TABLES）。它们已被 001_schema 删掉（spec §5.4），
 *     但 `lib/initDB.ts` 里还留着死代码引用；给出比"未声明"更具体的报错文案。
 *  3. **knex 基础设施表必须显式声明**：`knex_migrations` / `knex_migrations_lock` 是 knex
 *     迁移器自己建的（001_schema 不建它们），而迁移器直接拿裸 knex 跑、不经过守卫；
 *     但 `dbInfo` / `exportData` 这类会枚举表名的运维接口一旦经包装层碰它们，
 *     没有声明就会抛错（Phase 1a 计划的 deferred #4 就是这么登记的）。
 *  4. `global`（全平台只读）在本阶段**没有分配给任何表**：spec §6.2 的策略定义里有它，
 *     但附录 A 把 `o_artStyle`/`o_vendorConfig` 都判成了 `platform`。**它的语义（写一律抛错）
 *     由 Task 2 的守卫实现**；本任务（Task 1）既没有实现守卫、也没有对应用例，表映射留空。
 *     要让某张表"连管理员都不能写"时，只需在这里改一行 + 一条测试。
 *  5. **"33 / 29" 的口径（本表 vs spec 附录 A：数字不同，别混用）**：
 *     本表 = **33 张在库表**（11 platform + 22 tenant）+ **2 张 knex 基础设施表**
 *     （`knex_migrations` / `knex_migrations_lock`，迁移器自建、001_schema 不建）；
 *     spec 附录 A 的 29 = 1a 的 27 张在库表 + **2 张退役表**（`o_skillList` / `o_skillAttribution`，
 *     即 `DROPPED_TABLES`，**不在本表里**，任何访问都抛错）。引用数字时必须写明口径。
 *     ⚠ **【Phase 1c Task 1 更新】** 1a/1b 时期这里是 "27 张在库表（7 platform + 20 tenant）"。
 *     Task 1 的 `005_accounts` / `006_quota_grants` 新建 6 张表（`o_user` 是**重建**，不增数量）：
 *       platform ×4 —— `o_user` 一族的 `o_invite` / `o_loginAttempt` / `o_auditLog` / `o_userSetting`
 *         （**登录发生在建租户 ctx 之前**：`o_user` 必须无 ctx 可读，所以承载登录的表跟着它留在
 *          platform；`o_auditLog` 是**平台级**审计 —— 它按 `userId` 记录"谁做了什么"，
 *          注入租户条件反而会让运维看不到跨租户的审计流）；
 *       tenant  ×2 —— `o_account` / `o_modelGrant`（§8.2 / §8.5 的额度与授权骨架；
 *         同族的 `o_usage` / `o_ledger` / `o_order` / `o_price` 归 Phase 2，本阶段**不建、不登记**）。
 *     于是 27 + 6 = **33 张在库表**（11 platform + 22 tenant），租户表由 20 → **22**，
 *     `tools/check-tenant-policies.cjs` 的计数断言同步（**改的是单一来源的判据，不是放宽门槛**：
 *     表体与建表清单仍由该门禁逐项相等断言）。
 *     ⚠ **【Phase 1d Task 1 更新】** 再 +2 张 **platform** 表（`o_job` / `o_gate`，迁移 007/008：
 *     任务队列与分池槽位）。**租户表仍是 22 张**（`check-tenant-policies.cjs` 的 `tenant.length !== 22`
 *     判据不动），平台的表体清单断言（`tests/tenant-policies.test.ts`）随之 +2 —— 同样是
 *     "改登记、不改判据"：门禁仍要求策略表与迁移建表清单**逐项相等**。
 *     为什么这两张必须是 platform（而不是 tenant）：worker 的领取/回收要**跨租户扫描**，
 *     而 worker 的系统身份是 `userId = 0`，注入租户条件后一条都查不到。详见下方 `o_job` 的登记注释。
 *     ⚠ **【Phase 3】** 账务、quota admission 与访问分组表已登记；当前策略登记共 46 张业务表
 *     （18 platform + 28 tenant）；另有 `knex_migrations` / `knex_migrations_lock` 两张迁移基础表。
 */
export type TablePolicy = "tenant" | "platform" | "global";

/** 全库统一：租户列名（不要在任何地方硬编码 "userId" 字面量，除本文件与 SQL 断言外）。 */
export const USER_COLUMN = "userId" as const;

export class PolicyNotFoundError extends Error {
  readonly httpStatus = 500;
  readonly code = "POLICY_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "PolicyNotFoundError";
  }
}

/**
 * 表 → 策略。**新增表必须在这里登记**（该门禁由计划 **Task 8** 新增的
 * `tools/check-tenant-policies.cjs` 断言"本文件与 001_schema.ts 的建表清单双向相等"；
 * ⚠ **该脚本当前并不存在**（Task 1 交付时 `tools/` 下没有它），这条判据眼下由
 * `tests/tenant-policies.test.ts` 的"双向相等"用例承担）。
 *
 * policy 语义（与 spec §6.2 的行为表一字对应）：
 *  - tenant   读：自动 andWhere("userId", ctx.userId)；写：自动填 userId；显式写别人的 userId → 抛错
 *  - platform 读：放行（含无 ctx 的启动期读取，如登录前解析 JWT 密钥 —— `o_setting.jwtSecret`
 *    优先、`o_setting.tokenKey` 兼容、`config.jwtSecret` 兜底，见 `src/auth/secret.ts`）；
 *    写：仅 ctx.role === "admin"（⛔ **不是** `"user"`：注册/登录/登出/改密对 `o_user` 的写
 *    一律走 `src/db/noContext.ts` 的 `runAsAuth()` 系统身份，见该文件头）
 *  - global   读：放行；写：**一律抛错**（连管理员也不行）
 */
export const TABLE_POLICIES: Readonly<Record<string, TablePolicy>> = Object.freeze({
  // ---------- platform：平台级全局表（附录 A：账号、画风库、模型绑定、提示词、供应商） ----------
  // ⚠【Phase 1c Task 1】`o_user` 已由 005_accounts 重建为 §7.1 的 9 列
  //   （username/email/passwordHash/role/status/tokenVersion/mustChangePassword/…）。
  //   **策略不变**：登录发生在建租户 ctx **之前**，所以它必须无 ctx 可读。
  o_user: "platform",          // 账号表（重建：spec §7.1 / 迁移 005_accounts）
  // ---------- platform：账号族的承载表（Task 1 的 005_accounts 新建；同样"登录期无 ctx"）----------
  o_invite: "platform",        // 邀请码（§15 O1 的默认注册方式 = 邀请码 + 管理员开通）
  o_loginAttempt: "platform",  // 登录失败计数/锁定（登录期写入，无 ctx）
  o_auditLog: "platform",      // 平台级审计流水（跨租户可见：按 userId 记录"谁做了什么"）
  o_userSetting: "platform",   // 用户级 setting（§6.2 从 o_setting 迁出的 7 个键；登录期/启动期读）
  o_modelGroup: "platform",     // 模型授权组与服务商/模型成员
  o_modelGroupItem: "platform", // 模型组的可用模型及每日限额
  o_userGroup: "platform",      // 用户组配置
  o_userGroupModelGroup: "platform", // 用户组与模型组的授权绑定
  o_artStyle: "platform",      // 画风库（附录 A 判 platform；若要"连管理员都只读"→ 改 global）
  o_agentDeploy: "platform",   // 角色→模型绑定（全局）
  o_setting: "platform",       // 平台级 key（jwtSecret/tokenKey/shotsEngine/…；用户级 key 迁 o_userSetting 归 Phase 1c）
  o_prompt: "platform",        // 提示词模板（运营资产）
  o_modelPrompt: "platform",   // 模型↔提示词附件
  o_vendorConfig: "platform",  // 供应商配置（key 加密/不回传归 Phase 1c；策略在本阶段就收成"仅 admin 可写"）
  o_price: "platform",         // 定价历史（按 effectiveFrom 追加；跨租户平台资产）
  // ---------- platform：Phase 1d 的任务队列基础设施（spec §9.2 / §9.3）----------
  // ⚠ 为什么是 **platform** 而不是 tenant（这是本组必须论证的一处裁定）：
  //   ① worker 的 `claim` / `reclaimExpired` **必须跨租户扫描**（"领取任意租户的待办任务"）。
  //      若登记成 tenant，守卫会注入 `userId = ctx.userId`，而 worker 的系统身份是
  //      `userId = 0`（`src/db/noContext.ts`）⇒ 一条都查不到，队列直接瘫痪。
  //   ② 这两张表是**平台内部基础设施**（spec §6.2 口径）：`o_gate` 连 `userId` 列都没有。
  //   ③ 归属口径（`o_job.userId`）：**不靠守卫自动回填**（platform 表不注入），
  //      由入队方在 `payload` 之外**显式写 `userId`**（`src/jobs/store.ts` 的 enqueue 直接落列）。
  //      代价必须写清：用户可见的"我的任务"查询**必须自己**按 ctx.userId 过滤 ——
  //      路由层（Phase 1d Task 7）是唯一出口，`src/jobs/store.ts` 只提供不带租户条件的管理面。
  o_job: "platform",           // 生成任务队列（Phase 1d Task 1 的 007_job_queue）
  o_gate: "platform",          // 厂商/类型分池的并发槽位（Phase 1d Task 1 的 008_vendor_gate）
  // ---------- knex 基础设施（不是业务表，必须显式声明） ----------
  knex_migrations: "platform",
  knex_migrations_lock: "platform",
  // ---------- tenant：25 张（每张都有 userId 列；历史表回填见 Task 6） ----------
  o_project: "tenant",         // 唯一带"真 userId"的表（改造前被硬编码写成 1）
  o_tasks: "tenant",           // 经 projectId 归属；spec 附录 A 的最直接越权读（routes/task/getTaskApi.ts）
  o_novel: "tenant",           // projectId
  o_event: "tenant",           // ⚠ 无任何归属列 → 回填经 o_eventChapter → o_novel → o_project
  o_eventChapter: "tenant",    // novelId → o_novel
  o_script: "tenant",          // projectId
  o_assets: "tenant",          // projectId（+ scriptId）
  o_image: "tenant",           // assetsId → o_assets（另有 o_assets.imageId 反向引用）
  o_storyboard: "tenant",      // projectId（v1 只读兼容）
  o_agentWorkData: "tenant",   // projectId（另有 (projectId,episodesId,key) 唯一键）
  o_video: "tenant",           // projectId
  o_videoTrack: "tenant",      // projectId
  o_imageFlow: "tenant",       // Phase 1a 已定论（实例而非模板）；回填见 Task 6 的 flowData 兜底
  o_assets2Storyboard: "tenant", // storyboardId → o_storyboard / assetId → o_assets
  o_scriptAssets: "tenant",    // scriptId → o_script
  o_shotAssets: "tenant",      // shotId → o_shot
  o_assetsRole2Audio: "tenant", // assetsAudioId → o_assets（v2 口径：音频资产是根资产的子资产）
  o_segment: "tenant",         // projectId（v2 片段）
  o_shot: "tenant",            // projectId（v2 镜）
  memories: "tenant",          // isolationKey 前缀是 projectId；本阶段改格式为 ${userId}:${projectId}:…
  // ---------- tenant：计费、访问分组与模型授权表 ----------
  //   新建空表列在 `backfill-userid.ts` 的 `BACKFILL_EXEMPT_TABLES`；唯一例外是
  //   `o_userGroupMembership`，014 迁移用已知 userId 从历史授权初始化关系，不走 004 推导。
  //   三方一致门禁不变量：`TENANT == BACKFILL_TARGETS ∪ {o_project} ∪ EXEMPT`。
  o_account: "tenant",         // 每用户一行余额/冻结额（整数微元）；乐观锁 version
  o_modelGrant: "tenant",      // 用户级 Agent 授权；模型授权经模型组与用户组解析
  o_userGroupMembership: "tenant", // 用户与用户组成员关系
  // ---------- tenant：Phase 2 Task 1 的调用计量、账本与充值订单 ----------
  o_usage: "tenant",           // 调用用量与成本（每行归属一个用户）
  o_ledger: "tenant",          // 追加式余额流水（按用户隔离）
  o_order: "tenant",           // 充值订单（按用户隔离）
  o_dailyQuotaAdmission: "tenant", // 跨进程每日调用准入计数（按用户隔离）
  o_usageAdmission: "tenant", // providerCallId 的持久准入身份（按用户隔离）
});

/** spec §5.4 退役表：001_schema 已删；任何访问都抛错。 */
export const DROPPED_TABLES: ReadonlySet<string> = new Set(["o_skillList", "o_skillAttribution"]);

/** knex 迁移器自己建的基础设施表（001_schema 不建、但必须登记）。 */
export const INFRA_TABLES: ReadonlySet<string> = new Set(["knex_migrations", "knex_migrations_lock"]);

/** 27 张租户表（顺序稳定，便于测试与报告；**不是**"策略表全集"）。 */
export const TENANT_TABLES: readonly string[] = Object.freeze(
  Object.keys(TABLE_POLICIES).filter((t) => TABLE_POLICIES[t] === "tenant"),
);

export function policyOfIn(table: string, tableMap: Readonly<Record<string, TablePolicy>>): TablePolicy {
  if (DROPPED_TABLES.has(table)) {
    throw new PolicyNotFoundError(`表 ${table} 已在 001_schema 退役（spec §5.4）：任何访问都必须失败，不要给它加策略`);
  }
  // ⚠ 必须用 hasOwnProperty 判定，**不能用裸下标** `tableMap[table]`：`Object.prototype` 的
  //   继承键（constructor / toString / valueOf / __proto__ / hasOwnProperty / isPrototypeOf …）
  //   会让裸下标命中继承成员并**绕过 fail-closed** —— 返回值既不是 "tenant" 也不是
  //   "platform"/"global"，下游守卫因此**读不注入租户条件、写直接放行**（读+写全放行）。
  //   独立审查实跑证实：policyOf("constructor") 曾返回 <function Object> 而不抛错。
  if (!Object.prototype.hasOwnProperty.call(tableMap, table)) {
    throw new PolicyNotFoundError(
      `表 ${table} 未在 policies.ts 声明策略（fail-closed）。若这次访问是合法的，` +
        `请在 TABLE_POLICIES 里登记并说明理由；若不该访问，请删掉这条调用`,
    );
  }
  return tableMap[table];
}

/** 生产路径用这个（读 TABLE_POLICIES）；守卫允许传一张覆盖表，好让 `global` 这类"本阶段没有表用到"的语义也能被单测。 */
export function policyOf(table: string): TablePolicy {
  return policyOfIn(table, TABLE_POLICIES);
}

/**
 * ⚠ 这是**判定式，不是守卫入口**：未知表/退役表返回 `false`（**不抛**），与 `policyOf` 的失败方向
 *   **相反**。守卫一律用 `policyOf`/`policyOfIn`；只有"想探测某表是不是租户表"时才用它。
 *   同样用 `hasOwnProperty`，避免 `Object.prototype` 的继承键被当成表名。
 */
export function isTenantTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_POLICIES, table) && TABLE_POLICIES[table] === "tenant";
}

/**
 * ⚠【Phase 1c Task 11】**`roleOfUserId(userId)` 已删除**（原来它按 `userId === 1` 判 admin）。
 *
 * 它曾是"旧形状 token"的过渡桥接；Task 11 把旧形状整体退役之后它**没有任何调用方**，
 * 而它带来的风险很具体：`roleOfUserId(1) === "admin"` 是一条**不读 DB** 的管理员判定 ——
 * 只要有人在合并/重构里把某条链接回它，任何"用当前密钥签的 `{id:1}`"就又变成管理员，
 * 而**没有任何机械判据会红**（原来的 `tests/tenant-policies.test.ts` 甚至还在钉住它的行为）。
 * 现在唯一的管理员判定是 **`o_user.role`**（每请求现读，见 `auth/service.ts` 的 `loadUserCtx`）。
 */
