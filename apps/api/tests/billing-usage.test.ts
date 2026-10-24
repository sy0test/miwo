import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordProviderUsage, prepareProviderUsage, type ProviderUsageInput } from "@/billing/usage";
import type { AiBillingContext } from "@/billing/context";

let db: Knex;
const context: AiBillingContext = { userId: 7, jobId: "9007199254740993123", requestId: "req-1" };

beforeEach(async () => {
  db = knexFactory({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_modelGrant", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.string("agentKey").nullable();
    table.string("vendorId").nullable();
    table.string("model").nullable();
    table.boolean("enabled").notNullable();
    table.integer("dailyLimit").nullable();
    table.bigInteger("createdAt").notNullable();
  });
  await db.schema.createTable("o_modelGroup", (table) => {
    table.increments("id").primary();
    table.string("name").notNullable();
  });
  await db.schema.createTable("o_modelGroupItem", (table) => {
    table.integer("modelGroupId").notNullable();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.boolean("enabled").notNullable();
    table.integer("dailyLimit").nullable();
  });
  await db.schema.createTable("o_userGroup", (table) => {
    table.increments("id").primary();
    table.string("name").notNullable();
  });
  await db.schema.createTable("o_userGroupModelGroup", (table) => {
    table.integer("userGroupId").notNullable();
    table.integer("modelGroupId").notNullable();
  });
  await db.schema.createTable("o_userGroupMembership", (table) => {
    table.integer("userId").notNullable();
    table.integer("userGroupId").notNullable();
  });
  await db.schema.createTable("o_price", (table) => {
    table.increments("id").primary();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.string("unit").notNullable();
    table.text("unitPriceMicro").notNullable();
    table.bigInteger("effectiveFrom").notNullable();
    table.integer("createdBy").nullable();
  });
  await db.schema.createTable("o_dailyQuotaAdmission", (table) => {
    table.bigInteger("userId").notNullable();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.bigInteger("dayStart").notNullable();
    table.integer("admittedCount").notNullable();
    table.primary(["userId", "vendorId", "model", "dayStart"]);
  });
  await db.schema.createTable("o_usageAdmission", (table) => {
    table.bigInteger("userId").notNullable();
    table.string("providerCallId").notNullable();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.bigInteger("dayStart").notNullable();
    table.bigInteger("admittedAt").notNullable();
    table.bigInteger("jobId").nullable();
    table.string("requestId").notNullable();
    table.string("callType").notNullable();
    table.primary(["userId", "providerCallId"]);
  });
  await db.schema.createTable("o_usage", (table) => {
    table.increments("id").primary();
    table.bigInteger("userId").notNullable();
    table.bigInteger("projectId").nullable();
    table.bigInteger("jobId").nullable();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.string("callType").notNullable();
    table.integer("inTokens").nullable();
    table.integer("outTokens").nullable();
    table.integer("imageCount").nullable();
    table.text("videoSeconds").nullable();
    table.text("costMicro").notNullable();
    table.string("requestId").notNullable();
    table.string("providerCallId").notNullable();
    table.string("unit").notNullable();
    table.text("quantity").nullable();
    table.bigInteger("priceId").nullable();
    table.string("usageStatus").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.unique(["userId", "providerCallId"]);
  });
});

afterEach(async () => db.destroy());

async function grant(input: { agentKey?: string; vendorId?: string; model?: string; dailyLimit?: number; legacyOnly?: boolean }) {
  await db("o_modelGrant").insert({
    userId: context.userId,
    agentKey: input.agentKey ?? null,
    vendorId: input.vendorId ?? null,
    model: input.model ?? null,
    enabled: true,
    dailyLimit: input.dailyLimit ?? null,
    createdAt: 1,
  });
  if (input.agentKey !== undefined || input.legacyOnly) return;
  const [modelGroupId] = await db("o_modelGroup").insert({ name: `model-${input.vendorId}-${input.model}` });
  const [userGroupId] = await db("o_userGroup").insert({ name: `user-${modelGroupId}` });
  await db("o_modelGroupItem").insert({ modelGroupId, vendorId: input.vendorId, model: input.model, enabled: true, dailyLimit: input.dailyLimit ?? null });
  await db("o_userGroupModelGroup").insert({ userGroupId, modelGroupId });
  await db("o_userGroupMembership").insert({ userId: context.userId, userGroupId });
}

async function price(unit: string, unitPriceMicro: string, effectiveFrom = 0) {
  await db("o_price").insert({ vendorId: "vendor-a", model: "model-a", unit, unitPriceMicro, effectiveFrom, createdBy: null });
}

