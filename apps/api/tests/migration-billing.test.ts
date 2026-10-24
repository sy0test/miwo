import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { MIGRATIONS, makeMigrationSource } from "@/db/migrations";
import accountBootstrap from "@/db/migrations/013_account_bootstrap";
import { policyOf } from "@/db/policies";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-billing-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function freshDb(): Knex {
  seq += 1;
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `billing-${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

const EXPECTED_COLUMNS: Record<string, string[]> = {
  o_usage: [
    "id", "userId", "projectId", "jobId", "vendorId", "model", "callType", "inTokens", "outTokens",
    "imageCount", "videoSeconds", "costMicro", "requestId", "providerCallId", "unit", "quantity", "priceId", "usageStatus", "createdAt",
  ],
  o_dailyQuotaAdmission: ["userId", "vendorId", "model", "dayStart", "admittedCount"],
  o_usageAdmission: ["userId", "providerCallId", "vendorId", "model", "dayStart", "admittedAt", "jobId", "requestId", "callType"],
  o_ledger: [
    "id", "userId", "type", "amountMicro", "balanceAfter", "refType", "refId", "operatorId",
    "createdAt", "idempotencyKey", "frozenAfterMicro",
  ],
  o_order: [
    "id", "userId", "outTradeNo", "channel", "amountMicro", "status", "paidAt", "rawCallback", "type",
    "externalTradeId", "operatorId", "operatorNote", "createdAt", "updatedAt",
  ],
  o_price: ["id", "vendorId", "model", "unit", "unitPriceMicro", "effectiveFrom", "createdBy"],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  o_usage: ["o_usage_userid_createdat_index", "o_usage_jobid_index", "o_usage_userid_providercallid_unique"],
  o_dailyQuotaAdmission: ["o_dailyquota_user_vendor_model_day_unique"],
  o_usageAdmission: ["o_usageadmission_userid_providercallid_unique"],
  o_ledger: ["o_ledger_userid_createdat_index", "o_ledger_userid_idempotencykey_unique"],
  o_order: ["o_order_userid_createdat_index", "o_order_userid_status_index", "o_order_outtradeno_unique", "o_order_externaltradeid_unique"],
  o_price: ["o_price_vendor_model_unit_effectivefrom_index", "o_price_vendor_model_unit_effectivefrom_unique"],
};

describe("009_billing migration", () => {
  it("creates the exact billing columns and named indexes with the specified policies", async () => {
    const db = freshDb();
    try {
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        expect(await db.schema.hasTable(table), table).toBe(true);
        const actual = await db(table).columnInfo();
        expect(Object.keys(actual), table).toEqual(columns);
        if (table === "o_usage") {
          expect(actual.videoSeconds.type).toBe("text");
          expect(actual.quantity.type).toBe("text");
          expect(actual.quantity.nullable).toBe(true);
        }
        if (table === "o_usageAdmission") {
          expect(actual.admittedAt.nullable).toBe(false);
          expect(actual.dayStart.nullable).toBe(false);
        }
        const indexes = await db.raw(`PRAGMA index_list(\"${table}\")`) as Array<{ name: string }>;
        expect(indexes.map((index) => index.name).sort(), table).toEqual([...EXPECTED_INDEXES[table]].sort());
      }
      expect(policyOf("o_usage")).toBe("tenant");
      expect(policyOf("o_dailyQuotaAdmission")).toBe("tenant");
      expect(policyOf("o_usageAdmission")).toBe("tenant");
      expect(policyOf("o_ledger")).toBe("tenant");
      expect(policyOf("o_order")).toBe("tenant");
      expect(policyOf("o_price")).toBe("platform");
    } finally {
      await db.destroy();
    }
  });

  it("keeps unknown usage nullable and refuses to roll back while it is present", async () => {
    const db = freshDb();
    try {
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      const admission = MIGRATIONS.find((migration) => migration.name === "010_daily_quota_admission");
      expect(admission).toBeDefined();
      await db("o_usage").insert({
        userId: 71, vendorId: "v", model: "m", callType: "text", requestId: "r", providerCallId: "unknown",
        unit: "unknown", quantity: null, usageStatus: "uncertain", createdAt: 1,
      });
      await expect(admission!.down(db)).rejects.toThrow(/unmeasured usage rows/i);
      await db("o_usage").delete();
      await admission!.down(db);
      expect(await db.schema.hasTable("o_dailyQuotaAdmission")).toBe(false);
      expect((await db("o_usage").columnInfo()).quantity.nullable).toBe(false);
      await admission!.up(db);
      expect(await db.schema.hasTable("o_dailyQuotaAdmission")).toBe(true);
      expect((await db("o_usage").columnInfo()).quantity.nullable).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("stores per-call admissions separately from immutable usage rows", async () => {
    const db = freshDb();
    try {
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      const admission = MIGRATIONS.find((migration) => migration.name === "011_usage_admission");
      expect(admission).toBeDefined();
      await db("o_usageAdmission").insert({
        userId: 71, providerCallId: "admitted", vendorId: "v", model: "m", dayStart: 0,
        admittedAt: 1, jobId: null, requestId: "r", callType: "text",
      });
      await expect(admission!.down(db)).rejects.toThrow(/admission records/i);
      await expect(db("o_usage").count({ count: "*" }).first()).resolves.toMatchObject({ count: 0 });
      await db("o_usageAdmission").delete();
      await admission!.down(db);
      expect(await db.schema.hasTable("o_usageAdmission")).toBe(false);
      expect(await db.schema.hasColumn("o_usage", "admissionState")).toBe(false);
      await admission!.up(db);
      expect(await db.schema.hasTable("o_usageAdmission")).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("preserves decimal usage measurements as exact strings in SQLite", async () => {
    const db = freshDb();
    try {
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      await db("o_usage").insert({
        userId: 71, vendorId: "v", model: "m", callType: "video", requestId: "req-decimal", providerCallId: "call-decimal",
        videoSeconds: "12.123456", unit: "second", quantity: "1234567890123.123456789", usageStatus: "settled", createdAt: 1,
      });
      const row = await db("o_usage").where({ providerCallId: "call-decimal" }).first("videoSeconds", "quantity");
      expect(row).toEqual({ videoSeconds: "12.123456", quantity: "1234567890123.123456789" });
    } finally {
      await db.destroy();
    }
  });

  it("round-trips down and up without changing existing account and grant rows or schemas", async () => {
    const db = freshDb();
    try {
      const existingMigrations = MIGRATIONS.filter((migration) => !["009_billing", "010_daily_quota_admission", "011_usage_admission", "012_billing_admin_uniques"].includes(migration.name));
      await db.migrate.latest({ migrationSource: makeMigrationSource(existingMigrations) });
      await db("o_account").insert({ userId: 71, balanceMicro: 1250000, frozenMicro: 250000, version: 4, updatedAt: 1791582300907 });
      await db("o_modelGrant").insert({ userId: 71, agentKey: "writer", enabled: 1, dailyLimit: 17, createdAt: 1791582300907 });
      const accountColumns = Object.keys(await db("o_account").columnInfo());
      const grantColumns = Object.keys(await db("o_modelGrant").columnInfo());

      const billing = MIGRATIONS.find((migration) => migration.name === "009_billing");
      expect(billing, "009_billing must be registered").toBeDefined();
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      expect(await db("o_account").where("userId", 71).first()).toMatchObject({ balanceMicro: 1250000, frozenMicro: 250000, version: 4 });
      expect(await db("o_modelGrant").where("userId", 71).first()).toMatchObject({ agentKey: "writer", enabled: 1, dailyLimit: 17 });
      expect(Object.keys(await db("o_account").columnInfo())).toEqual(accountColumns);
      expect(Object.keys(await db("o_modelGrant").columnInfo()).filter((column) => column !== "identityKey")).toEqual(grantColumns);

      await billing!.down(db);
      for (const table of Object.keys(EXPECTED_COLUMNS).filter((name) => !["o_dailyQuotaAdmission", "o_usageAdmission"].includes(name))) expect(await db.schema.hasTable(table), table).toBe(false);
      expect(await db("o_account").where("userId", 71).first()).toBeDefined();
      expect(await db("o_modelGrant").where("userId", 71).first()).toBeDefined();
      await billing!.up(db);
      for (const table of ["o_usage", "o_ledger", "o_order", "o_price"]) expect(await db.schema.hasTable(table), table).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("backfills only users missing accounts and preserves existing account fields", async () => {
    const db = freshDb();
    try {
      const beforeBootstrap = MIGRATIONS.filter((migration) => migration.name !== "013_account_bootstrap");
      await db.migrate.latest({ migrationSource: makeMigrationSource(beforeBootstrap) });
      await db("o_user").insert([
        { username: "bootstrap_missing", passwordHash: "", role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: 1 },
        { username: "bootstrap_existing", passwordHash: "", role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: 1 },
      ]);
      const users = await db("o_user").select("id", "username");
      const missing = users.find((user) => user.username === "bootstrap_missing");
      const existing = users.find((user) => user.username === "bootstrap_existing");
      await db("o_account").insert({ userId: existing.id, balanceMicro: 987654, frozenMicro: 1234, version: 9, updatedAt: 456 });

      await accountBootstrap.up(db);

      expect(await db("o_account").where({ userId: missing.id }).first()).toMatchObject({ balanceMicro: 0, frozenMicro: 0, version: 0 });
      expect(await db("o_account").where({ userId: existing.id }).first()).toMatchObject({ balanceMicro: 987654, frozenMicro: 1234, version: 9, updatedAt: 456 });
      expect(accountBootstrap.name).toBe("013_account_bootstrap");
      expect(MIGRATIONS[MIGRATIONS.length - 1]?.name).toBe("016_redraw_pipeline");
    } finally {
      await db.destroy();
    }
  });

  it("allows multiple provider calls per request while enforcing per-call idempotency", async () => {
    const db = freshDb();
    try {
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      await db("o_usage").insert({ userId: 71, vendorId: "v", model: "m", callType: "text", requestId: "req-1", providerCallId: "call-1", unit: "token", quantity: 3, usageStatus: "settled", createdAt: 1 });
      await db("o_usage").insert({ userId: 71, vendorId: "v", model: "m", callType: "text", requestId: "req-1", providerCallId: "call-2", unit: "token", quantity: 1, usageStatus: "settled", createdAt: 1 });
      await expect(db("o_usage").insert({ userId: 71, vendorId: "v", model: "m", callType: "text", requestId: "req-1", providerCallId: "call-1", unit: "token", quantity: 3, usageStatus: "settled", createdAt: 1 })).rejects.toThrow();
      await db("o_ledger").insert({ userId: 71, type: "consume", amountMicro: -20, balanceAfter: 80, idempotencyKey: "settle-1", frozenAfterMicro: 0, createdAt: 1 });
      await expect(db("o_ledger").insert({ userId: 71, type: "consume", amountMicro: -20, balanceAfter: 60, idempotencyKey: "settle-1", frozenAfterMicro: 0, createdAt: 2 })).rejects.toThrow();
      await db("o_ledger").insert({ userId: 72, type: "consume", amountMicro: -20, balanceAfter: 80, idempotencyKey: "settle-1", frozenAfterMicro: 0, createdAt: 1 });
      await db("o_order").insert({ userId: 71, outTradeNo: "out-1", channel: "manual", amountMicro: 100, status: "paid", type: "recharge", createdAt: 1, updatedAt: 1 });
      expect(await db("o_order").where({ outTradeNo: "out-1" }).first()).toMatchObject({ rawCallback: null });
      await expect(db("o_order").insert({ userId: 72, outTradeNo: "out-1", channel: "manual", amountMicro: 100, status: "paid", type: "recharge", createdAt: 1, updatedAt: 1 })).rejects.toThrow();
      await db("o_order").insert({ userId: 72, outTradeNo: "out-2", channel: "manual", amountMicro: 100, status: "paid", type: "recharge", createdAt: 2, updatedAt: 2 });
    } finally {
      await db.destroy();
    }
  });
});
