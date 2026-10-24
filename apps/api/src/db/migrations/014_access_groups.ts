import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

type LegacyGrant = {
  userId: number | string;
  vendorId: string;
  model: string;
  enabled: number | boolean;
  dailyLimit: number | null;
};

const migration: Migration = {
  name: "014_access_groups",

  async up(knex: Knex): Promise<void> {
    const t = types(knex);
    if (!(await knex.schema.hasTable("o_modelGroup"))) {
      await knex.schema.createTable("o_modelGroup", (table) => {
        t.pk(table);
        t.vstr(table, "name", 128).notNullable();
        t.boolCol(table, "isLegacy").notNullable().defaultTo(0);
        t.u64(table, "legacyUserId").nullable().unique("o_modelgroup_legacyuserid_unique");
        t.ms(table, "createdAt").notNullable();
      });
    }
    if (!(await knex.schema.hasTable("o_modelGroupItem"))) {
      await knex.schema.createTable("o_modelGroupItem", (table) => {
        t.u64(table, "modelGroupId").notNullable();
        t.vstr(table, "vendorId", 64).notNullable();
        t.vstr(table, "model", 128).notNullable();
        t.boolCol(table, "enabled").notNullable().defaultTo(1);
        table.integer("dailyLimit").nullable();
        t.ms(table, "createdAt").notNullable();
        table.primary(["modelGroupId", "vendorId", "model"], "o_modelgroupitem_identity_primary");
      });
    }
    if (!(await knex.schema.hasTable("o_userGroup"))) {
      await knex.schema.createTable("o_userGroup", (table) => {
        t.pk(table);
        t.vstr(table, "name", 128).notNullable();
        t.boolCol(table, "isLegacy").notNullable().defaultTo(0);
        t.u64(table, "legacyUserId").nullable().unique("o_usergroup_legacyuserid_unique");
        t.ms(table, "createdAt").notNullable();
      });
    }
    if (!(await knex.schema.hasTable("o_userGroupModelGroup"))) {
      await knex.schema.createTable("o_userGroupModelGroup", (table) => {
        t.u64(table, "userGroupId").notNullable();
        t.u64(table, "modelGroupId").notNullable();
        table.primary(["userGroupId", "modelGroupId"], "o_usergroup_modelgroup_primary");
        table.index(["modelGroupId"], "o_usergroup_modelgroup_modelgroup_index");
      });
    }
    if (!(await knex.schema.hasTable("o_userGroupMembership"))) {
      await knex.schema.createTable("o_userGroupMembership", (table) => {
        t.u64(table, "userId").notNullable();
        t.u64(table, "userGroupId").notNullable();
        table.primary(["userId", "userGroupId"], "o_usergroupmembership_identity_primary");
        table.index(["userGroupId"], "o_usergroupmembership_group_index");
      });
    }

    const grants = (await knex("o_modelGrant")
      .whereNull("agentKey")
      .whereNotNull("vendorId")
      .whereNotNull("model")
      .select("userId", "vendorId", "model", "enabled", "dailyLimit")) as LegacyGrant[];
    const userIds = [...new Set(grants.map((grant) => String(grant.userId)))];
    for (const userId of userIds) {
      let modelGroup = await knex("o_modelGroup").where({ legacyUserId: userId }).first("id");
      if (!modelGroup) {
        const [id] = await knex("o_modelGroup").insert({ name: `历史授权（${userId}）`, isLegacy: 1, legacyUserId: userId, createdAt: Date.now() });
        modelGroup = { id };
      }
      let userGroup = await knex("o_userGroup").where({ legacyUserId: userId }).first("id");
      if (!userGroup) {
        const [id] = await knex("o_userGroup").insert({ name: `历史授权（${userId}）`, isLegacy: 1, legacyUserId: userId, createdAt: Date.now() });
        userGroup = { id };
      }
      const owned = grants.filter((grant) => String(grant.userId) === userId);
      for (const grant of owned) {
        const exists = await knex("o_modelGroupItem").where({ modelGroupId: modelGroup.id, vendorId: grant.vendorId, model: grant.model }).first("modelGroupId");
        if (!exists) {
          await knex("o_modelGroupItem").insert({
            modelGroupId: modelGroup.id,
            vendorId: grant.vendorId,
            model: grant.model,
            enabled: grant.enabled,
            dailyLimit: grant.dailyLimit,
            createdAt: Date.now(),
          });
        }
      }
      const membership = await knex("o_userGroupMembership").where({ userId, userGroupId: userGroup.id }).first("userId");
      if (!membership) await knex("o_userGroupMembership").insert({ userId, userGroupId: userGroup.id });
      const mapping = await knex("o_userGroupModelGroup").where({ userGroupId: userGroup.id, modelGroupId: modelGroup.id }).first("userGroupId");
      if (!mapping) await knex("o_userGroupModelGroup").insert({ userGroupId: userGroup.id, modelGroupId: modelGroup.id });
    }
  },

  async down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("o_userGroupMembership");
    await knex.schema.dropTableIfExists("o_userGroupModelGroup");
    await knex.schema.dropTableIfExists("o_modelGroupItem");
    await knex.schema.dropTableIfExists("o_userGroup");
    await knex.schema.dropTableIfExists("o_modelGroup");
  },
};

export default migration;
