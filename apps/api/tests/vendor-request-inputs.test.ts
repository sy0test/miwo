import { describe, expect, it } from "vitest";
import * as volcengine from "@/vendors/volcengine";
import * as volcengineSd2 from "@/vendors/volcengineSd2";
import { runWithVendorInputs, vendorInputs } from "@/vendors/runtime";

const videoConfig = { prompt: "x", mode: "text" as const, aspectRatio: "16:9", duration: 5, resolution: "480p", referenceList: [] };
const model = { modelName: "m" };

describe("适配器运行期读取 DB 里的 inputValues（Phase 1c Task 8 回归）", () => {
  it("默认（无请求上下文）仍读编译期默认值：缺 key 报错", async () => {
    expect(vendorInputs((volcengine as any).vendor).apiKey).toBe("");
    await expect((volcengine as any).videoRequest(videoConfig, model)).rejects.toThrow(/缺少API Key/);
  });

  it("注入请求上下文后不再报缺少 API Key，而是真的去请求 baseUrl", async () => {
    await expect(
      runWithVendorInputs({ apiKey: "test-key", baseUrl: "http://127.0.0.1:1" }, () =>
        (volcengine as any).videoRequest(videoConfig, model),
      ),
    ).rejects.not.toThrow(/缺少API Key/);
  });

  it("volcengineSd2 getHeaders 同样能读上下文里的 key", async () => {
    await expect(
      runWithVendorInputs({ apiKey: "test-key", baseUrl: "http://127.0.0.1:1", ak: "a", sk: "s" }, () =>
        (volcengineSd2 as any).videoRequest(videoConfig, model),
      ),
    ).rejects.not.toThrow(/缺少API Key/);
  });
});
