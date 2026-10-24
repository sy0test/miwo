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

const TAG = `adminGroups${crypto.randomBytes(4).toString("hex")}`;
let userId = 0;
let otherUserId = 0;
let adminId = 0;
let userToken = "";
let adminToken = "";
let modelGroupId = 0;
let userGroupId = 0;
let newApiConfigCreated = false;
let newApiPreviousEnable: number | null = null;
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

async function addUser(username: string, role: "admin" | "user"): Promise<number> {
  const [id] = await systemDb("o_user").insert({
    username, email: null, passwordHash: `${TAG}-secret`, role, status: "active", tokenVersion: 0,
    mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null,
  });
  await systemDb("o_account").insert({ userId: id, balanceMicro: "1234567", frozenMicro: "230000", version: 0, updatedAt: Date.now() });
  return Number(id);
}

async function tokenFor(id: number, role: "admin" | "user"): Promise<string> {
  const secret = await resolveJwtSecret();
  return `Bearer ${signToken({ uid: id, role, tv: 0, typ: "access" }, secret)}`;
}

beforeAll(async () => {
  await dbReady;
  userId = await addUser(`${TAG}_user`, "user");
  otherUserId = await addUser(`${TAG}_other`, "user");
  adminId = await addUser(`${TAG}_admin`, "admin");
  await systemDb("o_vendorConfig").insert({ id: TAG, enable: 1, inputValues: "{}", models: JSON.stringify([{ modelName: "model-a", type: "text" }]) });
  const existingNewApi = await systemDb("o_vendorConfig").where({ id: "newapi" }).first("id", "enable");
  if (!existingNewApi) {
    await systemDb("o_vendorConfig").insert({ id: "newapi", enable: 1, inputValues: "{}", models: "[]" });
    newApiConfigCreated = true;
  } else {
    newApiPreviousEnable = Number(existingNewApi.enable);
    if (newApiPreviousEnable !== 1) await systemDb("o_vendorConfig").where({ id: "newapi" }).update({ enable: 1 });
  }
  userToken = await tokenFor(userId, "user");
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
    await systemDb("o_userGroupMembership").whereIn("userId", [userId, otherUserId]).del();
    if (userGroupId) {
      await systemDb("o_userGroupModelGroup").where({ userGroupId }).del();
      await systemDb("o_userGroup").where({ id: userGroupId }).del();
    }
    if (modelGroupId) {
      await systemDb("o_userGroupModelGroup").where({ modelGroupId }).del();
      await systemDb("o_modelGroupItem").where({ modelGroupId }).del();
      await systemDb("o_modelGroup").where({ id: modelGroupId }).del();
    }
    await systemDb("o_user").whereIn("id", [userId, otherUserId, adminId]).del();
    await systemDb("o_account").whereIn("userId", [userId, otherUserId, adminId]).del();
    await systemDb("o_vendorConfig").where({ id: TAG }).del();
    if (newApiConfigCreated) await systemDb("o_vendorConfig").where({ id: "newapi" }).del();
    else if (newApiPreviousEnable !== null) await systemDb("o_vendorConfig").where({ id: "newapi" }).update({ enable: newApiPreviousEnable });
  }
});

