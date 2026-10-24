import type { Knex } from "knex";
import { resolvePrice, resolveTextPricingUnit, resolveVideoPrice, type VideoPriceUnit } from "@/billing/prices";

const QUANTITY_SCALE = 1_000_000_000n;
const MAX_MICRO = 9_223_372_036_854_775_807n;

function exactQuantityScaled(quantity: number | string): bigint {
  const value = typeof quantity === "number" ? String(quantity) : quantity;
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,9})?$/.test(value)) {
    throw new TypeError("Submission quantity must be a finite non-negative decimal with at most 9 fractional digits");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(9, "0"));
}

export async function resolveTextSubmissionEstimate(
  db: Knex,
  modelRef: string,
  tokenQuantity: number | string,
  callQuantity: number | string,
  at = new Date(),
): Promise<bigint> {
  const tokenScaled = exactQuantityScaled(tokenQuantity);
  const callScaled = exactQuantityScaled(callQuantity);
  if (tokenScaled <= 0n || callScaled <= 0n) throw new RangeError("Submission quantity must be greater than zero");

  const { vendorId, model } = splitBilledModel(modelRef);
  const unit = await resolveTextPricingUnit(db, vendorId, model, at);
  return resolveSubmissionEstimate(db, modelRef, unit, unit === "token" ? tokenQuantity : callQuantity, at);
}

export function splitBilledModel(modelRef: string): { vendorId: string; model: string } {
  const separator = modelRef.indexOf(":");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new TypeError("A billed model must use vendorId:model format");
  }
  return { vendorId: modelRef.slice(0, separator), model: modelRef.slice(separator + 1) };
}

function isVideoPriceUnit(unit: string): unit is VideoPriceUnit {
  return unit === "video_second" || unit === "video_second_480p" || unit === "video_second_720p";
}

/** Resolve the active tariff and round upward so an estimate never under-reserves. */
export async function resolveSubmissionEstimate(
  db: Knex,
  modelRef: string,
  unit: string,
  quantity: number | string,
  at = new Date(),
): Promise<bigint> {
  const { vendorId, model } = splitBilledModel(modelRef);
  const scaledQuantity = exactQuantityScaled(quantity);
  if (scaledQuantity <= 0n) throw new RangeError("Submission quantity must be greater than zero");
  const price = isVideoPriceUnit(unit)
    ? await resolveVideoPrice(db, vendorId, model, unit, at)
    : await resolvePrice(db, vendorId, model, unit, at);
  const estimate = (price.unitPriceMicro * scaledQuantity + QUANTITY_SCALE - 1n) / QUANTITY_SCALE;
  if (estimate > MAX_MICRO) throw new RangeError("Submission estimate exceeds the signed 64-bit ledger range");
  return estimate;
}
