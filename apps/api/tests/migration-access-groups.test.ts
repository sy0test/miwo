import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource, MIGRATIONS } from "@/db/migrations";
import accessGroups from "@/db/migrations/014_access_groups";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-access-groups-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function freshDb(): Knex {
  seq += 1;
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `groups-${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

describe("014 access group migration", () => {
  it("backfills legacy model grants into private per-user groups and is idempotent", async () => {
    const db = freshDb();
    try {
      const before = MIGRATIONS.filter((migration) => migration.name !== accessGroups.name);
      await db.migrate.latest({ migrationSource: makeMigrationSource(before) });
      await db("o_user").insert({ username: "legacy-user", passwordHash: "", role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: 1 });
      const user = await db("o_user").where({ username: "legacy-user" }).first("id");
      const legacyRows = [
        { userId: user.id, agentKey: null, vendorId: "vendor-a", model: "model-a", enabled: 0, dailyLimit: 7, createdAt: 10 },
        { userId: user.id, agentKey: null, vendorId: "vendor-a", model: "model-b", enabled: 1, dailyLimit: null, createdAt: 11 },
        { userId: user.id, agentKey: "writer", vendorId: null, model: null, enabled: 1, dailyLimit: 9, createdAt: 12 },
      ];
      await db("o_modelGrant").insert(legacyRows);

      await accessGroups.up(db);
      const userGroup = await db("o_userGroup").where({ legacyUserId: user.id }).first();
      const modelGroup = await db("o_modelGroup").where({ legacyUserId: user.id }).first();
      expect(userGroup).toMatchObject({ name: `历史授权（${user.id}）`, isLegacy: 1 });
      expect(modelGroup).toMatchObject({ name: `历史授权（${user.id}）`, isLegacy: 1 });
      expect(await db("o_userGroupMembership").where({ userId: user.id, userGroupId: userGroup.id })).toHaveLength(1);
      expect(await db("o_userGroupModelGroup").where({ userGroupId: userGroup.id, modelGroupId: modelGroup.id })).toHaveLength(1);
      expect(await db("o_modelGroupItem").where({ modelGroupId: modelGroup.id }).orderBy("model")).toMatchObject([
        { vendorId: "vendor-a", model: "model-a", enabled: 0, dailyLimit: 7 },
        { vendorId: "vendor-a", model: "model-b", enabled: 1, dailyLimit: null },
      ]);

      await accessGroups.up(db);
      expect(await db("o_modelGroup").where({ legacyUserId: user.id })).toHaveLength(1);
      expect(await db("o_userGroup").where({ legacyUserId: user.id })).toHaveLength(1);
      expect(await db("o_modelGroupItem").where({ modelGroupId: modelGroup.id })).toHaveLength(2);
      expect(await db("o_userGroupMembership").where({ userId: user.id })).toHaveLength(1);
      expect(await db("o_userGroupModelGroup").where({ userGroupId: userGroup.id })).toHaveLength(1);
      expect(await db("o_modelGrant").where({ userId: user.id })).toMatchObject(legacyRows);
    } finally {
      await db.destroy();
    }
  });
});
