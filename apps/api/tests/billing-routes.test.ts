import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import router from "@/router";
import { dbReady, systemDb } from "@/utils/db";
import { resolveJwtSecret } from "@/auth/secret";
import { signToken } from "@/auth/tokens";
import { authenticate, authErrorHandler } from "@/middleware/auth";
import { tenantErrorHandler } from "@/middleware/tenant";

const TAG = `billroutes${crypto.randomBytes(4).toString("hex")}`;
let userId = 0;
let otherUserId = 0;
let adminId = 0;
let userToken = "";
let otherToken = "";
let adminToken = "";
let port = 0;
let server: http.Server;

interface Reply { status: number; body: any; raw: string }
function request(method: string, path: string, token: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path,
      headers: { Authorization: token, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      timeout: 20000,
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let parsed: any = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep raw response */ }
        resolve({ status: res.statusCode || 0, body: parsed, raw });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function tokenFor(id: number, role: "admin" | "user"): Promise<string> {
  const secret = await resolveJwtSecret();
  return `Bearer ${signToken({ uid: id, role, tv: 0, typ: "access" }, secret)}`;
}

async function insertUser(username: string, role: "admin" | "user"): Promise<number> {
  const [id] = await systemDb("o_user").insert({
    username, email: null, passwordHash: "", role, status: "active", tokenVersion: 0,
    mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null,
  });
  return Number(id);
}

async function seedTargetData(targetId: number): Promise<void> {
  await systemDb("o_account").insert({ userId: targetId, balanceMicro: "10000000", frozenMicro: "0", version: 0, updatedAt: Date.now() });
  await systemDb("o_ledger").insert({
    userId: targetId, type: "recharge", amountMicro: "10000000", balanceAfter: "10000000", frozenAfterMicro: "0",
    refType: "seed", refId: TAG, operatorId: null, createdAt: Date.now(), idempotencyKey: `${TAG}:seed:${targetId}`,
  });
  await systemDb("o_usage").insert({
    userId: targetId, projectId: null, jobId: null, vendorId: "vendor-a", model: "model-a", callType: "text",
    inTokens: 2, outTokens: 3, imageCount: null, videoSeconds: null, costMicro: "10", requestId: TAG,
    providerCallId: `${TAG}:usage:${targetId}`, unit: "token", quantity: "5", priceId: null,
    usageStatus: "success", createdAt: Date.now(),
  });
}

beforeAll(async () => {
  await dbReady;
  userId = await insertUser(`${TAG}_user`, "user");
  otherUserId = await insertUser(`${TAG}_other`, "user");
  adminId = await insertUser(`${TAG}_admin`, "admin");
  await seedTargetData(userId);
  await seedTargetData(otherUserId);
  userToken = await tokenFor(userId, "user");
  otherToken = await tokenFor(otherUserId, "user");
  adminToken = await tokenFor(adminId, "admin");

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
  if (userId) {
    await systemDb("o_usage").whereIn("userId", [userId, otherUserId]).del();
    await systemDb("o_ledger").whereIn("userId", [userId, otherUserId]).del();
    await systemDb("o_order").whereIn("userId", [userId, otherUserId]).del();
    await systemDb("o_price").where("vendorId", TAG).del();
    await systemDb("o_modelGrant").whereIn("userId", [userId, otherUserId]).del();
    await systemDb("o_account").whereIn("userId", [userId, otherUserId]).del();
    await systemDb("o_auditLog").where("detail", "like", `%${TAG}%`).del();
    await systemDb("o_user").whereIn("id", [userId, otherUserId, adminId]).del();
  }
});

describe("billing HTTP routes", () => {
  it("does not expose the retired update-check endpoint", async () => {
    const result = await request("POST", "/api/setting/about/checkUpdate", adminToken, { source: "toonflow" });
    expect(result.status, result.raw).toBe(404);
  });

  it("returns only the authenticated user's account, ledger, usage and orders", async () => {
    const account = await request("GET", "/api/billing/account", userToken);
    expect(account.status, account.raw).toBe(200);
    expect(account.body.data.userId).toBe(userId);

    const ledger = await request("GET", "/api/billing/ledger", userToken);
    expect(ledger.status, ledger.raw).toBe(200);
    expect(ledger.body.data.map((row: any) => row.userId)).toEqual([userId]);

    const usage = await request("GET", "/api/billing/usage", userToken);
    expect(usage.status, usage.raw).toBe(200);
    expect(usage.body.data.map((row: any) => row.userId)).toEqual([userId]);

    const orders = await request("GET", "/api/billing/orders", userToken);
    expect(orders.status, orders.raw).toBe(200);
    expect(orders.body.data).toEqual([]);
  });

  it("denies cross-user selectors on self-service billing reads", async () => {
    for (const path of ["account", "ledger", "usage", "orders"]) {
      const result = await request("GET", `/api/billing/${path}?userId=${otherUserId}`, userToken);
      expect(result.status, `${path}: ${result.raw}`).toBe(403);
    }
  });

  it("denies admin pricing, grant and recharge operations to ordinary users", async () => {
    const price = await request("POST", "/api/billing/admin/prices", userToken, { vendorId: TAG, model: "m", unit: "token", unitPriceMicro: "1", effectiveFrom: Date.now() });
    expect(price.status).toBe(403);
    const grant = await request("POST", "/api/billing/admin/grants", userToken, { userId: otherUserId, vendorId: TAG, model: "m", enabled: true, dailyLimit: 1 });
    expect(grant.status).toBe(403);
    const order = await request("POST", "/api/billing/admin/recharges", userToken, { userId: otherUserId, amount: "1.000000", note: TAG, idempotencyKey: crypto.randomUUID() });
    expect(order.status).toBe(403);
  });

  it("rejects direct recharge when the admin reason is missing or blank", async () => {
    const before = await systemDb("o_account").where({ userId: otherUserId }).first();
    for (const note of [undefined, "", "   "]) {
      const result = await request("POST", "/api/billing/admin/recharges", adminToken, {
        userId: otherUserId,
        amount: "1.000000",
        ...(note === undefined ? {} : { note }),
        idempotencyKey: crypto.randomUUID(),
      });
      expect(result.status, result.raw).toBe(400);
    }
    expect(await systemDb("o_account").where({ userId: otherUserId }).first()).toMatchObject({
      balanceMicro: before.balanceMicro, frozenMicro: before.frozenMicro, version: before.version,
    });
    expect(await systemDb("o_order").where({ userId: otherUserId, channel: "manual_admin" })).toHaveLength(0);
  });

  it("directly credits a target user's account once and records the admin actor", async () => {
    const idempotencyKey = crypto.randomUUID();
    const payload = { userId: otherUserId, amount: "2.500000", note: TAG, idempotencyKey };
    const created = await request("POST", "/api/billing/admin/recharges", adminToken, payload);
    expect(created.status, created.raw).toBe(201);
    expect(created.body.data).toMatchObject({ userId: otherUserId, status: "paid", channel: "manual_admin", type: "recharge", externalTradeId: null });
    expect(created.body.data.paidAt).toBeTruthy();
    expect(String(created.body.data.balanceMicro)).toBe("12500000");
    const orderId = created.body.data.id;
    const ownOrderList = await request("GET", "/api/billing/orders", otherToken);
    expect(ownOrderList.body.data.map((row: any) => row.id)).toContain(orderId);
    const wrongTenantList = await request("GET", "/api/billing/orders", userToken);
    expect(wrongTenantList.body.data).toEqual([]);
    expect(String((await systemDb("o_account").where({ userId: otherUserId }).first()).balanceMicro)).toBe("12500000");
    const ledger = await systemDb("o_ledger").where({ userId: otherUserId, refType: "recharge", refId: created.body.data.outTradeNo });
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].operatorId)).toBe(adminId);

    const replay = await request("POST", "/api/billing/admin/recharges", adminToken, payload);
    expect(replay.status, replay.raw).toBe(200);
    expect(replay.body.data.id).toBe(orderId);
    expect(String((await systemDb("o_account").where({ userId: otherUserId }).first()).balanceMicro)).toBe("12500000");
    expect(await systemDb("o_ledger").where({ userId: otherUserId, refType: "recharge", refId: created.body.data.outTradeNo })).toHaveLength(1);

    const changedPayloads = [
      { ...payload, userId },
      { ...payload, amount: "2.500001" },
    ];
    for (const changed of changedPayloads) {
      const conflict = await request("POST", "/api/billing/admin/recharges", adminToken, changed);
      expect(conflict.status, conflict.raw).toBe(409);
    }

    const audit = await systemDb("o_auditLog").where({ userId: adminId, action: "billing.recharge.create", target: String(otherUserId) }).orderBy("id", "desc").first();
    expect(audit?.userId).toBe(adminId);
    expect(audit?.role).toBe("admin");
    expect(audit?.detail).toContain(TAG);
  });

  it("confirms a historical pending recharge exactly once and rejects replay and mismatched amounts", async () => {
    const outTradeNo = `legacy_${crypto.randomUUID()}`;
    const [id] = await systemDb("o_order").insert({
      userId, outTradeNo, channel: "manual_admin", amountMicro: "1250000", status: "pending", paidAt: null,
      type: "recharge", externalTradeId: null, operatorId: adminId, operatorNote: TAG, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const mismatch = await request("POST", `/api/billing/admin/recharges/${id}/confirm`, adminToken, { userId, amount: "1.250001", externalTradeId: `${TAG}:external-mismatch` });
    expect(mismatch.status).toBe(400);
    const confirmed = await request("POST", `/api/billing/admin/recharges/${id}/confirm`, adminToken, { userId, amount: "1.250000", externalTradeId: `${TAG}:external` });
    expect(confirmed.status, confirmed.raw).toBe(200);
    const replay = await request("POST", `/api/billing/admin/recharges/${id}/confirm`, adminToken, { userId, amount: "1.250000", externalTradeId: `${TAG}:external` });
    expect(replay.status).toBe(409);
    const changed = await systemDb("o_account").where({ userId }).first();
    expect(String(changed.balanceMicro)).toBe("11250000");
    expect(Number(changed.version)).toBe(1);
    const ledger = await systemDb("o_ledger").where({ userId, refType: "recharge", refId: outTradeNo });
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].operatorId)).toBe(adminId);
  });

  it("rolls back account and ledger changes when order insertion fails", async () => {
    const marker = `${TAG}_order_failure`;
    const trigger = `billing_fail_${crypto.randomBytes(4).toString("hex")}`;
    const before = await systemDb("o_account").where({ userId: otherUserId }).first();
    const ledgerBefore = await systemDb("o_ledger").where({ userId: otherUserId }).count({ count: "*" }).first();
    try {
      await systemDb.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON o_order WHEN NEW.operatorNote = '${marker}' BEGIN SELECT RAISE(ABORT, 'forced order failure'); END`);
      const result = await request("POST", "/api/billing/admin/recharges", adminToken, {
        userId: otherUserId, amount: "1.000000", note: marker, idempotencyKey: crypto.randomUUID(),
      });
      expect(result.status, result.raw).toBe(500);
      expect(await systemDb("o_account").where({ userId: otherUserId }).first()).toMatchObject({
        balanceMicro: before.balanceMicro, frozenMicro: before.frozenMicro, version: before.version,
      });
      expect(await systemDb("o_ledger").where({ userId: otherUserId }).count({ count: "*" }).first()).toEqual(ledgerBefore);
    } finally {
      await systemDb.raw(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it("initializes a missing target account in the direct recharge transaction", async () => {
    const missingAccountUser = await insertUser(`${TAG}_no_account`, "user");
    try {
      const result = await request("POST", "/api/billing/admin/recharges", adminToken, {
        userId: missingAccountUser, amount: "0.750001", note: TAG, idempotencyKey: crypto.randomUUID(),
      });
      expect(result.status, result.raw).toBe(201);
      expect(String((await systemDb("o_account").where({ userId: missingAccountUser }).first()).balanceMicro)).toBe("750001");
      expect(await systemDb("o_ledger").where({ userId: missingAccountUser })).toHaveLength(1);
    } finally {
      await systemDb("o_ledger").where({ userId: missingAccountUser }).del();
      await systemDb("o_order").where({ userId: missingAccountUser }).del();
      await systemDb("o_account").where({ userId: missingAccountUser }).del();
      await systemDb("o_user").where({ id: missingAccountUser }).del();
    }
  });

  it("rejects negative, malformed and signed-64-bit-overflow recharge amounts", async () => {
    for (const amount of ["-1", "1.0000001", "9223372036854.775808"]) {
      const result = await request("POST", "/api/billing/admin/recharges", adminToken, { userId, amount, note: TAG });
      expect(result.status, `${amount}: ${result.raw}`).toBe(400);
    }
  });

  it("appends effective-dated prices without changing historical rows", async () => {
    const firstAt = Date.now() - 1000;
    const first = await request("POST", "/api/billing/admin/prices", adminToken, { vendorId: TAG, model: "m", unit: "token", unitPriceMicro: "10", effectiveFrom: firstAt });
    expect(first.status, first.raw).toBe(201);
    const second = await request("POST", "/api/billing/admin/prices", adminToken, { vendorId: TAG, model: "m", unit: "token", unitPriceMicro: "20", effectiveFrom: firstAt + 500 });
    expect(second.status, second.raw).toBe(201);
    const rows = await systemDb("o_price").where({ vendorId: TAG, model: "m", unit: "token" }).orderBy("effectiveFrom", "asc");
    expect(rows.map((row: any) => String(row.unitPriceMicro))).toEqual(["10", "20"]);
    expect(Number(rows[0].effectiveFrom)).toBe(firstAt);
  });

  it("accepts call prices and rejects unsupported units", async () => {
    const effectiveFrom = Date.now() - 1000;
    const created = await request("POST", "/api/billing/admin/prices", adminToken, {
      vendorId: TAG, model: "call-priced-model", unit: "call", unitPriceMicro: "250000", effectiveFrom,
    });
    expect(created.status, created.raw).toBe(201);
    expect(created.body.data).toMatchObject({ unit: "call", unitPriceMicro: "250000", effectiveFrom });

    const unsupported = await request("POST", "/api/billing/admin/prices", adminToken, {
      vendorId: TAG, model: "call-priced-model", unit: "request", unitPriceMicro: "1", effectiveFrom,
    });
    expect(unsupported.status, unsupported.raw).toBe(400);
  });

  it("accepts resolution-specific video units and preserves them in price history", async () => {
    const model = `${TAG}-video-tiers`;
    for (const unit of ["video_second_480p", "video_second_720p"]) {
      const created = await request("POST", "/api/billing/admin/prices", adminToken, {
        vendorId: TAG, model, unit, unitPriceMicro: "250000", effectiveFrom: Date.now(),
      });
      expect(created.status, created.raw).toBe(201);
      expect(created.body.data.unit).toBe(unit);
    }

    const history = await request("GET", `/api/billing/admin/prices?vendorId=${encodeURIComponent(TAG)}&model=${encodeURIComponent(model)}`, adminToken);
    expect(history.status, history.raw).toBe(200);
    expect(history.body.data.items.map((row: any) => row.unit).sort()).toEqual(["video_second_480p", "video_second_720p"]);

    const unsupported = await request("POST", "/api/billing/admin/prices", adminToken, {
      vendorId: TAG, model, unit: "video_second_1080p", unitPriceMicro: "1", effectiveFrom: Date.now(),
    });
    expect(unsupported.status, unsupported.raw).toBe(400);
  });

  it("lists append-only price history for admins with bounded vendor and model filters", async () => {
    const historyVendor = `${TAG}-history`;
    const historyModel = `${TAG}-history-model`;
    const otherModel = `${TAG}-other-model`;
    const firstAt = Date.now() - 4000;
    for (const price of [
      { vendorId: historyVendor, model: historyModel, unit: "token", unitPriceMicro: "10", effectiveFrom: firstAt },
      { vendorId: historyVendor, model: historyModel, unit: "image", unitPriceMicro: "20", effectiveFrom: firstAt + 1000 },
      { vendorId: historyVendor, model: otherModel, unit: "token", unitPriceMicro: "30", effectiveFrom: firstAt + 2000 },
      { vendorId: `${historyVendor}-other`, model: historyModel, unit: "token", unitPriceMicro: "40", effectiveFrom: firstAt + 3000 },
    ]) {
      const created = await request("POST", "/api/billing/admin/prices", adminToken, price);
      expect(created.status, created.raw).toBe(201);
    }

    const denied = await request("GET", "/api/billing/admin/prices", userToken);
    expect(denied.status, denied.raw).toBe(403);

    const byVendor = await request("GET", `/api/billing/admin/prices?vendorId=${encodeURIComponent(historyVendor)}`, adminToken);
    expect(byVendor.status, byVendor.raw).toBe(200);
    expect(byVendor.body).toMatchObject({ code: 200, message: "定价历史已读取" });
    expect(byVendor.body.data.items).toHaveLength(3);
    expect(byVendor.body.data.total).toBe(3);
    expect(byVendor.body.data.items.map((row: any) => row.model)).toEqual([otherModel, historyModel, historyModel]);

    const byModel = await request("GET", `/api/billing/admin/prices?model=${encodeURIComponent(historyModel)}`, adminToken);
    expect(byModel.status, byModel.raw).toBe(200);
    expect(byModel.body.data.items).toHaveLength(3);
    expect(byModel.body.data.items.every((row: any) => row.model === historyModel)).toBe(true);

    const combined = await request("GET", `/api/billing/admin/prices?vendorId=${encodeURIComponent(historyVendor)}&model=${encodeURIComponent(historyModel)}&limit=1&offset=1`, adminToken);
    expect(combined.status, combined.raw).toBe(200);
    expect(combined.body.data).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(combined.body.data.items).toHaveLength(1);
    expect(combined.body.data.items[0]).toMatchObject({ vendorId: historyVendor, model: historyModel, unitPriceMicro: "10" });

    for (const query of ["limit=201", "offset=1000001", `vendorId=${"v".repeat(33)}`, "model="]) {
      const invalid = await request("GET", `/api/billing/admin/prices?${query}`, adminToken);
      expect(invalid.status, `${query}: ${invalid.raw}`).toBe(400);
    }
  });

  it("rejects a duplicate effective price for the same vendor, model and unit", async () => {
    const effectiveFrom = Date.now() - 2000;
    const first = await request("POST", "/api/billing/admin/prices", adminToken, { vendorId: TAG, model: "duplicate-price", unit: "token", unitPriceMicro: "10", effectiveFrom });
    expect(first.status, first.raw).toBe(201);

    const duplicate = await request("POST", "/api/billing/admin/prices", adminToken, { vendorId: TAG, model: "duplicate-price", unit: "token", unitPriceMicro: "20", effectiveFrom });
    expect(duplicate.status, duplicate.raw).toBe(409);

    const otherUnit = await request("POST", "/api/billing/admin/prices", adminToken, { vendorId: TAG, model: "duplicate-price", unit: "image", unitPriceMicro: "30", effectiveFrom });
    expect(otherUnit.status, otherUnit.raw).toBe(201);
  });

  it("rejects direct vendor/model grants while retaining Agent grants", async () => {
    const modelGrant = await request("POST", "/api/billing/admin/grants", adminToken, {
      userId, vendorId: TAG, model: "legacy-direct", enabled: true, dailyLimit: 5,
    });
    expect(modelGrant.status, modelGrant.raw).toBe(400);

    const agentGrant = await request("POST", "/api/billing/admin/grants", adminToken, {
      userId, agentKey: `${TAG}-agent`, enabled: true, dailyLimit: 5,
    });
    expect(agentGrant.status, agentGrant.raw).toBe(201);
    expect(agentGrant.body.data.agentKey).toBe(`${TAG}-agent`);
  });

  it("maps concurrent grant identity inserts to one create and one conflict", async () => {
    const grant = { userId, agentKey: `${TAG}-race-agent`, enabled: true };
    const results = await Promise.all([
      request("POST", "/api/billing/admin/grants", adminToken, grant),
      request("POST", "/api/billing/admin/grants", adminToken, grant),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.message).toBe("相同模型授权已存在");
  });

  it("maps concurrent price identity inserts to one create and one conflict", async () => {
    const price = { vendorId: TAG, model: "race-price", unit: "token", unitPriceMicro: "1", effectiveFrom: Date.now() };
    const results = await Promise.all([
      request("POST", "/api/billing/admin/prices", adminToken, price),
      request("POST", "/api/billing/admin/prices", adminToken, price),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.message).toBe("相同生效时间的定价已存在");
  });

  it("does not persist direct user model grants", async () => {
    const denied = await request("POST", "/api/billing/admin/grants", adminToken, { userId, vendorId: TAG, model: "direct-model", enabled: false, dailyLimit: 5 });
    expect(denied.status, denied.raw).toBe(400);
    const directGrant = await systemDb("o_modelGrant").where({ userId, vendorId: TAG, model: "direct-model" }).first();
    expect(directGrant).toBeFalsy();
  });
});
