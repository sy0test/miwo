import { describe, expect, it } from "vitest";
import { normalizeLineEndings } from "../src/utils/db-type-format";

describe("normalizeLineEndings", () => {
  it("converts CRLF and bare CR to LF", () => {
    expect(normalizeLineEndings("first\r\nsecond\rthird\n")).toBe("first\nsecond\nthird\n");
  });
});
