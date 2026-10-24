import { setTimeout as delay } from "node:timers/promises";
import type { Knex } from "knex";

type DbInteger = number | string | bigint;
type LedgerRow = {
  id: DbInteger;
  userId: DbInteger;
  type: string;
  amountMicro: DbInteger;
  balanceAfter: DbInteger;
  refType: string | null;
  refId: string | null;
  createdAt: DbInteger;
  idempotencyKey: string;
  frozenAfterMicro: DbInteger;
};

export interface Reservation {
  id: string;
  userId: number;
  amountMicro: bigint;
}

export interface Settlement {
  balanceMicro: bigint;
  frozenMicro: bigint;
  debtMicro: bigint;
}

export interface ReserveInput {
  userId: number;
  amountMicro: bigint;
  refType: string;
  refId: string;
  idempotencyKey: string;
}

export interface SettleInput {
  userId: number;
  reservationId: string;
  actualMicro: bigint;
  idempotencyKey: string;
}

export interface ReleaseInput {
  userId: number;
  reservationId: string;
  reason: string;
  idempotencyKey: string;
}

export interface CreditInput {
  userId: number;
  amountMicro: bigint;
  orderId: string;
  operatorId: number;
  idempotencyKey: string;
}

const MAX_I64 = 9_223_372_036_854_775_807n;
const MIN_I64 = -9_223_372_036_854_775_808n;
const MAX_ACCOUNT_VERSION = 4_294_967_295;
const INTERNAL_DEBT_KEY_PREFIX = "~debt~:";
const MAX_RETRY_ATTEMPTS = 20;
const RETRY_DELAY_MS = 10;

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

function checkedI64(value: bigint, field: string): bigint {
  if (value < MIN_I64 || value > MAX_I64) throw new RangeError(`${field} exceeds the signed 64-bit database range`);
  return value;
}

function validateInput(userId: number, amount: bigint, idempotencyKey: string, action: string): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("userId must be a positive safe integer");
  if (typeof amount !== "bigint") throw new TypeError(`${action} amountMicro must be a bigint`);
  if (amount < 0n) throw new RangeError(`${action} amountMicro must not be negative`);
  checkedI64(amount, `${action} amountMicro`);
  if (!idempotencyKey || idempotencyKey.length > 120) throw new TypeError("idempotencyKey must contain 1 to 120 characters");
  if (idempotencyKey.startsWith(INTERNAL_DEBT_KEY_PREFIX)) throw new TypeError("idempotencyKey uses a reserved internal prefix");
}

function now(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value)) throw new RangeError("current timestamp is outside the safe integer range");
  return value;
}

function isTransientLedgerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
  const code = String(candidate.code ?? "");
  const errno = Number(candidate.errno);
  if (["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", "ER_LOCK_DEADLOCK"].includes(code) || errno === 1213) return true;
  if (typeof candidate.message === "string" && /database is locked|database table is locked/i.test(candidate.message)) return true;
  return candidate.cause !== undefined && isTransientLedgerError(candidate.cause);
}

/** Retry the whole caller-owned transaction; a failed SQLite snapshot cannot be reused. */
export async function withLedgerRetry<T>(db: Knex, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientLedgerError(error) || attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
}

async function ledgerByKey(trx: Knex.Transaction, userId: number, idempotencyKey: string): Promise<LedgerRow | undefined> {
  return await trx("o_ledger").where({ userId, idempotencyKey }).first(
    "id", "userId", "type", "amountMicro", "balanceAfter", "refType", "refId", "createdAt", "idempotencyKey", "frozenAfterMicro",
  ) as LedgerRow | undefined;
}

function reservationFrom(row: LedgerRow): Reservation {
  if (row.type !== "freeze") throw new Error("idempotency key is already used by a non-reservation ledger entry");
  return {
    id: row.idempotencyKey,
    userId: safeNumber(row.userId, "o_ledger.userId"),
    amountMicro: exactInteger(row.amountMicro, "o_ledger.amountMicro"),
  };
}