describe("billing admin users and groups API", () => {
  it("limits user search to safe account fields and requires admin access", async () => {
    const denied = await request("GET", "/api/billing/admin/users", userToken);
    expect(denied.status).toBe(403);

    const result = await request("GET", `/api/billing/admin/users?search=${encodeURIComponent(TAG + "_user")}&limit=1&offset=0`, adminToken);
    expect(result.status, result.raw).toBe(200);
    expect(result.body.data.total).toBe(1);
    expect(result.body.data.items[0]).toMatchObject({
      id: userId, username: `${TAG}_user`, role: "user", status: "active",
      balanceMicro: "1234567", frozenMicro: "230000", groupIds: [], groupNames: [],
    });
    expect(JSON.stringify(result.body)).not.toMatch(/passwordHash|tokenVersion|secret/i);
    const byId = await request("GET", `/api/billing/admin/users?search=${userId}&limit=1&offset=0`, adminToken);
    expect(byId.status, byId.raw).toBe(200);
    expect(byId.body.data.items.map((item: any) => item.id)).toEqual([userId]);
  });

  it("protects group management and target membership replacement", async () => {
    const deniedGroups = await request("GET", "/api/billing/admin/groups", userToken);
    expect(deniedGroups.status).toBe(403);
    const deniedMembership = await request("PUT", `/api/billing/admin/users/${userId}/groups`, userToken, { groupIds: [] });
    expect(deniedMembership.status).toBe(403);

    const unassignedModels = await request("POST", "/api/modelSelect/getModelList", userToken, { type: "text" });
    expect(unassignedModels.status, unassignedModels.raw).toBe(200);
    expect(unassignedModels.body.data).toEqual([]);

    const adminModels = await request("POST", "/api/modelSelect/getModelList", adminToken, { type: "text" });
    expect(adminModels.status, adminModels.raw).toBe(200);
    expect(adminModels.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "newapi", value: "gpt-5.5", type: "text" }),
    ]));

    const badModel = await request("POST", "/api/billing/admin/groups/model-groups", adminToken, {
      name: `${TAG}_bad_models`, items: [{ vendorId: TAG, model: "not-configured", enabled: true, dailyLimit: 25 }],
    });
    expect(badModel.status, badModel.raw).toBe(400);
    const modelGroup = await request("POST", "/api/billing/admin/groups/model-groups", adminToken, {
      name: `${TAG}_models`, items: [{ vendorId: "newapi", model: "gpt-5.5", enabled: true, dailyLimit: 25 }],
    });
    expect(modelGroup.status, modelGroup.raw).toBe(201);
    modelGroupId = Number(modelGroup.body.data.id);
    const duplicateGroupIds = await request("POST", "/api/billing/admin/groups/user-groups", adminToken, {
      name: `${TAG}_duplicate_users`, modelGroupIds: [modelGroup.body.data.id, modelGroup.body.data.id],
    });
    expect(duplicateGroupIds.status, duplicateGroupIds.raw).toBe(400);
    const userGroup = await request("POST", "/api/billing/admin/groups/user-groups", adminToken, {
      name: `${TAG}_users`, modelGroupIds: [modelGroup.body.data.id],
    });
    expect(userGroup.status, userGroup.raw).toBe(201);
    userGroupId = Number(userGroup.body.data.id);

    const assigned = await request("PUT", `/api/billing/admin/users/${userId}/groups`, adminToken, { groupIds: [userGroup.body.data.id] });
    expect(assigned.status, assigned.raw).toBe(200);
    const assignedModels = await request("POST", "/api/modelSelect/getModelList", userToken, { type: "text" });
    expect(assignedModels.status, assignedModels.raw).toBe(200);
    expect(assignedModels.body.data).toEqual([
      expect.objectContaining({ id: "newapi", value: "gpt-5.5", type: "text" }),
    ]);
    const addBuiltinNewApiModel = await request("PATCH", `/api/billing/admin/groups/model-groups/${modelGroupId}`, adminToken, {
      items: [{ vendorId: "newapi", model: "gpt-image-2.5-sunburst", enabled: true, dailyLimit: null }],
    });
    expect(addBuiltinNewApiModel.status, addBuiltinNewApiModel.raw).toBe(200);
    const invalidReplacement = await request("PUT", `/api/billing/admin/users/${userId}/groups`, adminToken, { groupIds: [999999999] });
    expect(invalidReplacement.status, invalidReplacement.raw).toBe(400);
    const duplicateReplacement = await request("PUT", `/api/billing/admin/users/${userId}/groups`, adminToken, { groupIds: [userGroup.body.data.id, userGroup.body.data.id] });
    expect(duplicateReplacement.status, duplicateReplacement.raw).toBe(400);
    const deniedDelete = await request("DELETE", `/api/billing/admin/groups/user-groups/${userGroup.body.data.id}`, adminToken);
    expect(deniedDelete.status, deniedDelete.raw).toBe(409);
    const deniedModelDelete = await request("DELETE", `/api/billing/admin/groups/model-groups/${modelGroup.body.data.id}`, adminToken);
    expect(deniedModelDelete.status, deniedModelDelete.raw).toBe(409);
    const rename = await request("PATCH", `/api/billing/admin/groups/user-groups/${userGroup.body.data.id}`, adminToken, {
      name: `${TAG}_renamed_users`, modelGroupIds: [modelGroup.body.data.id],
    });
    expect(rename.status, rename.raw).toBe(200);
    const list = await request("GET", "/api/billing/admin/groups", adminToken);
    expect(list.status, list.raw).toBe(200);
    expect(list.body.data.userGroups.find((group: any) => group.id === userGroup.body.data.id).modelGroupIds).toEqual([modelGroup.body.data.id]);
    const removeOnlyModel = await request("PATCH", `/api/billing/admin/groups/model-groups/${modelGroup.body.data.id}`, adminToken, { items: [] });
    expect(removeOnlyModel.status, removeOnlyModel.raw).toBe(200);
    const afterRemoval = await request("GET", "/api/billing/admin/groups", adminToken);
    expect(afterRemoval.body.data.modelGroups.find((group: any) => group.id === modelGroup.body.data.id).items).toEqual([]);

    const target = await request("GET", `/api/billing/admin/users?search=${encodeURIComponent(TAG + "_user")}`, adminToken);
    const other = await request("GET", `/api/billing/admin/users?search=${encodeURIComponent(TAG + "_other")}`, adminToken);
    expect(target.body.data.items[0].groupIds).toEqual([userGroup.body.data.id]);
    expect(other.body.data.items[0].groupIds).toEqual([]);
  });
});
