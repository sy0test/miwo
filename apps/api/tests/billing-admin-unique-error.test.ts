import { describe, expect, it } from "vitest";
import { grantIdentityKey } from "@/billing/grantIdentity";
import { isUniqueConstraintError } from "@/billing/isUniqueConstraintError";

describe("billing identity and unique conflict helpers", () => {
  it("encodes disjoint grant identity kinds and leaves incomplete identities nullable", () => {
    expect(grantIdentityKey({ agentKey: "writer" })).toMatch(/^agent:[a-f0-9]{64}$/);
    expect(grantIdentityKey({ vendorId: "vendor", model: "model" })).toMatch(/^model:[a-f0-9]{64}$/);
    expect(grantIdentityKey({ agentKey: "same" })).not.toBe(grantIdentityKey({ vendorId: "same", model: "same" }));
    expect(grantIdentityKey({ vendorId: "vendor" })).toBeNull();
  });

  it("recognizes SQLite and MySQL duplicate-key driver errors only", () => {
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })).toBe(true);
    expect(isUniqueConstraintError({ code: "ER_DUP_ENTRY", errno: 1062 })).toBe(true);
    expect(isUniqueConstraintError({ errno: 1062 })).toBe(true);
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: o_price.vendorId"))).toBe(true);
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBe(false);
    expect(isUniqueConstraintError(new Error("connection lost"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
