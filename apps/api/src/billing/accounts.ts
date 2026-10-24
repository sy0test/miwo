import type { Knex } from "knex";

type DbInteger = number | string | bigint;

export interface AccountSnapshot {
  userId: number;
  balanceMicro: bigint;
  frozenMicro: bigint;
  version: number;
  updatedAt: number;
}

function exactInteger(value: DbInteger, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${field} from database is not a safe integer`);
    return BigInt(value);
  }
  if (typeof value === "bigint") return value;
  if (!/^-?\d+$/.test(value)) throw new TypeError(`${field} from database is not an integer`);
  return BigInt(value);
}

function safeNumber(value: DbInteger, field: string): number {
  const result = exactInteger(value, field);
  const number = Number(result);
  if (!Number.isSafeInteger(number) || BigInt(number) !== result) {
    throw new RangeError(`${field} from database is outside the safe integer range`);
  }
  return number;
}

/** Insert the zero-balance account for a user when it does not already exist. */
export async function ensureAccountInTransaction(trx: Knex.Transaction, userId: number): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("userId must be a positive safe integer");
  const existing = await trx("o_account").where({ userId }).first("userId");
  if (existing) return;
  await trx("o_account").insert({
    userId,
    balanceMicro: 0,
    frozenMicro: 0,
    version: 0,
    updatedAt: Date.now(),
  });
}

/** Read only the requested user's account and preserve exact micro-CNY values. */
export async function getAccount(db: Knex, userId: number): Promise<AccountSnapshot> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("userId must be a positive safe integer");
  const row = (await db("o_account").where({ userId }).first(
    "userId", "balanceMicro", "frozenMicro", "version", "updatedAt",
  )) as
    | {
        userId: DbInteger;
        balanceMicro: DbInteger;
        frozenMicro: DbInteger;
        version: DbInteger;
        updatedAt: DbInteger;
      }
    | undefined;
  if (!row) throw new Error(`Account not found for user ${userId}`);

  return {
    userId: safeNumber(row.userId, "o_account.userId"),
    balanceMicro: exactInteger(row.balanceMicro, "o_account.balanceMicro"),
    frozenMicro: exactInteger(row.frozenMicro, "o_account.frozenMicro"),
    version: safeNumber(row.version, "o_account.version"),
    updatedAt: safeNumber(row.updatedAt, "o_account.updatedAt"),
  };
}
