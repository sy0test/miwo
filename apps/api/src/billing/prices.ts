import type { Knex } from "knex";

type DbInteger = number | string | bigint;

export interface Price {
  id: number;
  vendorId: string;
  model: string;
  unit: string;
  unitPriceMicro: bigint;
  effectiveFrom: number;
  createdBy: number | null;
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

/** Resolve exactly one latest active price, failing closed on missing or tied rows. */
export async function resolvePrice(
  db: Knex,
  vendorId: string,
  model: string,
  unit: string,
  at: Date,
): Promise<Price> {
  const atMs = at.getTime();
  if (!Number.isSafeInteger(atMs)) throw new TypeError("Price resolution time must be a valid Date");

  const query = db("o_price").where({ vendorId, model, unit }).where("effectiveFrom", "<=", atMs);
  const latest = (await query.clone().orderBy("effectiveFrom", "desc").first()) as
    | { effectiveFrom: DbInteger }
    | undefined;
  if (!latest) throw new Error(`No effective price for ${vendorId}/${model}/${unit}`);

  const effectiveFrom = safeNumber(latest.effectiveFrom, "o_price.effectiveFrom");
  const rows = (await query
    .clone()
    .where("effectiveFrom", effectiveFrom)
    .select("id", "vendorId", "model", "unit", "unitPriceMicro", "effectiveFrom", "createdBy")) as Array<{
    id: DbInteger;
    vendorId: string;
    model: string;
    unit: string;
    unitPriceMicro: DbInteger;
    effectiveFrom: DbInteger;
    createdBy: DbInteger | null;
  }>;

  if (rows.length !== 1) throw new Error(`Ambiguous effective price for ${vendorId}/${model}/${unit}`);
  const row = rows[0];
  const unitPriceMicro = exactInteger(row.unitPriceMicro, "o_price.unitPriceMicro");
  if (unitPriceMicro < 0n) throw new RangeError("o_price.unitPriceMicro must not be negative");

  return {
    id: safeNumber(row.id, "o_price.id"),
    vendorId: row.vendorId,
    model: row.model,
    unit: row.unit,
    unitPriceMicro,
    effectiveFrom: safeNumber(row.effectiveFrom, "o_price.effectiveFrom"),
    createdBy: row.createdBy === null ? null : safeNumber(row.createdBy, "o_price.createdBy"),
  };
}

export type TextPricingUnit = "token" | "call";

export async function resolveTextPricingUnit(
  db: Knex,
  vendorId: string,
  model: string,
  at: Date,
): Promise<TextPricingUnit> {
  const atMs = at.getTime();
  if (!Number.isSafeInteger(atMs)) throw new TypeError("Price resolution time must be a valid Date");

  const rows = (await db("o_price")
    .where({ vendorId, model })
    .whereIn("unit", ["token", "call"])
    .where("effectiveFrom", "<=", atMs)
    .select("unit", "effectiveFrom")) as Array<{ unit: TextPricingUnit; effectiveFrom: DbInteger }>;
  if (rows.length === 0) throw new Error(`No effective text price for ${vendorId}/${model}`);

  const latestTime = Math.max(...rows.map((row) => safeNumber(row.effectiveFrom, "o_price.effectiveFrom")));
  const latestUnits = new Set(rows
    .filter((row) => safeNumber(row.effectiveFrom, "o_price.effectiveFrom") === latestTime)
    .map((row) => row.unit));
  if (latestUnits.size !== 1) throw new Error(`Ambiguous effective text price for ${vendorId}/${model}`);

  const unit = latestUnits.values().next().value as TextPricingUnit;
  await resolvePrice(db, vendorId, model, unit, at);
  return unit;
}

export type VideoPriceUnit = "video_second" | "video_second_480p" | "video_second_720p";

export function videoPricingUnit(resolution: string): VideoPriceUnit {
  if (resolution === "480p") return "video_second_480p";
  if (resolution === "720p") return "video_second_720p";
  return "video_second";
}

export async function resolveVideoPrice(
  db: Knex,
  vendorId: string,
  model: string,
  requestedUnit: VideoPriceUnit,
  at: Date,
): Promise<Price> {
  if (requestedUnit === "video_second") return resolvePrice(db, vendorId, model, requestedUnit, at);

  const atMs = at.getTime();
  if (!Number.isSafeInteger(atMs)) throw new TypeError("Price resolution time must be a valid Date");
  const tierPrice = await db("o_price")
    .where({ vendorId, model })
    .whereIn("unit", ["video_second_480p", "video_second_720p"])
    .where("effectiveFrom", "<=", atMs)
    .first("id");

  if (!tierPrice) return resolvePrice(db, vendorId, model, "video_second", at);
  return resolvePrice(db, vendorId, model, requestedUnit, at);
}
