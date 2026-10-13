/**
 * 001_schema —— 谜沃的基线表结构（spec §5.2 ① / §5.3 / 附录 A）。
 *
 * 这个文件是**全新 MySQL 库的唯一结构真相**；同时它必须能在 sqlite 下跑通，
 * 因为本机的回归网（`apps/api/tests/**` 与 `apps/api/scripts/verify-phase0.cjs`）跑的是 sqlite。
 *
 * 与 `apps/api/src/lib/initDB.ts`（1176 行）的关系：后者是**旧真相**，Phase 1a 起
 * **不再被启动路径调用**（Task 4 摘除，守它的门禁是 `tools/check-dead-ddl.cjs`），本文件是它的替代。
 * 两者会短暂并存（1c 才删旧文件，因为 `apps/api/scripts/verify-phase0.cjs` 的构件清单还断言它存在）。
 *
 * 与现状库的差异（全部是**有意**的，spec 有据；逐表差集见 Task 3 报告与
 * `apps/api/scripts/gen-schema-migration.cjs` 的机械输出）：
 *   - 不建 o_skillList / o_skillAttribution（§5.4 删除；本文件对老库 dropTableIfExists）
 *   - 27 张表的主键改为 BIGINT UNSIGNED AUTO_INCREMENT（§5.3）
 *     ⚠ **【T3 更正】原写"26 张"，实测是 27**（本文件 `createTable` 调用 **27 处**；
 *       `verify-phase1a.cjs` 的 `EXPECT_TABLES` 与 `migration-ddl-mysql.test.ts` 都是 27）。
 *   - memories.id 由 TEXT 改 VARCHAR(191)（§5.3，规避 MySQL ERROR 1170）
 *   - **20 张租户表**有 userId（§6.2）：**19 张本阶段新增** + `o_project`（**已有该列**）；**回填归 Phase 1b**
 *     ⚠ **【M2 更正】原写"18 张"，实测是 20**（机械口径：本文件 `t.u64(T, "userId")` 共 **20 处**）。
 *       1b 照 18 回填会**漏 2 张表**。
 *   - o_agentWorkData 补唯一键 (projectId, episodesId, key)（§5.3）
 *   - o_project.directorManual / o_modelPrompt.{fileName,path} / o_agentDeploy.type 是现状库里
 *     由 fixDB 补出来的列，**必须进基线**（否则全新 MySQL 库少列 → 启动期 unknown column）
 *   - **15 个毫秒时间戳列走 `t.ms()`（mysql `bigint unsigned`），不是 `integer`**（修复轮 1）：
 *     现状全库时间戳是 `Date.now()` 的毫秒值（实测 1774447310118 / 1791741159298 这类），
 *     MySQL 的 `int` 上限 2147483647 会在写入时直接报越界；sqlite 的 INTEGER 是 64 位，
 *     所以这个缺陷**只在真 MySQL 暴露**。清单见 `tests/migration-ddl-mysql.test.ts` 的
 *     「毫秒时间戳列」用例（12 张表 / 15 列）与本节各表的 `t.ms(...)` 调用点。
 *   - **`o_project.id` / `o_videoTrack.id` 及其 12 个外键列走 `t.u64()`，不是 `integer`**（修复轮 1 + 2）：
 *     这两个 id 由代码用 `Date.now()` 显式给（`routes/project/addProject.ts:29`、`utils/redraw.ts:711`），
 *     **本身就是毫秒值**；装它们的 `projectId` / `trackId` / `videoTrackId` 因此也必须 64 位。
 *     同一根因、同一证据（实测 dev 库 `o_project.id` = 1791385147125）。
 *     ⚠ 修复轮 1 漏了 `o_segment.projectId` / `o_shot.projectId`（修复轮 2 补上）—— 当时判据是
 *     `tests/migration-ddl-mysql.test.ts` 里一张**手工外键清单**，清单外的表永远不会被检查。
 *     现在判据换成机械扫描：`tests/migration-column-fit.test.ts`（判据 A 同名整数列宽度必须一致；
 *     判据 B 老库实测值域 vs 目标类型上界；判据 C 活库真实行复核）。加外键列时**不需要**再维护清单。
 *     去掉那些显式 `Date.now()` 属 Phase 1b 的 35 处 insert 语义复核，本阶段**不动调用点**。
 *   - **长文本列不得比现状库窄（修复轮 2）**：`o_agentWorkData.data`（实测最长 103,624 字符）与
 *     `o_tasks.relatedObjects`（614 字符）在现状库里声明成 varchar(255) 却装着更长的值
 *     （sqlite 不强制长度）→ 一律走 `t.text()`（mysql `longtext`）。机械证据：判据 B 逐列比对
 *     "老库实测最大字符数 vs 目标类型字符上限"。
 *   - **o_modelPrompt.fileName / path 保持 TEXT（修复轮 1）**：现状库是 TEXT（initDB.ts:411-412），
 *     收窄成 varchar(255) 会让超长路径在 MySQL 报 `Data too long`；这两列无索引需求（见表内注释）。
 *
 * ⚠ 迁移纪律（见根 README.md 的「迁移纪律」）：schema 迁移**只允许**用 schema builder
 *   （`knex.schema.createTable` / `dropTableIfExists` / `alterTable`），不得出现 `knex.raw` 或查询调用 ——
 *   `tests/migration-ddl-mysql.test.ts` 用一个假 knex 收集编译出来的 DDL 来断言 MySQL 合法性，
 *   那条路径只覆盖 schema builder。
 */
