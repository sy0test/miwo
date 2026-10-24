import type { Knex } from "knex";

export interface ReconcileBillingOptions {
  from: number;
  to: number;
  dryRun: boolean;
}

type DbInteger = bigint | number | string;
type RawRow = Record<string, unknown>;

export type BillingDrift =
  | {
      type: "account-ledger";
      userId: string;
      balanceMicro: string;
      ledgerBalanceMicro: string;
      frozenMicro: string;
      ledgerFrozenMicro: string;
    }
  | { type: "missing-account"; userId: string; ledgerBalanceMicro: string; ledgerFrozenMicro: string }
  | {
      type: "job-reservation";
      userId: string;
      jobId: string;
      jobState: string;
      reservationId: string;
      terminalState: string;
      reason: string;
    }
  | { type: "duplicate-usage-key"; userId: string; providerCallId: string; count: number }
  | { type: "missing-usage-key"; userId: string; usageId: string; missingFields: string[] }
  | { type: "unresolved-provider"; userId: string; usageId: string | null; providerCallId: string; source?: "admission" }
  | {
      type: "order-credit";
      userId: string;
      orderId: string;
      status: string;
      amountMicro: string;
      creditAmountMicro: string | null;
      reason: string;
    };

export interface BillingReconciliationReport {
  from: number;
  to: number;
  dryRun: boolean;
  stateSemantics: "current-at-execution";
  drifts: BillingDrift[];
}

