import { beforeEach, describe, expect, it, vi } from "vitest";
import Ai, { estimateTextInvocationTokens } from "@/utils/ai";
import { waitForAiBillingTasks, withAiBillingContext } from "@/billing/context";
import { GrantNotFoundError } from "@/billing/grants";

const { ttsRequest, videoRequest, textRequest, generateText, streamText, prepareProviderUsage, recordProviderUsage, resolveTextPricingUnit, sharedVendor, pricingMode } = vi.hoisted(() => ({
  ttsRequest: vi.fn(),
  videoRequest: vi.fn(),
  textRequest: vi.fn().mockReturnValue({}),
  sharedVendor: { inputValues: { apiKey: "", baseUrl: "" } },
  generateText: vi.fn().mockResolvedValue({ usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) }),
  streamText: vi.fn(),
  prepareProviderUsage: vi.fn().mockResolvedValue({}),
  recordProviderUsage: vi.fn().mockResolvedValue({}),
  pricingMode: { value: "token" as "token" | "call" },
  resolveTextPricingUnit: vi.fn(async () => pricingMode.value),
}));

vi.mock("ai", () => ({
  generateText,
  streamText,
  wrapLanguageModel: vi.fn(),
  stepCountIs: vi.fn(),
  extractReasoningMiddleware: vi.fn(),
}));

vi.mock("@/billing/usage", () => ({ prepareProviderUsage, recordProviderUsage }));
vi.mock("@/billing/prices", () => ({ videoPricingUnit: (resolution: string) => resolution === "480p" ? "video_second_480p" : resolution === "720p" ? "video_second_720p" : "video_second", resolveTextPricingUnit }));

vi.mock("@/utils", () => {
  const db = (table: string) => ({
    where: () => ({
      first: async () => table === "o_vendorConfig" ? {
        id: "1", inputValues: JSON.stringify({ apiKey: "sk-persisted-test", baseUrl: "https://provider.test/v1" }),
      }
        : table === "o_agentDeploy" ? { key: "scriptAgent", modelName: "1:model", maxOutputTokens: 64 }
          : undefined,
    }),
  });
  return {
    default: {
      db,
      vendor: {
        getModelList: async () => [{ modelName: "model" }],
        getVendor: () => ({ version: "2" }),
        getVendorConfigFor: (_id: string, overrides: Record<string, string>) => ({
          inputValues: { ...sharedVendor.inputValues, ...overrides },
        }),
      },
    },
  };
});

vi.mock("@/vendors", () => ({
  getVendorModule: () => ({ ttsRequest, videoRequest, textRequest }),
}));

const context = { userId: 41, jobId: "job-77", requestId: "request-77" };

beforeEach(() => {
  ttsRequest.mockReset();
  videoRequest.mockReset();
  textRequest.mockClear();
  generateText.mockClear();
  streamText.mockReset();
  prepareProviderUsage.mockClear();
  recordProviderUsage.mockClear();
  pricingMode.value = "token";
  resolveTextPricingUnit.mockClear();
});

