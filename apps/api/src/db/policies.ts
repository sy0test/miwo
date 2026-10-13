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
 *  5. **"29" 的口径（本表 vs spec 附录 A：数字相同、成员不同，别混用）**：
 *     本表的 29 = **27 张在库表**（7 platform + 20 tenant）+ **2 张 knex 基础设施表**
 *     （`knex_migrations` / `knex_migrations_lock`，001_schema 不建、由迁移器自建）；
 *     spec 附录 A 的 29 = 27 张在库表 + **2 张退役表**（`o_skillList` / `o_skillAttribution`，
 *     即 `DROPPED_TABLES`，**不在本表里**，任何访问都抛错）。引用"29"时必须写明口径。
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
 *  - platform 读：放行（含无 ctx 的启动期读取，如登录前取 tokenKey）；写：仅 ctx.role === "admin"
 *  - global   读：放行；写：**一律抛错**（连管理员也不行）
 */
export const TABLE_POLICIES: Readonly<Record<string, TablePolicy>> = Object.freeze({
  // ---------- platform：平台级全局表（附录 A：账号、画风库、模型绑定、提示词、供应商） ----------
  o_user: "platform",          // 账号表；本阶段只有 id/name/password（重建归 Phase 1c）
  o_artStyle: "platform",      // 画风库（附录 A 判 platform；若要"连管理员都只读"→ 改 global）
  o_agentDeploy: "platform",   // 角色→模型绑定（全局）
  o_setting: "platform",       // 平台级 key（tokenKey/shotsEngine/…；用户级 key 迁 o_userSetting 归 Phase 1c）
  o_prompt: "platform",        // 提示词模板（运营资产）
  o_modelPrompt: "platform",   // 模型↔提示词附件
  o_vendorConfig: "platform",  // 供应商配置（key 加密/不回传归 Phase 1c；策略在本阶段就收成"仅 admin 可写"）
  // ---------- knex 基础设施（不是业务表，必须显式声明） ----------
  knex_migrations: "platform",
  knex_migrations_lock: "platform",
  // ---------- tenant：20 张（每张都有 userId 列，由 001_schema 建出；回填见 Task 6） ----------
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
});

/** spec §5.4 退役表：001_schema 已删；任何访问都抛错。 */
export const DROPPED_TABLES: ReadonlySet<string> = new Set(["o_skillList", "o_skillAttribution"]);

/** knex 迁移器自己建的基础设施表（001_schema 不建、但必须登记）。 */
export const INFRA_TABLES: ReadonlySet<string> = new Set(["knex_migrations", "knex_migrations_lock"]);

/** 20 张租户表（顺序稳定，便于测试与报告；**不是**"策略表全集"）。 */
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
 * `role` 的**临时桥接**：本阶段 `o_user` 还没有 role 列（重建归 Phase 1c，spec §7.1），
 * 而 platform 表的写权限必须现在就有判别力，否则要么放行所有人写、要么把运维写操作全打死。
 *
 * 实测依据（本计划编写时的 dev 库只读探针）：`o_user` 只有一行 `id=1, name=admin`。
 * **Phase 1c 必须把本函数删掉**，改为 token 里的 role claim + `o_user.role` 校验。
 */
export function roleOfUserId(userId: number): "user" | "admin" {
  return Number(userId) === 1 ? "admin" : "user";
}
