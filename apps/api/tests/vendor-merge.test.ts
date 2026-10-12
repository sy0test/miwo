import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { mergeAgentDeployVendorId, mergeVendorId } from "@/db/legacy/vendor-merge";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-vendor-merge-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
function freshDb(): Knex {
  seq += 1;
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `v${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

async function table(db: Knex) {
  await db.schema.createTable("o_vendorConfig", (T) => { T.string("id", 191).primary(); T.text("inputValues"); T.text("models"); T.integer("enable"); });
  await db.schema.createTable("o_agentDeploy", (T) => { T.increments("id"); T.text("vendorId"); T.string("key"); });
}

describe("供应商 id 合并（Phase 0 deferred，spec §4.2 规则 2）", () => {
  let db: Knex;
  beforeEach(async () => { db = freshDb(); await table(db); });

  it("A. 只有旧行 → 改名并保留字段", async () => {
    await db("o_vendorConfig").insert({ id: "toonflow", inputValues: '{"a":"1"}', models: "[1]", enable: 1 });
    const r = await mergeVendorId(db);
    expect(r.action).toBe("renamed");
    const row = await db("o_vendorConfig").where("id", "miwo").first();
    expect(row).toMatchObject({ inputValues: '{"a":"1"}', models: "[1]", enable: 1 });
    expect(await db("o_vendorConfig").where("id", "toonflow").first()).toBeUndefined();
    await db.destroy();
  });

  it("B. 两行都缺 → noop", async () => {
    expect((await mergeVendorId(db)).action).toBe("noop");
    await db.destroy();
  });

  it("C. 两行都在 → 合并（删旧行 + enable 取 max），**不抛主键错**", async () => {
    await db("o_vendorConfig").insert([{ id: "toonflow", inputValues: "{}", models: "[]", enable: 1 }, { id: "miwo", inputValues: "{}", models: "[]", enable: 0 }]);
    const r = await mergeVendorId(db);
    expect(r).toMatchObject({ action: "merged", targetEnable: 1 });
    const rows = await db("o_vendorConfig").select("id", "enable");
    expect(rows).toEqual([{ id: "miwo", enable: 1 }]);
    await db.destroy();
  });

  it("C 的反向：apply=false 时什么都不写（dry-run）", async () => {
    await db("o_vendorConfig").insert([{ id: "toonflow", inputValues: "{}", models: "[]", enable: 1 }, { id: "miwo", inputValues: "{}", models: "[]", enable: 0 }]);
    const r = await mergeVendorId(db, { apply: false });
    expect(r.action).toBe("merged");
    expect((await db("o_vendorConfig").select("id")).map((x: any) => x.id).sort()).toEqual(["miwo", "toonflow"]);
    await db.destroy();
  });

  it("幂等：连跑两次结果相同", async () => {
    await db("o_vendorConfig").insert({ id: "toonflow", inputValues: "{}", models: "[]", enable: 1 });
    await mergeVendorId(db);
    expect((await mergeVendorId(db)).action).toBe("noop");
    expect((await db("o_vendorConfig").select("id")).map((x: any) => x.id)).toEqual(["miwo"]);
    await db.destroy();
  });

  it("o_agentDeploy.vendorId 一起改", async () => {
    await db("o_agentDeploy").insert([{ vendorId: "toonflow", key: "a" }, { vendorId: "toonflow", key: "b" }, { vendorId: "miwo", key: "c" }]);
    expect(await mergeAgentDeployVendorId(db)).toBe(2);
    expect((await db("o_agentDeploy").select("vendorId")).map((x: any) => x.vendorId)).toEqual(["miwo", "miwo", "miwo"]);
    await db.destroy();
  });

  it("表不存在时不炸（迁移前的空库）", async () => {
    const db2 = freshDb();
    expect((await mergeVendorId(db2)).action).toBe("noop");
    expect(await mergeAgentDeployVendorId(db2)).toBe(0);
    await db2.destroy();
    await db.destroy();
  });
});
