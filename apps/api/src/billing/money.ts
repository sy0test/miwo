const CNY_SCALE = 1_000_000n;
const DECIMAL_CNY = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parse a non-negative base-10 CNY amount into integer micro-CNY. */
export function parseCnyToMicro(input: string): bigint {
  if (typeof input !== "string") throw new TypeError("CNY amount must be a decimal string");
  const match = DECIMAL_CNY.exec(input);
  if (!match) throw new TypeError("CNY amount must be a non-negative decimal with at most 6 fractional digits");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return whole * CNY_SCALE + fraction;
}

/** Format signed integer micro-CNY as a fixed six-place decimal string. */
export function formatMicroToCny(value: bigint): string {
  if (typeof value !== "bigint") throw new TypeError("Micro-CNY amount must be a bigint");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / CNY_SCALE;
  const fraction = (absolute % CNY_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