function tokenInput(overrides: Partial<ProviderUsageInput> = {}): ProviderUsageInput {
  return {
    vendorId: "vendor-a",
    model: "model-a",
    callType: "chat",
    providerCallId: "provider-call-1",
    at: new Date("2026-05-15T12:00:00.000Z"),
    usageStatus: "success",
    usage: { unit: "token", inTokens: 3, outTokens: 2 },
    ...overrides,
  } as ProviderUsageInput;
}

async function setupTokenGrant(dailyLimit?: number) {
  await grant({ vendorId: "vendor-a", model: "model-a", dailyLimit });
  await price("token", "9007199254740993");
}

async function recordAdmittedUsage(input: ProviderUsageInput, billingContext = context) {
  await prepareProviderUsage(db, billingContext, input);
  return recordProviderUsage(db, billingContext, input);
}

describe("provider usage billing", () => {
  it("prepares validated pricing before dispatch and records exact token usage", async () => {
    await setupTokenGrant();
    const prepared = await prepareProviderUsage(db, context, tokenInput());
    expect(prepared).toMatchObject({ unit: "token", quantity: "5", priceId: 1, costMicro: 45035996273704965n });

    const row = await recordProviderUsage(db, context, tokenInput());
    expect(row).toMatchObject({ userId: 7, jobId: "9007199254740993123", callType: "chat", inTokens: 3, outTokens: 2, quantity: "5", costMicro: "45035996273704965", usageStatus: "success" });
  });

  it("admits only the daily limit across concurrent preparations", async () => {
    await setupTokenGrant(2);
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      prepareProviderUsage(db, context, tokenInput({ providerCallId: `parallel-${i}` }))));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((result) => result.status === "rejected").length).toBe(6);
    await expect(db("o_dailyQuotaAdmission").first("admittedCount")).resolves.toMatchObject({ admittedCount: 2 });
  });

  it("does not consume another quota slot when persisting an admitted result", async () => {
    await setupTokenGrant(2);
    const input = tokenInput();
    await prepareProviderUsage(db, context, input);
    await expect(db("o_dailyQuotaAdmission").first("admittedCount")).resolves.toMatchObject({ admittedCount: 1 });
    await recordProviderUsage(db, context, input);
    await expect(db("o_dailyQuotaAdmission").first("admittedCount")).resolves.toMatchObject({ admittedCount: 1 });
  });

  it("admits repeated and concurrent use of one providerCallId only once without a usage placeholder", async () => {
    await setupTokenGrant(1);
    const input = tokenInput();
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => prepareProviderUsage(db, context, input)));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    await expect(db("o_dailyQuotaAdmission").first("admittedCount")).resolves.toMatchObject({ admittedCount: 1 });
    await expect(db("o_usageAdmission").count({ n: "*" }).first()).resolves.toMatchObject({ n: 1 });
    await expect(db("o_usage").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("rejects changed admission identity and reuses the stored UTC day after midnight", async () => {
    await setupTokenGrant(3);
    const input = tokenInput();
    await prepareProviderUsage(db, context, input);
    await expect(prepareProviderUsage(db, context, tokenInput({ vendorId: "vendor-b" }))).rejects.toThrow(/different|admission/i);
    await expect(prepareProviderUsage(db, context, tokenInput({ model: "model-b" }))).rejects.toThrow(/different|admission/i);
    await expect(prepareProviderUsage(db, context, tokenInput({ callType: "image" }))).rejects.toThrow(/different|admission/i);
    await expect(prepareProviderUsage(db, context, tokenInput({ at: new Date("2026-05-16T00:00:00.000Z") }))).resolves.toMatchObject({ unit: "token" });
    await expect(db("o_dailyQuotaAdmission").first("admittedCount", "dayStart")).resolves.toMatchObject({ admittedCount: 1, dayStart: Date.UTC(2026, 4, 15) });
  });

  it("fails closed when persisting a result without pre-dispatch admission", async () => {
    await setupTokenGrant();
    await expect(recordProviderUsage(db, context, tokenInput())).rejects.toThrow(/admission/i);
    await expect(db("o_usage").count({ n: "*" }).first()).resolves.toMatchObject({ n: 0 });
  });

  it("uses UTC day boundaries for quota admission", async () => {
    await setupTokenGrant(1);
    await prepareProviderUsage(db, context, tokenInput({ at: new Date("2026-05-15T23:59:59.999Z") }));
    await expect(prepareProviderUsage(db, context, tokenInput({ providerCallId: "next-day", at: new Date("2026-05-16T00:00:00.000Z") }))).resolves.toMatchObject({ unit: "token" });
  });

  it("deduplicates provider retries by user and provider call id without mutating history", async () => {
    await setupTokenGrant();
    const input = tokenInput();
    const first = await recordAdmittedUsage(input);
    const retry = await recordProviderUsage(db, context, input);
    expect(retry).toEqual(first);
    await expect(db("o_usage").count({ n: "*" }).first()).resolves.toMatchObject({ n: 1 });
  });

  it("allows an exact replay at its daily limit but rejects changed request and usage identity", async () => {
    await setupTokenGrant(1);
    const input = tokenInput();
    const first = await recordAdmittedUsage(input);
    await expect(recordAdmittedUsage(input, { ...context, requestId: "retry-request" })).rejects.toThrow(/call identity/i);
    const changed = tokenInput({ usage: { unit: "token", inTokens: 4, outTokens: 2 } });
    await prepareProviderUsage(db, context, changed);
    await expect(recordProviderUsage(db, context, changed)).rejects.toThrow(/different usage input/i);
    await expect(db("o_usage").count({ n: "*" }).first()).resolves.toMatchObject({ n: 1 });
  });

  it("requires an enabled exact Agent grant and never authorizes models from legacy grant rows", async () => {
    await price("token", "1");
    await expect(prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-a" }))).rejects.toMatchObject({ status: 403 });
    await grant({ agentKey: "agent-other" });
    await expect(prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-a" }))).rejects.toMatchObject({ status: 403 });
    await grant({ agentKey: "agent-a" });
    await expect(prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-a" }))).resolves.toMatchObject({ unit: "token" });

    await grant({ vendorId: "vendor-a", model: "model-a", legacyOnly: true });
    await expect(prepareProviderUsage(db, context, tokenInput({ providerCallId: "legacy-model-only" }))).rejects.toMatchObject({ status: 403 });
  });

  it("falls back to group model authorization when no exact Agent grant exists", async () => {
    await price("token", "1");
    await grant({ vendorId: "vendor-a", model: "model-a", dailyLimit: 4 });
    await expect(prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-with-group-access" }))).resolves.toMatchObject({ unit: "token" });
  });

  it("uses the agent grant daily limit instead of a broader model grant limit", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a", dailyLimit: 5 });
    await grant({ agentKey: "agent-a", dailyLimit: 1 });
    await price("token", "1");

    await prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-a" }));
    await expect(prepareProviderUsage(db, context, tokenInput({ agentKey: "agent-a", providerCallId: "agent-call-2" })))
      .rejects.toThrow(/daily limit/i);
  });

  it("enforces the grant daily call limit from immutable usage rows", async () => {
    await setupTokenGrant(1);
    await recordAdmittedUsage(tokenInput());
    await expect(prepareProviderUsage(db, context, tokenInput({ providerCallId: "provider-call-2" }))).rejects.toThrow(/daily limit/i);
  });

  it.each([
    [{ unit: "image" as const, imageCount: 2 }, "image", "2", "imageCount", 2],
    [{ unit: "video_second" as const, videoSeconds: "1.250000" }, "video_second", "1.25", "videoSeconds", "1.250000"],
    [{ unit: "character" as const, text: "é🙂x" }, "character", "4", undefined, undefined],
  ])("maps %s usage into schema units and exact quantities", async (usage, unit, quantity, metricColumn, metricValue) => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price(unit, "1000001");
    const input = tokenInput({ usage: usage as ProviderUsageInput["usage"], providerCallId: `call-${unit}` });
    const row = await recordAdmittedUsage(input);
    expect(row.unit).toBe(unit);
    expect(row.quantity).toBe(quantity);
    expect(row.costMicro).toBe(unit === "video_second" ? "1250001" : unit === "character" ? "4000004" : "2000002");
    if (metricColumn) expect(row[metricColumn as "imageCount" | "videoSeconds"]).toBe(metricValue);
  });

  it("prices call usage at quantity one and keeps token metrics analytics-only", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("token", "999999999");
    await price("call", "250000");

    const row = await recordAdmittedUsage(tokenInput({
      usage: { unit: "call", inTokens: 12, outTokens: 5 } as any,
      providerCallId: "call-priced",
    }));
    expect(row).toMatchObject({ unit: "call", quantity: "1", inTokens: 12, outTokens: 5, costMicro: "250000", priceId: 2 });
  });

  it("forces call quantity to one on replay and rejects missing call prices before admission", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("call", "17");
    const input = tokenInput({ usage: { unit: "call", inTokens: 1, outTokens: 2 } as any, providerCallId: "one-call" });
    const first = await recordAdmittedUsage(input);
    expect(first.quantity).toBe("1");
    const replay = await recordProviderUsage(db, context, { ...input, usage: { unit: "call", inTokens: 1, outTokens: 2, quantity: 2 } as any });
    expect(replay).toEqual(first);

    await db("o_price").where({ unit: "call" }).delete();
    await expect(prepareProviderUsage(db, context, tokenInput({
      usage: { unit: "call" } as any, providerCallId: "missing-call-price",
    }))).rejects.toThrow(/price/i);
    expect(await db("o_usageAdmission").where({ providerCallId: "missing-call-price" })).toHaveLength(0);
  });

  it("records tier-specific video units and charges each effective tier price", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("video_second_480p", "3000000");
    await price("video_second_720p", "5000000");

    const low = await recordAdmittedUsage(tokenInput({
      callType: "video", providerCallId: "video-480p",
      usage: { unit: "video_second_480p", videoSeconds: "2" } as any,
    }));
    const high = await recordAdmittedUsage(tokenInput({
      callType: "video", providerCallId: "video-720p",
      usage: { unit: "video_second_720p", videoSeconds: "2" } as any,
    }));

    expect(low).toMatchObject({ unit: "video_second_480p", quantity: "2", priceId: 1, costMicro: "6000000" });
    expect(high).toMatchObject({ unit: "video_second_720p", quantity: "2", priceId: 2, costMicro: "10000000" });
  });

  it("keeps requested tier usage while charging the generic video price during transition", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("video_second", "100000");

    const low = await recordAdmittedUsage(tokenInput({
      callType: "video", providerCallId: "fallback-480p",
      usage: { unit: "video_second_480p", videoSeconds: "2" } as any,
    }));
    const high = await recordAdmittedUsage(tokenInput({
      callType: "video", providerCallId: "fallback-720p",
      usage: { unit: "video_second_720p", videoSeconds: "2" } as any,
    }));

    expect(low).toMatchObject({ unit: "video_second_480p", priceId: 1, costMicro: "200000" });
    expect(high).toMatchObject({ unit: "video_second_720p", priceId: 1, costMicro: "200000" });
  });

  it("rejects a missing requested tier before recording an admission", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("video_second", "100000");
    await price("video_second_720p", "500000");

    await expect(prepareProviderUsage(db, context, tokenInput({
      callType: "video", providerCallId: "missing-480p",
      usage: { unit: "video_second_480p", videoSeconds: "2" } as any,
    }))).rejects.toThrow(/video_second_480p/);
    expect(await db("o_usageAdmission").where({ providerCallId: "missing-480p" })).toHaveLength(0);
    expect(await db("o_usage").where({ providerCallId: "missing-480p" })).toHaveLength(0);
  });

  it("records unmeasured provider outcomes without fabricating billable metrics", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    const unmeasured = await recordAdmittedUsage(tokenInput({
      usageStatus: "uncertain", usage: undefined, providerCallId: "unmeasured",
    }));
    expect(unmeasured).toMatchObject({
      usageStatus: "uncertain", unit: "unknown", quantity: null, priceId: null, costMicro: "0",
      inTokens: null, outTokens: null, imageCount: null, videoSeconds: null,
    });
  });

  it("preserves estimated and measured uncertain usage states", async () => {
    await setupTokenGrant();
    const estimated = await recordAdmittedUsage(tokenInput({ usageStatus: "estimated", providerCallId: "estimated" }));
    const uncertain = await recordAdmittedUsage(tokenInput({ usageStatus: "uncertain", providerCallId: "uncertain" }));
    expect(estimated.usageStatus).toBe("estimated");
    expect(uncertain.usageStatus).toBe("uncertain");
  });

  it("accepts six video decimal places and rejects excess precision", async () => {
    await grant({ vendorId: "vendor-a", model: "model-a" });
    await price("video_second", "1");
    await expect(prepareProviderUsage(db, context, tokenInput({ usage: { unit: "video_second", videoSeconds: "0.123456" } }))).resolves.toMatchObject({ videoSeconds: "0.123456" });
    await expect(prepareProviderUsage(db, context, tokenInput({ providerCallId: "excess-precision", usage: { unit: "video_second", videoSeconds: "0.1234567" } }))).rejects.toThrow(/fractional digits/i);
  });
});
