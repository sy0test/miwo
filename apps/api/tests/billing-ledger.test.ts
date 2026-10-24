import knexFactory, { type Knex } from "knex";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAccount } from "@/billing/accounts";
import { releaseInTransaction, reserveInTransaction, settleInTransaction, withLedgerRetry } from "@/billing/ledger";

let db: Knex;

async function createLedgerTables(knex: Knex): Promise<void> {
  await knex.schema.createTable("o_account", (table) => {
    table.bigInteger("userId").primary();
    table.text("balanceMicro").notNullable();
    table.text("frozenMicro").notNullable();
    table.integer("version").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
  await knex.schema.createTable("o_ledger", (table) => {
    table.increments("id").primary();
    table.bigInteger("userId").notNullable();
    table.string("type", 32).notNullable();
    table.text("amountMicro").notNullable();
    table.text("balanceAfter").notNullable();
    table.string("refType", 32).nullable();
    table.string("refId", 128).nullable();
    table.bigInteger("operatorId").nullable();
    table.bigInteger("createdAt").notNullable();
    table.string("idempotencyKey", 128).notNullable();
    table.text("frozenAfterMicro").notNullable();
    table.unique(["userId", "idempotencyKey"]);
  });
}

async function newDb(filename = ":memory:"): Promise<Knex> {
  const knex = knexFactory({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 8 },
  });
  await createLedgerTables(knex);
  return knex;
}

async function seedAccount(knex: Knex, balanceMicro: bigint, frozenMicro = 0n): Promise<void> {
  await knex("o_account").insert({ userId: 7, balanceMicro: balanceMicro.toString(), frozenMicro: frozenMicro.toString(), version: 0, updatedAt: 1 });
}

async function run<T>(knex: Knex, work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return withLedgerRetry(knex, () => knex.transaction(work));
}

beforeEach(async () => {
  db = await newDb();
});

afterEach(async () => db.destroy());

describe("atomic billing ledger operations", () => {
  it("freezes funds without reducing the total balance", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 40n, refType: "job", refId: "job-1", idempotencyKey: "reserve-1",
    }));
    expect(reservation.amountMicro).toBe(40n);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 40n, version: 1 });
    await expect(db("o_ledger").select("type", "amountMicro", "balanceAfter", "frozenAfterMicro")).resolves.toMatchObject([
      { type: "freeze", amountMicro: "40", balanceAfter: "100", frozenAfterMicro: "40" },
    ]);
  });

  it("settles a zero-amount reservation without charging or leaving frozen funds", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 0n, refType: "job", refId: "job-free", idempotencyKey: "reserve-free",
    }));
    const result = await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 0n, idempotencyKey: "settle-free",
    }));
    expect(result).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, debtMicro: 0n });
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, version: 2 });
    await expect(db("o_ledger").where({ userId: 7 }).select("type", "amountMicro").orderBy("id")).resolves.toMatchObject([
      { type: "freeze", amountMicro: "0" },
      { type: "consume", amountMicro: "0" },
    ]);
  });

  it("rejects insufficient available funds without a partial write", async () => {
    await seedAccount(db, 100n, 75n);
    await expect(run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 30n, refType: "job", refId: "job-2", idempotencyKey: "reserve-low",
    }))).rejects.toThrow(/insufficient/i);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 75n, version: 0 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("settles partial usage and releases the unused reservation", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 50n, refType: "job", refId: "job-3", idempotencyKey: "reserve-partial",
    }));
    const result = await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 30n, idempotencyKey: "settle-partial",
    }));
    expect(result.balanceMicro).toBe(70n);
    expect(result.frozenMicro).toBe(0n);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 70n, frozenMicro: 0n, version: 2 });
  });

  it("settles the exact reservation without a remainder", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 50n, refType: "job", refId: "job-4", idempotencyKey: "reserve-exact",
    }));
    const result = await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 50n, idempotencyKey: "settle-exact",
    }));
    expect(result).toMatchObject({ balanceMicro: 50n, frozenMicro: 0n, debtMicro: 0n });
  });

  it("records over-estimate shortfall as an explicit debt adjustment", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 40n, refType: "job", refId: "job-5", idempotencyKey: "reserve-over",
    }));
    const result = await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 60n, idempotencyKey: "settle-over",
    }));
    expect(result).toMatchObject({ balanceMicro: 40n, frozenMicro: 0n, debtMicro: 20n });
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 40n, frozenMicro: 0n, version: 3 });
    await expect(db("o_ledger").where({ userId: 7 }).orderBy("id").select("type", "amountMicro", "balanceAfter")).resolves.toMatchObject([
      { type: "freeze", amountMicro: "40", balanceAfter: "100" },
      { type: "consume", amountMicro: "-40", balanceAfter: "60" },
      { type: "debt_adjustment", amountMicro: "-20", balanceAfter: "40" },
    ]);
  });

  it("releases a cancelled reservation", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 50n, refType: "job", refId: "job-6", idempotencyKey: "reserve-release",
    }));
    await run(db, (trx) => releaseInTransaction(trx, {
      userId: 7, reservationId: reservation.id, reason: "cancelled", idempotencyKey: "release-1",
    }));
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, version: 2 });
    await expect(db("o_ledger").where({ idempotencyKey: "release-1" }).first()).resolves.toMatchObject({ type: "release", amountMicro: "-50", refType: "cancelled" });
  });

  it("returns the original results for duplicate idempotency keys without new mutations", async () => {
    await seedAccount(db, 100n);
    const input = { userId: 7, amountMicro: 20n, refType: "job", refId: "job-7", idempotencyKey: "reserve-idem" };
    const first = await run(db, (trx) => reserveInTransaction(trx, input));
    const duplicate = await run(db, (trx) => reserveInTransaction(trx, input));
    expect(duplicate).toEqual(first);
    const settlement = { userId: 7, reservationId: first.id, actualMicro: 15n, idempotencyKey: "settle-idem" };
    const settled = await run(db, (trx) => settleInTransaction(trx, settlement));
    await expect(run(db, (trx) => settleInTransaction(trx, settlement))).resolves.toEqual(settled);
    const second = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 10n, refType: "job", refId: "job-7b", idempotencyKey: "reserve-idem-2",
    }));
    await run(db, (trx) => releaseInTransaction(trx, {
      userId: 7, reservationId: second.id, reason: "cancelled", idempotencyKey: "release-idem",
    }));
    await expect(run(db, (trx) => releaseInTransaction(trx, {
      userId: 7, reservationId: second.id, reason: "cancelled", idempotencyKey: "release-idem",
    }))).resolves.toBeUndefined();
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 85n, frozenMicro: 0n, version: 4 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 4 });
  });

  it("rejects an account version increment beyond the MySQL INT UNSIGNED range", async () => {
    await db("o_account").insert({ userId: 7, balanceMicro: "100", frozenMicro: "0", version: 4_294_967_295, updatedAt: 1 });
    await expect(run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 10n, refType: "job", refId: "version-limit", idempotencyKey: "reserve-version-limit",
    }))).rejects.toThrow(/version/i);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, version: 4_294_967_295 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("rejects settlement replay when actual usage differs", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 40n, refType: "job", refId: "settlement-replay", idempotencyKey: "reserve-settlement-replay",
    }));
    await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 25n, idempotencyKey: "settle-replay-mismatch",
    }));

    await expect(run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 30n, idempotencyKey: "settle-replay-mismatch",
    }))).rejects.toThrow(/idempotency key.*different settlement input/i);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 75n, frozenMicro: 0n, version: 2 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 2 });
  });

  it("keeps internal debt keys disjoint from caller keys", async () => {
    await seedAccount(db, 100n);
    const reservation = await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 20n, refType: "job", refId: "debt-key", idempotencyKey: "reserve-debt-key",
    }));
    await run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 1n, refType: "job", refId: "debt-key-caller", idempotencyKey: "settle-key:debt",
    }));

    const result = await run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 30n, idempotencyKey: "settle-key",
    }));
    expect(result).toMatchObject({ balanceMicro: 70n, frozenMicro: 1n, debtMicro: 10n });
    await expect(run(db, (trx) => settleInTransaction(trx, {
      userId: 7, reservationId: reservation.id, actualMicro: 30n, idempotencyKey: "settle-key",
    }))).resolves.toEqual(result);
    await expect(db("o_ledger").where({ idempotencyKey: "~debt~:settle-key" }).first()).resolves.toMatchObject({ type: "debt_adjustment", refId: reservation.id });
    await expect(run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 1n, refType: "job", refId: "internal-key", idempotencyKey: "~debt~:settle-key",
    }))).rejects.toThrow(/reserved/i);
  });

  it("rolls back the account update if immutable ledger insertion fails", async () => {
    await seedAccount(db, 100n);
    await db.raw("CREATE TRIGGER reject_ledger BEFORE INSERT ON o_ledger BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END");
    await db.transaction(async (trx) => {
      await expect(reserveInTransaction(trx, {
        userId: 7, amountMicro: 25n, refType: "job", refId: "job-8", idempotencyKey: "reserve-rollback",
      })).rejects.toThrow("injected ledger failure");
    });
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, version: 0 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("rejects negative reservation amounts", async () => {
    await seedAccount(db, 100n);
    await expect(run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: -1n, refType: "job", refId: "job-negative", idempotencyKey: "reserve-negative",
    }))).rejects.toThrow(/must not be negative/i);
    expect(await getAccount(db, 7)).toMatchObject({ balanceMicro: 100n, frozenMicro: 0n, version: 0 });
    await expect(db("o_ledger").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("rejects currency inputs that are not non-negative bigint values", async () => {
    await seedAccount(db, 100n);
    await expect(run(db, (trx) => reserveInTransaction(trx, {
      userId: 7, amountMicro: 10 as unknown as bigint, refType: "job", refId: "job-9", idempotencyKey: "reserve-number",
    }))).rejects.toThrow(/bigint/);
  });

  it("retries only recognized SQLite busy and MySQL deadlock errors", async () => {
    let sqliteAttempts = 0;
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    await expect(withLedgerRetry(db, async () => {
      sqliteAttempts += 1;
      if (sqliteAttempts < 3) throw busy;
      return "done";
    })).resolves.toBe("done");
    expect(sqliteAttempts).toBe(3);

    let deadlockAttempts = 0;
    const deadlock = Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    await expect(withLedgerRetry(db, async () => {
      deadlockAttempts += 1;
      if (deadlockAttempts < 2) throw deadlock;
      return "done";
    })).resolves.toBe("done");
    expect(deadlockAttempts).toBe(2);

    let otherAttempts = 0;
    await expect(withLedgerRetry(db, async () => {
      otherAttempts += 1;
      throw new Error("validation failure");
    })).rejects.toThrow("validation failure");
    expect(otherAttempts).toBe(1);
  });
});