describe("AI wrapper provider errors", () => {
  it("returns model permission denial before invoking the provider", async () => {
    const denial = new GrantNotFoundError("model", "1/model");
    prepareProviderUsage.mockRejectedValueOnce(denial);

    await withAiBillingContext(context, async () => {
      await expect(Ai.Text("scriptAgent", context).invoke({ messages: [] } as any)).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining("无权使用模型"),
      });
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(recordProviderUsage).not.toHaveBeenCalled();
  });

  it("records Audio usage after a successful provider response", async () => {
    ttsRequest.mockResolvedValue("audio-result");

    await withAiBillingContext(context, async () => {
      const audio = Ai.Audio("1:model", context);
      await audio.run({
        duration: 1,
        resolution: "1K",
        aspectRatio: "16:9",
        prompt: "hello",
        mode: [],
      } as any);
    });

    expect(prepareProviderUsage).toHaveBeenCalledOnce();
    expect(recordProviderUsage).toHaveBeenCalledOnce();
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({
      callType: "audio", usageStatus: "estimated", usage: { unit: "character", text: "hello" },
    });
    expect(recordProviderUsage.mock.calls[0][2].providerCallId).toBe(prepareProviderUsage.mock.calls[0][2].providerCallId);
  });

  it.each([
    ["480p", "video_second_480p"],
    ["720p", "video_second_720p"],
    ["1080p", "video_second"],
  ])("uses the %s video unit for admission and successful usage recording", async (resolution, unit) => {
    videoRequest.mockResolvedValue("video-result");

    await withAiBillingContext(context, async () => {
      await Ai.Video("1:model", context).run({
        duration: 3, resolution, aspectRatio: "16:9", prompt: "scene", mode: [],
      } as any);
    });

    expect(prepareProviderUsage.mock.calls[0][2]).toMatchObject({
      callType: "video", usage: { unit, videoSeconds: "3" },
    });
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({
      callType: "video", usageStatus: "estimated", usage: { unit, videoSeconds: "3" },
    });
    expect(recordProviderUsage.mock.calls[0][2].providerCallId).toBe(prepareProviderUsage.mock.calls[0][2].providerCallId);
  });

  it("passes persisted vendor inputs to text adapters without mutating the shared adapter", async () => {
    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).invoke({ messages: [] } as any);
    });

    expect(textRequest.mock.calls[0][3]).toMatchObject({
      inputValues: { apiKey: "sk-persisted-test", baseUrl: "https://provider.test/v1" },
    });
    expect(sharedVendor.inputValues).toEqual({ apiKey: "", baseUrl: "" });
  });

  it("passes the resolved agent key into provider admission", async () => {
    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).invoke({ messages: [] } as any);
    });

    expect(prepareProviderUsage.mock.calls[0][2]).toMatchObject({
      vendorId: "1", model: "model", agentKey: "scriptAgent", callType: "text",
    });
  });

  it("includes system instructions in the complete text invocation token estimate", async () => {
    const short = await estimateTextInvocationTokens({ system: "x", messages: [] });
    const long = await estimateTextInvocationTokens({ system: "x".repeat(100), messages: [] });
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(64);
  });

  it("admits and records invoke calls at quantity one in call mode", async () => {
    pricingMode.value = "call";
    generateText.mockResolvedValue({ usage: Promise.resolve({ inputTokens: 4, outputTokens: 3 }) });

    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).invoke({ system: "system rules", messages: [{ role: "user", content: "hello" }] } as any);
    });

    expect(resolveTextPricingUnit).toHaveBeenCalledOnce();
    expect(prepareProviderUsage.mock.calls[0][2]).toMatchObject({ usage: { unit: "call", inTokens: expect.any(Number), outTokens: 64 } });
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({ usageStatus: "success", usage: { unit: "call", inTokens: 4, outTokens: 3 } });
    expect(recordProviderUsage.mock.calls[0][2].at).toBe(prepareProviderUsage.mock.calls[0][2].at);
  });

  it("records one uncertain call when invoke fails after admission", async () => {
    pricingMode.value = "call";
    const providerError = new Error("text provider failed");
    generateText.mockRejectedValue(providerError);

    await withAiBillingContext(context, async () => {
      await expect(Ai.Text("scriptAgent", context).invoke({ messages: [] } as any)).rejects.toBe(providerError);
    });

    expect(prepareProviderUsage).toHaveBeenCalledOnce();
    expect(recordProviderUsage).toHaveBeenCalledOnce();
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({ usageStatus: "uncertain", usage: { unit: "call" } });
    expect(recordProviderUsage.mock.calls[0][2].at).toBe(prepareProviderUsage.mock.calls[0][2].at);
  });

  it("uses call mode for streamed success and uncertain stream outcomes", async () => {
    pricingMode.value = "call";
    streamText.mockReturnValue({ usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }), fullStream: { [Symbol.asyncIterator]: async function* () {} } });
    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).stream({ system: "rules", messages: [] } as any);
      await waitForAiBillingTasks(context);
    });
    expect(prepareProviderUsage.mock.calls[0][2].usage.unit).toBe("call");
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({ usageStatus: "success", usage: { unit: "call", inTokens: 2, outTokens: 1 } });

    prepareProviderUsage.mockClear();
    recordProviderUsage.mockClear();
    streamText.mockReturnValue({ usage: Promise.reject(new Error("usage unavailable")), fullStream: { [Symbol.asyncIterator]: async function* () {} } });
    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).stream({ messages: [] } as any);
      await waitForAiBillingTasks(context);
    });
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({ usageStatus: "uncertain", usage: { unit: "call" } });
  });

  it("exposes a barrier for streamed usage persistence", async () => {
    let resolveUsage!: (value: { inputTokens: number; outputTokens: number }) => void;
    let resolveRecord!: () => void;
    const usage = new Promise<{ inputTokens: number; outputTokens: number }>((resolve) => { resolveUsage = resolve; });
    const persistence = new Promise<void>((resolve) => { resolveRecord = resolve; });
    streamText.mockReturnValue({ usage, fullStream: { [Symbol.asyncIterator]: async function* () {} } });
    recordProviderUsage.mockImplementation(async () => { await persistence; return {}; });

    await withAiBillingContext(context, async () => {
      await Ai.Text("scriptAgent", context).stream({ messages: [] } as any);
    });
    const completion = waitForAiBillingTasks(context);
    let finished = false;
    void completion.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    resolveUsage({ inputTokens: 2, outputTokens: 3 });
    await vi.waitFor(() => expect(recordProviderUsage).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    resolveRecord();
    await completion;
    expect(finished).toBe(true);
  });

  it("propagates Audio provider failures unchanged", async () => {
    const providerError = new Error("tts provider failed");
    ttsRequest.mockRejectedValue(providerError);

    await withAiBillingContext(context, async () => {
      const audio = Ai.Audio("1:model", context);
      await expect(audio.run({
        duration: 1,
        resolution: "1K",
        aspectRatio: "16:9",
        prompt: "hello",
        mode: [],
      } as any)).rejects.toBe(providerError);
    });

    expect(prepareProviderUsage).toHaveBeenCalledOnce();
    expect(prepareProviderUsage.mock.calls[0][2]).toMatchObject({
      vendorId: "1", model: "model", callType: "audio", usageStatus: "estimated",
      usage: { unit: "character", text: "hello" },
    });
    expect(recordProviderUsage).toHaveBeenCalledOnce();
    expect(recordProviderUsage.mock.calls[0][2]).toMatchObject({
      vendorId: "1", model: "model", callType: "audio", usageStatus: "uncertain",
    });
    expect(recordProviderUsage.mock.calls[0][2].providerCallId).toBe(prepareProviderUsage.mock.calls[0][2].providerCallId);
  });
});
