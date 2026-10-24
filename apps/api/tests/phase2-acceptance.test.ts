import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveJwtSecret } from "@/auth/secret";
import { signToken } from "@/auth/tokens";
import { currentAiBillingContext } from "@/billing/context";
import { InsufficientBalanceError, submitBilledJob } from "@/billing/submit";
import { reconcileBilling } from "@/billing/reconcile";
import { prepareProviderUsage, recordProviderUsage } from "@/billing/usage";
import { createJobRegistry } from "@/jobs/registry";
import { createJobStore } from "@/jobs/store";
import { startWorkerLoop } from "@/jobs/worker";
import { withJobTenant } from "@/jobs/tenant";
import type { JobDefinition } from "@/jobs/types";
import type { JobContext } from "@/jobs/types";
import { authenticate, authErrorHandler } from "@/middleware/auth";
import { tenantErrorHandler } from "@/middleware/tenant";
import router from "@/router";
import u from "@/utils";
import { dbReady, systemDb } from "@/utils/db";

const TAG = `phase2${crypto.randomBytes(6).toString("hex")}`;
let userId = 0;
let adminId = 0;
let modelGroupId = 0;
let userGroupId = 0;
let userToken = "";
let adminToken = "";
let port = 0;
let server: http.Server;

interface Reply { status: number; body: any; raw: string }
function request(method: string, pathname: string, token: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path: pathname,
      headers: { Authorization: token, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      timeout: 10000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = raw;
        try { parsed = JSON.parse(raw); } catch { /* retain raw response */ }
        resolve({ status: res.statusCode || 0, body: parsed, raw });
      });
    });
    req.on("timeout", () => req.destroy(new Error("HTTP request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function insertUser(username: string, role: "admin" | "user"): Promise<number> {
  const [id] = await systemDb("o_user").insert({
    username, email: null, passwordHash: "", role, status: "active", tokenVersion: 0,
    mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null,
  });
  return Number(id);
}

function waitForJob(store: ReturnType<typeof createJobStore>, jobId: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const job = await store.get(jobId, { all: true });
        if (job?.state === "succeeded") return resolve();
        if (job && ["dead", "failed", "canceled"].includes(job.state)) return reject(new Error(`Generated job ended in ${job.state}: ${job.lastError ?? ""}`));
        if (Date.now() >= deadline) return reject(new Error(`Generated job ${jobId} did not finish`));
        setTimeout(check, 20);
      } catch (error) { reject(error); }
    };
    void check();
  });
}

beforeAll(async () => {
  await dbReady;
  userId = await insertUser(`${TAG}_user`, "user");
  adminId = await insertUser(`${TAG}_admin`, "admin");
  await systemDb("o_account").insert({ userId, balanceMicro: "0", frozenMicro: "0", version: 0, updatedAt: Date.now() });
  const secret = await resolveJwtSecret();
  userToken = `Bearer ${signToken({ uid: userId, role: "user", tv: 0, typ: "access" }, secret)}`;
  adminToken = `Bearer ${signToken({ uid: adminId, role: "admin", tv: 0, typ: "access" }, secret)}`;
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => authenticate(req, res, next, "/api"));
  await router(app);
  app.use(tenantErrorHandler);
  app.use(authErrorHandler);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).send({ code: err?.status || 500, data: null, message: err?.message }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (userGroupId) {
    await systemDb("o_userGroupMembership").where({ userId }).del();
    await systemDb("o_userGroupModelGroup").where({ userGroupId }).del();
    await systemDb("o_userGroup").where({ id: userGroupId }).del();
  }
  if (modelGroupId) {
    await systemDb("o_userGroupModelGroup").where({ modelGroupId }).del();
    await systemDb("o_modelGroupItem").where({ modelGroupId }).del();
    await systemDb("o_modelGroup").where({ id: modelGroupId }).del();
  }
  await systemDb("o_vendorConfig").where({ id: TAG }).del();
});

