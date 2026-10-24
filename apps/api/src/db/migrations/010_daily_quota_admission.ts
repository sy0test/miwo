import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

export default {
  name: "010_daily_quota_admission",
  async up(knex: Knex): Promise<void> {
    if (await knex.schema.hasTable("o_dailyQuotaAdmission")) return;
    const t = types(knex);
    await knex.schema.createTable("o_dailyQuotaAdmission", (T) => {
      t.u64(T, "userId").notNullable();
      T.string("vendorId", 64).notNullable();
      T.string("model", 96).notNullable();
      t.ms(T, "dayStart").notNullable();
      T.integer("admittedCount").notNullable();
      T.unique(["userId", "vendorId", "model", "dayStart"], "o_dailyquota_user_vendor_model_day_unique");
    });
    await knex.schema.alterTable("o_usage", (T) => {
      t.decimal(T as unknown as Knex.CreateTableBuilder, "quantity", 30, 9).nullable().alter();
    });
  },
  async down(knex: Knex): Promise<void> {
    const unmeasured = await knex("o_usage").whereNull("quantity").count({ count: "*" }).first() as { count: string | number };
    if (Number(unmeasured.count) > 0) throw new Error("Cannot roll back 010_daily_quota_admission while unmeasured usage rows exist");
    const t = types(knex);
    await knex.schema.alterTable("o_usage", (T) => {
      t.decimal(T as unknown as Knex.CreateTableBuilder, "quantity", 30, 9).notNullable().alter();
    });
    await knex.schema.dropTableIfExists("o_dailyQuotaAdmission");
  },
} satisfies Migration;
