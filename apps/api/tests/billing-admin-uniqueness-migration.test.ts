import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { MIGRATIONS, makeMigrationSource } from "@/db/migrations";
import { grantIdentityKey } from "@/billing/grantIdentity";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-admin-unique-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function freshDb(): Knex {
  seq += 1;
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `admin-${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

const NEW_MIGRATION = "012_billing_admin_uniques";

describe("admin billing uniqueness migration", () => {
  it("selects only grouped grant identity columns during duplicate preflight", async () => {
    const selected: string[][] = [];
    let firstCalls = 0;
    const builder = {
      select(...columns: string[]) { selected.push(columns); return this; },
      count() { return this; },
      whereNotNull() { return this; },
      whereNull() { return this; },
      groupBy() { return this; },
      havingRaw() { return this; },
      async first() {
        firstCalls += 1;
        return firstCalls === 2 ? { userId: 1, vendorId: "vendor", model: "model" } : undefined;
      },
    };
    const fakeKnex = Object.assign(() => builder, { schema: {} });
    const migration = MIGRATIONS.find((item) => item.name === NEW_MIGRATION)!;

    await expect(migration.up(fakeKnex as unknown as Knex)).rejects.toThrow(/duplicate.*vendorId\/model/i);
    expect(selected).toEqual([["userId", "agentKey"], ["userId", "vendorId", "model"]]);
  });

  it("fails clearly on duplicate legacy identities without deleting rows", async () => {
    const db = freshDb();
    try {
      const prior = MIGRATIONS.filter((migration) => migration.name !== NEW_MIGRATION);
      await db.migrate.latest({ migrationSource: makeMigrationSource(prior) });
      await db("o_modelGrant").insert([
        { userId: 51, agentKey: "writer", vendorId: null, model: null, enabled: 1, dailyLimit: null, createdAt: 1 },
        { userId: 51, agentKey: "writer", vendorId: null, model: null, enabled: 0, dailyLimit: null, createdAt: 2 },
      ]);
      await expect(db.migrate.latest({ migrationSource: makeMigrationSource() })).rejects.toThrow(/duplicate.*o_modelGrant.*agentKey/i);
      await expect(db("o_modelGrant").where({ userId: 51 }).count({ count: "*" }).first()).resolves.toMatchObject({ count: 2 });
    } finally {
      await db.destroy();
    }
  });

  it("fails clearly on duplicate legacy vendor/model grants without deleting rows", async () => {
    const db = freshDb();
    try {
      const prior = MIGRATIONS.filter((migration) => migration.name !== NEW_MIGRATION);
      await db.migrate.latest({ migrationSource: makeMigrationSource(prior) });
      await db("o_modelGrant").insert([
        { userId: 52, agentKey: null, vendorId: "vendor", model: "model", enabled: 1, dailyLimit: null, createdAt: 1 },
        { userId: 52, agentKey: null, vendorId: "vendor", model: "model", enabled: 0, dailyLimit: null, createdAt: 2 },
      ]);
      await expect(db.migrate.latest({ migrationSource: makeMigrationSource() })).rejects.toThrow(/duplicate.*o_modelGrant.*vendorId\/model/i);
      await expect(db("o_modelGrant").where({ userId: 52 }).count({ count: "*" }).first()).resolves.toMatchObject({ count: 2 });
    } finally {
      await db.destroy();
    }
  });

  it("fails clearly on duplicate legacy prices without deleting rows", async () => {
    const db = freshDb();
    try {
      const prior = MIGRATIONS.filter((migration) => migration.name !== NEW_MIGRATION);
      await db.migrate.latest({ migrationSource: makeMigrationSource(prior) });
      await db("o_price").insert([
        { vendorId: "v", model: "m", unit: "token", unitPriceMicro: "1", effectiveFrom: 1, createdBy: null },
        { vendorId: "v", model: "m", unit: "token", unitPriceMicro: "2", effectiveFrom: 1, createdBy: null },
      ]);
      await expect(db.migrate.latest({ migrationSource: makeMigrationSource() })).rejects.toThrow(/duplicate.*o_price.*vendorId.*model.*unit.*effectiveFrom/i);
      await expect(db("o_price").count({ count: "*" }).first()).resolves.toMatchObject({ count: 2 });
    } finally {
      await db.destroy();
    }
  });

  it("backfills grant identities and enforces grant and price uniqueness", async () => {
    const db = freshDb();
    try {
      const prior = MIGRATIONS.filter((migration) => migration.name !== NEW_MIGRATION);
      await db.migrate.latest({ migrationSource: makeMigrationSource(prior) });
      await db("o_modelGrant").insert([
        { userId: 61, agentKey: "writer", vendorId: null, model: null, enabled: 1, dailyLimit: null, createdAt: 1 },
        { userId: 61, agentKey: null, vendorId: "vendor", model: "model", enabled: 1, dailyLimit: null, createdAt: 2 },
      ]);
      await db.migrate.latest({ migrationSource: makeMigrationSource() });
      const grants = await db("o_modelGrant").where({ userId: 61 }).orderBy("id");
      expect(grants.map((grant) => grant.identityKey)).toEqual([
        grantIdentityKey({ agentKey: "writer" }),
        grantIdentityKey({ vendorId: "vendor", model: "model" }),
      ]);
      await expect(db("o_modelGrant").insert({ userId: 61, agentKey: "writer", vendorId: null, model: null, identityKey: grantIdentityKey({ agentKey: "writer" }), enabled: 1, dailyLimit: null, createdAt: 3 })).rejects.toThrow();
      await expect(db("o_modelGrant").insert({ userId: 62, agentKey: "writer", vendorId: null, model: null, identityKey: grantIdentityKey({ agentKey: "writer" }), enabled: 1, dailyLimit: null, createdAt: 3 })).resolves.toBeDefined();
      await db("o_price").insert({ vendorId: "v", model: "m", unit: "token", unitPriceMicro: "1", effectiveFrom: 1, createdBy: null });
      await expect(db("o_price").insert({ vendorId: "v", model: "m", unit: "token", unitPriceMicro: "2", effectiveFrom: 1, createdBy: null })).rejects.toThrow();
      await expect(db("o_price").insert({ vendorId: "v", model: "m", unit: "image", unitPriceMicro: "2", effectiveFrom: 1, createdBy: null })).resolves.toBeDefined();
    } finally {
      await db.destroy();
    }
  });
});
