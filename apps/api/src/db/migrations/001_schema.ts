/**
 * 001_schema —— 谜沃的基线表结构（spec §5.2 ① / §5.3 / 附录 A）。
 *
 * 这个文件是**全新 MySQL 库的唯一结构真相**；同时它必须能在 sqlite 下跑通，
 * 因为本机的回归网（`apps/api/tests/**` 与 `apps/api/scripts/verify-phase0.cjs`）跑的是 sqlite。
 *
 * 与 `apps/api/src/lib/initDB.ts`（1176 行）的关系：后者是**旧真相**，Phase 1a 之后
 * 不再被启动路径调用（Task 7 摘除），本文件是它的替代。两者会短暂并存（1c 才删旧文件，
 * 因为 `apps/api/scripts/verify-phase0.cjs` 的构件清单还断言它存在）。
 *
 * 与现状库的差异（全部是**有意**的，spec 有据；逐表差集见 Task 3 报告与
 * `apps/api/scripts/gen-schema-migration.cjs` 的机械输出）：
 *   - 不建 o_skillList / o_skillAttribution（§5.4 删除；本文件对老库 dropTableIfExists）
 *   - 26 张表的主键改为 BIGINT UNSIGNED AUTO_INCREMENT（§5.3）
 *   - memories.id 由 TEXT 改 VARCHAR(191)（§5.3，规避 MySQL ERROR 1170）
 *   - 18 张租户表新增 userId（§6.2）；**回填归 Phase 1b**
 *   - o_agentWorkData 补唯一键 (projectId, episodesId, key)（§5.3）
 *   - o_project.directorManual / o_modelPrompt.{fileName,path} / o_agentDeploy.type 是现状库里
 *     由 fixDB 补出来的列，**必须进基线**（否则全新 MySQL 库少列 → 启动期 unknown column）
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

    // ---------- 用户与项目 ----------
    await knex.schema.createTable("o_user", (T) => {
      // ⚠ 不加自增：现状由代码显式给 id（种子 id=1）。整体重建归 Phase 1c（spec §7.1）。
      T.bigInteger("id").unsigned().primary();
      t.text(T, "name");
      t.text(T, "password");
    });

    await knex.schema.createTable("o_project", (T) => {
      t.pk(T);
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
      T.integer("createTime");
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
      T.integer("projectId");
      T.string("taskClass");
      T.string("relatedObjects");
      T.string("model");
      t.text(T, "describe");
      T.string("state");
      T.integer("startTime");
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
      T.string("fileName");            // fixDB 补过
      T.string("path");                // fixDB 补过
    });

    // ---------- 小说 / 事件 ----------
    await knex.schema.createTable("o_novel", (T) => {
      t.pk(T);
      T.integer("chapterIndex");
      t.text(T, "reel");
      t.text(T, "chapter");
      t.text(T, "chapterData");
      T.integer("projectId");
      T.integer("eventState");
      t.text(T, "event");
      t.text(T, "errorReason");
      T.integer("createTime");
      t.u64(T, "userId");
      T.index(["userId"], "o_novel_userid_index");
    });

    await knex.schema.createTable("o_event", (T) => {
      t.pk(T);
      T.string("name");
      T.string("detail");
      T.integer("createTime");
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
      T.integer("projectId");
      T.integer("extractState");
      T.integer("createTime");
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
      T.integer("projectId");
      T.integer("flowId");
      T.integer("startTime");
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
      T.integer("trackId");
      t.text(T, "reason");
      t.text(T, "track");
      t.text(T, "videoDesc");
      T.integer("shouldGenerateImage");
      T.integer("projectId");
      T.integer("flowId");
      T.integer("index");
      T.integer("createTime");
      t.text(T, "sourceRange");
      t.text(T, "clipPath");
      t.text(T, "originDialogue");
      t.u64(T, "userId");
      T.index(["userId"], "o_storyboard_userid_index");
    });

    await knex.schema.createTable("o_agentWorkData", (T) => {
      t.pk(T);
      T.integer("projectId");
      T.integer("episodesId");
      T.string("key");
      T.string("data");
      T.integer("createTime");
      T.integer("updateTime");
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
      T.integer("time");
      t.text(T, "state");
      T.integer("scriptId");
      T.integer("projectId");
      T.integer("videoTrackId");
      t.u64(T, "userId");
      T.index(["userId"], "o_video_userid_index");
    });

    await knex.schema.createTable("o_videoTrack", (T) => {
      t.pk(T);
      T.integer("videoId");
      T.integer("projectId");
      T.integer("scriptId");
      t.text(T, "state");
      t.text(T, "reason");
      t.text(T, "prompt");
      T.integer("selectVideoId");
      T.integer("duration");
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
      T.integer("projectId");
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
      T.integer("createTime");
      T.integer("updateTime");
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
      T.integer("projectId");
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
      T.integer("createTime");
      T.integer("updateTime");
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
      t.text(T, "type").notNullable();
      t.text(T, "role");
      t.text(T, "name");
      t.text(T, "content").notNullable();
      t.text(T, "embedding");
      t.text(T, "relatedMessageIds");
      T.integer("summarized").defaultTo(0);
      T.integer("createTime").notNullable();
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
