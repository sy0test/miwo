import type { Knex } from "knex";
import { grantIdentityKey } from "@/billing/grantIdentity";
import type { Migration } from "@/db/migrations";

const GRANT_UNIQUE = "o_modelgrant_userid_identitykey_unique";
const PRICE_UNIQUE = "o_price_vendor_model_unit_effectivefrom_unique";

async function duplicateGrant(knex: Knex, field: "agentKey" | "model"): Promise<Record<string, unknown> | undefined> {
  const query = knex("o_modelGrant");
  if (field === "agentKey") {
    query.select("userId", "agentKey").whereNotNull("agentKey").groupBy("userId", "agentKey");
  } else {
    query.select("userId", "vendorId", "model").whereNull("agentKey").whereNotNull("vendorId").whereNotNull("model").groupBy("userId", "vendorId", "model");
  }
  return query.count({ rows: "id" }).havingRaw("count(*) > 1").first();
}

const migration: Migration = {
  name: "012_billing_admin_uniques",
  async up(knex: Knex): Promise<void> {
    const agentDuplicate = await duplicateGrant(knex, "agentKey");
    if (agentDuplicate) {
      throw new Error(`[012_billing_admin_uniques] duplicate o_modelGrant agentKey identity for userId=${agentDuplicate.userId}, agentKey=${agentDuplicate.agentKey}; no rows were changed`);
    }
    const modelDuplicate = await duplicateGrant(knex, "model");
    if (modelDuplicate) {
      throw new Error(`[012_billing_admin_uniques] duplicate o_modelGrant vendorId/model identity for userId=${modelDuplicate.userId}, vendorId=${modelDuplicate.vendorId}, model=${modelDuplicate.model}; no rows were changed`);
    }
    const priceDuplicate: Record<string, unknown> | undefined = await knex("o_price")
      .select("vendorId", "model", "unit", "effectiveFrom")
      .count({ rows: "id" })
      .groupBy("vendorId", "model", "unit", "effectiveFrom")
      .havingRaw("count(*) > 1")
      .first() as unknown as Record<string, unknown> | undefined;
    if (priceDuplicate) {
      throw new Error(`[012_billing_admin_uniques] duplicate o_price identity for vendorId=${priceDuplicate.vendorId}, model=${priceDuplicate.model}, unit=${priceDuplicate.unit}, effectiveFrom=${priceDuplicate.effectiveFrom}; no rows were changed`);
    }

    if (!(await knex.schema.hasColumn("o_modelGrant", "identityKey"))) {
      await knex.schema.alterTable("o_modelGrant", (table) => table.string("identityKey", 80).nullable());
    }
    const grants = await knex("o_modelGrant").select("id", "agentKey", "vendorId", "model").whereNull("identityKey");
    for (const grant of grants) {
      const identityKey = grantIdentityKey(grant);
      if (identityKey !== null) await knex("o_modelGrant").where({ id: grant.id }).update({ identityKey });
    }

    await knex.schema.alterTable("o_modelGrant", (table) => {
      table.unique(["userId", "identityKey"], GRANT_UNIQUE);
    });
    await knex.schema.alterTable("o_price", (table) => {
      table.unique(["vendorId", "model", "unit", "effectiveFrom"], PRICE_UNIQUE);
    });
  },
  async down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("o_price", (table) => table.dropUnique(["vendorId", "model", "unit", "effectiveFrom"], PRICE_UNIQUE));
    await knex.schema.alterTable("o_modelGrant", (table) => table.dropUnique(["userId", "identityKey"], GRANT_UNIQUE));
    if (await knex.schema.hasColumn("o_modelGrant", "identityKey")) {
      await knex.schema.alterTable("o_modelGrant", (table) => table.dropColumn("identityKey"));
    }
  },
};

export default migration;
