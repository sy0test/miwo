import type { Knex } from "knex";
import { types } from "@/db/dialect";
import type { Migration } from "@/db/migrations";

export function usageTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T) => {
    t.pk(T);
    t.u64(T, "userId").notNullable();
    t.u64(T, "projectId").nullable();
    t.u64(T, "jobId").nullable();
    T.string("vendorId", 64).notNullable();
    T.string("model", 96).notNullable();
    T.string("callType", 32).notNullable();
    T.integer("inTokens").nullable();
    T.integer("outTokens").nullable();
    T.integer("imageCount").nullable();
    t.decimal(T, "videoSeconds", 18, 6).nullable();
    T.bigInteger("costMicro").unsigned().notNullable().defaultTo(0);
    T.string("requestId", 128).notNullable();
    T.string("providerCallId", 128).notNullable();
    T.string("unit", 32).notNullable();
    t.decimal(T, "quantity", 30, 9).notNullable();
    t.u64(T, "priceId").nullable();
    T.string("usageStatus", 32).notNullable();
    t.ms(T, "createdAt").notNullable();
    T.index(["userId", "createdAt"], "o_usage_userid_createdat_index");
    T.index(["jobId"], "o_usage_jobid_index");
    T.unique(["userId", "providerCallId"], "o_usage_userid_providercallid_unique");
  };
}

export function ledgerTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T) => {
    t.pk(T);
    t.u64(T, "userId").notNullable();
    T.string("type", 32).notNullable();
    T.bigInteger("amountMicro").notNullable();
    T.bigInteger("balanceAfter").notNullable();
    T.string("refType", 32).nullable();
    T.string("refId", 128).nullable();
    t.u64(T, "operatorId").nullable();
    t.ms(T, "createdAt").notNullable();
    T.string("idempotencyKey", 128).notNullable();
    T.bigInteger("frozenAfterMicro").unsigned().notNullable().defaultTo(0);
    T.index(["userId", "createdAt"], "o_ledger_userid_createdat_index");
    T.unique(["userId", "idempotencyKey"], "o_ledger_userid_idempotencykey_unique");
  };
}

export function orderTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T) => {
    t.pk(T);
    t.u64(T, "userId").notNullable();
    T.string("outTradeNo", 128).notNullable();
    T.string("channel", 32).notNullable();
    T.bigInteger("amountMicro").unsigned().notNullable();
    T.string("status", 32).notNullable();
    t.ms(T, "paidAt").nullable();
    t.text(T, "rawCallback").nullable();
    T.string("type", 32).notNullable();
    T.string("externalTradeId", 128).nullable();
    t.u64(T, "operatorId").nullable();
    t.text(T, "operatorNote").nullable();
    t.ms(T, "createdAt").notNullable();
    t.ms(T, "updatedAt").notNullable();
    T.index(["userId", "createdAt"], "o_order_userid_createdat_index");
    T.index(["userId", "status"], "o_order_userid_status_index");
    T.unique(["outTradeNo"], "o_order_outtradeno_unique");
    T.unique(["externalTradeId"], "o_order_externaltradeid_unique");
  };
}

export function priceTableSpec(knex: Knex): (T: Knex.CreateTableBuilder) => void {
  const t = types(knex);
  return (T) => {
    t.pk(T);
    T.string("vendorId", 32).notNullable();
    T.string("model", 96).notNullable();
    T.string("unit", 32).notNullable();
    T.bigInteger("unitPriceMicro").unsigned().notNullable();
    t.ms(T, "effectiveFrom").notNullable();
    t.u64(T, "createdBy").nullable();
    T.index(["vendorId", "model", "unit", "effectiveFrom"], "o_price_vendor_model_unit_effectivefrom_index");
  };
}

export default {
  name: "009_billing",
  async up(knex: Knex): Promise<void> {
    if (!(await knex.schema.hasTable("o_usage"))) await knex.schema.createTable("o_usage", usageTableSpec(knex));
    if (!(await knex.schema.hasTable("o_ledger"))) await knex.schema.createTable("o_ledger", ledgerTableSpec(knex));
    if (!(await knex.schema.hasTable("o_order"))) await knex.schema.createTable("o_order", orderTableSpec(knex));
    if (!(await knex.schema.hasTable("o_price"))) await knex.schema.createTable("o_price", priceTableSpec(knex));
  },
  async down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("o_price");
    await knex.schema.dropTableIfExists("o_order");
    await knex.schema.dropTableIfExists("o_ledger");
    await knex.schema.dropTableIfExists("o_usage");
  },
} satisfies Migration;
