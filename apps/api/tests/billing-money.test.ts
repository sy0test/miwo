import { describe, expect, it } from "vitest";
import { formatMicroToCny, parseCnyToMicro } from "@/billing/money";

describe("exact CNY money conversion", () => {
  it("parses decimal CNY into integer micro-CNY without floating point", () => {
    expect(parseCnyToMicro("0")).toBe(0n);
    expect(parseCnyToMicro("1")).toBe(1_000_000n);
    expect(parseCnyToMicro("12.34")).toBe(12_340_000n);
    expect(parseCnyToMicro("0.000001")).toBe(1n);
    expect(parseCnyToMicro("900719925474099312345.123456")).toBe(900719925474099312345123456n);
  });

  it("rejects invalid, negative, exponent, and sub-micro input", () => {
    for (const value of ["", " ", "NaN", "Infinity", "-1", "+1", "1e3", "1.0000001", ".5", "1."]) {
      expect(() => parseCnyToMicro(value), value).toThrow();
    }
  });

  it("formats signed bigint micro-CNY exactly, including values larger than safe numbers", () => {
    expect(formatMicroToCny(0n)).toBe("0.000000");
    expect(formatMicroToCny(1n)).toBe("0.000001");
    expect(formatMicroToCny(12_340_000n)).toBe("12.340000");
    expect(formatMicroToCny(-900719925474099312345123456n)).toBe("-900719925474099312345.123456");
  });
});
