import type { Knex } from "knex";
import { isUniqueConstraintError } from "@/billing/isUniqueConstraintError";
import type { AiBillingContext } from "@/billing/context";
import { resolvePrice, resolveVideoPrice } from "@/billing/prices";
import { GrantNotFoundError, resolveAgentGrant, resolveModelGrant } from "@/billing/grants";

const QUANTITY_SCALE = 1_000_000_000n;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

type UsageStatus = "success" | "estimated" | "uncertain";
type UsageMeasure =
  | { unit: "call"; inTokens?: number; outTokens?: number }
  | { unit: "token"; inTokens?: number; outTokens?: number }
  | { unit: "image"; imageCount: number }
  | { unit: "video_second"; videoSeconds: string }
  | { unit: "video_second_480p"; videoSeconds: string }
  | { unit: "video_second_720p"; videoSeconds: string }
  | { unit: "character"; text: string };

export interface ProviderUsageInput {
  vendorId: string;
  model: string;
  agentKey?: string;
  callType: string;
  providerCallId: string;
  at?: Date;
  usageStatus: UsageStatus;
  /** Omit only when the provider outcome is uncertain and usage is unmeasured. */
  usage?: UsageMeasure;
}

export interface PreparedProviderUsage {
  vendorId: string;
  model: string;
  callType: string;
  providerCallId: string;
  usageStatus: UsageStatus;
  unit: UsageMeasure["unit"] | "unknown";
  quantity: string | null;
  inTokens: number | null;
  outTokens: number | null;
  imageCount: number | null;
  videoSeconds: string | null;
  priceId: number | null;
  costMicro: bigint;
  createdAt: number;
}

export interface ProviderUsageRow extends Omit<PreparedProviderUsage, "costMicro"> {
  id: number | string;
  userId: number | string;
  jobId: string | number | bigint | null;
  requestId: string;
  costMicro: string | number | bigint;
}

type DbInteger = number | string | bigint;

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
  const integer = exactInteger(value, field);
  const number = Number(integer);
  if (!Number.isSafeInteger(number) || BigInt(number) !== integer) {
    throw new RangeError(`${field} is outside the safe integer range`);
  }
  return number;
}

function decimalScaled(value: string, field: string, scale = 9, maxFraction = scale): bigint {
  if (typeof value !== "string") throw new TypeError(`${field} must be an exact decimal string`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > maxFraction) {
    throw new TypeError(`${field} must be a non-negative decimal string with at most ${maxFraction} fractional digits`);
  }
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  return BigInt(match[1]) * 10n ** BigInt(scale) + BigInt(fraction || "0");
}