async function insertLedger(
  trx: Knex.Transaction,
  input: {
    userId: number;
    type: string;
    amountMicro: bigint;
    balanceAfter: bigint;
    frozenAfterMicro: bigint;
    refType?: string | null;
    refId?: string | null;
    operatorId?: number | null;
    idempotencyKey: string;
  },
): Promise<void> {
  await trx("o_ledger").insert({
    userId: input.userId,
    type: input.type,
    amountMicro: input.amountMicro.toString(10),
    balanceAfter: input.balanceAfter.toString(10),
    frozenAfterMicro: input.frozenAfterMicro.toString(10),
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    operatorId: input.operatorId ?? null,
    createdAt: now(),
    idempotencyKey: input.idempotencyKey,
  });
}

async function updateAccount(
  trx: Knex.Transaction,
  userId: number,
  expectedVersion: number,
  balanceMicro: bigint,
  frozenMicro: bigint,
): Promise<number> {
  checkedI64(balanceMicro, "o_account.balanceMicro");
  checkedI64(frozenMicro, "o_account.frozenMicro");
  if (frozenMicro < 0n) throw new RangeError("o_account.frozenMicro cannot be negative");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= MAX_ACCOUNT_VERSION) {
    throw new RangeError("o_account.version is outside the unsigned 32-bit range");
  }
  const affected = await trx("o_account").where({ userId, version: expectedVersion }).update({
    balanceMicro: balanceMicro.toString(10),
    frozenMicro: frozenMicro.toString(10),
    version: expectedVersion + 1,
    updatedAt: now(),
  });
  if (Number(affected) !== 1) throw new Error("Account version conflict");
  return expectedVersion + 1;
}

async function accountForUpdate(trx: Knex.Transaction, userId: number): Promise<{
  balanceMicro: bigint;
  frozenMicro: bigint;
  version: number;
}> {
  const row = await trx("o_account").where({ userId }).first("balanceMicro", "frozenMicro", "version") as
    | { balanceMicro: DbInteger; frozenMicro: DbInteger; version: DbInteger }
    | undefined;
  if (!row) throw new Error(`Account not found for user ${userId}`);
  const balanceMicro = exactInteger(row.balanceMicro, "o_account.balanceMicro");
  const frozenMicro = exactInteger(row.frozenMicro, "o_account.frozenMicro");
  const version = safeNumber(row.version, "o_account.version");
  if (frozenMicro < 0n) throw new Error("Account frozen balance invariant is invalid");
  return { balanceMicro, frozenMicro, version };
}

async function findReservation(trx: Knex.Transaction, userId: number, reservationId: string): Promise<Reservation> {
  const row = await ledgerByKey(trx, userId, reservationId);
  if (!row) throw new Error("Reservation not found");
  const reservation = reservationFrom(row);
  const terminal = await trx("o_ledger").where({ userId, refId: reservationId }).whereIn("type", ["consume", "debt_adjustment", "release"]).first("id");
  if (terminal) throw new Error("Reservation is already settled or released");
  return reservation;
}

async function reserveOperation(trx: Knex.Transaction, input: ReserveInput): Promise<Reservation> {
  validateInput(input.userId, input.amountMicro, input.idempotencyKey, "reserve");
  if (!input.refType || input.refType.length > 32 || !input.refId || input.refId.length > 128) {
    throw new TypeError("reservation refType/refId is invalid");
  }
  const prior = await ledgerByKey(trx, input.userId, input.idempotencyKey);
  if (prior) {
    const result = reservationFrom(prior);
    if (result.amountMicro !== input.amountMicro || prior.refType !== input.refType || prior.refId !== input.refId) {
      throw new Error("idempotency key was reused with different reservation input");
    }
    return result;
  }

  const account = await accountForUpdate(trx, input.userId);
  if (account.balanceMicro - account.frozenMicro < input.amountMicro) throw new Error("Insufficient available balance");
  const frozenAfter = checkedI64(account.frozenMicro + input.amountMicro, "o_account.frozenMicro");
  await updateAccount(trx, input.userId, account.version, account.balanceMicro, frozenAfter);
  await insertLedger(trx, {
    userId: input.userId,
    type: "freeze",
    amountMicro: input.amountMicro,
    balanceAfter: account.balanceMicro,
    frozenAfterMicro: frozenAfter,
    refType: input.refType,
    refId: input.refId,
    idempotencyKey: input.idempotencyKey,
  });
  return { id: input.idempotencyKey, userId: input.userId, amountMicro: input.amountMicro };
}

export async function reserveInTransaction(trx: Knex.Transaction, input: ReserveInput): Promise<Reservation> {
  return trx.transaction((operationTrx) => reserveOperation(operationTrx, input));
}

