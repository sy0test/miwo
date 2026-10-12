/**
 * 002_platform_seed 的单测（spec §5.2 ④）。
 *
 * 覆盖七件事：
 *   1. `seed/*.ndjson` 每行都是**完整** JSON（截断会当场炸）且非空；
 *   2. 仓库里的种子文件**不含凭据痕迹**（Step 2 的"导出物不泄漏凭证"落到回归网里）；
 *   3. `o_prompt` 的 4 条都在，且 `videoPromptGeneration.data` 有量级护栏（防被截断成 2000）；
 *   4. `o_agentDeploy` 19 行且关键 key 齐全（`resolveModelName` 需要行存在）；
 *   5. `o_setting` 只有平台键、**绝无 `tokenKey`**（Phase 1c 才把它彻底移出 DB）；
 *   6. `o_vendorConfig` 恰好 8 个空模板行（enable=0 / inputValues={} / models=[]）；
 *   7. **只插不改**：手工改过的行重跑 `up` 不被覆盖；第二次 `up` 插入 0 行；
 *      `down` 只删自己种下的行，运行期新增的行存活。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource } from "@/db/migrations";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-seed-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
function freshDb(): Knex {
  seq += 1;
  return createKnex({
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `s${seq}.sqlite`) },
  } as MiwoConfig);
}
const SEED_DIR = path.resolve(__dirname, "..", "src", "db", "migrations", "seed");
const SEED_FILES = ["o_prompt.ndjson", "o_agentDeploy.ndjson", "o_setting.platform.ndjson", "o_vendorConfig.templates.ndjson"];

/** 已迁移到最新（001_schema + 002_platform_seed）的一次性库。调用方负责 destroy。 */
async function migratedDb(): Promise<Knex> {
  const db = freshDb();
  await db.migrate.latest({ migrationSource: makeMigrationSource() });
  return db;
}

