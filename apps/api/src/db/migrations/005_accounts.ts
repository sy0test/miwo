/**
 * 005_accounts —— 账号模型重建（spec §7.1）+ `o_setting` 拆键（spec §6.2 / Tier 0 #5/#6）
 * + 邀请码 / 登录尝试 / 审计日志三张承载表（附录 A 缺项，本阶段补齐）。
 *
 * ⚠ 编号：brief 里写的是 `002_accounts` / `003_quota_grants`，但 1b 收口时
 *   `002_platform_seed` / `003_vendor_asset_sync` / `004_backfill_userid` 已占用这两个号段 ⇒
 *   本迁移顺延为 `005`，并**追加到 `MIGRATIONS` 数组末尾**（数组顺序 = 执行顺序；按文件名升序
 *   `001 < 002 < 003 < 004 < 005 < 006`，所以"追加到末尾"才是有序的）。
 *
 * ── 为什么 o_user 是"建暂存表 → 迁数据 → 删旧表 → 改名"而不是 alterTable ──
 *   1a 的 `001_schema` 建出的 `o_user` 只有 3 列且 `id` **不自增**
 *   （`T.bigInteger("id").unsigned().primary()`），要变成 §7.1 的 9 列 + `id` 自增 +
 *   两个唯一键 —— `alterTable` 改不动主键语义（sqlite 侧更是只能重建表）。
 *   ⚠ 暂存表必须叫 `*_new`：`tools/migration-tables.cjs`（三方一致门禁的单一来源解析器）
 *   把"创建后又 rename 掉的暂存表"按名字后缀 `_new` 排除在"最终落地的表"之外 ——
 *   否则门禁会要求给一张**迁移结束时并不存在**的表登记策略。
 *
 * ── 旧行的处置（**不是**迁移明文口令）──
 *   旧 `o_user` 的 `password` 是**明文**（`lib/initDB.ts:24` 种的是 admin/admin123）。
 *   把明文搬进 `passwordHash` 等于把"可登录的弱口令账号"带进新系统，所以旧行一律迁成
 *   `status='disabled'` + `passwordHash=''`（空哈希无法通过任何 argon2 校验），
 *   由后续的 bootstrap 管理员流程（Phase 1c Task 12）重新开通。
 *
 * ── 已知的跨任务窗口（**如实登记，不粉饰**）──
 *   本迁移删掉 `o_setting.tokenKey`（Tier 0 #6：JWT 密钥改由 `MIWO_JWT_SECRET` 提供，
 *   运行期由 `src/auth/secret.ts` 的"库值优先（`o_setting.jwtSecret` → `o_setting.tokenKey`）
 *   + 配置兜底"承接），并把 `o_user` 的口令列换成 `passwordHash`。**旧的路由代码
 *   （`routes/login/login.ts` 读 `name`/`password`、`routes/setting/loginConfig/*`）要等
 *   Phase 1c 的鉴权重写任务才改用新列** —— 本任务是数据模型任务，不把鉴权改写夹带进来。
 *
 *   ✅【Phase 1c Task 2+3 已闭合】窗口已关：登录链路（`src/auth/**` + `/api/auth/*` +
 *   保留的 `/api/login/login`）已经改用新列与 argon2id；本文件**不再改一行**（只更新这段注释）。
 *   红端证据：在迁到 `006` 的库上跑本迁移之前的那两条查询，实测
 *   `select * from o_user where name = 'admin' → no such column: name`。
 *
 * ⚠ 迁移纪律：只用 schema builder（`createTable` / `renameTable` / 查询构造器），
 *   不用 `knex.raw` —— `tests/migration-ddl-mysql.test.ts` 的假-knex 路径只覆盖 schema builder。
 */
import type { Knex } from "knex";
import { types } from "@/db/dialect";

/**
 * spec §6.2 明确要迁到 `o_userSetting` 的 7 个用户级键（直接影响 token 成本）。
 *
 * ⚠ 这是一份**语义清单**（"哪些键属于用户级"是业务判定，不是机械可推导的），但**只此一处**：
 *   迁移按它搬迁并删除 `o_setting` 里的同名行，没有第二份副本。
 */
const USER_LEVEL_SETTING_KEYS = [
  "agentUseMode",
  "messagesPerSummary",
  "shortTermLimit",
  "summaryMaxLength",
  "summaryLimit",
  "ragLimit",
  "deepRetrieveSummaryLimit",
] as const;