async function creditOperation(trx: Knex.Transaction, input: CreditInput): Promise<Settlement> {
  validateInput(input.userId, input.amountMicro, input.idempotencyKey, "credit");
  if (input.amountMicro === 0n) throw new RangeError("credit amountMicro must be greater than zero");
  if (!input.orderId || input.orderId.length > 128) throw new TypeError("orderId is invalid");
  if (!Number.isSafeInteger(input.operatorId) || input.operatorId <= 0) throw new TypeError("operatorId must be a positive safe integer");

  const prior = await ledgerByKey(trx, input.userId, input.idempotencyKey);
  if (prior) {
    if (prior.type !== "recharge" || prior.refType !== "recharge" || prior.refId !== input.orderId
      || exactInteger(prior.amountMicro, "o_ledger.amountMicro") !== input.amountMicro) {
      throw new Error("idempotency key was reused with different credit input");
    }
    return { balanceMicro: exactInteger(prior.balanceAfter, "o_ledger.balanceAfter"), frozenMicro: exactInteger(prior.frozenAfterMicro, "o_ledger.frozenAfterMicro"), debtMicro: 0n };
  }

  const account = await accountForUpdate(trx, input.userId);
  const balanceAfter = checkedI64(account.balanceMicro + input.amountMicro, "o_account.balanceMicro");
  await updateAccount(trx, input.userId, account.version, balanceAfter, account.frozenMicro);
  await insertLedger(trx, {
    userId: input.userId,
    type: "recharge",
    amountMicro: input.amountMicro,
    balanceAfter,
    frozenAfterMicro: account.frozenMicro,
    refType: "recharge",
    refId: input.orderId,
    operatorId: input.operatorId,
    idempotencyKey: input.idempotencyKey,
  });
  return { balanceMicro: balanceAfter, frozenMicro: account.frozenMicro, debtMicro: 0n };
}

export async function creditInTransaction(trx: Knex.Transaction, input: CreditInput): Promise<Settlement> {
  return creditOperation(trx, input);
}

async function priorSettlement(
  trx: Knex.Transaction,
  userId: number,
  idempotencyKey: string,
  reservationId: string,
  actualMicro: bigint,
): Promise<Settlement | undefined> {
  const prior = await ledgerByKey(trx, userId, idempotencyKey);
  if (!prior) return undefined;
  if (prior.type !== "consume" || prior.refId !== reservationId) throw new Error("idempotency key is already used by a different ledger operation");

  const consumed = exactInteger(prior.amountMicro, "o_ledger.amountMicro");
  if (consumed > 0n) throw new Error("Existing settlement ledger amount is invalid");
  const debt = await ledgerByKey(trx, userId, `${INTERNAL_DEBT_KEY_PREFIX}${idempotencyKey}`);
  if (debt && (debt.type !== "debt_adjustment" || debt.refId !== reservationId || debt.refType !== "reservation")) {
    throw new Error("Existing settlement debt ledger entry is invalid");
  }
  const debtMicro = debt ? -exactInteger(debt.amountMicro, "o_ledger.amountMicro") : 0n;
  if (debtMicro < 0n || -consumed + debtMicro !== actualMicro) {
    throw new Error("idempotency key was reused with different settlement input");
  }
  const balanceMicro = debt ? exactInteger(debt.balanceAfter, "o_ledger.balanceAfter") : exactInteger(prior.balanceAfter, "o_ledger.balanceAfter");
  const frozenMicro = debt ? exactInteger(debt.frozenAfterMicro, "o_ledger.frozenAfterMicro") : exactInteger(prior.frozenAfterMicro, "o_ledger.frozenAfterMicro");
  return { balanceMicro, frozenMicro, debtMicro };
}

