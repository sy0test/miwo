import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/reconcile-billing";

describe("billing reconciliation CLI arguments", () => {
  it("requires an explicit read-only dry-run and parses a half-open epoch range", () => {
    expect(parseArgs(["--from", "100", "--to", "200", "--dry-run"])).toEqual({
      from: 100,
      to: 200,
      dryRun: true,
    });
  });

  it.each([
    ["missing range", ["--dry-run"]],
    ["missing dry-run", ["--from", "1", "--to", "2"]],
    ["missing value", ["--from", "1", "--to", "--dry-run"]],
    ["unknown flag", ["--from", "1", "--to", "2", "--dry-run", "--apply"]],
    ["duplicate flag", ["--from", "1", "--from", "2", "--to", "3", "--dry-run"]],
    ["non-integer epoch", ["--from", "1.5", "--to", "2", "--dry-run"]],
    ["unsafe epoch", ["--from", "1", "--to", "9007199254740992", "--dry-run"]],
    ["negative epoch", ["--from", "-1", "--to", "2", "--dry-run"]],
    ["empty interval", ["--from", "2", "--to", "2", "--dry-run"]],
    ["reversed interval", ["--from", "3", "--to", "2", "--dry-run"]],
    ["duplicate dry-run", ["--from", "1", "--to", "2", "--dry-run", "--dry-run"]],
  ])("rejects %s", (_description, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it("accepts pnpm's single argument separator", () => {
    expect(parseArgs(["--", "--from", "1", "--to", "2", "--dry-run"])).toEqual({
      from: 1,
      to: 2,
      dryRun: true,
    });
  });
});
