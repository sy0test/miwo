import { describe, expect, it } from "vitest";
import { runWithTenant } from "@/db/tenant-context";
import { currentAiBillingContext, withAiBillingContext, type AiBillingContext } from "@/billing/context";

const context: AiBillingContext = { userId: 7, jobId: "job-1", requestId: "req-1" };

describe("AI billing async context", () => {
  it("is available across async work and is isolated between concurrent calls", async () => {
    const values = await Promise.all([
      withAiBillingContext(context, async () => {
        await Promise.resolve();
        return currentAiBillingContext();
      }),
      withAiBillingContext({ userId: 8, requestId: "req-2" }, async () => {
        await Promise.resolve();
        return currentAiBillingContext();
      }),
    ]);

    expect(values).toEqual([context, { userId: 8, requestId: "req-2" }]);
    expect(() => currentAiBillingContext()).toThrow(/billing context/i);
  });

  it("rejects invalid users and tenant identity mismatches", async () => {
    await expect(withAiBillingContext({ userId: 0, requestId: "req" }, () => "ok")).rejects.toThrow(/userId/i);
    await expect(withAiBillingContext(context, () => "ok")).resolves.toBe("ok");

    await runWithTenant({ userId: 9, role: "user", requestId: "tenant-req", source: "http" }, async () => {
      await expect(withAiBillingContext(context, () => "ok")).rejects.toThrow(/tenant/i);
    });
  });
});
