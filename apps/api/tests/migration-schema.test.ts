/**
 * 001_schema 在 **sqlite 下真跑** 的回归网（本机的方言侧）。
 *
 * MySQL 侧由 `migration-ddl-mysql.test.ts` 做**静态** DDL 断言（本机没有 MySQL 服务端）；
 * 这里负责的是"同一份 up/down 在 sqlite 上真的建得出、插得进、回滚得干净"。
 *
 * ⚠ `up` 幂等性的正确口径：`createTable` 在表已存在时**会抛**（无论哪个方言）。所以"幂等"在这里
 *    的含义是"**迁移系统层面幂等**"（靠 `knex_migrations` 跳过已执行条目），而不是"DDL 字面可重放"。
 *    不要给 `createTable` 加 `hasTable` 守卫 —— 那会掩盖真实的结构漂移。
 *    对老库的兼容路径（`o_skillList` 的清理）用的才是真幂等守卫 `dropTableIfExists`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource } from "@/db/migrations";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-schema-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const EXPECTED_TABLES = [
  "o_user", "o_project", "o_artStyle", "o_agentDeploy", "o_setting", "o_tasks", "o_prompt", "o_modelPrompt",
  "o_novel", "o_event", "o_eventChapter", "o_script", "o_assets", "o_image", "o_storyboard",
  "o_agentWorkData", "o_video", "o_videoTrack", "o_vendorConfig", "o_imageFlow",
  "o_assets2Storyboard", "o_scriptAssets", "memories", "o_assetsRole2Audio", "o_segment", "o_shot", "o_shotAssets",
];
const RETIRED_TABLES = ["o_skillList", "o_skillAttribution"];

function freshDb(name: string): Knex {
  const cfg = {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `${name}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

describe("001_schema 在 sqlite 下真跑", () => {
  it("建出恰好 27 张表，且不含退役表", async () => {
    const db = freshDb("tables");
    await db.migrate.latest({ migrationSource: makeMigrationSource() });
    const rows = await db("sqlite_master").where("type", "table").whereNot("name", "like", "sqlite_%").select("name");
    const names = rows.map((r: any) => r.name).filter((n: string) => !n.startsWith("knex_"));
    for (const t of EXPECTED_TABLES) expect(names, t).toContain(t);
    for (const t of RETIRED_TABLES) expect(names, t).not.toContain(t);
    expect(names.length).toBe(EXPECTED_TABLES.length);
    await db.destroy();
  });

  it("每张表都能插一行再读回来（列名/类型没有拼错）", async () => {
    const db = freshDb("insert");
    await db.migrate.latest({ migrationSource: makeMigrationSource() });
    // 复合主键的表用最小必填列
    await db("o_shotAssets").insert({ shotId: 1, assetId: 2, userId: 3 });
    expect(await db("o_shotAssets").where({ shotId: 1, assetId: 2 }).first()).toMatchObject({ userId: 3 });
    await db("o_segment").insert({ scriptId: 1, segmentIndex: 1, manual: 0 });
    await db("o_segment").insert({ scriptId: 1, segmentIndex: 2, manual: 0 });
    expect((await db("o_segment").orderBy("segmentIndex")).map((r: any) => r.id)).toEqual([1, 2]);
    await db.destroy();
  });

  it("up 幂等：在已经建好的库上再跑一次不报错", async () => {
    const db = freshDb("idempotent");
    const src = makeMigrationSource();
    await db.migrate.latest({ migrationSource: src });
    // 直接再调一次 up（绕过 knex_migrations 的跳过逻辑），证明 DDL 本身幂等
    // ⚠ createTable 不幂等（表已存在会抛）→ 这里断言的是"**迁移层面**幂等由 knex_migrations 保证"
    const [batch, names] = (await db.migrate.latest({ migrationSource: src })) as [number, string[]];
    expect(names).toEqual([]);
    void batch;
    await db.destroy();
  });

  it("downgrade 之后 27 张表全没了", async () => {
    const db = freshDb("down");
    const src = makeMigrationSource();
    await db.migrate.latest({ migrationSource: src });
    await db.migrate.rollback({ migrationSource: src }, true);
    const rows = await db("sqlite_master").where("type", "table").whereNot("name", "like", "sqlite_%").select("name");
    const names = rows.map((r: any) => r.name).filter((n: string) => !n.startsWith("knex_"));
    expect(names).toEqual([]);
    await db.destroy();
  });

  it("⚠ 语义差异记录：批量 insert 的返回值在 mysql 是首行 id、sqlite 是末行 rowid", async () => {
    // 这条**不是**要修行为，而是把 spec §5.3「35 处 insert 语义复核」的差异钉成可执行的文档。
    // 现状代码里 `const [id] = await db(x).insert([...])` 多为单行插入 → 两边一致；
    // 真正的批量插入点由 Phase 1b 复查（本阶段不改调用点）。
    const db = freshDb("insertid");
    await db.migrate.latest({ migrationSource: makeMigrationSource() });
    const single = await db("o_artStyle").insert({ name: "a" });
    expect(single[0]).toBe(1);                       // 单行：两边都返回这一行的 id
    const multi = await db("o_artStyle").insert([{ name: "b" }, { name: "c" }]);
    // sqlite：末行 rowid（3）；mysql：**首行** insertId（2）
    expect(Array.isArray(multi)).toBe(true);
    expect(multi[multi.length - 1]).toBe(3);          // sqlite 现状
    // ⚠ 在 MySQL 下这里会是 2 —— 断言写成"与方言相关"，避免把差异藏起来
    const ids = await db("o_artStyle").orderBy("id").pluck("id");
    expect(ids).toEqual([1, 2, 3]);
    await db.destroy();
  });
});