import type { Knex } from "knex";
import { types } from "@/db/dialect";

export default {
  name: "001_schema",

  async up(knex: Knex): Promise<void> {
    const t = types(knex);

    // ⚠ 本迁移**不包含**两件旧 fixDB 在启动时做的事（spec §5.2 明确要求删除；Phase 1a / Task 4 Step 6）：
    //   1. 「把 6 类 state='生成中' 的行改成失败」（fixDB.ts 的 `矫正因软件异常退出导致的状态不一致问题` 一段：
    //      o_novel.eventState=0 / o_script.extractState=0 / o_assets.promptState / o_image.state /
    //      o_storyboard.state / o_video.state）。删除理由：无条件写会与多实例互相踩、且会误杀正在运行的任务。
    //      **替代机制是 Phase 1d 的队列租约超时（spec §9.2）**；在 1d 落地之前，重启后残留的"生成中"行
    //      **不会**被自动改判 —— 这是 Phase 1a 引入的、**已知且盖章**的语义变化。
    //      人工清除手段：`pnpm.cmd run db:repair-stuck`（新增，默认 dry-run；`--apply` 才写库；
    //      默认只动超过 1 小时未更新的行，避免误杀正在跑的任务；幂等）。
    //      见计划 Task 4 Step 6 与 Phase 1a 完成判据；登记落点还有根 README.md 的
    //      「启动期副作用的两条语义变化」一节。
    //   2. 「无条件覆写 o_prompt.data 全文」（fixDB.ts 的 o_prompt 覆写一段）。删除理由：运营改过的提示词
    //      每次重启被冲掉。**这是收益**（spec §5.2 ③）；新库的提示词由 `002_platform_seed` 只插不改。
    //
    // ⚠ 也不要在这里"顺手补一个 state 清理的 UPDATE"：迁移纪律（根 README「迁移纪律」）规定 schema 迁移
    //    只能用 schema builder，`tests/migration-ddl-mysql.test.ts` 的假-knex 路径只覆盖 schema builder；
    //    而且把"启动时改数据"塞进 `001_schema` 等于把刚摘掉的副作用换个地方又装回去。

    // ---------- 用户与项目 ----------
    await knex.schema.createTable("o_user", (T) => {
      // ⚠ 不加自增：现状由代码显式给 id（种子 id=1）。整体重建归 Phase 1c（spec §7.1）。
      T.bigInteger("id").unsigned().primary();
      t.text(T, "name");
      t.text(T, "password");
    });

    await knex.schema.createTable("o_project", (T) => {
      // ⚠ **不能**用 `t.pk(T)`：现状 `id` 由代码显式给 `Date.now()`（`routes/project/addProject.ts:29`），
      //    所以它必须能装毫秒值 → `bigint unsigned`（spec §5.3 的目标类型正好就是它）。
      //    自增只是"没给值时"的兜底（现状同理：sqlite 侧 `integer primary key` 也允许显式给值）。
      //    ⚠ 去掉 `Date.now()` 这个显式 id 属 Phase 1b 的 35 处 insert 语义复核，本阶段**不动调用点**。
      //    断言：`tests/migration-ddl-mysql.test.ts` 的「id / 外键列也是 Date.now()」用例。
      T.bigInteger("id").unsigned().primary();
      T.string("projectType");
      T.string("imageModel");
      T.string("imageQuality");
      T.string("videoModel");
      t.text(T, "name");
      t.text(T, "intro");
      t.text(T, "type");
      t.text(T, "artStyle");
      // ⚠ 现状库里有、initDB.ts 里没有：必须进基线，否则全新库少这一列
      t.text(T, "directorManual");
      t.text(T, "mode");
      t.text(T, "videoRatio");
      t.ms(T, "createTime");
      t.u64(T, "userId");              // 已有列（initDB.ts:47），保持
      t.text(T, "targetCountry");
      T.index(["userId"], "o_project_userid_index");
    });

    await knex.schema.createTable("o_artStyle", (T) => {
      t.pk(T);
      T.string("name");
      t.text(T, "fileUrl");
      t.text(T, "label");
      t.text(T, "prompt");
    });

    await knex.schema.createTable("o_agentDeploy", (T) => {
      t.pk(T);
      T.string("model");
      T.string("key");
      T.string("modelName");
      t.text(T, "vendorId");
      T.string("desc");
      T.string("name");
      T.integer("temperature");
      T.integer("maxOutputTokens");
      t.boolCol(T, "disabled").defaultTo(0);
      T.string("type");                // fixDB 补过的列，必须进基线
    });

    await knex.schema.createTable("o_setting", (T) => {
      // 原为 TEXT PK → MySQL ERROR 1170，收窄为 varchar(191)
      t.vstr(T, "key").primary();
      t.text(T, "value");
    });

    await knex.schema.createTable("o_tasks", (T) => {
      t.pk(T);
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）→ 不能用 int
      T.string("taskClass");
      // ⚠ 现状库声明的是 varchar(255)，但**实际最长 614 字符**（2 行超 255）——
      //   sqlite 不强制 varchar 长度所以本机看不出问题，真 MySQL 严格模式直接
      //   `Data too long for column`。判据：**不得把 SQLite 接受得了的数据在 MySQL 侧拒掉或截断**
      //   → 必须 longtext。该列无 where/orderBy/索引，放宽无副作用。
      //   机械证据：`tests/migration-column-fit.test.ts` 判据 B（fixture 实测 maxChars=614）。
      t.text(T, "relatedObjects");
      T.string("model");
      t.text(T, "describe");
      T.string("state");
      t.ms(T, "startTime");
      t.text(T, "reason");
      t.u64(T, "userId");              // 新增（§6.2）
      T.index(["userId"], "o_tasks_userid_index");
    });

    // ---------- 平台资产 ----------
    await knex.schema.createTable("o_prompt", (T) => {
      t.pk(T);
      T.string("name");
      T.string("type");
      t.text(T, "data");
      t.text(T, "useData");
    });

    await knex.schema.createTable("o_modelPrompt", (T) => {
      t.pk(T);
      T.string("vendorId");
      T.string("model");
      // ⚠ 这两列是**长文本路径**，不能收窄成 varchar(255)：
      //   initDB.ts:411-412 建表时用的是 `table.text(...)`（现状库 PRAGMA 也确认是 TEXT），
      //   而 fixDB.ts:113-114 的 addColumn 用的是 `string` —— 谁先跑到就是谁的类型（本机现状是 TEXT）。
      //   收窄成 varchar(255) 会让超过 255 字符的路径在 MySQL 严格模式下直接
      //   `Data too long for column`（sqlite 侧完全看不出问题）→ 属"保留现有功能"原则下的回归。
      //   **无索引需求**：这两列没有任何 where/orderBy/索引（全仓唯一读写点
      //   `routes/setting/modelMap/bindingPrompt.ts` 只按 model+vendorId 查），所以可以安全用 TEXT。
      t.text(T, "fileName");           // fixDB 补过；现状库为 TEXT
      t.text(T, "path");               // fixDB 补过；现状库为 TEXT
    });

    // ---------- 小说 / 事件 ----------
    await knex.schema.createTable("o_novel", (T) => {
      t.pk(T);
      T.integer("chapterIndex");
      t.text(T, "reel");
      t.text(T, "chapter");
      t.text(T, "chapterData");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("eventState");
      t.text(T, "event");
      t.text(T, "errorReason");
      t.ms(T, "createTime");
      t.u64(T, "userId");
      T.index(["userId"], "o_novel_userid_index");
    });

    await knex.schema.createTable("o_event", (T) => {
      t.pk(T);
      T.string("name");
      T.string("detail");
      t.ms(T, "createTime");
      // ⚠ 现状这张表**没有任何归属列**（spec 附录 A）。补 userId 后回填要经
      //    o_eventChapter → o_novel → o_project（§6.2）；回填归 Phase 1b。
      t.u64(T, "userId");
      T.index(["userId"], "o_event_userid_index");
    });

    await knex.schema.createTable("o_eventChapter", (T) => {
      t.pk(T);
      T.integer("eventId");
      T.integer("novelId");
      t.u64(T, "userId");
      T.index(["userId"], "o_eventchapter_userid_index");
    });

    // ---------- 剧本 / 资产 / 图片 ----------
    await knex.schema.createTable("o_script", (T) => {
      t.pk(T);
      t.text(T, "name");
      t.text(T, "content");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("extractState");
      t.ms(T, "createTime");
      t.text(T, "errorReason");
      t.text(T, "sourceVideo");
      T.integer("sortIndex");
      t.text(T, "coverPath");
      t.text(T, "brief");
      t.u64(T, "userId");
      T.index(["userId"], "o_script_userid_index");
    });

    await knex.schema.createTable("o_assets", (T) => {
      t.pk(T);
      t.text(T, "name");
      t.text(T, "prompt");
      t.text(T, "remark");
      t.text(T, "type");
      t.text(T, "describe");
      T.integer("scriptId");
      T.integer("imageId");
      T.integer("assetsId");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("flowId");
      t.ms(T, "startTime");
      T.string("promptState");
      T.integer("audioBindState");
      t.text(T, "promptErrorReason");
      t.u64(T, "userId");
      T.index(["userId"], "o_assets_userid_index");
    });

    await knex.schema.createTable("o_image", (T) => {
      t.pk(T);
      t.text(T, "filePath");
      t.text(T, "type");
      T.integer("assetsId");
      t.text(T, "model");
      t.text(T, "resolution");
      t.text(T, "state");
      t.text(T, "errorReason");
      t.u64(T, "userId");
      T.index(["userId"], "o_image_userid_index");
    });

    // ---------- 分镜（v1 只读兼容 + v2 结构化） ----------
    await knex.schema.createTable("o_storyboard", (T) => {
      t.pk(T);
      T.integer("scriptId");
      t.text(T, "prompt");
      t.text(T, "filePath");
      t.text(T, "duration");
      t.text(T, "state");
      // ⚠ trackId 装的是轨道 id：v1 下是 `o_videoTrack.id`（`utils/redraw.ts:711` 用
      //    `Date.now() + seq` 显式给 → **毫秒值**），v2 下是 `o_segment.id`（自增 bigint）。
      //    两种取值都超 int → 必须 u64。
      t.u64(T, "trackId");
      t.text(T, "reason");
      t.text(T, "track");
      t.text(T, "videoDesc");
      T.integer("shouldGenerateImage");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("flowId");
      T.integer("index");
      t.ms(T, "createTime");
      t.text(T, "sourceRange");
      t.text(T, "clipPath");
      t.text(T, "originDialogue");
      t.u64(T, "userId");
      T.index(["userId"], "o_storyboard_userid_index");
    });

    await knex.schema.createTable("o_agentWorkData", (T) => {
      t.pk(T);
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("episodesId");
      T.string("key");
      // ⚠ 同 `o_tasks.relatedObjects`：现状库声明 varchar(255)，但实际最长 **103,624 字符**（5 行超 255）。
      //   这一列存的是 `productionAgent` 的分镜表 JSON（真相就是这份文本，见 AGENTS.md §3）→
      //   被 MySQL 拒掉/截断等于**静默夹断分镜数据**。机械证据：判据 B（fixture maxChars=103624）。
      t.text(T, "data");
      t.ms(T, "createTime");
      t.ms(T, "updateTime");
      t.u64(T, "userId");
      T.index(["userId"], "o_agentworkdata_userid_index");
      // spec §5.3：补唯一约束（saveFlowData.ts:31 的注释已指出缺唯一键）
      // ⚠ 老库可能有重复行 → 导入脚本（Task 6）会先查重，重复时拒绝写入
      T.unique(["projectId", "episodesId", "key"], { indexName: "o_agentworkdata_pid_epid_key_unique" });
    });

    await knex.schema.createTable("o_video", (T) => {
      t.pk(T);
      t.text(T, "filePath");
      t.text(T, "errorReason");
      t.ms(T, "time");                 // 写入端是 `time: Date.now()`（generateVideo.ts:94 / batchGenerateVideo.ts:96）
      t.text(T, "state");
      T.integer("scriptId");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      t.u64(T, "videoTrackId");        // = o_videoTrack.id（Date.now() 毫秒值）
      t.u64(T, "userId");
      T.index(["userId"], "o_video_userid_index");
    });

    await knex.schema.createTable("o_videoTrack", (T) => {
      // ⚠ 这里的 `id` 虽然是自增主键，但**现状代码会显式给它 `Date.now()`**
      //    （`utils/redraw.ts:711` 的 `trackId = Date.now() + seq++` → `insert({ id: trackId, ... })`）→
      //    `t.pk(T)` 编译出的 mysql `bigint unsigned` 正好装得下；改成 int 会直接炸。
      //    去掉那个显式 id 属 Phase 1b（本阶段不动调用点）。
      t.pk(T);
      T.integer("videoId");
      t.u64(T, "projectId");           // = o_project.id（Date.now() 毫秒值）
      T.integer("scriptId");
      t.text(T, "state");
      t.text(T, "reason");
      t.text(T, "prompt");
      T.integer("selectVideoId");
      T.integer("duration");           // 秒数（实测 4..15），不是毫秒 → 保持 int
      t.u64(T, "userId");
      T.index(["userId"], "o_videotrack_userid_index");
    });

    // ---------- 供应商 / 图片工作流 ----------
    await knex.schema.createTable("o_vendorConfig", (T) => {
      t.vstr(T, "id").primary();          // 原 string("id") → varchar(255)，统一收到 191
      t.text(T, "inputValues");
      t.text(T, "models");
      T.integer("enable");
    });

    await knex.schema.createTable("o_imageFlow", (T) => {
      t.pk(T);
      t.text(T, "flowData").notNullable();
      // 归属结论见本计划"本阶段的边界"：实测它是项目/剧本内的实例（会被 deleteAssetsDireve 级联删），
      // 按 tenant 处理；回填经 o_assets.flowId → o_assets.projectId → o_project.userId（Phase 1b）。
      t.u64(T, "userId");
      T.index(["userId"], "o_imageflow_userid_index");
    });

    // ---------- 关联表（复合主键） ----------
    await knex.schema.createTable("o_assets2Storyboard", (T) => {
      T.integer("storyboardId").notNullable();
      T.integer("assetId").notNullable();
      T.primary(["storyboardId", "assetId"]);
      t.u64(T, "userId");
      T.index(["userId", "storyboardId"], "o_a2s_userid_storyboardid_index");
    });

    await knex.schema.createTable("o_scriptAssets", (T) => {
      T.integer("scriptId").notNullable();
      T.integer("assetId").notNullable();
      T.primary(["scriptId", "assetId"]);
      t.u64(T, "userId");
      T.index(["userId", "scriptId"], "o_scriptassets_userid_scriptid_index");
    });

    await knex.schema.createTable("o_shotAssets", (T) => {
      T.integer("shotId").notNullable();
      T.integer("assetId").notNullable();
      T.primary(["shotId", "assetId"]);
      t.u64(T, "userId");
      T.index(["userId", "shotId"], "o_shotassets_userid_shotid_index");
    });

    await knex.schema.createTable("o_assetsRole2Audio", (T) => {
      T.integer("assetsAudioId").notNullable();
      T.integer("assetsRoleId").notNullable();
      T.primary(["assetsAudioId", "assetsRoleId"]);
      t.u64(T, "userId");
      T.index(["userId"], "o_assetsrole2audio_userid_index");
    });

    // ---------- 结构化分镜 v2（建模正确的两张，主键同样是 BIGINT UNSIGNED） ----------
    await knex.schema.createTable("o_segment", (T) => {
      t.pk(T);
      // ⚠ **不能是 `T.integer`**（修复轮 2）：它是 `o_project.id` 的外键，而那个 id 由代码用
      //   `Date.now()` 显式给（`routes/project/addProject.ts:29`）→ 老库实测 1791385147125 > int 上界。
      //   修复轮 1 漏了这张表（当时判据是手工清单）；现在由 `tests/migration-column-fit.test.ts`
      //   的机械扫描守住（判据 A 同名整数列宽度 + 判据 B 值域 vs 目标类型）。
      t.u64(T, "projectId");
      T.integer("scriptId");
      T.integer("segmentIndex");
      T.integer("sceneIndex");
      t.text(T, "sceneTitle");
      T.float("duration");
      t.text(T, "videoDesc");
      t.text(T, "state");
      t.text(T, "prompt");
      T.integer("videoId");
      T.integer("selectVideoId");
      t.ms(T, "createTime");
      t.ms(T, "updateTime");
      t.text(T, "reason");
      T.float("videoDuration");
      T.integer("manual").notNullable().defaultTo(0);
      t.u64(T, "userId");
      T.unique(["scriptId", "segmentIndex"], { indexName: "o_segment_scriptid_segmentindex_unique" });
      T.index(["scriptId"], "o_segment_scriptid_index");
      T.index(["userId"], "o_segment_userid_index");
    });

    await knex.schema.createTable("o_shot", (T) => {
      t.pk(T);
      // ⚠ 同 `o_segment.projectId`（修复轮 2）：`= o_project.id` = `Date.now()` 毫秒值，
      //   老库实测 1791385147125 → mysql `int` 装不下（严格模式 Out of range，非严格静默夹断）。
      t.u64(T, "projectId");
      T.integer("scriptId");
      T.integer("sceneIndex");
      t.text(T, "sceneTitle");
      T.integer("segmentIndex");
      T.integer("segmentId");
      T.integer("shotIndex");
      T.float("duration");
      t.text(T, "shotSize");
      t.text(T, "camera");
      t.text(T, "light");
      t.text(T, "action");
      t.text(T, "dialogue");
      t.text(T, "sfx");
      T.integer("revision");
      t.ms(T, "createTime");
      t.ms(T, "updateTime");
      t.u64(T, "userId");
      T.index(["scriptId", "segmentIndex", "shotIndex"], "o_shot_script_seg_shot_index");
      T.index(["userId"], "o_shot_userid_index");
    });

    // ---------- 记忆 ----------
    await knex.schema.createTable("memories", (T) => {
      t.vstr(T, "id").notNullable().primary();
      // ⚠ isolationKey 必须 varchar，不能用 text：MySQL 不允许对 TEXT/LONGTEXT 建索引（ERROR 1170），
      //    而下面两条复合索引都以它为前缀。现状值形如
      //    `${projectId}:${agentType}:${episodesId}`（spec §6.2 说 Phase 1b 会加 userId 前缀），
      //    191 字符对现有值（实测 ≈ 40 字符）有充足余量。
      t.vstr(T, "isolationKey").notNullable();
      // ⚠ **同 isolationKey，也必须是 varchar**：`type` 也出现在复合索引
      //    `memories_isolationkey_type_index(isolationKey, type)` 里 —— 上一句注释写下的规则对
      //    **每一个被索引的列**都成立，不只对前缀列。实据（Task 7 首次真连本机 MySQL 8.4.11）：
      //    `t.text()` 在 mysql 侧编译成 `longtext` → 服务端直接拒绝
      //    `alter table memories add index ... - BLOB/TEXT column 'type' used in key specification
      //    without a key length`（ER_BLOB_KEY_WITHOUT_LENGTH，errno 1170），**整个 001 迁移失败**。
      //    静态 DDL 编译（`tests/migration-ddl-mysql.test.ts` 的假 knex）看不到这条：1170 是
      //    **服务端**的语义校验，SQL 串本身完全合法。所以同文件加了机械断言
      //    「任何被索引/主键引用的列都不得是 text/longtext」——它不依赖任何手工清单。
      t.vstr(T, "type").notNullable();
      t.text(T, "role");
      t.text(T, "name");
      t.text(T, "content").notNullable();
      t.text(T, "embedding");
      t.text(T, "relatedMessageIds");
      T.integer("summarized").defaultTo(0);
      t.ms(T, "createTime").notNullable();
      t.u64(T, "userId");
      T.index(["isolationKey", "summarized"], "memories_isolationkey_summarized_index");
      T.index(["isolationKey", "type"], "memories_isolationkey_type_index");
      T.index(["userId"], "memories_userid_index");
    });

    // ---------- 删除退役表（幂等：老 sqlite 库有，全新 MySQL 库没有） ----------
    // spec §5.4：o_skillList / o_skillAttribution 全仓无读取点，删除。
    // ⚠ 先删带外键的从表（o_skillAttribution 有 references o_skillList），再删主表。
    await knex.schema.dropTableIfExists("o_skillAttribution");
    await knex.schema.dropTableIfExists("o_skillList");
  },

  async down(knex: Knex): Promise<void> {
    // 逆序 drop（不做 IF EXISTS 之外的猜测；knex 的 dropTable 在 MySQL 与 sqlite 上都能跑）
    const tables = [
      "memories",
      "o_shot", "o_segment",
      "o_assetsRole2Audio", "o_shotAssets", "o_scriptAssets", "o_assets2Storyboard",
      "o_imageFlow", "o_vendorConfig",
      "o_videoTrack", "o_video", "o_agentWorkData", "o_storyboard",
      "o_image", "o_assets", "o_script",
      "o_eventChapter", "o_event", "o_novel",
      "o_modelPrompt", "o_prompt",
      "o_tasks", "o_setting", "o_agentDeploy", "o_artStyle", "o_project", "o_user",
    ];
    for (const name of tables) await knex.schema.dropTableIfExists(name);
    // ⚠ o_skillList / o_skillAttribution 在 up 里被删了；down **不重建**它们
    //（重建等于把 §5.4 的删除撤销；up 里对它们的 dropTableIfExists 本来就是幂等清理）。
  },
};
