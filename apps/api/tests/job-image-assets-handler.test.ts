import { describe, expect, it } from "vitest";
import { imageAssetsBatch } from "@/jobs/handlers/imageAssets";

const payload = {
  projectId: 1,
  model: "vendor-a:model-a",
  resolution: "1K",
  items: [{ assetsId: 10, imageId: 20, type: "unknown", name: "item", prompt: "prompt" }],
};

describe("image.assets.batch payload validation", () => {
  it("rejects batches whose item types would all be silently skipped", () => {
    expect(() => imageAssetsBatch.parse(payload)).toThrow(/不支持的素材类型/);
  });
});