/** 平台级新键（spec §15 O1 的注册方式 / §7.3 的运维接口总开关）。 */
const PLATFORM_SETTING_DEFAULTS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "registrationMode", value: "invite" }, // invite | open | closed
  { key: "allowDbAdminOps", value: "0" },       // §7.3「默认关闭」
];

/**
 * ⚠ 暂存表的表名**必须写成字符串字面量**（`createTable("o_user_new", …)` / `renameTable("o_user_new", "o_user")`），
 *   不能抽成常量：`tools/migration-tables.cjs` 是**源码解析**（只认字面量），把实参写成变量会让
 *   暂存表从解析结果里消失 —— 那时 `o_user_new` 会被当成"最终落地的表"，门禁反过来要求给它登记策略。
 *   单测 `tests/accounts-migration.test.ts` 有「暂存表口径」用例把这条钉住（解析结果必须含
 *   `o_user_new` / `o_user_old`，且它们**不在**最终落地的表里）。
 */

export default {
  name: "005_accounts",

  async up(knex: Knex): Promise<void> {
    const t = types(knex);

    // ---- 1. o_invite（附录 A 缺项：§15 O1 的默认注册方式"邀请码"需要承载表）----
    await knex.schema.createTable("o_invite", (T) => {
      t.pk(T);
      t.vstr(T, "code", 64).notNullable().unique();
      t.u64(T, "createdBy").notNullable();
      T.integer("maxUses").notNullable().defaultTo(1);
      T.integer("usedCount").notNullable().defaultTo(0);
      T.bigInteger("expiresAt").nullable();
      t.boolCol(T, "disabled").notNullable().defaultTo(0);
      t.ms(T, "createdAt").notNullable();
    });

    // ---- 2. o_user 重建（§7.1 的 8 列 + mustChangePassword）----
    await knex.schema.createTable("o_user_new", (T) => {
      t.pk(T); // bigint unsigned + auto_increment（§5.3）。⚠ 旧库的 id 值在下面显式带回，保真
      t.vstr(T, "username", 64).notNullable().unique();
      t.vstr(T, "email", 191).nullable().unique();
      t.vstr(T, "passwordHash", 255).notNullable().defaultTo("");
      t.vstr(T, "role", 16).notNullable().defaultTo("user");     // user | admin
      t.vstr(T, "status", 16).notNullable().defaultTo("active"); // active | disabled
      T.integer("tokenVersion").unsigned().notNullable().defaultTo(0);
      // §7.1 的 8 列之外：引导管理员"首次登录强制改密"必须有处可放
      t.boolCol(T, "mustChangePassword").notNullable().defaultTo(0);
      t.ms(T, "createdAt").notNullable();
      T.bigInteger("lastLoginAt").nullable();
    });

    // 旧行迁移：id 保真、name → username、**明文口令不迁**、一律 disabled
    const legacy = (await knex("o_user").select("id", "name")) as Array<{ id: number | string; name: string | null }>;
    if (legacy.length) {
      await knex("o_user_new").insert(
        legacy.map((r) => ({
          id: Number(r.id),
          username: r.name ?? `legacy-${r.id}`,
          email: null,
          passwordHash: "",
          role: "admin", // 旧系统只有"管理员"一种语义；是否可用由 status 决定
          status: "disabled",
          tokenVersion: 0,
          mustChangePassword: 1,
          createdAt: Date.now(),
          lastLoginAt: null,
        })),
      );
      console.log(`[005] 旧 o_user ${legacy.length} 行迁为 disabled（明文口令未迁，需 bootstrap 管理员重新开通）`);
    }
    await knex.schema.dropTable("o_user");
    await knex.schema.renameTable("o_user_new", "o_user");

    // ---- 3. o_userSetting（§6.2：7 个用户级键从 o_setting 迁出）----
    await knex.schema.createTable("o_userSetting", (T) => {
      t.u64(T, "userId").notNullable();
      t.vstr(T, "key", 64).notNullable();
      t.text(T, "value");
      T.primary(["userId", "key"]);
    });
    // 归属：老库是单租户，用户级键挂到**第一个 o_user 行**（迁移后该行 status 仍是 disabled）。
    // ⚠ 刻意不做"每个用户一份"的展开：老库只有 1 个用户，展开是假动作。
    const firstUser = (await knex("o_user").orderBy("id", "asc").first()) as { id: number | string } | undefined;
    if (firstUser) {
      const firstUserId = Number(firstUser.id);
      const userRows = (await knex("o_setting").whereIn("key", [...USER_LEVEL_SETTING_KEYS]).select("key", "value")) as Array<{
        key: string;
        value: string | null;
      }>;
      if (userRows.length) {
        await knex("o_userSetting").insert(userRows.map((r) => ({ userId: firstUserId, key: r.key, value: r.value })));
        await knex("o_setting").whereIn("key", [...USER_LEVEL_SETTING_KEYS]).delete();
        console.log(`[005] 用户级键迁 o_userSetting：${userRows.length} 行（归 userId=${firstUserId}）`);
      }
    } else {
      console.log("[005] 无 o_user 行 → 用户级键留在 o_setting 不动（避免无主数据）");
    }

    // ---- 4. tokenKey 移出 DB（Tier 0 #6 / §6.2；改由 MIWO_JWT_SECRET 提供）----
    const tokenRows = await knex("o_setting").where("key", "tokenKey").delete();
    console.log(`[005] o_setting.tokenKey 删除 ${tokenRows} 行（改由 MIWO_JWT_SECRET 提供）`);

    // ---- 5. o_loginAttempt / o_auditLog ----
    await knex.schema.createTable("o_loginAttempt", (T) => {
      t.vstr(T, "username", 64).notNullable();
      t.vstr(T, "ip", 64).notNullable();
      T.integer("failedCount").notNullable().defaultTo(0);
      t.ms(T, "lockedUntil").nullable();
      t.ms(T, "firstFailedAt").nullable();
      t.ms(T, "updatedAt").notNullable();
      T.primary(["username", "ip"]);
    });

    await knex.schema.createTable("o_auditLog", (T) => {
      t.pk(T);
      t.u64(T, "userId").nullable();
      t.vstr(T, "role", 16).nullable();
      t.vstr(T, "action", 64).notNullable();
      t.vstr(T, "target", 191).nullable();
      t.text(T, "detail");
      t.vstr(T, "requestId", 64).nullable();
      t.vstr(T, "ip", 64).nullable();
      t.ms(T, "createdAt").notNullable();
      T.index(["userId", "createdAt"], "o_auditlog_userid_createdat_index");
      T.index(["action", "createdAt"], "o_auditlog_action_createdat_index");
    });

    // ---- 6. 平台开关（**不新增 MIWO_* 变量**的落点）----
    // ⚠ `.onConflict("key").ignore()` **必须紧跟在 insert 后面**（不要把 `await` 拆到 insert 上）：
    //   `await knex(...).insert(...)` 之后再 `.onConflict()` 是运行时错误（await 把 QueryBuilder 变成了数组）。
    //   key 是 o_setting 主键 ⇒ 幂等：重跑不会覆盖运维改过的值（`tests/accounts-migration.test.ts` 有钉住）。
    await knex("o_setting")
      .insert(PLATFORM_SETTING_DEFAULTS.map((r) => ({ ...r })))
      .onConflict("key")
      .ignore();
  },

  async down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("o_auditLog");
    await knex.schema.dropTableIfExists("o_loginAttempt");
    await knex.schema.dropTableIfExists("o_userSetting");
    await knex.schema.dropTableIfExists("o_invite");

    // 回到 1a 的 3 列形状。**明文口令不可恢复**：password 只能留空串（登记在报告里）。
    await knex.schema.createTable("o_user_old", (T) => {
      T.bigInteger("id").unsigned().primary();
      T.text("name");
      T.text("password");
    });
    const rows = (await knex("o_user").select("id", "username")) as Array<{ id: number | string; username: string | null }>;
    if (rows.length) {
      await knex("o_user_old").insert(rows.map((r) => ({ id: Number(r.id), name: r.username, password: "" })));
    }
    await knex.schema.dropTable("o_user");
    await knex.schema.renameTable("o_user_old", "o_user");

    // 平台键回滚。⚠ `tokenKey` **不恢复**：它已被环境变量取代，恢复一条"空/陈旧密钥"比没有更糟。
    await knex("o_setting").whereIn("key", PLATFORM_SETTING_DEFAULTS.map((r) => r.key)).delete();
    console.log("[005] down 完成：账号数据回到 3 列形状；明文口令不可恢复（password 为空串）");
  },
};
