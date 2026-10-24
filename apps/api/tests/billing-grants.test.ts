import knexFactory, { type Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentGrant, resolveModelGrant } from "@/billing/grants";

let db: Knex;

beforeEach(async () => {
  db = knexFactory({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await db.schema.createTable("o_userGroupMembership", (table) => {
    table.integer("userId").notNullable();
    table.integer("userGroupId").notNullable();
    table.primary(["userId", "userGroupId"]);
  });
  await db.schema.createTable("o_userGroupModelGroup", (table) => {
    table.integer("userGroupId").notNullable();
    table.integer("modelGroupId").notNullable();
    table.primary(["userGroupId", "modelGroupId"]);
  });
  await db.schema.createTable("o_modelGroupItem", (table) => {
    table.integer("modelGroupId").notNullable();
    table.string("vendorId").notNullable();
    table.string("model").notNullable();
    table.boolean("enabled").notNullable();
    table.integer("dailyLimit").nullable();
    table.primary(["modelGroupId", "vendorId", "model"]);
  });
  await db.schema.createTable("o_modelGrant", (table) => {
    table.increments("id").primary();
    table.integer("userId").notNullable();
    table.string("agentKey").nullable();
    table.string("vendorId").nullable();
    table.string("model").nullable();
    table.boolean("enabled").notNullable();
    table.integer("dailyLimit").nullable();
  });
});

afterEach(async () => db.destroy());

async function grantGroup(userId: number, userGroupId: number, modelGroupId: number, dailyLimit: number | null, enabled = true) {
  await db("o_userGroupMembership").insert({ userId, userGroupId });
  await db("o_userGroupModelGroup").insert({ userGroupId, modelGroupId });
  await db("o_modelGroupItem").insert({ modelGroupId, vendorId: "v", model: "m", enabled, dailyLimit });
}

describe("model grant resolution through groups", () => {
  it("rejects users without an enabled group authorization", async () => {
    await expect(resolveModelGrant(db, 7, "v", "m")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("无权使用模型"),
    });
    await grantGroup(7, 1, 1, null, false);
    await expect(resolveModelGrant(db, 7, "v", "m")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("无权使用模型"),
    });
  });

  it("returns the strictest non-null limit across groups and treats all-null as unlimited", async () => {
    await grantGroup(7, 1, 1, 20);
    await grantGroup(7, 2, 2, 3);
    await expect(resolveModelGrant(db, 7, "v", "m")).resolves.toEqual({ dailyLimit: 3 });

    await db("o_userGroupMembership").delete();
    await db("o_userGroupModelGroup").delete();
    await db("o_modelGroupItem").delete();
    await grantGroup(7, 3, 3, null);
    await grantGroup(7, 4, 4, null);
    await expect(resolveModelGrant(db, 7, "v", "m")).resolves.toEqual({ dailyLimit: null });
  });

  it("keeps Agent authorization on its independent grant path", async () => {
    await grantGroup(7, 1, 1, 1);
    await db("o_modelGrant").insert({ userId: 7, agentKey: "writer", enabled: true, dailyLimit: 8 });
    await expect(resolveAgentGrant(db, 7, "writer")).resolves.toEqual({ dailyLimit: 8 });
    await expect(resolveAgentGrant(db, 7, "other")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("无权使用智能体") });
    await expect(resolveAgentGrant(db, 8, "writer")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("无权使用智能体") });
  });
});
