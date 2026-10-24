import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { reconcileBilling } from "@/billing/reconcile";

const TMP = path.join(os.tmpdir(), `miwo-billing-reconcile-${process.pid}`);
let db: Knex;
let filename: string;

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

beforeEach(async () => {
  await fs.mkdir(TMP, { recursive: true });
  filename = path.join(TMP, `reconcile-${Date.now()}-${Math.random()}.sqlite`);
  db = createKnex(cfg(filename));
  await runMigrations(db);
});

afterEach(async () => {
  await db.destroy();
  await fs.rm(filename, { force: true });
});

describe("billing reconciliation", () => {
  it("reports account, reservation, usage-key, provider, and order drift deterministically without writes", async () => {
    await db("o_account").insert({ userId: "71", balanceMicro: "100", frozenMicro: "5", version: 0, updatedAt: 10 });
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "30", balanceAfter: "90", refType: "job", refId: "41", createdAt: 20, idempotencyKey: "reserve:41", frozenAfterMicro: "30" },
    ]);
    await db("o_job").insert({
      id: 41, userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 20, updatedAt: 30, finishedAt: 30,
    });
    await db("o_order").insert({
      userId: "71", outTradeNo: "paid-order-1", channel: "manual", amountMicro: "25", status: "paid",
      type: "recharge", paidAt: 25, createdAt: 20, updatedAt: 25,
    });

    await db.raw("DROP INDEX o_usage_userid_providercallid_unique");
    const usageDefaults = {
      userId: "71", projectId: null, jobId: 41, vendorId: "vendor", model: "model", callType: "text",
      inTokens: null, outTokens: null, imageCount: null, videoSeconds: null, costMicro: "0", requestId: "req-1",
      unit: "unknown", quantity: null, priceId: null, usageStatus: "success", createdAt: 22,
    };
    await db("o_usage").insert([
      { ...usageDefaults, providerCallId: "duplicate-key" },
      { ...usageDefaults, providerCallId: "duplicate-key" },
      { ...usageDefaults, requestId: "", providerCallId: "" },
      { ...usageDefaults, providerCallId: "uncertain-call", usageStatus: "uncertain" },
    ]);

    const before = await fs.readFile(filename);
    const options = { from: 0, to: 100, dryRun: true };
    const first = await reconcileBilling(db, options);
    const second = await reconcileBilling(db, options);
    const nonDryRun = await reconcileBilling(db, { ...options, dryRun: false });
    const after = await fs.readFile(filename);

    expect(first).toEqual(second);
    expect(nonDryRun.drifts).toEqual(first.drifts);
    expect(nonDryRun.dryRun).toBe(false);
    expect(first.dryRun).toBe(true);
    expect(first.drifts.map((drift) => drift.type)).toEqual([
      "account-ledger", "job-reservation", "duplicate-usage-key", "missing-usage-key", "unresolved-provider", "order-credit",
    ]);
    expect(first.drifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "account-ledger", userId: "71", balanceMicro: "100", ledgerBalanceMicro: "90", frozenMicro: "5", ledgerFrozenMicro: "30" }),
      expect.objectContaining({ type: "job-reservation", userId: "71", jobId: "41", jobState: "succeeded" }),
      expect.objectContaining({ type: "duplicate-usage-key", userId: "71", providerCallId: "duplicate-key" }),
      expect.objectContaining({ type: "missing-usage-key", userId: "71" }),
      expect.objectContaining({ type: "unresolved-provider", userId: "71", providerCallId: "uncertain-call" }),
      expect.objectContaining({ type: "order-credit", userId: "71", orderId: "paid-order-1" }),
    ]));
    expect(after.equals(before)).toBe(true);
  });

  it("matches reservation anchors to terminal ledger rows on either side of the interval", async () => {
    await db("o_job").insert([
      { id: "81", userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1, priority: 100, createdAt: 5, updatedAt: 150, finishedAt: 150 },
      { id: "82", userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1, priority: 100, createdAt: 5, updatedAt: 150, finishedAt: 150 },
    ]);
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "100", frozenAfterMicro: "10", refType: "job", refId: "81", idempotencyKey: "reserve-81", createdAt: 10 },
      { userId: "71", type: "consume", amountMicro: "-10", balanceAfter: "90", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-81", idempotencyKey: "settle-81", createdAt: 100 },
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "80", frozenAfterMicro: "10", refType: "job", refId: "82", idempotencyKey: "reserve-82", createdAt: 5 },
      { userId: "71", type: "release", amountMicro: "10", balanceAfter: "80", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-82", idempotencyKey: "settle-82", createdAt: 20 }
    ]);

    const freezeWindow = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });
    const terminalWindow = await reconcileBilling(db, { from: 20, to: 100, dryRun: true });

    expect(freezeWindow.drifts.filter((drift) => drift.type === "job-reservation")).toEqual([]);
    expect(terminalWindow.drifts.filter((drift) => drift.type === "job-reservation")).toEqual([
      expect.objectContaining({ type: "job-reservation", jobId: "82", terminalState: "release", reason: "success-without-settlement" }),
    ]);
  });

  it("accepts the linked consume and debt-adjustment pair for an over-estimate settlement", async () => {
    await db("o_job").insert({
      id: "83", userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 5, updatedAt: 30, finishedAt: 30,
    });
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "100", frozenAfterMicro: "10", refType: "job", refId: "83", idempotencyKey: "reserve-83", createdAt: 10 },
      { userId: "71", type: "consume", amountMicro: "-10", balanceAfter: "90", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-83", idempotencyKey: "settle-83", createdAt: 20 },
      { userId: "71", type: "debt_adjustment", amountMicro: "-5", balanceAfter: "85", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-83", idempotencyKey: "~debt~:settle-83", createdAt: 20 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 30, dryRun: true });

    expect(report.drifts.filter((drift) => drift.type === "job-reservation")).toEqual([]);
  });

  it("reports admitted provider calls that have no persisted usage as unresolved in stable call order", async () => {
    await db("o_usageAdmission").insert([
      {
        userId: "71", providerCallId: "z-crashed-call", vendorId: "vendor", model: "model", dayStart: 0,
        admittedAt: 14, jobId: "91", requestId: "request-z", callType: "text",
      },
      {
        userId: "71", providerCallId: "a-crashed-call", vendorId: "vendor", model: "model", dayStart: 0,
        admittedAt: 15, jobId: "91", requestId: "request-a", callType: "text",
      },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts.filter((drift) => drift.type === "unresolved-provider")).toEqual([
      { type: "unresolved-provider", userId: "71", usageId: null, providerCallId: "a-crashed-call", source: "admission" },
      { type: "unresolved-provider", userId: "71", usageId: null, providerCallId: "z-crashed-call", source: "admission" },
    ]);
  });

  it("uses current job and order state for in-window immutable anchors", async () => {
    await db("o_account").insert({ userId: "71", balanceMicro: "50", frozenMicro: "0", version: 0, updatedAt: 200 });
    await db("o_job").insert({
      id: "91", userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 5, updatedAt: 200, finishedAt: 200,
    });
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "100", frozenAfterMicro: "10", refType: "job", refId: "91", idempotencyKey: "reserve-91", createdAt: 10 },
      { userId: "71", type: "consume", amountMicro: "-10", balanceAfter: "90", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-91", idempotencyKey: "settle-91", createdAt: 200 },
      { userId: "71", type: "recharge", amountMicro: "25", balanceAfter: "115", frozenAfterMicro: "0", refType: "recharge", refId: "out-100", idempotencyKey: "credit-100", createdAt: 200 },
      { userId: "71", type: "recharge", amountMicro: "30", balanceAfter: "145", frozenAfterMicro: "0", refType: "recharge", refId: "out-101", idempotencyKey: "credit-101", createdAt: 10 },
    ]);
    await db("o_order").insert([
      { userId: "71", outTradeNo: "out-100", channel: "manual", amountMicro: "25", status: "paid", type: "recharge", paidAt: 200, createdAt: 10, updatedAt: 200 },
      { userId: "71", outTradeNo: "out-101", channel: "manual", amountMicro: "30", status: "paid", type: "recharge", paidAt: 10, createdAt: 5, updatedAt: 200 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts.filter((drift) => drift.type === "job-reservation")).toEqual([]);
    expect(report.drifts.filter((drift) => drift.type === "order-credit")).toEqual([]);
    expect(report.drifts).toContainEqual(expect.objectContaining({
      type: "account-ledger", userId: "71", balanceMicro: "50", ledgerBalanceMicro: "115",
    }));
  });

  it("uses a half-open interval for immutable usage anchors", async () => {
    const defaults = {
      userId: "71", projectId: null, jobId: null, vendorId: "vendor", model: "model", callType: "text",
      inTokens: null, outTokens: null, imageCount: null, videoSeconds: null, costMicro: "0", requestId: "r",
      unit: "unknown", quantity: null, priceId: null, usageStatus: "uncertain",
    };
    await db("o_usage").insert([
      { ...defaults, providerCallId: "at-from", createdAt: 10 },
      { ...defaults, providerCallId: "at-to", createdAt: 20 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts.filter((drift) => drift.type === "unresolved-provider")).toEqual([
      { type: "unresolved-provider", userId: "71", usageId: expect.any(String), providerCallId: "at-from" },
    ]);
  });

  it("preserves identifiers and money above Number.MAX_SAFE_INTEGER exactly", async () => {
    const userId = "9007199254740993";
    const exactAmount = "9007199254740993";
    const jobId = "9007199254740993";
    await db("o_account").insert({ userId, balanceMicro: exactAmount, frozenMicro: "0", version: 0, updatedAt: 200 });
    await db("o_job").insert({
      id: jobId, userId, type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 5, updatedAt: 200, finishedAt: 200,
    });
    await db("o_ledger").insert([
      {
        userId, type: "recharge", amountMicro: exactAmount, balanceAfter: "9007199254740992", frozenAfterMicro: "0",
        refType: "recharge", refId: "large-order", idempotencyKey: "large-credit", createdAt: 10,
      },
      {
        userId, type: "freeze", amountMicro: "-1", balanceAfter: "9007199254740992", frozenAfterMicro: "0",
        refType: "job", refId: jobId, idempotencyKey: "large-reservation", createdAt: 11,
      },
    ]);
    await db("o_order").insert({
      userId, outTradeNo: "large-order", channel: "manual", amountMicro: exactAmount, status: "paid", type: "recharge",
      paidAt: 10, createdAt: 10, updatedAt: 200,
    });

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts).toContainEqual({
      type: "account-ledger", userId, balanceMicro: exactAmount, ledgerBalanceMicro: "9007199254740992",
      frozenMicro: "0", ledgerFrozenMicro: "0",
    });
    expect(report.drifts.filter((drift) => drift.type === "order-credit")).toEqual([]);
    expect(report.drifts).toContainEqual(expect.objectContaining({
      type: "job-reservation", userId, jobId, reservationId: "large-reservation", reason: "success-without-settlement",
    }));
  });

  it("reports a ranged ledger user whose current account is missing", async () => {
    await db("o_ledger").insert({
      userId: "72", type: "recharge", amountMicro: "10", balanceAfter: "10", frozenAfterMicro: "0",
      refType: "recharge", refId: "orphan-account", idempotencyKey: "credit-orphan", createdAt: 10,
    });

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts).toContainEqual({
      type: "missing-account", userId: "72", ledgerBalanceMicro: "10", ledgerFrozenMicro: "0",
    });
  });

  it("does not accept a terminal row with an invalid reference type", async () => {
    await db("o_job").insert({
      id: 101, userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 10, updatedAt: 15, finishedAt: 15,
    });
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "100", frozenAfterMicro: "10", refType: "job", refId: "101", idempotencyKey: "reserve-101", createdAt: 10 },
      { userId: "71", type: "consume", amountMicro: "-10", balanceAfter: "90", frozenAfterMicro: "0", refType: "job", refId: "reserve-101", idempotencyKey: "settle-101", createdAt: 15 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts).toContainEqual(expect.objectContaining({
      type: "job-reservation", jobId: "101", terminalState: "invalid", reason: "invalid-terminal-reference",
    }));
  });

  it("reports multiple terminal rows instead of hiding contradictory associations", async () => {
    await db("o_job").insert({
      id: 102, userId: "71", type: "test", payload: "{}", state: "succeeded", attempts: 1, maxAttempts: 1,
      priority: 100, createdAt: 10, updatedAt: 15, finishedAt: 15,
    });
    await db("o_ledger").insert([
      { userId: "71", type: "freeze", amountMicro: "-10", balanceAfter: "100", frozenAfterMicro: "10", refType: "job", refId: "102", idempotencyKey: "reserve-102", createdAt: 10 },
      { userId: "71", type: "consume", amountMicro: "-10", balanceAfter: "90", frozenAfterMicro: "0", refType: "reservation", refId: "reserve-102", idempotencyKey: "settle-102", createdAt: 15 },
      { userId: "71", type: "release", amountMicro: "0", balanceAfter: "90", frozenAfterMicro: "0", refType: "cancelled", refId: "reserve-102", idempotencyKey: "release-102", createdAt: 16 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts).toContainEqual(expect.objectContaining({
      type: "job-reservation", jobId: "102", terminalState: "multiple", reason: "multiple-terminal-events",
    }));
  });

  it("marks linked mutable state as current-at-execution in the report", async () => {
    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.stateSemantics).toBe("current-at-execution");
  });

  it("orders string identifiers by ordinal code units", async () => {
    const umlaut = String.fromCharCode(0xe4);
    await db("o_order").insert([
      { userId: "71", outTradeNo: umlaut, channel: "manual", amountMicro: "1", status: "paid", type: "recharge", createdAt: 10, updatedAt: 10 },
      { userId: "71", outTradeNo: "z", channel: "manual", amountMicro: "1", status: "paid", type: "recharge", createdAt: 10, updatedAt: 10 },
    ]);

    const report = await reconcileBilling(db, { from: 10, to: 20, dryRun: true });

    expect(report.drifts.filter((drift) => drift.type === "order-credit").map((drift) => drift.orderId)).toEqual(["z", umlaut]);
  });
});