async function settleOperation(trx: Knex.Transaction, input: SettleInput): Promise<Settlement> {
  validateInput(input.userId, input.actualMicro, input.idempotencyKey, "settle");
  if (input.idempotencyKey.length > 115) throw new TypeError("settlement idempotencyKey is too long for a debt adjustment key");
  if (!input.reservationId) throw new TypeError("reservationId is required");
  const prior = await priorSettlement(trx, input.userId, input.idempotencyKey, input.reservationId, input.actualMicro);
  if (prior) return prior;
  const reservation = await findReservation(trx, input.userId, input.reservationId);
  const account = await accountForUpdate(trx, input.userId);
  if (account.frozenMicro < reservation.amountMicro) throw new Error("Frozen balance is less than the reservation");

  const covered = input.actualMicro < reservation.amountMicro ? input.actualMicro : reservation.amountMicro;
  const shortfall = input.actualMicro - covered;
  const balanceAfterConsume = checkedI64(account.balanceMicro - covered, "o_account.balanceMicro");
  const frozenAfter = account.frozenMicro - reservation.amountMicro;
  await updateAccount(trx, input.userId, account.version, balanceAfterConsume, frozenAfter);
  await insertLedger(trx, {
    userId: input.userId,
    type: "consume",
    amountMicro: -covered,
    balanceAfter: balanceAfterConsume,
    frozenAfterMicro: frozenAfter,
    refType: "reservation",
    refId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
  });

  if (shortfall === 0n) return { balanceMicro: balanceAfterConsume, frozenMicro: frozenAfter, debtMicro: 0n };
  const debtBalance = checkedI64(balanceAfterConsume - shortfall, "o_account.balanceMicro");
  await updateAccount(trx, input.userId, account.version + 1, debtBalance, frozenAfter);
  await insertLedger(trx, {
    userId: input.userId,
    type: "debt_adjustment",
    amountMicro: -shortfall,
    balanceAfter: debtBalance,
    frozenAfterMicro: frozenAfter,
    refType: "reservation",
    refId: input.reservationId,
    idempotencyKey: `${INTERNAL_DEBT_KEY_PREFIX}${input.idempotencyKey}`,
  });
  return { balanceMicro: debtBalance, frozenMicro: frozenAfter, debtMicro: shortfall };
}

export async function settleInTransaction(trx: Knex.Transaction, input: SettleInput): Promise<Settlement> {
  return trx.transaction((operationTrx) => settleOperation(operationTrx, input));
}

async function releaseOperation(trx: Knex.Transaction, input: ReleaseInput): Promise<void> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) throw new TypeError("userId must be a positive safe integer");
  if (!input.reservationId || !input.reason || input.reason.length > 32) throw new TypeError("reservationId/reason is invalid");
  if (!input.idempotencyKey || input.idempotencyKey.length > 120) throw new TypeError("idempotencyKey must contain 1 to 120 characters");
  if (input.idempotencyKey.startsWith(INTERNAL_DEBT_KEY_PREFIX)) throw new TypeError("idempotencyKey uses a reserved internal prefix");
  const prior = await ledgerByKey(trx, input.userId, input.idempotencyKey);
  if (prior) {
    if (prior.type !== "release" || prior.refId !== input.reservationId || prior.refType !== input.reason) {
      throw new Error("idempotency key was reused with different release input");
    }
    return;
  }
  const reservation = await findReservation(trx, input.userId, input.reservationId);
  const account = await accountForUpdate(trx, input.userId);
  if (account.frozenMicro < reservation.amountMicro) throw new Error("Frozen balance is less than the reservation");
  const frozenAfter = account.frozenMicro - reservation.amountMicro;
  await updateAccount(trx, input.userId, account.version, account.balanceMicro, frozenAfter);
  await insertLedger(trx, {
    userId: input.userId,
    type: "release",
    amountMicro: -reservation.amountMicro,
    balanceAfter: account.balanceMicro,
    frozenAfterMicro: frozenAfter,
    refType: input.reason,
    refId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function releaseInTransaction(trx: Knex.Transaction, input: ReleaseInput): Promise<void> {
  return trx.transaction((operationTrx) => releaseOperation(operationTrx, input));
}

/** Resolve the reservation key from the unique job freeze ledger row, never from the job id. */
export async function reservationIdForJobInTransaction(
  trx: Knex.Transaction,
  input: { userId: number; jobId: string },
): Promise<string> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !input.jobId) {
    throw new TypeError("userId and jobId are required to resolve a job reservation");
  }
  const rows = (await trx("o_ledger")
    .select("idempotencyKey")
    .where({ userId: input.userId, type: "freeze", refType: "job", refId: input.jobId })) as Array<{ idempotencyKey: string }>;
  if (rows.length !== 1) throw new Error(`Expected exactly one job freeze row, found ${rows.length}`);
  return rows[0].idempotencyKey;
}