function exactInteger(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${field} from database is not a safe integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${field} from database is not an integer`);
}

function safeTimestamp(value: unknown, field: string): number {
  const integer = exactInteger(value, field);
  const number = Number(integer);
  if (!Number.isSafeInteger(number) || BigInt(number) !== integer) {
    throw new RangeError(`${field} from database is outside the safe integer range`);
  }
  return number;
}

function dbInteger(db: Knex, column: string, alias: string): Knex.Raw {
  // Casting integer columns to text preserves full BIGINT values in SQLite and MySQL drivers.
  return db.raw("CAST(?? AS CHAR) AS ??", [column, alias]);
}

function cmpIntegerText(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function cmpOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateOptions(options: ReconcileBillingOptions): void {
  if (!options || !Number.isSafeInteger(options.from) || !Number.isSafeInteger(options.to)) {
    throw new TypeError("from and to must be safe integer millisecond timestamps");
  }
  if (options.from < 0 || options.to < options.from) throw new RangeError("reconciliation range is invalid");
  if (typeof options.dryRun !== "boolean") throw new TypeError("dryRun must be a boolean");
}

/** Read-only billing consistency report. No mode of this function performs writes. */
export async function reconcileBilling(db: Knex, options: ReconcileBillingOptions): Promise<BillingReconciliationReport> {
  validateOptions(options);
  const { from, to } = options;
  // The interval chooses immutable event anchors; these mutable rows are current at execution.
  const accounts = await db("o_account").select(
    dbInteger(db, "userId", "userId"),
    dbInteger(db, "balanceMicro", "balanceMicro"),
    dbInteger(db, "frozenMicro", "frozenMicro"),
  ) as RawRow[];
  const accountByUser = new Map<string, RawRow>();
  for (const row of accounts) {
    const userId = exactInteger(row.userId, "o_account.userId").toString();
    accountByUser.set(userId, row);
  }

  const ledgerRows = await db("o_ledger")
    .orderBy([{ column: "userId", order: "asc" }, { column: "createdAt", order: "asc" }, { column: "id", order: "asc" }])
    .select(
      dbInteger(db, "id", "id"), dbInteger(db, "userId", "userId"), "type", "refType", "refId", "idempotencyKey",
      dbInteger(db, "amountMicro", "amountMicro"), dbInteger(db, "balanceAfter", "balanceAfter"),
      dbInteger(db, "frozenAfterMicro", "frozenAfterMicro"), dbInteger(db, "createdAt", "createdAt"),
    ) as RawRow[];

  const lastLedgerByUser = new Map<string, RawRow>();
  const rangedLedger: RawRow[] = [];
  for (const row of ledgerRows) {
    const userId = exactInteger(row.userId, "o_ledger.userId").toString();
    const createdAt = safeTimestamp(row.createdAt, "o_ledger.createdAt");
    lastLedgerByUser.set(userId, row);
    if (createdAt >= from && createdAt < to) rangedLedger.push(row);
  }

  const drifts: BillingDrift[] = [];
  const usersWithLedgerAnchors = new Set(rangedLedger.map((row) => exactInteger(row.userId, "o_ledger.userId").toString()));
  for (const [userId, account] of accountByUser) {
    if (!usersWithLedgerAnchors.has(userId)) continue;
    const latest = lastLedgerByUser.get(userId);
    const balance = exactInteger(account.balanceMicro, "o_account.balanceMicro");
    const frozen = exactInteger(account.frozenMicro, "o_account.frozenMicro");
    const ledgerBalance = latest ? exactInteger(latest.balanceAfter, "o_ledger.balanceAfter") : 0n;
    const ledgerFrozen = latest ? exactInteger(latest.frozenAfterMicro, "o_ledger.frozenAfterMicro") : 0n;
    if (balance !== ledgerBalance || frozen !== ledgerFrozen) {
      drifts.push({
        type: "account-ledger", userId, balanceMicro: balance.toString(), ledgerBalanceMicro: ledgerBalance.toString(),
        frozenMicro: frozen.toString(), ledgerFrozenMicro: ledgerFrozen.toString(),
      });
    }
  }
  for (const userId of usersWithLedgerAnchors) {
    if (accountByUser.has(userId)) continue;
    const latest = lastLedgerByUser.get(userId);
    drifts.push({
      type: "missing-account", userId,
      ledgerBalanceMicro: latest ? exactInteger(latest.balanceAfter, "o_ledger.balanceAfter").toString() : "0",
      ledgerFrozenMicro: latest ? exactInteger(latest.frozenAfterMicro, "o_ledger.frozenAfterMicro").toString() : "0",
    });
  }

  const freezes = ledgerRows.filter((row) => row.type === "freeze" && row.refType === "job" && typeof row.refId === "string");
  const terminals = ledgerRows.filter((row) => ["consume", "debt_adjustment", "release"].includes(String(row.type)) && typeof row.refId === "string");
  const terminalsByReservation = new Map<string, RawRow[]>();
  for (const row of terminals) {
    const userId = exactInteger(row.userId, "o_ledger.userId").toString();
    const key = `${userId}:${String(row.refId)}`;
    const candidates = terminalsByReservation.get(key) ?? [];
    candidates.push(row);
    terminalsByReservation.set(key, candidates);
  }
  const relevantFreezes = freezes.filter((freeze) => {
    const freezeAt = safeTimestamp(freeze.createdAt, "o_ledger.createdAt");
    const userId = exactInteger(freeze.userId, "o_ledger.userId").toString();
    const reservationId = String(freeze.idempotencyKey);
    const matchingTerminals = terminalsByReservation.get(`${userId}:${reservationId}`) ?? [];
    return (freezeAt >= from && freezeAt < to) || matchingTerminals.some((terminal) => {
      const terminalAt = safeTimestamp(terminal.createdAt, "o_ledger.createdAt");
      return terminalAt >= from && terminalAt < to;
    });
  });
  const jobUserIds = [...new Set(relevantFreezes.map((row) => exactInteger(row.userId, "o_ledger.userId").toString()))];
  const jobIds = [...new Set(relevantFreezes.map((row) => String(row.refId)))];
  const jobs = jobIds.length && jobUserIds.length
    ? await db("o_job").whereIn("userId", jobUserIds).whereIn("id", jobIds)
      .select(dbInteger(db, "id", "id"), dbInteger(db, "userId", "userId"), "state") as RawRow[]
    : [];
  const jobByKey = new Map(jobs.map((row) => [`${exactInteger(row.userId, "o_job.userId")}:${exactInteger(row.id, "o_job.id")}`, row]));
  for (const reservation of relevantFreezes) {
    const userId = exactInteger(reservation.userId, "o_ledger.userId").toString();
    const jobId = String(reservation.refId);
    const job = jobByKey.get(`${userId}:${jobId}`);
    const reservationId = String(reservation.idempotencyKey);
    const candidates = terminalsByReservation.get(`${userId}:${reservationId}`) ?? [];
    const state = String(job?.state ?? "missing");
    const consumeCandidate = candidates.find((candidate) => candidate.type === "consume");
    const debtCandidate = candidates.find((candidate) => candidate.type === "debt_adjustment");
    const validOverrunPair = candidates.length === 2 && !!consumeCandidate && !!debtCandidate
      && candidates.every((candidate) => candidate.refType === "reservation" && candidate.refId === reservationId)
      && exactInteger(consumeCandidate.amountMicro, "o_ledger.amountMicro") < 0n
      && exactInteger(debtCandidate.amountMicro, "o_ledger.amountMicro") < 0n
      && exactInteger(reservation.amountMicro, "o_ledger.amountMicro") < 0n
      && exactInteger(consumeCandidate.amountMicro, "o_ledger.amountMicro") === exactInteger(reservation.amountMicro, "o_ledger.amountMicro")
      && debtCandidate.idempotencyKey === `~debt~:${String(consumeCandidate.idempotencyKey)}`;
    const hasInvalidReference = candidates.some((candidate) => {
      if (candidate.type === "consume" || candidate.type === "debt_adjustment") return candidate.refType !== "reservation";
      return typeof candidate.refType !== "string" || candidate.refType.length === 0;
    });
    const terminalState = validOverrunPair ? "consume" : candidates.length > 1 ? "multiple"
      : hasInvalidReference ? "invalid" : String(candidates[0]?.type ?? "none");
    const expectsConsume = state === "succeeded";
    const expectsRelease = ["failed", "dead", "canceled"].includes(state);
    const settled = ["consume", "debt_adjustment"].includes(terminalState);
    const reason = candidates.length > 1 && !validOverrunPair ? "multiple-terminal-events"
      : hasInvalidReference ? "invalid-terminal-reference"
        : !job ? "job-missing" : expectsConsume ? "success-without-settlement"
          : expectsRelease ? "failure-without-release" : "active-job-already-terminal";
    const mismatch = (candidates.length > 1 && !validOverrunPair) || hasInvalidReference || !job
      || (expectsConsume && !settled) || (expectsRelease && terminalState !== "release")
      || (!expectsConsume && !expectsRelease && terminalState !== "none");
    if (mismatch) {
      drifts.push({ type: "job-reservation", userId, jobId, jobState: state, reservationId, terminalState, reason });
    }
  }

  const usageRows = await db("o_usage")
    .where("createdAt", ">=", from).andWhere("createdAt", "<", to)
    .orderBy([{ column: "userId", order: "asc" }, { column: "id", order: "asc" }])
    .select(
      dbInteger(db, "id", "id"), dbInteger(db, "userId", "userId"), "requestId", "providerCallId", "usageStatus",
    ) as RawRow[];
  const usageGroups = new Map<string, RawRow[]>();
  for (const row of usageRows) {
    const userId = exactInteger(row.userId, "o_usage.userId").toString();
    const id = exactInteger(row.id, "o_usage.id").toString();
    const providerCallId = typeof row.providerCallId === "string" ? row.providerCallId : "";
    if (!providerCallId || typeof row.requestId !== "string" || row.requestId.length === 0) {
      const missingFields = [
        ...(providerCallId ? [] : ["providerCallId"]),
        ...(typeof row.requestId === "string" && row.requestId.length ? [] : ["requestId"]),
      ];
      drifts.push({ type: "missing-usage-key", userId, usageId: id, missingFields });
    } else {
      const key = `${userId}:${providerCallId}`;
      usageGroups.set(key, [...(usageGroups.get(key) ?? []), row]);
    }
    if (row.usageStatus === "uncertain") {
      drifts.push({ type: "unresolved-provider", userId, usageId: id, providerCallId });
    }
  }
  for (const [key, rows] of usageGroups) {
    if (rows.length > 1) {
      const split = key.indexOf(":");
      drifts.push({
        type: "duplicate-usage-key", userId: key.slice(0, split), providerCallId: key.slice(split + 1), count: rows.length,
      });
    }
  }

  const admissions = await db("o_usageAdmission")
    .where("admittedAt", ">=", from).andWhere("admittedAt", "<", to)
    .orderBy([{ column: "userId", order: "asc" }, { column: "admittedAt", order: "asc" }, { column: "providerCallId", order: "asc" }])
    .select(dbInteger(db, "userId", "userId"), "providerCallId") as RawRow[];
  if (admissions.length) {
    const admissionKeys = admissions.map((row) => [
      exactInteger(row.userId, "o_usageAdmission.userId").toString(), String(row.providerCallId),
    ]);
    const persisted = await db("o_usage")
      .whereIn(["userId", "providerCallId"], admissionKeys)
      .select(dbInteger(db, "userId", "userId"), "providerCallId") as RawRow[];
    const persistedKeys = new Set(persisted.map((row) =>
      `${exactInteger(row.userId, "o_usage.userId")}:${String(row.providerCallId)}`));
    for (const [userId, providerCallId] of admissionKeys) {
      if (!persistedKeys.has(`${userId}:${providerCallId}`)) {
        drifts.push({ type: "unresolved-provider", userId, usageId: null, providerCallId, source: "admission" });
      }
    }
  }

  const orders = await db("o_order")
    .orderBy([{ column: "userId", order: "asc" }, { column: "id", order: "asc" }])
    .select(
      dbInteger(db, "id", "id"), dbInteger(db, "userId", "userId"), "outTradeNo", "status", "type",
      dbInteger(db, "amountMicro", "amountMicro"), dbInteger(db, "createdAt", "createdAt"),
    ) as RawRow[];
  const credits = ledgerRows.filter((row) => row.type === "recharge" && row.refType === "recharge");
  const creditsByOrder = new Map<string, RawRow[]>();
  for (const credit of credits) {
    const userId = exactInteger(credit.userId, "o_ledger.userId").toString();
    const key = `${userId}:${String(credit.refId ?? "")}`;
    creditsByOrder.set(key, [...(creditsByOrder.get(key) ?? []), credit]);
  }
  const orderByTrade = new Map(orders.map((order) => [
    `${exactInteger(order.userId, "o_order.userId")}:${String(order.outTradeNo)}`,
    order,
  ]));
  const relevantOrders = orders.filter((order) => {
    const createdAt = safeTimestamp(order.createdAt, "o_order.createdAt");
    const userId = exactInteger(order.userId, "o_order.userId").toString();
    const orderId = String(order.outTradeNo);
    const linkedCreditInRange = (creditsByOrder.get(`${userId}:${orderId}`) ?? []).some((credit) => {
      const createdAt = safeTimestamp(credit.createdAt, "o_ledger.createdAt");
      return createdAt >= from && createdAt < to;
    });
    return (createdAt >= from && createdAt < to) || linkedCreditInRange;
  });
  const checkedCredits = new Set<RawRow>();
  for (const order of relevantOrders) {
    const userId = exactInteger(order.userId, "o_order.userId").toString();
    const orderId = String(order.outTradeNo);
    const linkedCredits = creditsByOrder.get(`${userId}:${orderId}`) ?? [];
    const status = String(order.status);
    const expected = exactInteger(order.amountMicro, "o_order.amountMicro");
    for (const credit of linkedCredits) checkedCredits.add(credit);
    if (order.type === "recharge" && status === "paid") {
      const actual = linkedCredits.reduce((sum, credit) => sum + exactInteger(credit.amountMicro, "o_ledger.amountMicro"), 0n);
      if (linkedCredits.length !== 1 || actual !== expected) {
        drifts.push({
          type: "order-credit", userId, orderId, status, amountMicro: expected.toString(),
          creditAmountMicro: linkedCredits.length ? actual.toString() : null,
          reason: !linkedCredits.length ? "paid-order-without-credit" : linkedCredits.length > 1 ? "multiple-credits" : "credit-amount-mismatch",
        });
      }
    } else if (linkedCredits.length) {
      drifts.push({
        type: "order-credit", userId, orderId, status, amountMicro: expected.toString(),
        creditAmountMicro: linkedCredits.reduce((sum, credit) => sum + exactInteger(credit.amountMicro, "o_ledger.amountMicro"), 0n).toString(),
        reason: "credit-without-paid-order",
      });
    }
  }
  for (const credit of credits) {
    if (checkedCredits.has(credit)) continue;
    const createdAt = safeTimestamp(credit.createdAt, "o_ledger.createdAt");
    if (createdAt < from || createdAt >= to) continue;
    const userId = exactInteger(credit.userId, "o_ledger.userId").toString();
    const orderId = String(credit.refId ?? "");
    const order = orderByTrade.get(`${userId}:${orderId}`);
    drifts.push({
      type: "order-credit", userId, orderId, status: order ? String(order.status) : "missing-order",
      amountMicro: order ? exactInteger(order.amountMicro, "o_order.amountMicro").toString() : "0",
      creditAmountMicro: exactInteger(credit.amountMicro, "o_ledger.amountMicro").toString(),
      reason: order && order.type === "recharge" && order.status === "paid" ? "credit-amount-mismatch" : "credit-without-paid-order",
    });
  }

  const typeOrder: BillingDrift["type"][] = [
    "account-ledger", "missing-account", "job-reservation", "duplicate-usage-key", "missing-usage-key", "unresolved-provider", "order-credit",
  ];
  drifts.sort((a, b) => {
    const typeDifference = typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);
    if (typeDifference) return typeDifference;
    const userDifference = cmpIntegerText(a.userId, b.userId);
    if (userDifference) return userDifference;
    const idOf = (drift: BillingDrift): string => {
      if ("jobId" in drift) return drift.jobId;
      if ("usageId" in drift && drift.usageId !== null) return drift.usageId;
      if ("orderId" in drift) return drift.orderId;
      if ("providerCallId" in drift) return drift.providerCallId;
      return "";
    };
    return cmpOrdinal(idOf(a), idOf(b));
  });

  return { from, to, dryRun: options.dryRun, stateSemantics: "current-at-execution", drifts };
}