describe("002_platform_seed", () => {
  it("种子文件都是合法 NDJSON（截断会当场炸）", () => {
    for (const f of fs.readdirSync(SEED_DIR).filter((x) => x.endsWith(".ndjson"))) {
      const lines = fs.readFileSync(path.join(SEED_DIR, f), "utf8").split(/\r?\n/).filter((l) => l.trim());
      for (const [i, l] of lines.entries()) {
        expect(() => JSON.parse(l), `${f}:${i + 1}`).not.toThrow();
      }
      expect(lines.length, f).toBeGreaterThan(0);
    }
    // 四份种子都必须存在（少一份 = seed 静默为空，prod 直接不可用）
    expect(fs.readdirSync(SEED_DIR).filter((x) => x.endsWith(".ndjson")).sort()).toEqual([...SEED_FILES].sort());
  });

  it("种子文件里不含凭据痕迹（导出白名单的回归网）", () => {
    // ⚠ 这些串在任何一份种子里出现都说明**导出的白名单被绕过**（例如把 o_vendorConfig 带 key 的行、
    //    或 o_setting.tokenKey 写进了文件）。Step 2 的哨兵实验证明过这个判别力：
    //    `scripts/dump-platform-seed.cjs` 对白名单行只写常量，对非白名单行整行跳过。
    const forbidden = ["tokenKey", "apiKey", "api_key", "sk-", "Bearer ", "password", "secret", "Authorization"];
    for (const f of SEED_FILES) {
      const body = fs.readFileSync(path.join(SEED_DIR, f), "utf8");
      for (const needle of forbidden) expect(body, `${f} 含 ${needle}`).not.toContain(needle);
    }
  });

  it("o_prompt 的 4 条都要在，且 data 长度与源库一致（不被截断）", async () => {
    const db = await migratedDb();
    const rows = await db("o_prompt").select("type", "name");
    const types = rows.map((r: any) => r.type).sort();
    expect(types).toEqual(["audioBindPrompt", "eventExtraction", "scriptAssetExtraction", "videoPromptGeneration"]);
    const video = await db("o_prompt").where("type", "videoPromptGeneration").first();
    // ⚠ 实测源库该行 20,982 字符；允许上游微调但必须有量级护栏（防止被截断成 2000）
    expect(String(video.data).length).toBeGreaterThan(15000);
    await db.destroy();
  });

  it("o_agentDeploy 19 行，且基行/子键/转绘行的 key 都在", async () => {
    const db = await migratedDb();
    const keys = (await db("o_agentDeploy").pluck("key")).sort();
    expect(keys.length).toBe(19);
    for (const k of ["scriptAgent", "productionAgent", "universalAi", "ttsDubbing", "redrawAgent", "redrawAgent:analysisAgent", "productionAgent:storyboardTableAgent"]) {
      expect(keys).toContain(k);
    }
    await db.destroy();
  });

  it("o_setting 只有平台键，绝无 tokenKey", async () => {
    const db = await migratedDb();
    const keys = (await db("o_setting").pluck("key")).sort();
    expect(keys).not.toContain("tokenKey");
    expect(keys.length).toBeGreaterThan(0);
    // 只 seed 平台键：行数与导出文件一致（不是"把源库 12 个键全搬过来"）
    const seeded = fs.readFileSync(path.join(SEED_DIR, "o_setting.platform.ndjson"), "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
    expect(keys.length).toBe(seeded);
    // 新库显式 v2（"未设置" = legacy，会让结构化分镜写入被拒）
    expect((await db("o_setting").where("key", "shotsEngine").first()).value).toBe("v2");
    await db.destroy();
  });

  it("o_vendorConfig 的 8 个模板行都是空模板（enable=0、inputValues={}）", async () => {
    const db = await migratedDb();
    const rows = await db("o_vendorConfig").select("*");
    // ⚠ 顺序是 ASCII 排序："vidu" < "volcengine"（'i' < 'o'），不要按直觉把 volcengine 放前面
    expect(rows.map((r: any) => r.id).sort()).toEqual(["atlascloud", "deepseek", "klingai", "minimax", "miwo", "openai", "vidu", "volcengine"]);
    for (const r of rows as any[]) {
      expect(r.inputValues, r.id).toBe("{}");
      expect(r.models, r.id).toBe("[]");
      expect(r.enable, r.id).toBe(0);
    }
    await db.destroy();
  });

  it("只插不改：手工改过 o_prompt / o_setting / o_vendorConfig 后重跑 up 不覆盖", async () => {
    const db = await migratedDb();
    await db("o_prompt").where("type", "audioBindPrompt").update({ data: "运营手工改过的内容" });
    await db("o_setting").where("key", "shotsEngine").update({ value: "legacy" });
    await db("o_vendorConfig").where("id", "miwo").update({ enable: 1, inputValues: "{\"baseURL\":\"https://ops.example\"}" });
    // 直接再调一次 up（绕过 knex_migrations）
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.up(db);
    const row = await db("o_prompt").where("type", "audioBindPrompt").first();
    expect(row.data).toBe("运营手工改过的内容");
    expect((await db("o_setting").where("key", "shotsEngine").first()).value).toBe("legacy");
    const vendor = await db("o_vendorConfig").where("id", "miwo").first();
    expect(vendor.enable).toBe(1);
    expect(vendor.inputValues).toBe("{\"baseURL\":\"https://ops.example\"}");
    await db.destroy();
  });

  it("up 幂等：第二次 up 四张表的行数都不变（插入 0 行）", async () => {
    const db = await migratedDb();
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    const count = async (t: string) => Number(((await db(t).count({ n: "*" }).first()) as any).n);
    const tables = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"];
    const before = await Promise.all(tables.map(count));
    await mod.up(db);
    const after = await Promise.all(tables.map(count));
    expect(after).toEqual(before);
    // 而且第一次迁移本身就"插满了"（不是 0 行 -> 0 行的假幂等）
    expect(before[0]).toBe(4);
    expect(before[1]).toBe(19);
    expect(before[2]).toBe(4);
    expect(before[3]).toBe(8);
    await db.destroy();
  });

  it("down 只删自己种下的行：运行期新增的行存活", async () => {
    const db = await migratedDb();
    await db("o_prompt").insert({ type: "runtimeCustom", name: "运行期新增", data: "keep me" });
    await db("o_vendorConfig").insert({ id: "runtimeVendor", inputValues: "{\"k\":1}", models: "[]", enable: 1 });
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.down(db);
    const rows = (await db("o_prompt").select("type")).map((r: any) => r.type);
    expect(rows).toEqual(["runtimeCustom"]);
    expect((await db("o_vendorConfig").pluck("id"))).toEqual(["runtimeVendor"]);
    // 表本身还在（down 不该删表；建表是 001 的事）
    expect(await db.schema.hasTable("o_prompt")).toBe(true);
    await db.destroy();
  });
});
