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
  // ---- Phase 1c Task 1（005_accounts / 006_quota_grants）：6 张新表（`o_user` 是**重建**，不增数量）----
  "o_account", "o_modelGrant", "o_invite", "o_loginAttempt", "o_auditLog", "o_userSetting",
  // ---- Phase 1d Task 1（007_job_queue / 008_vendor_gate）：2 张 platform 基础设施表 ----
  "o_job", "o_gate",
  // ---- Phase 2 Task 1（009_billing）：3 张 tenant 表 + 1 张 platform 定价表 ----
  "o_usage", "o_ledger", "o_order", "o_price",
  // ---- Phase 2 Task 5 quota admission ----
  "o_dailyQuotaAdmission", "o_usageAdmission",
  // ---- Phase 2 Task 6 access groups ----
  "o_modelGroup", "o_modelGroupItem", "o_userGroup", "o_userGroupModelGroup", "o_userGroupMembership",
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
  it("建出恰好 46 张表（含分组授权表），且不含退役表", async () => {
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

  it("downgrade 之后 39 张表全没了", async () => {
    const db = freshDb("down");
    const src = makeMigrationSource();
    await db.migrate.latest({ migrationSource: src });
    await db.migrate.rollback({ migrationSource: src }, true);
    const rows = await db("sqlite_master").where("type", "table").whereNot("name", "like", "sqlite_%").select("name");
    const names = rows.map((r: any) => r.name).filter((n: string) => !n.startsWith("knex_"));
    expect(names).toEqual([]);
    await db.destroy();
  });

  it("毫秒时间戳列在 sqlite 下原样存取（12 张表 / 15 列；只在真 MySQL 靠 bigint 兜住）", async () => {
    // 修复轮 1：这些列原来被种成 `T.integer` → mysql `int`，装不下 `Date.now()` 的毫秒值
    // （int 上限 2147483647；种子/现状库里是 1774447310118 这种）。
    // sqlite 侧的 INTEGER 本来就是 64 位，**看不见问题** —— 所以这条用例的价值不是"抓 sqlite 的错"，
    // 而是把"列清单 + 毫秒值原样读回 number（不被降精度/不被断言成 string）"钉住，
    // 免得下一次有人把它改回 int 时只在真 MySQL 才炸。
    const MS_COLUMNS: Array<[string, string]> = [
      ["o_project", "createTime"],
      ["o_tasks", "startTime"],
      ["o_novel", "createTime"],
      ["o_event", "createTime"],
      ["o_script", "createTime"],
      ["o_assets", "startTime"],
      ["o_storyboard", "createTime"],
      ["o_agentWorkData", "createTime"],
      ["o_agentWorkData", "updateTime"],
      ["o_video", "time"],
      ["o_segment", "createTime"],
      ["o_segment", "updateTime"],
      ["o_shot", "createTime"],
      ["o_shot", "updateTime"],
      ["memories", "createTime"],
    ];
    expect(MS_COLUMNS.length).toBe(15);
    expect(new Set(MS_COLUMNS.map(([t]) => t)).size).toBe(12);
    const db = freshDb("mscols");
    await db.migrate.latest({ migrationSource: makeMigrationSource() });
    const ms = 1791582300907; // 实测 dev 库里的量级（> int 上限）
    let n = 0;
    for (const [table, col] of MS_COLUMNS) {
      // ⚠ 两张表的主键**不是**自增：o_project.id 由代码给 Date.now()、memories.id 是 varchar(191)。
      //    其余 10 张表都是自增主键，只填时间列即可。
      const extra =
        table === "o_project" ? { id: 1791385000000 + n++ } :
        table === "memories" ? { id: "ms-" + n++, isolationKey: "k", type: "message", content: "c" } : {};
      const [id] = await db(table).insert({ [col]: ms, ...extra } as any);
      const row: any = extra.id
        ? await db(table).where("id", (extra as any).id).first()
        : await db(table).where("id", id).first();
      expect(row[col], `${table}.${col}`).toBe(ms);
      expect(typeof row[col], `${table}.${col} 必须是 number`).toBe("number");
    }
    // 顺带钉住 sqlite 侧的列声明类型（`t.ms()` → `bigint`；见 dialect.ts 的 ms()）
    const info: any[] = await db.raw("PRAGMA table_info(o_shot)");
    const createTime = info.find((c) => c.name === "createTime");
    expect(String(createTime.type).toLowerCase()).toBe("bigint");
    await db.destroy();
  });

  it("Date.now() 型 id 在 sqlite 下也能带值插入（o_project.id / o_videoTrack.id + 外键列）", async () => {
    // 修复轮 1 的第二组：这两个 id 的取值不是自增小整数，而是 `Date.now()`（见 001_schema.ts 顶部注释）。
    // sqlite 侧 `integer primary key` 本来就允许显式给值；这条把"显式给毫秒 id + 外键跟着写"钉住，
    // 免得下次有人为了"统一自增"把显式 id 去掉（那是 Phase 1b 的事，且会改语义）。
    const db = freshDb("msid");
    await db.migrate.latest({ migrationSource: makeMigrationSource() });
    const pid = 1791385147125;
    const tid = 1791392243171;
    await db("o_project").insert({ id: pid, createTime: pid });
    await db("o_tasks").insert({ projectId: pid, startTime: pid });
    await db("o_script").insert({ projectId: pid });
    await db("o_assets").insert({ projectId: pid, startTime: pid });
    await db("o_storyboard").insert({ projectId: pid, trackId: tid, createTime: pid });
    await db("o_videoTrack").insert({ id: tid, projectId: pid, duration: 5 });
    await db("o_video").insert({ projectId: pid, videoTrackId: tid, time: pid });
    const joined = await db("o_video")
      .join("o_project", "o_project.id", "o_video.projectId")
      .join("o_videoTrack", "o_videoTrack.id", "o_video.videoTrackId")
      .select("o_video.time as time", "o_project.id as pid", "o_videoTrack.id as tid")
      .first();
    expect(joined).toMatchObject({ time: pid, pid, tid });
    expect((await db("o_tasks").first()).projectId).toBe(pid);
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
