import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { createJobRegistry } from "@/jobs/registry";
import { createJobStore } from "@/jobs/store";
import type { JobDefinition } from "@/jobs/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-billing-submit-"));
let db: Knex;
let store: ReturnType<typeof createJobStore>;

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const definition: JobDefinition<{ key: string; businessId: number }> = {
  type: "test.billed-submit", timeoutMs: 60_000, maxAttempts: 1, pool: "test",
  parse: (raw) => raw as { key: string; businessId: number },
  dedupeKey: (payload, userId) => `${userId}:billed-submit:${payload.key}`,
  handle: async () => null,
};

beforeEach(async () => {
  db = createKnex(cfg(path.join(TMP, `submit-${Date.now()}-${Math.random()}.sqlite`)));
  await runMigrations(db);
  await db.schema.createTable("o_submitBusiness", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.string("key").notNullable();
  });
  await db("o_account").insert({ userId: 71, balanceMicro: "100", frozenMicro: "0", version: 0, updatedAt: 1 });
  store = createJobStore({ db, registry: createJobRegistry([definition]) });
});

afterEach(async () => {
  await db.destroy();
});

async function submit(key: string, estimateMicro = 25n, resolveExistingBusiness?: (trx: Knex.Transaction, jobId: string) => Promise<{ businessId: number; marker: string }>) {
  const { submitBilledJob } = await import("@/billing/submit");
  return submitBilledJob({
    db,
    userId: 71,
    estimateMicro,
    idempotencyKey: `reserve:${key}`,
    createBusinessRows: async (trx) => {
      const [businessId] = await trx("o_submitBusiness").insert({ userId: 71, key });
      return { businessId: Number(businessId), marker: "new" };
    },
    resolveExistingBusiness,
    enqueue: async (trx, business) => {
      const result = await store.enqueueInTransaction(trx, { type: definition.type, userId: 71, payload: { key, businessId: business.businessId } });
      return result;
    },
  });
}

describe("billed job submission", () => {
  it("commits business row, queued job, freeze, and reservation ledger together", async () => {
    const result = await submit("commit");
    expect(result).toMatchObject({ business: { businessId: expect.any(Number) }, jobId: expect.any(String), deduplicated: false });
    expect(await db("o_submitBusiness").count({ n: "*" }).first()).toMatchObject({ n: 1 });
    expect(await db("o_job").where({ id: result.jobId, state: "queued" }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
    expect(await db("o_account").where({ userId: 71 }).first()).toMatchObject({ balanceMicro: 100, frozenMicro: 25 });
    expect(await db("o_ledger").where({ userId: 71, type: "freeze", refId: result.jobId }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
  });

  it("submits a free job with a zero-amount reservation", async () => {
    const result = await submit("free", 0n);
    expect(result).toMatchObject({ business: { businessId: expect.any(Number) }, jobId: expect.any(String), deduplicated: false });
    expect(await db("o_account").where({ userId: 71 }).first()).toMatchObject({ balanceMicro: 100, frozenMicro: 0 });
    expect(await db("o_ledger").where({ userId: 71, type: "freeze", refId: result.jobId }).first())
      .toMatchObject({ amountMicro: 0, frozenAfterMicro: 0, idempotencyKey: `reserve:free` });
  });

  it("rolls back every write when enqueue fails", async () => {
    const { submitBilledJob } = await import("@/billing/submit");
    await expect(submitBilledJob({
      db, userId: 71, estimateMicro: 25n, idempotencyKey: "reserve:enqueue-fail",
      createBusinessRows: async (trx) => {
        await trx("o_submitBusiness").insert({ userId: 71, key: "enqueue-fail" });
        return { businessId: 1 };
      },
      enqueue: async () => { throw new Error("enqueue failed"); },
    })).rejects.toThrow("enqueue failed");
    expect(await db("o_submitBusiness").count({ n: "*" }).first()).toMatchObject({ n: 0 });
    expect(await db("o_job").count({ n: "*" }).first()).toMatchObject({ n: 0 });
    expect(await db("o_account").where({ userId: 71 }).first()).toMatchObject({ frozenMicro: 0, version: 0 });
    expect(await db("o_ledger").count({ n: "*" }).first()).toMatchObject({ n: 0 });
  });

  it("returns an existing active job without duplicate business rows or reservation", async () => {
    const first = await submit("dedupe");
    const second = await submit("dedupe", 25n, async (trx, jobId) => {
      const existing = await trx("o_job").where({ id: jobId }).first();
      const payload = JSON.parse(existing.payload) as { businessId: number };
      const row = await trx("o_submitBusiness").where({ id: payload.businessId }).first();
      return { businessId: Number(row.id), marker: "existing" };
    });
    expect(second).toMatchObject({ jobId: first.jobId, deduplicated: true });
    expect(second.business).toEqual({ ...first.business, marker: "existing" });
    expect(await db("o_submitBusiness").count({ n: "*" }).first()).toMatchObject({ n: 1 });
    expect(await db("o_account").where({ userId: 71 }).first()).toMatchObject({ frozenMicro: 25, version: 1 });
    expect(await db("o_ledger").where({ userId: 71, type: "freeze" }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
  });

  it("finds exactly one reservation id through the job freeze ledger row", async () => {
    const { reservationIdForJobInTransaction } = await import("@/billing/ledger");
    const result = await submit("reservation-lookup");
    const found = await db.transaction((trx) => reservationIdForJobInTransaction(trx, { userId: 71, jobId: result.jobId }));
    expect(found).toBe("reserve:reservation-lookup");
  });

  it("rejects ambiguous job freeze ledger rows", async () => {
    const { reservationIdForJobInTransaction } = await import("@/billing/ledger");
    await db("o_ledger").insert([
      { userId: 71, type: "freeze", amountMicro: -1, balanceAfter: 100, frozenAfterMicro: 1, refType: "job", refId: "ambiguous", idempotencyKey: "reserve:a", createdAt: 1 },
      { userId: 71, type: "freeze", amountMicro: -1, balanceAfter: 100, frozenAfterMicro: 2, refType: "job", refId: "ambiguous", idempotencyKey: "reserve:b", createdAt: 2 },
    ]);
    await expect(db.transaction((trx) => reservationIdForJobInTransaction(trx, { userId: 71, jobId: "ambiguous" }))).rejects.toThrow(/exactly one/i);
  });

  it("rejects insufficient funds and rolls back submission effects", async () => {
    const { submitBilledJob } = await import("@/billing/submit");
    await expect(submitBilledJob({
      db, userId: 71, estimateMicro: 101n, idempotencyKey: "reserve:insufficient",
      createBusinessRows: async (trx) => {
        const [businessId] = await trx("o_submitBusiness").insert({ userId: 71, key: "insufficient" });
        return { businessId: Number(businessId) };
      },
      enqueue: async (trx, business) => store.enqueueInTransaction(trx, { type: definition.type, userId: 71, payload: { key: "insufficient", businessId: business.businessId } }),
    })).rejects.toMatchObject({ httpStatus: 402 });
    expect(await db("o_submitBusiness").count({ n: "*" }).first()).toMatchObject({ n: 0 });
    expect(await db("o_job").count({ n: "*" }).first()).toMatchObject({ n: 0 });
    expect(await db("o_ledger").count({ n: "*" }).first()).toMatchObject({ n: 0 });
  });
});
