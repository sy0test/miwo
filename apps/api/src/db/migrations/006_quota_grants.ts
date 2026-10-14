/**
 * 006_quota_grants —— 平台统一 key 下的"用户额度 + 模型授权"骨架（spec §8.2 / §8.5，D1）。
 *
 * ⚠ 编号同 `005_accounts`：brief 写的 `003_quota_grants` 已被 1b 的迁移占用 ⇒ 顺延为 `006`，
 *   追加到 `MIGRATIONS` 数组末尾（顺序 = 执行顺序，且与文件名的升序一致）。
 *
 * 本阶段**不做计费**（Phase 2）：只落两张表的结构与归属，让 Phase 2 的结算与
 * `resolveModelName()` 的授权判定有地方落。
 *
 * 归属（**写死在这里**，同时登记进 `src/db/policies.ts`，由 `tools/check-tenant-policies.cjs`
 * 断言"策略表 ↔ 建表清单"逐项一致 —— 两处任一漏写都会当场红）：
 *   o_account     tenant   —— 每个用户一行余额/冻结额
 *   o_modelGrant  tenant   —— 用户可见/可用的模型范围
 *   o_usage       tenant   —— Phase 2 建（每次厂商调用一行）
 *   o_ledger      tenant   —— Phase 2 建（只追加流水）
 *   o_order       tenant   —— Phase 2 建（充值订单）
 *   o_price       platform —— Phase 2 建（单价表，只读）
 *
 * 金额一律**整数微元**（Micro，1 元 = 1_000_000），避免浮点误差（spec §8.2）。
 *
 * ⚠ 迁移纪律：只用 schema builder（`tests/migration-ddl-mysql.test.ts` 的假-knex 路径只覆盖它）。
 */
import type { Knex } from "knex";
import { types } from "@/db/dialect";

export default {
  name: "006_quota_grants",

  async up(knex: Knex): Promise<void> {
    const t = types(knex);

    // ---- o_account：一个用户一行余额 ----
    // ⚠ 为什么用**表级** `T.primary([...])` 而不是列级 `.primary()`：这一列同时是
    //   `o_user.id` 的外键（u64 → mysql `bigint unsigned`）。sqlite 的列级
    //   `integer primary key` 会让它变成 rowid 别名（隐式自增、NULL 被自动填值），
    //   与"userId 由调用方显式给"的语义不符；表级 `primary key (userId)` 在两个方言下
    //   都保留普通列语义（sqlite 实测 DDL：`"userId" integer not null, primary key ("userId")`）。
    await knex.schema.createTable("o_account", (T) => {
      t.u64(T, "userId").notNullable();
      // 余额与冻结都是**整数微元**
      T.bigInteger("balanceMicro").notNullable().defaultTo(0);
      T.bigInteger("frozenMicro").notNullable().defaultTo(0);
      // 乐观锁：Phase 2 的"预扣 → 结算"必须带 version 条件更新，防并发双花
      T.integer("version").unsigned().notNullable().defaultTo(0);
      T.bigInteger("updatedAt").notNullable().defaultTo(0);
      T.primary(["userId"]);
    });

    // ---- o_modelGrant：用户可见/可用的模型范围 ----
    await knex.schema.createTable("o_modelGrant", (T) => {
      t.pk(T);
      t.u64(T, "userId").notNullable();
      // 三选一的定位方式（§8.5：现状 `o_agentDeploy.key` 是全局角色名，无法表达用户级覆盖）
      t.vstr(T, "agentKey", 64).nullable();
      t.vstr(T, "vendorId", 64).nullable();
      t.vstr(T, "model", 128).nullable();
      t.boolCol(T, "enabled").notNullable().defaultTo(1);
      T.integer("dailyLimit").nullable();
      t.ms(T, "createdAt").notNullable();
      T.index(["userId", "enabled"], "o_modelgrant_userid_enabled_index");
    });
  },

  async down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("o_modelGrant");
    await knex.schema.dropTableIfExists("o_account");
  },
};
