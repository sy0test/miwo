import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAI } = vi.hoisted(() => ({ createOpenAI: vi.fn() }));

vi.mock("@/vendors/runtime", () => ({
  createOpenAI,
  createDeepSeek: vi.fn(),
  createZhipu: vi.fn(),
  createQwen: vi.fn(),
  createAnthropic: vi.fn(),
  createOpenAICompatible: vi.fn(),
  createXai: vi.fn(),
  createMinimax: vi.fn(),
  createGoogleGenerativeAI: vi.fn(),
  zipImage: vi.fn(),
  zipImageResolution: vi.fn(),
  urlToBase64: vi.fn(),
  mergeImages: vi.fn(),
  pollTask: vi.fn(),
  logger: vi.fn(),
  jsonwebtoken: {},
  crypto: {},
  FormData: class {},
  axios: { get: vi.fn(), post: vi.fn() },
}));

import { textRequest, vendor } from "@/vendors/newapi";

describe("NewAPI request-scoped configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the persisted key and base URL without changing the adapter singleton", () => {
    const chat = vi.fn().mockReturnValue({ model: "configured-model" });
    createOpenAI.mockReturnValue({ chat });
    const requestVendor = {
      ...vendor,
      inputValues: { ...vendor.inputValues, apiKey: "request-only-key", baseUrl: "https://request.example/v1" },
    };

    const result = textRequest({ modelName: "test-model" } as any, false, 0, requestVendor as any);

    expect(createOpenAI).toHaveBeenCalledWith({ baseURL: "https://request.example/v1", apiKey: "request-only-key" });
    expect(chat).toHaveBeenCalledWith("test-model");
    expect(result).toEqual({ model: "configured-model" });
    expect(vendor.inputValues).not.toMatchObject({ apiKey: "request-only-key", baseUrl: "https://request.example/v1" });
  });
});
