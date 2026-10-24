import { describe, expect, it, vi } from "vitest";

const { db, invoke, withVendorSlot, states } = vi.hoisted(() => {
  const states = new Map<number, Record<string, unknown>>();
  const assets = [
    { id: 11, assetsId: null },
    { id: 12, assetsId: null },
  ];
  const invoke = vi.fn();
  const withVendorSlot = vi.fn(async (_pool: string, _holder: string, fn: () => Promise<unknown>) => fn());
  const db = vi.fn((table: string) => ({
    where: (column: string, id: number) => ({
      select: () => ({ first: async () => table === "o_project" ? { artStyle: "test", videoRatio: "16:9", type: "novel", intro: "" } : undefined }),
      update: async (value: Record<string, unknown>) => {
        states.set(id, { ...states.get(id), ...value });
        return 1;
      },
    }),
    whereIn: (_column: string, ids: number[]) => ({
      select: async () => table === "o_assets" ? assets.filter((asset) => ids.includes(asset.id)) : [],
      update: async (value: Record<string, unknown>) => {
        ids.forEach((id) => states.set(id, { ...states.get(id), ...value }));
        return ids.length;
      },
    }),
  }));
  return { db, invoke, withVendorSlot, states };
});

vi.mock("@/utils", () => ({
  default: {
    db,
    feicai: {
      buildAssetPromptSystem: () => "system prompt",
      withOpaqueWhiteCanvas: (prompt: string) => prompt,
    },
    Ai: { Text: () => ({ invoke }) },
    error: (error: unknown) => ({ message: String(error) }),
  },
}));
vi.mock("@/billing/context", () => ({ currentAiBillingContext: () => ({ userId: 1 }) }));
vi.mock("@/jobs/gate", () => ({ apiHolderId: () => "api:test", withVendorSlot }));

import batchPolishAssetsPrompt from "@/routes/assetsGenerate/batchPolishAssetsPrompt";

const requestBody = {
  projectId: 1,
  concurrentCount: 2,
  otherTextPrompt: "",
  items: [
    { assetsId: 11, type: "role", name: "first", describe: "first" },
    { assetsId: 12, type: "role", name: "second", describe: "second" },
  ],
};

function routeHandler() {
  const route = (batchPolishAssetsPrompt as any).stack.find((layer: any) => layer.route).route;
  return route.stack[route.stack.length - 1].handle;
}

function response() {
  const result: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) { result.statusCode = code; return this; },
    send(body: unknown) { result.body = body; return body; },
  };
  return { result, res };
}

describe("batchPolishAssetsPrompt", () => {
  it("waits for and gates every selected prompt before responding", async () => {
    states.clear();
    withVendorSlot.mockClear();
    let release!: () => void;
    const providerWait = new Promise<void>((resolve) => { release = resolve; });
    invoke.mockImplementation(async () => {
      await providerWait;
      return { _output: "polished" };
    });
    const { result, res } = response();

    const completion = routeHandler()({ body: requestBody }, res);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    expect(result.statusCode).toBeUndefined();
    release();
    await completion;

    expect(result.statusCode).toBe(200);
    expect([...states.values()].filter((state) => state.promptState === "已完成")).toHaveLength(2);
    expect(withVendorSlot).toHaveBeenCalledTimes(2);
    expect(withVendorSlot).toHaveBeenCalledWith("vendor:text", "api:test", expect.any(Function));
  });

  it("marks unsupported asset types failed instead of leaving them generating", async () => {
    states.clear();
    invoke.mockReset();
    const { res } = response();

    await routeHandler()({
      body: { ...requestBody, items: [{ assetsId: 11, type: "unknown", name: "item", describe: "item" }] },
    }, res);

    expect(states.get(11)).toMatchObject({ promptState: "生成失败" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
