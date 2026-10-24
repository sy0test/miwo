import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { currentTenant, runWithTenant } from "@/db/tenant-context";
import { makeTenantAware } from "@/db/tenant-guard";
import { TABLE_POLICIES } from "@/db/policies";
import { createJobRegistry } from "@/jobs/registry";
import { createJobStore } from "@/jobs/store";
import type { JobDefinition } from "@/jobs/types";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-job-enqueue-trx-"));
const databases: Knex[] = [];
afterAll(async () => {
  await Promise.all(databases.map((db) => db.destroy()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const definition: JobDefinition<{ reservationKey: string }> = {
  type: "test.reservation", timeoutMs: 60_000, maxAttempts: 1, pool: "test",
  parse: (raw) => raw as { reservationKey: string },
  dedupeKey: (payload, userId) => `${userId}:reservation:${payload.reservationKey}`,
  handle: async () => null,
};

let seq = 0;
async function setup() {
  seq += 1;
  const db = createKnex(cfg(path.join(TMP, `trx-${seq}.sqlite`)));
  databases.push(db);
  await runMigrations(db);
  await db.schema.createTable("o_testReservation", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.string("reservationKey").notNullable();
  });
  const guarded = makeTenantAware(db, {
    getCtx: currentTenant,
    policies: { ...TABLE_POLICIES, o_testReservation: "tenant" },
  });
  const store = createJobStore({ db: guarded as unknown as Knex, registry: createJobRegistry([definition]) });
  return { db, guarded, store };
}

const input = (reservationKey: string) => ({
  type: definition.type,
  userId: 41,
  payload: { reservationKey },
});
const tenantCtx = { userId: 41, role: "user" as const, requestId: "enqueue-trx", source: "http" as const };

describe("transaction-scoped job enqueue", () => {
  it("commits the tenant reservation and job on the same transaction connection", async () => {
    const { db, guarded, store } = await setup();
    let result: { jobId: string; created: boolean } | undefined;

    await runWithTenant(tenantCtx, async () => {
      await guarded.transaction(async (trx: Knex.Transaction) => {
        await trx("o_testReservation").insert({ reservationKey: "commit" });
        result = await store.enqueueInTransaction(trx, input("commit"));
      });
    });

    expect(result).toEqual({ jobId: expect.any(String), created: true });
    expect(await db("o_testReservation").where({ userId: 41 }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
    expect(await db("o_job").where({ dedupeKey: "41:reservation:commit" }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
    await db.destroy();
  });

  it("rolls back the tenant reservation and newly inserted job together", async () => {
    const { db, guarded, store } = await setup();

    await expect(runWithTenant(tenantCtx, async () => {
      await guarded.transaction(async (trx: Knex.Transaction) => {
        await trx("o_testReservation").insert({ reservationKey: "rollback" });
        await store.enqueueInTransaction(trx, input("rollback"));
        throw new Error("abort reservation");
      });
    })).rejects.toThrow("abort reservation");

    expect(await db("o_testReservation").where({ userId: 41 }).count({ n: "*" }).first()).toMatchObject({ n: 0 });
    expect(await db("o_job").where({ dedupeKey: "41:reservation:rollback" }).count({ n: "*" }).first()).toMatchObject({ n: 0 });
    await db.destroy();
  });

  it("returns active-key dedupe before a caller creates a second reservation", async () => {
    const { db, guarded, store } = await setup();

    await runWithTenant(tenantCtx, async () => {
      await guarded.transaction(async (trx: Knex.Transaction) => {
        const first = await store.enqueueInTransaction(trx, input("dedupe"));
        if (first.created) await trx("o_testReservation").insert({ reservationKey: "dedupe" });
      });
      await guarded.transaction(async (trx: Knex.Transaction) => {
        const second = await store.enqueueInTransaction(trx, input("dedupe"));
        expect(second.created).toBe(false);
        expect(second.jobId).toBeTruthy();
        if (second.created) await trx("o_testReservation").insert({ reservationKey: "dedupe" });
      });
    });

    expect(await db("o_job").where({ dedupeKey: "41:reservation:dedupe" }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
    expect(await db("o_testReservation").where({ userId: 41 }).count({ n: "*" }).first()).toMatchObject({ n: 1 });
    await db.destroy();
  });

  it("exports a facade that forwards the supplied transaction", async () => {
    const { db, guarded } = await setup();
    const registry = createJobRegistry([definition]);
    vi.doMock("@/utils", () => ({ default: { db: guarded } }));
    vi.doMock("@/jobs/registry", () => ({ jobRegistry: registry }));

    try {
      const facade = await import("@/jobs/index");
      let result: { jobId: string; created: boolean } | undefined;
      await runWithTenant(tenantCtx, async () => {
        await guarded.transaction(async (trx: Knex.Transaction) => {
          result = await facade.enqueueJobInTransaction(trx, input("facade"));
        });
      });
      expect(result).toEqual({ jobId: expect.any(String), created: true });
      expect(await db("o_job").where({ dedupeKey: "41:reservation:facade" }).first()).toBeTruthy();
    } finally {
      vi.doUnmock("@/utils");
      vi.doUnmock("@/jobs/registry");
      vi.resetModules();
      await db.destroy();
    }
  });

  it("uses the registered system writer boundary for guarded platform writes", async () => {
    const { db, guarded, store } = await setup();

    await expect(runWithTenant(tenantCtx, async () => {
      await guarded("o_job").insert({
        userId: 41, type: definition.type, payload: "{}", state: "queued", attempts: 0,
        maxAttempts: 1, priority: 100, progress: 0, createdAt: 1, updatedAt: 1,
      });
    })).rejects.toThrow(/平台表/);

    await runWithTenant(tenantCtx, async () => {
      await guarded.transaction(async (trx: Knex.Transaction) => {
        await store.enqueueInTransaction(trx, input("writer"));
      });
    });
    expect(await db("o_job").where({ dedupeKey: "41:reservation:writer" }).first()).toBeTruthy();
    await db.destroy();
  });
});