function decimalString(scaled: bigint, scale = 9): string {
  const base = 10n ** BigInt(scale);
  const whole = scaled / base;
  const fraction = (scaled % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function fixedDecimalString(scaled: bigint, scale: number): string {
  const base = 10n ** BigInt(scale);
  return `${scaled / base}.${(scaled % base).toString().padStart(scale, "0")}`;
}

function sameDecimal(actual: unknown, expected: string, field: string, scale = 9): boolean {
  if (typeof actual !== "string") throw new TypeError(`${field} from database must be an exact decimal string`);
  return decimalScaled(actual, field, scale) === decimalScaled(expected, field, scale);
}

function safeMetric(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${field} must be a non-negative 32-bit integer`);
  }
  return value;
}

function measure(input: UsageMeasure | undefined): Pick<PreparedProviderUsage, "unit" | "quantity" | "inTokens" | "outTokens" | "imageCount" | "videoSeconds"> {
  if (input === undefined) {
    return { unit: "unknown", quantity: null, inTokens: null, outTokens: null, imageCount: null, videoSeconds: null };
  }
  if (input.unit === "call") {
    const inTokens = input.inTokens === undefined ? null : safeMetric(input.inTokens, "inTokens");
    const outTokens = input.outTokens === undefined ? null : safeMetric(input.outTokens, "outTokens");
    return { unit: input.unit, quantity: "1", inTokens, outTokens, imageCount: null, videoSeconds: null };
  }
  if (input.unit === "token") {
    const inTokens = input.inTokens === undefined ? null : safeMetric(input.inTokens, "inTokens");
    const outTokens = input.outTokens === undefined ? null : safeMetric(input.outTokens, "outTokens");
    if (inTokens === null && outTokens === null) throw new TypeError("Token usage requires inTokens or outTokens");
    return {
      unit: input.unit,
      quantity: String((inTokens ?? 0) + (outTokens ?? 0)),
      inTokens,
      outTokens,
      imageCount: null,
      videoSeconds: null,
    };
  }
  if (input.unit === "image") {
    const imageCount = safeMetric(input.imageCount, "imageCount");
    return { unit: input.unit, quantity: String(imageCount), inTokens: null, outTokens: null, imageCount, videoSeconds: null };
  }
  if (input.unit === "video_second" || input.unit === "video_second_480p" || input.unit === "video_second_720p") {
    const scaled = decimalScaled(input.videoSeconds, "videoSeconds", 9, 6);
    return {
      unit: input.unit,
      quantity: decimalString(scaled),
      inTokens: null,
      outTokens: null,
      imageCount: null,
      videoSeconds: fixedDecimalString(scaled / 1_000n, 6),
    };
  }
  const quantity = safeMetric(input.text.length, "text character count");
  return { unit: input.unit, quantity: String(quantity), inTokens: null, outTokens: null, imageCount: null, videoSeconds: null };
}

function validateInput(context: AiBillingContext, input: ProviderUsageInput): Date {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0) throw new TypeError("userId must be a positive safe integer");
  if (context.jobId !== undefined) {
    if (!/^\d+$/.test(context.jobId) || BigInt(context.jobId) > MAX_UNSIGNED_BIGINT) {
      throw new TypeError("jobId must be a non-negative bigint-compatible decimal string");
    }
  }
  for (const [name, value] of Object.entries({
    vendorId: input.vendorId,
    model: input.model,
    callType: input.callType,
    providerCallId: input.providerCallId,
  })) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  }
  if (!["success", "estimated", "uncertain"].includes(input.usageStatus)) throw new TypeError("Invalid usageStatus");
  const at = input.at ?? new Date();
  if (!(at instanceof Date) || !Number.isSafeInteger(at.getTime())) throw new TypeError("Usage time must be a valid Date");
  return at;
}

function utcDayStart(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

interface ProviderCallAdmission {
  userId: DbInteger;
  providerCallId: string;
  vendorId: string;
  model: string;
  dayStart: DbInteger;
  admittedAt: DbInteger;
  jobId: DbInteger | null;
  requestId: string;
  callType: string;
}

async function admissionByProviderCall(
  db: Knex | Knex.Transaction,
  userId: number,
  providerCallId: string,
): Promise<ProviderCallAdmission | undefined> {
  return await db("o_usageAdmission")
    .select("*")
    .select(db.raw("CAST(?? AS CHAR) AS ??", ["jobId", "jobId"]))
    .where({ userId, providerCallId })
    .first() as ProviderCallAdmission | undefined;
}

function assertAdmissionMatches(row: ProviderCallAdmission, context: AiBillingContext, input: ProviderUsageInput): void {
  const expectedJobId = context.jobId === undefined ? null : BigInt(context.jobId);
  const actualJobId = row.jobId === null ? null : exactInteger(row.jobId, "o_usageAdmission.jobId");
  if (row.vendorId !== input.vendorId || row.model !== input.model || row.callType !== input.callType
    || row.requestId !== context.requestId || actualJobId !== expectedJobId) {
    throw new Error("Provider call id was already admitted with different vendor, model, or call identity");
  }
}

async function incrementDailyAdmission(
  trx: Knex.Transaction,
  context: AiBillingContext,
  input: ProviderUsageInput,
  dailyLimit: number | null,
  dayStart: number,
): Promise<void> {
  const key = { userId: context.userId, vendorId: input.vendorId, model: input.model, dayStart };
  try {
    await trx("o_dailyQuotaAdmission").insert({ ...key, admittedCount: 0 });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }
  const query = trx("o_dailyQuotaAdmission").where(key);
  if (dailyLimit !== null) query.where("admittedCount", "<", dailyLimit);
  const changed = await query.update({ admittedCount: trx.raw("?? + 1", ["admittedCount"]) });
  if (changed !== 1) throw new Error(`Daily limit of ${dailyLimit} calls exceeded for ${input.vendorId}/${input.model}`);
}

async function reserveProviderCall(
  db: Knex,
  context: AiBillingContext,
  input: ProviderUsageInput,
  dailyLimit: number | null,
  at: Date,
): Promise<ProviderCallAdmission> {
  const existing = await admissionByProviderCall(db, context.userId, input.providerCallId);
  if (existing) {
    assertAdmissionMatches(existing, context, input);
    return existing;
  }

  const dayStart = utcDayStart(at);
  try {
    await db.transaction(async (trx) => {
      await trx("o_usageAdmission").insert({
        userId: context.userId,
        providerCallId: input.providerCallId,
        vendorId: input.vendorId,
        model: input.model,
        dayStart,
        admittedAt: at.getTime(),
        jobId: context.jobId === undefined ? null : context.jobId,
        requestId: context.requestId,
        callType: input.callType,
      });
      await incrementDailyAdmission(trx, context, input, dailyLimit, dayStart);
    });
  } catch (error) {
    const concurrent = await admissionByProviderCall(db, context.userId, input.providerCallId);
    if (!concurrent) throw error;
    assertAdmissionMatches(concurrent, context, input);
    return concurrent;
  }

  const admitted = await admissionByProviderCall(db, context.userId, input.providerCallId);
  if (!admitted) throw new Error("Provider quota admission did not produce a durable admission");
  return admitted;
}

async function buildPreparedUsage(db: Knex, input: ProviderUsageInput, at: Date): Promise<PreparedProviderUsage> {
  const measured = measure(input.usage);
  if (measured.unit === "unknown" && input.usageStatus !== "uncertain") {
    throw new TypeError("Unmeasured provider usage requires usageStatus uncertain");
  }
  const price = measured.unit === "unknown"
    ? null
    : measured.unit === "video_second_480p" || measured.unit === "video_second_720p"
      ? await resolveVideoPrice(db, input.vendorId, input.model, measured.unit, at)
      : await resolvePrice(db, input.vendorId, input.model, measured.unit, at);
  const costMicro = price === null
    ? 0n
    : (price.unitPriceMicro * decimalScaled(measured.quantity!, "quantity") + QUANTITY_SCALE / 2n) / QUANTITY_SCALE;
  if (costMicro > MAX_UNSIGNED_BIGINT) throw new RangeError("Calculated usage cost exceeds o_usage.costMicro storage range");
  return {
    vendorId: input.vendorId,
    model: input.model,
    callType: input.callType,
    providerCallId: input.providerCallId,
    usageStatus: input.usageStatus,
    ...measured,
    priceId: price?.id ?? null,
    costMicro,
    createdAt: at.getTime(),
  };
}

/** Resolve grant, durable quota admission, and effective price before provider dispatch. */
export async function prepareProviderUsage(db: Knex, context: AiBillingContext, input: ProviderUsageInput): Promise<PreparedProviderUsage> {
  const at = validateInput(context, input);
  const existing = await admissionByProviderCall(db, context.userId, input.providerCallId);
  if (existing) {
    assertAdmissionMatches(existing, context, input);
    return buildPreparedUsage(db, input, new Date(safeNumber(existing.admittedAt, "o_usageAdmission.admittedAt")));
  }

  let grant: { dailyLimit: number | null };
  if (input.agentKey === undefined) {
    grant = await resolveModelGrant(db, context.userId, input.vendorId, input.model);
  } else {
    try {
      grant = await resolveAgentGrant(db, context.userId, input.agentKey);
    } catch (error) {
      if (!(error instanceof GrantNotFoundError)) throw error;
      grant = await resolveModelGrant(db, context.userId, input.vendorId, input.model);
    }
  }
  const prepared = await buildPreparedUsage(db, input, at);
  const admission = await reserveProviderCall(db, context, input, grant.dailyLimit, at);
  const admittedAt = safeNumber(admission.admittedAt, "o_usageAdmission.admittedAt");
  return admittedAt === at.getTime() ? prepared : buildPreparedUsage(db, input, new Date(admittedAt));
}

function rowMatchesInput(row: ProviderUsageRow, context: AiBillingContext, input: ProviderUsageInput): boolean {
  const measured = measure(input.usage);
  exactInteger(row.userId, "o_usage.userId");
  exactInteger(row.costMicro, "o_usage.costMicro");
  const metricsMatch = (row.inTokens === null ? null : safeNumber(row.inTokens, "o_usage.inTokens")) === measured.inTokens
    && (row.outTokens === null ? null : safeNumber(row.outTokens, "o_usage.outTokens")) === measured.outTokens
    && (row.imageCount === null ? null : safeNumber(row.imageCount, "o_usage.imageCount")) === measured.imageCount
    && (row.videoSeconds === null
      ? measured.videoSeconds === null
      : measured.videoSeconds !== null && sameDecimal(row.videoSeconds, measured.videoSeconds, "o_usage.videoSeconds", 6));
  const expectedJobId = context.jobId === undefined ? null : BigInt(context.jobId);
  const actualJobId = row.jobId === null ? null : exactInteger(row.jobId, "o_usage.jobId");
  return actualJobId === expectedJobId
    && row.vendorId === input.vendorId
    && row.model === input.model
    && row.callType === input.callType
    && row.requestId === context.requestId
    && row.unit === measured.unit
    && (measured.quantity === null ? row.quantity === null : sameDecimal(row.quantity, measured.quantity, "o_usage.quantity"))
    && row.usageStatus === input.usageStatus
    && metricsMatch;
}

/** Append one immutable usage event after pre-dispatch admission; never admits or increments quota. */
export async function recordProviderUsage(db: Knex, context: AiBillingContext, input: ProviderUsageInput): Promise<ProviderUsageRow> {
  validateInput(context, input);
  const admission = await admissionByProviderCall(db, context.userId, input.providerCallId);
  if (!admission) throw new Error("Provider usage cannot be recorded without pre-dispatch admission");
  assertAdmissionMatches(admission, context, input);
  const admittedAt = safeNumber(admission.admittedAt, "o_usageAdmission.admittedAt");
  const prepared = await buildPreparedUsage(db, input, new Date(admittedAt));
  const existing = (await db("o_usage")
    .select("*")
    .select(db.raw("CAST(?? AS CHAR) AS ??", ["jobId", "jobId"]))
    .where({ userId: context.userId, providerCallId: input.providerCallId })
    .first()) as ProviderUsageRow | undefined;
  if (existing) {
    if (!rowMatchesInput(existing, context, input)
      || exactInteger(existing.costMicro, "o_usage.costMicro") !== prepared.costMicro) {
      throw new Error("Provider call id was already recorded with different usage input");
    }
    return existing;
  }

  try {
    await db("o_usage").insert({
      userId: context.userId,
      jobId: context.jobId === undefined ? null : context.jobId,
      vendorId: prepared.vendorId,
      model: prepared.model,
      callType: prepared.callType,
      inTokens: prepared.inTokens,
      outTokens: prepared.outTokens,
      imageCount: prepared.imageCount,
      videoSeconds: prepared.videoSeconds,
      costMicro: prepared.costMicro.toString(),
      requestId: context.requestId,
      providerCallId: prepared.providerCallId,
      unit: prepared.unit,
      quantity: prepared.quantity,
      priceId: prepared.priceId,
      usageStatus: prepared.usageStatus,
      createdAt: prepared.createdAt,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const row = (await db("o_usage")
    .select("*")
    .select(db.raw("CAST(?? AS CHAR) AS ??", ["jobId", "jobId"]))
    .where({ userId: context.userId, providerCallId: prepared.providerCallId })
    .first()) as ProviderUsageRow | undefined;
  if (!row) throw new Error("Usage insert did not produce a row");
  if (!rowMatchesInput(row, context, input)
    || exactInteger(row.costMicro, "o_usage.costMicro") !== prepared.costMicro) {
    throw new Error("Provider call id was already recorded with different usage input");
  }
  return row;
}
