import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { resolveSubmissionEstimate, resolveTextSubmissionEstimate } from "@/billing/estimate";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-billing-estimate-"));
let db: Knex;

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

beforeEach(async () => {
  db = createKnex(cfg(path.join(TMP, `estimate-${Date.now()}-${Math.random()}.sqlite`)));
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

describe("generation submission estimate", () => {
  it("uses the request model, active unit price, and exact finite quantity", async () => {
    await db("o_price").insert({ vendorId: "vendor-a", model: "model-a", unit: "image", unitPriceMicro: "1250000", effectiveFrom: 1, createdBy: null });
    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "image", 3, new Date(2))).resolves.toBe(3_750_000n);
  });

  it("fails closed for missing active price, malformed model, and unbounded quantity", async () => {
    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "image", 1, new Date(2))).rejects.toThrow(/price/i);
    await expect(resolveSubmissionEstimate(db, "model-a", "image", 1, new Date(2))).rejects.toThrow(/model/i);
    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "image", Number.POSITIVE_INFINITY, new Date(2))).rejects.toThrow(/quantity/i);
  });

  it("estimates text submissions with only the latest active pricing unit", async () => {
    await db("o_price").insert([
      { vendorId: "vendor-a", model: "text-a", unit: "token", unitPriceMicro: "100", effectiveFrom: 1, createdBy: null },
      { vendorId: "vendor-a", model: "text-a", unit: "call", unitPriceMicro: "300", effectiveFrom: 20, createdBy: null },
      { vendorId: "vendor-a", model: "text-b", unit: "call", unitPriceMicro: "500", effectiveFrom: 1, createdBy: null },
    ]);

    await expect(resolveTextSubmissionEstimate(db, "vendor-a:text-a", 5, 2, new Date(10))).resolves.toBe(500n);
    await expect(resolveTextSubmissionEstimate(db, "vendor-a:text-a", 5, 2, new Date(20))).resolves.toBe(600n);
    await expect(resolveTextSubmissionEstimate(db, "vendor-a:text-b", 5, 2, new Date(20))).resolves.toBe(1000n);
  });

  it("rejects tied text modes and invalid unused quantities", async () => {
    await db("o_price").insert([
      { vendorId: "vendor-a", model: "text-a", unit: "token", unitPriceMicro: "100", effectiveFrom: 10, createdBy: null },
      { vendorId: "vendor-a", model: "text-a", unit: "call", unitPriceMicro: "300", effectiveFrom: 10, createdBy: null },
    ]);

    await expect(resolveTextSubmissionEstimate(db, "vendor-a:text-a", 5, 2, new Date(10))).rejects.toThrow(/ambiguous/i);
    await expect(resolveTextSubmissionEstimate(db, "vendor-a:text-a", 0, 2, new Date(9))).rejects.toThrow(/quantity/i);
  });

  it("uses the legacy video rate until a resolution-specific rate takes effect", async () => {
    await db("o_price").insert([
      { vendorId: "vendor-a", model: "model-a", unit: "video_second", unitPriceMicro: "100", effectiveFrom: 1, createdBy: null },
      { vendorId: "vendor-a", model: "model-a", unit: "video_second_480p", unitPriceMicro: "200", effectiveFrom: 300, createdBy: null },
    ]);

    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "video_second_480p", 2, new Date(299))).resolves.toBe(200n);
    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "video_second_480p", 2, new Date(300))).resolves.toBe(400n);
  });

  it("requires the requested tier after any resolution-specific rate is effective", async () => {
    await db("o_price").insert([
      { vendorId: "vendor-a", model: "model-a", unit: "video_second", unitPriceMicro: "100", effectiveFrom: 1, createdBy: null },
      { vendorId: "vendor-a", model: "model-a", unit: "video_second_480p", unitPriceMicro: "200", effectiveFrom: 100, createdBy: null },
    ]);

    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "video_second_720p", 2, new Date(99))).resolves.toBe(200n);
    await expect(resolveSubmissionEstimate(db, "vendor-a:model-a", "video_second_720p", 2, new Date(100))).rejects.toThrow(/price/i);
  });
});
