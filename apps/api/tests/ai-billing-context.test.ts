import { describe, expect, it } from "vitest";
import Ai from "@/utils/ai";
import { withAiBillingContext, type AiBillingContext } from "@/billing/context";

const context: AiBillingContext = { userId: 41, jobId: "job-77", requestId: "request-77" };

const constructors = [
  () => (Ai.Text as any)("scriptAgent"),
  () => (Ai.Image as any)("1:model"),
  () => (Ai.Video as any)("1:model"),
  () => (Ai.Audio as any)("1:model"),
];

describe("AI billing context constructors", () => {
  it("requires the explicit context to match the active async context", async () => {
    for (const construct of constructors) {
      expect(construct).toThrow(/AI billing context/i);
    }

    await withAiBillingContext(context, async () => {
      const mismatch = { ...context, userId: context.userId + 1 };
      expect(() => (Ai.Text as any)("scriptAgent", mismatch)).toThrow(/does not match active/i);
      expect(() => (Ai.Image as any)("1:model", mismatch)).toThrow(/does not match active/i);
      expect(() => (Ai.Video as any)("1:model", mismatch)).toThrow(/does not match active/i);
      expect(() => (Ai.Audio as any)("1:model", mismatch)).toThrow(/does not match active/i);

      expect(() => (Ai.Text as any)("scriptAgent", context)).not.toThrow();
      expect(() => (Ai.Image as any)("1:model", context)).not.toThrow();
      expect(() => (Ai.Video as any)("1:model", context)).not.toThrow();
      expect(() => (Ai.Audio as any)("1:model", context)).not.toThrow();
    });
  });
});
