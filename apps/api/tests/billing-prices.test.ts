import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as priceResolvers from "@/billing/prices";
import { resolvePrice, resolveTextPricingUnit } from "@/billing/prices";

let db: Knex;

beforeEach(async () => {
  db = knexFactory({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_price", (table) => {
    table.increments("id").primary();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.string("unit").notNullable();
    table.text("unitPriceMicro").notNullable();
    table.bigInteger("effectiveFrom").notNullable();
    table.integer("createdBy").nullable();
  });
});

afterEach(async () => db.destroy());

async function addPrice(effectiveFrom: number, unitPriceMicro: string | number) {
  const [id] = await db("o_price").insert({
    vendorId: "vendor-a", model: "model-a", unit: "token", unitPriceMicro: String(unitPriceMicro), effectiveFrom, createdBy: 1,
  });
  return id;
}

describe("effective-dated price resolution", () => {
  it("selects the latest effective price at the call-time boundary", async () => {
    const olderId = await addPrice(100, "9007199254740993");
    const currentId = await addPrice(200, "12345678901234567890");
    await addPrice(300, "999");

    await expect(resolvePrice(db, "vendor-a", "model-a", "token", new Date(199))).resolves.toMatchObject({
      id: olderId,
      unitPriceMicro: 9007199254740993n,
    });
    await expect(resolvePrice(db, "vendor-a", "model-a", "token", new Date(200))).resolves.toMatchObject({
      id: currentId,
      unitPriceMicro: 12345678901234567890n,
    });
  });

  it("fails closed when no price is effective yet", async () => {
    await addPrice(200, 10);
    await expect(resolvePrice(db, "vendor-a", "model-a", "token", new Date(199))).rejects.toThrow();
  });

  it("fails closed when multiple prices have the same latest effective time", async () => {
    await addPrice(100, 10);
    await addPrice(200, 20);
    await addPrice(200, 30);
    await expect(resolvePrice(db, "vendor-a", "model-a", "token", new Date(250))).rejects.toThrow();
  });

  it("rejects a negative stored unit price", async () => {
    await addPrice(100, "-1");
    await expect(resolvePrice(db, "vendor-a", "model-a", "token", new Date(100))).rejects.toThrow();
  });

  it("does not mutate price history during resolution", async () => {
    await addPrice(100, 10);
    await resolvePrice(db, "vendor-a", "model-a", "token", new Date(100));
    await expect(db("o_price").count({ count: "*" }).first()).resolves.toMatchObject({ count: 1 });
  });
});

describe("text price mode resolution", () => {
  async function addTextPrice(unit: "token" | "call", effectiveFrom: number, unitPriceMicro = "10") {
    await db("o_price").insert({ vendorId: "vendor-a", model: "model-a", unit, unitPriceMicro, effectiveFrom, createdBy: 1 });
  }

  it("switches to the latest effective token or call mode without activating future prices early", async () => {
    await addTextPrice("token", 100);
    await addTextPrice("call", 300);
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(299))).resolves.toBe("token");
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(300))).resolves.toBe("call");
    await addTextPrice("token", 400, "20");
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(400))).resolves.toBe("token");
  });

  it("fails closed when token and call modes share the latest effective time", async () => {
    await addTextPrice("token", 200);
    await addTextPrice("call", 200);
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(250))).rejects.toThrow(/ambiguous/i);
  });

  it("fails when no text price is effective and preserves same-unit ambiguity checks", async () => {
    await addTextPrice("call", 200);
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(199))).rejects.toThrow(/price/i);
    await addTextPrice("call", 300);
    await addTextPrice("call", 300, "20");
    await expect(resolveTextPricingUnit(db, "vendor-a", "model-a", new Date(400))).rejects.toThrow(/ambiguous/i);
  });
});

describe("resolution-aware video prices", () => {
  async function addVideoPrice(unit: string, effectiveFrom: number, unitPriceMicro: string) {
    await db("o_price").insert({ vendorId: "vendor-a", model: "model-a", unit, unitPriceMicro, effectiveFrom, createdBy: 1 });
  }

  const resolveVideoPrice = (priceResolvers as any).resolveVideoPrice as typeof resolvePrice;

  it("falls back to the generic rate until either tier is effective", async () => {
    await addVideoPrice("video_second", 1, "100");
    await addVideoPrice("video_second_720p", 200, "300");

    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second_480p", new Date(199)))
      .resolves.toMatchObject({ unit: "video_second", unitPriceMicro: 100n });
    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second_480p", new Date(200)))
      .rejects.toThrow(/price/i);
    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second_720p", new Date(200)))
      .resolves.toMatchObject({ unit: "video_second_720p", unitPriceMicro: 300n });
  });

  it("selects each exact tier and keeps non-tier resolutions generic", async () => {
    await addVideoPrice("video_second", 1, "100");
    await addVideoPrice("video_second_480p", 100, "200");
    await addVideoPrice("video_second_720p", 150, "300");

    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second_480p", new Date(149)))
      .resolves.toMatchObject({ unitPriceMicro: 200n });
    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second_720p", new Date(150)))
      .resolves.toMatchObject({ unitPriceMicro: 300n });
    await expect(resolveVideoPrice(db, "vendor-a", "model-a", "video_second", new Date(200)))
      .resolves.toMatchObject({ unit: "video_second", unitPriceMicro: 100n });
  });
});
