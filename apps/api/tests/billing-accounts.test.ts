import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAccountInTransaction, getAccount } from "@/billing/accounts";

let db: Knex;

beforeEach(async () => {
  db = knexFactory({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_account", (table) => {
    table.bigInteger("userId").primary();
    table.text("balanceMicro").notNullable();
    table.text("frozenMicro").notNullable();
    table.integer("version").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
});

afterEach(async () => db.destroy());

describe("user-scoped account reads", () => {
  it("returns exact bigint balances for only the requested user", async () => {
    await db("o_account").insert([
      { userId: 7, balanceMicro: "9007199254740993", frozenMicro: "12345678901234567890", version: 4, updatedAt: 123 },
      { userId: 8, balanceMicro: 999, frozenMicro: 0, version: 1, updatedAt: 456 },
    ]);

    await expect(getAccount(db, 7)).resolves.toMatchObject({
      userId: 7,
      balanceMicro: 9007199254740993n,
      frozenMicro: 12345678901234567890n,
      version: 4,
      updatedAt: 123,
    });
  });

  it("fails closed when the requested account does not exist", async () => {
    await db("o_account").insert({ userId: 8, balanceMicro: 100, frozenMicro: 0, version: 1, updatedAt: 456 });
    await expect(getAccount(db, 7)).rejects.toThrow();
  });

  it("creates a missing account with zeroed balance, frozen amount, version, and timestamp", async () => {
    await db.transaction(async (trx) => ensureAccountInTransaction(trx, 7));

    const account = await db("o_account").where({ userId: 7 }).first();
    expect(account).toMatchObject({ userId: 7, version: 0 });
    expect(Number(account.balanceMicro)).toBe(0);
    expect(Number(account.frozenMicro)).toBe(0);
    expect(Number(account.updatedAt)).toBeGreaterThan(0);
  });

  it("leaves an existing nonzero account unchanged", async () => {
    const original = { userId: 7, balanceMicro: 900, frozenMicro: 120, version: 4, updatedAt: 123 };
    await db("o_account").insert(original);

    await db.transaction(async (trx) => ensureAccountInTransaction(trx, 7));

    const unchanged = await db("o_account").where({ userId: 7 }).first();
    expect(unchanged.userId).toBe(original.userId);
    expect(Number(unchanged.balanceMicro)).toBe(original.balanceMicro);
    expect(Number(unchanged.frozenMicro)).toBe(original.frozenMicro);
    expect(unchanged.version).toBe(original.version);
    expect(unchanged.updatedAt).toBe(original.updatedAt);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid user id %s", async (userId) => {
    await expect(db.transaction(async (trx) => ensureAccountInTransaction(trx, userId))).rejects.toThrow(/userId/);
  });

  it("rejects unsafe numeric database values instead of converting them to bigint", async () => {
    const unsafeDb = ((table: string) => ({
      where: (condition: { userId: number }) => ({
        first: async () => condition.userId === 7 ? {
          userId: 7,
          balanceMicro: Number.MAX_SAFE_INTEGER + 1,
          frozenMicro: 0,
          version: 1,
          updatedAt: 123,
        } : undefined,
      }),
    })) as unknown as Knex;
    await expect(getAccount(unsafeDb, 7)).rejects.toThrow(/safe integer/);
  });
});
