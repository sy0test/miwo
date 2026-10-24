import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

const migration: Migration = {
  name: "011_usage_admission",
  async up(knex: Knex) {
    if (await knex.schema.hasTable("o_usageAdmission")) return;
    const t = types(knex);
    await knex.schema.createTable("o_usageAdmission", (T) => {
      t.u64(T, "userId");
      T.string("providerCallId", 128).notNullable();
      T.string("vendorId", 64).notNullable();
      T.string("model", 96).notNullable();
      t.ms(T, "dayStart").notNullable();
      t.ms(T, "admittedAt").notNullable();
      t.u64(T, "jobId").nullable();
      T.string("requestId", 128).notNullable();
      T.string("callType", 32).notNullable();
      T.unique(["userId", "providerCallId"], "o_usageadmission_userid_providercallid_unique");
    });
  },
  async down(knex: Knex) {
    if (!(await knex.schema.hasTable("o_usageAdmission"))) return;
    const row = await knex("o_usageAdmission").count({ count: "*" }).first() as { count: string | number };
    if (Number(row.count) > 0) throw new Error("Cannot roll back 011_usage_admission while admission records exist");
    await knex.schema.dropTable("o_usageAdmission");
  },
};

export default migration;