describe("SQLite reservation contention", () => {
  it("limits 100 contenders to available funds and reconciles immutable ledger rows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miwo-ledger-"));
    const filename = path.join(directory, "ledger.sqlite");
    const fileDb = await newDb(filename);
    try {
      await seedAccount(fileDb, 1000n);
      const outcomes = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => run(fileDb, (trx) => reserveInTransaction(trx, {
        userId: 7,
        amountMicro: 15n,
        refType: "job",
        refId: `contender-${index}`,
        idempotencyKey: `contender-${index}`,
      }))));
      const successful = outcomes.filter((result) => result.status === "fulfilled");
      const failed = outcomes.filter((result) => result.status === "rejected");
      expect(successful).toHaveLength(66);
      expect(failed).toHaveLength(34);
      expect(failed.every((result) => result.status === "rejected" && /insufficient available balance/i.test(String(result.reason)))).toBe(true);
      const account = await getAccount(fileDb, 7);
      expect(account.frozenMicro).toBe(BigInt(successful.length) * 15n);
      expect(account.balanceMicro).toBe(1000n);
      expect(account.frozenMicro).toBeLessThanOrEqual(account.balanceMicro);
      const rows = await fileDb("o_ledger").where({ userId: 7 }).orderBy("id").select("amountMicro", "frozenAfterMicro");
      expect(rows).toHaveLength(successful.length);
      expect(rows.every((row) => row.amountMicro === "15")).toBe(true);
      expect(BigInt(rows[rows.length - 1].frozenAfterMicro)).toBe(account.frozenMicro);
      expect(account.version).toBe(successful.length);
    } finally {
      await fileDb.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