describe("Phase 2 disposable acceptance", () => {
  it("credits one admin recharge, bills one generated provider call, and reconciles exact totals", async () => {
    const reportFrom = Date.now();
    const denied = await request("POST", "/api/billing/admin/recharges", userToken, { userId, amount: "2.000000", note: TAG });
    expect(denied.status, denied.raw).toBe(403);

    const created = await request("POST", "/api/billing/admin/recharges", adminToken, {
      userId, amount: "2.000000", note: TAG, idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status, created.raw).toBe(201);
    expect(created.body.data).toMatchObject({ status: "paid", balanceMicro: "2000000" });

    const model = `${TAG}-model`;
    await systemDb("o_vendorConfig").insert({
      id: TAG, enable: 1, inputValues: "{}", models: JSON.stringify([{ modelName: model, type: "text" }]),
    });
    const price = await request("POST", "/api/billing/admin/prices", adminToken, {
      vendorId: TAG, model, unit: "token", unitPriceMicro: "1", effectiveFrom: Date.now() - 1000,
    });
    expect(price.status, price.raw).toBe(201);
    const modelGroup = await request("POST", "/api/billing/admin/groups/model-groups", adminToken, {
      name: `${TAG}_models`, items: [{ vendorId: TAG, model, enabled: true, dailyLimit: 5 }],
    });
    expect(modelGroup.status, modelGroup.raw).toBe(201);
    modelGroupId = Number(modelGroup.body.data.id);
    const userGroup = await request("POST", "/api/billing/admin/groups/user-groups", adminToken, {
      name: `${TAG}_users`, modelGroupIds: [modelGroupId],
    });
    expect(userGroup.status, userGroup.raw).toBe(201);
    userGroupId = Number(userGroup.body.data.id);
    const assigned = await request("PUT", `/api/billing/admin/users/${userId}/groups`, adminToken, { groupIds: [userGroupId] });
    expect(assigned.status, assigned.raw).toBe(200);

    const callInput = {
      vendorId: TAG, model, callType: "text", providerCallId: `${TAG}:provider-1`, usageStatus: "success" as const,
      usage: { unit: "token" as const, inTokens: 3, outTokens: 2 },
    };
    const definition: JobDefinition<Record<string, never>> = {
      type: `${TAG}.generate`, timeoutMs: 10000, maxAttempts: 1, pool: TAG,
      parse: (raw) => raw as Record<string, never>,
      dedupeKey: () => null,
      handle: async (_ctx: JobContext) => {
        const context = currentAiBillingContext();
        await prepareProviderUsage(u.db as any, context, callInput);
        const providerResponse = { text: "generated", usage: callInput.usage };
        await recordProviderUsage(u.db as any, context, { ...callInput, usage: providerResponse.usage });
        return { text: providerResponse.text };
      },
    };
    const registry = createJobRegistry([definition]);
    const store = createJobStore({ db: u.db as any, registry });
    const submitted = await withJobTenant(userId, () => submitBilledJob({
      db: u.db as any, userId, estimateMicro: 1000n, idempotencyKey: `${TAG}:reservation`,
      createBusinessRows: async () => ({}),
      enqueue: async (trx) => store.enqueueInTransaction(trx, { type: definition.type, userId, payload: {} }),
    }));

    const runner = startWorkerLoop({ store, registry, workerId: `${TAG}-worker`, log: () => {} });
    try {
      await waitForJob(store, Number(submitted.jobId));
    } finally {
      await runner.stop();
    }

    const usageRows = await systemDb("o_usage").where({ userId, providerCallId: callInput.providerCallId });
    expect(usageRows).toHaveLength(1);
    expect(String(usageRows[0].costMicro)).toBe("5");
    const ledger = await systemDb("o_ledger").where({ userId }).orderBy("id");
    expect(ledger.map((row: any) => [row.type, String(row.amountMicro)])).toEqual([
      ["recharge", "2000000"], ["freeze", "1000"], ["consume", "-5"],
    ]);
    const account = await systemDb("o_account").where({ userId }).first();
    expect(String(account.balanceMicro)).toBe("1999995");
    expect(String(account.frozenMicro)).toBe("0");

    const report = await reconcileBilling(systemDb, { from: reportFrom, to: Date.now() + 1, dryRun: true });
    expect(report.drifts).toEqual([]);

    const beforeJobs = await systemDb("o_job").count({ count: "*" }).first();
    const beforeLedger = await systemDb("o_ledger").where({ userId }).count({ count: "*" }).first();
    await expect(withJobTenant(userId, () => submitBilledJob({
      db: u.db as any, userId, estimateMicro: 2_000_000n, idempotencyKey: `${TAG}:insufficient`,
      createBusinessRows: async () => ({}),
      enqueue: async (trx) => store.enqueueInTransaction(trx, { type: definition.type, userId, payload: {} }),
    }))).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await systemDb("o_job").count({ count: "*" }).first()).toEqual(beforeJobs);
    expect(await systemDb("o_ledger").where({ userId }).count({ count: "*" }).first()).toEqual(beforeLedger);
  });
});
