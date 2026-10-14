/**
 * `005_accounts` / `006_quota_grants` 的回归网（Phase 1c Task 1；spec §7.1 / §6.2 / §8.2）。
 *
 * 覆盖六件事（每条都对应一个**会真的坏掉**的路径，不是 happy path 装饰）：
 *   1. 两条迁移进了清单，且**按名字有序**（Ruling 24：knex 不排序，数组顺序 = 执行顺序）；
 *   2. `up → down → up` 全程可逆，且 `down` 之后 `o_user` 真的回到 1a 的 3 列形状；
 *   3. 旧**明文**口令不会变成可登录账号（`status='disabled'` + `passwordHash=''`）；
 *   4. `o_setting` 拆键的**判别力**：`tokenKey` 行消失、7 个用户级键迁走、两个平台开关就位；
 *      —— 断言一律**直读库**（不是只看某个 API 返回值）；
 *   5. 平台开关的写入是**幂等**的（`onConflict("key").ignore()`：运维改过的值不会被重跑冲掉）；
 *   6. 迁移文件里**必须**用 `dropTable`（而不是 `dropTableIfExists`）做 `o_user` 重建的中转删除
 *      —— 门禁 `tools/check-tenant-policies.cjs` 把后者当"退役表"，用错会让 `o_user` 被判成退役。
 *
 * ⚠ 库一律建在 `%TEMP%` 的一次性目录里（`apps/api/data/db2.sqlite` 是用户真实数据的只读快照，
 *   本阶段已被误写 5 次）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { MIGRATIONS, makeMigrationSource, rollbackMigrations, runMigrations } from "@/db/migrations";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-p1c-accounts-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function freshDb(): Knex {
  seq += 1;
  const cfg = {
    env: "dev",
    port: 10599,
    host: "127.0.0.1",
    dataDir: TMP,
    mediaDir: path.join(TMP, "oss"),
    storageDriver: "local",
    publicBaseUrl: "http://127.0.0.1:10599",
    trustProxy: 0,
    jwtSecret: "x".repeat(48),
    db: { driver: "sqlite", file: path.join(TMP, `accounts-${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

async function tableNames(db: Knex): Promise<string[]> {
  const rows = (await db("sqlite_master").where("type", "table").select("name")) as Array<{ name: string }>;
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("knex_"))
    .sort();
}

async function columnsOf(db: Knex, table: string): Promise<string[]> {
  const cols = (await db.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

async function indexesOf(db: Knex, table: string): Promise<string[]> {
  const idx = (await db.raw(`PRAGMA index_list(${table})`)) as Array<{ name: string }>;
  return idx.map((i) => i.name).sort();
}

/**
 * 造"老库升级"的起点：跑到 `002_platform_seed` 为止（它自带"库里不得有 tokenKey"的断言，
 * 所以旧行的注入必须在它**之后** —— ⚠ 002 是已发布迁移，不许为了测试去改它），
 * 再塞进旧 `o_user` 明文行 + 老 `tokenKey` + 一个用户级键。
 */
async function dbAt002WithLegacyRows(db: Knex): Promise<void> {
  await db.migrate.latest({
    migrationSource: makeMigrationSource(MIGRATIONS.filter((m) => ["001_schema", "002_platform_seed"].includes(m.name))),
  });
  await db("o_user").insert({ id: 1, name: "admin", password: "admin123" });
  await db("o_setting").insert([
    { key: "tokenKey", value: "legacy-token-key" },
    { key: "agentUseMode", value: "auto" },
  ]);
}

describe("005_accounts / 006_quota_grants（spec §7.1 / §6.2 / §8.2）", () => {
  it("清单里包含两条迁移，且按名字有序（Ruling 24）", () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toContain("005_accounts");
    expect(names).toContain("006_quota_grants");
    expect(names).toEqual([...names].sort());
    // 编号顺延的**理由**也要钉住：brief 的 002/003 号段已被 1b 的迁移占用
    expect(names.filter((n) => /^(002|003)_/.test(n))).toEqual(["002_platform_seed", "003_vendor_asset_sync"]);
  });

  it("up → down → up 全程可逆；down 之后 o_user 回到 1a 的 3 列形状", async () => {
    const db = freshDb();
    try {
      // 起点：002 为止（001 建表 + 002 种子），让 005 有真实的"旧 o_user"可迁
      await dbAt002WithLegacyRows(db);
      expect(await columnsOf(db, "o_user")).toEqual(["id", "name", "password"]);

      const [up1, n1] = await runMigrations(db);
      expect(up1).toBe(2); // 002 是 batch 1，其余是 batch 2
      expect(n1).toEqual(["003_vendor_asset_sync", "004_backfill_userid", "005_accounts", "006_quota_grants"]);

      // ---- 幂等 ①：再跑一次 0 行 ----
      const [up2, n2] = await runMigrations(db);
      expect(n2).toEqual([]);
      expect(up2).toBe(2);

      // ---- down（全部）只回滚 005/006 之外还要把 004/003/002/001 也带走：这里只回滚第二批 ----
      const [rb, rn] = await rollbackMigrations(db); // all=false ⇒ 只回滚最后一个 batch（2）
      expect(rb).toBe(2);
      expect(rn).toEqual(["006_quota_grants", "005_accounts", "004_backfill_userid", "003_vendor_asset_sync"]);

      // 005 的 down：新表消失、o_user 回到 3 列、口令**不可恢复**（空串）
      const names = await tableNames(db);
      for (const gone of ["o_invite", "o_userSetting", "o_loginAttempt", "o_auditLog", "o_account", "o_modelGrant"]) {
        expect(names, `${gone} 应已被 down 删掉`).not.toContain(gone);
      }
      expect(await columnsOf(db, "o_user")).toEqual(["id", "name", "password"]);
      expect(await db("o_user").where("name", "admin").first()).not.toBeUndefined();
      const restored = (await db("o_user").where("id", 1).first()) as any;
      expect(restored.name).toBe("admin");
      expect(restored.password).toBe(""); // 明文不可恢复 —— 这是**登记的语义**，不是缺陷

      // ---- 再 up（往返）：005 会把"已回滚成 name 列"的行重新迁成 disabled 账号 ----
      // ⚠ batch 号是 knex 的 `max(batch) + 1`（不是历史自增计数器）：上一次 down 走的是
      //   **不带 all** 的 rollback（只回滚最后一个 batch）⇒ `knex_migrations` 里 batch 1 的行还在，
      //   max 仍是 1，所以往返后的批次号实测是 **2**（`tests/migrations.test.ts` 里那条
      //   "全量回滚后再 up 得到 batch 1" 是 all=true 的路径，两者不矛盾）。
      const [up3, n3] = await runMigrations(db);
      expect(up3).toBe(2);
      expect(n3).toEqual(["003_vendor_asset_sync", "004_backfill_userid", "005_accounts", "006_quota_grants"]);
      expect(await columnsOf(db, "o_user")).toContain("passwordHash");
      const again = (await db("o_user").where("username", "admin").first()) as any;
      expect(again).toMatchObject({ status: "disabled", passwordHash: "", role: "admin" });
    } finally {
      await db.destroy();
    }
  });

  it("旧明文用户迁成 disabled 且不可登录（passwordHash 为空串）", async () => {
    const db = freshDb();
    try {
      await dbAt002WithLegacyRows(db);
      await runMigrations(db);
      const row = (await db("o_user").where("username", "admin").first()) as any;
      expect(row).toMatchObject({
        id: 1,          // id 保真（老 token 里的 id=1 仍然指向同一个账号）
        username: "admin",
        role: "admin",
        status: "disabled",       // 迁移后不可登录
        passwordHash: "",         // 明文口令**没有**被搬进来
        mustChangePassword: 1,    // 重新开通后必须改密
        tokenVersion: 0,
      });
      expect(row.email).toBeNull();
      expect(row.lastLoginAt).toBeNull();
      expect(typeof row.createdAt).toBe("number");
      // 判别力：明文口令**不得**以任何形式出现在新库里
      expect(JSON.stringify(row)).not.toContain("admin123");
      // 新表结构（§7.1 的 8 列 + mustChangePassword + 自增主键）
      expect(await columnsOf(db, "o_user")).toEqual([
        "id", "username", "email", "passwordHash", "role", "status", "tokenVersion", "mustChangePassword", "createdAt", "lastLoginAt",
      ]);
      // 唯一键（username / email）：两条 `unique` 索引真的建出来了（sqlite 侧无名字，看列即可）
      const uniq = (await db.raw("PRAGMA index_list(o_user)")) as Array<{ name: string; unique: number }>;
      const uniqCols: string[] = [];
      for (const ix of uniq.filter((i) => i.unique)) {
        const info = (await db.raw(`PRAGMA index_info(${ix.name})`)) as Array<{ name: string }>;
        uniqCols.push(info.map((c) => c.name).join(","));
      }
      expect(uniqCols.sort()).toEqual(["email", "username"]);
    } finally {
      await db.destroy();
    }
  });

  it("★ o_setting 拆键（直读库）：tokenKey 行消失、7 个用户级键迁 o_userSetting、两个平台键就位", async () => {
    const db = freshDb();
    try {
      // 7 个用户级键 + tokenKey 一起塞进老库
      const USER_KEYS = [
        "agentUseMode", "messagesPerSummary", "shortTermLimit", "summaryMaxLength", "summaryLimit", "ragLimit", "deepRetrieveSummaryLimit",
      ];
      await dbAt002WithLegacyRows(db);
      await db("o_setting").insert(USER_KEYS.slice(1).map((key) => ({ key, value: `v-${key}` })));

      // 改前：tokenKey 在、7 个用户级键都在（这是"判别力"的**红端基线**）
      const before = ((await db("o_setting").select("key")) as Array<{ key: string }>).map((r) => r.key);
      expect(before).toContain("tokenKey");
      for (const k of USER_KEYS) expect(before, k).toContain(k);

      await runMigrations(db);

      // ---- 改后：tokenKey 行**必须消失**（直读库，不看任何 API 返回值）----
      expect(await db("o_setting").where("key", "tokenKey").first()).toBeUndefined();
      // 7 个用户级键从 o_setting 消失，并整行迁进 o_userSetting（归第一个用户）
      const afterKeys = ((await db("o_setting").select("key")) as Array<{ key: string }>).map((r) => r.key);
      for (const k of USER_KEYS) expect(afterKeys, k).not.toContain(k);
      const settings = (await db("o_userSetting").select("userId", "key", "value").orderBy("key")) as Array<{
        userId: number;
        key: string;
        value: string;
      }>;
      expect(settings.map((s) => s.key)).toEqual([...USER_KEYS].sort());
      expect(new Set(settings.map((s) => s.userId))).toEqual(new Set([1]));
      expect(settings.find((s) => s.key === "agentUseMode")?.value).toBe("auto"); // 值原样搬
      expect(settings.find((s) => s.key === "summaryLimit")?.value).toBe("v-summaryLimit");

      // 平台开关
      expect(((await db("o_setting").where("key", "registrationMode").first()) as any)?.value).toBe("invite");
      expect(((await db("o_setting").where("key", "allowDbAdminOps").first()) as any)?.value).toBe("0");
      // 002 的 4 个平台键还在（拆键不得误删）
      for (const k of ["shotsEngine", "switchAiDevTool", "modelOnnxFile", "modelDtype"]) {
        expect(afterKeys, k).toContain(k);
      }
      expect(afterKeys.sort()).toEqual(
        ["allowDbAdminOps", "modelDtype", "modelOnnxFile", "registrationMode", "shotsEngine", "switchAiDevTool"].sort(),
      );
    } finally {
      await db.destroy();
    }
  });

  it("平台开关的重跑**不覆盖**运维改过的值（onConflict(key).ignore() 幂等）", async () => {
    const db = freshDb();
    try {
      await dbAt002WithLegacyRows(db);
      await runMigrations(db);
      await db("o_setting").where("key", "registrationMode").update({ value: "closed" });
      // 再跑一次（模拟"运维改完值之后，进程重启又跑了一遍迁移"）
      await runMigrations(db);
      expect(((await db("o_setting").where("key", "registrationMode").first()) as any)?.value).toBe("closed");
    } finally {
      await db.destroy();
    }
  });

  it("★ 006 落两张租户表，且带 userId 索引（迁移建表清单 = 门禁的单一来源）", async () => {
    const db = freshDb();
    try {
      await dbAt002WithLegacyRows(db);
      await runMigrations(db);
      const names = await tableNames(db);
      for (const t of ["o_account", "o_modelGrant", "o_invite", "o_userSetting", "o_loginAttempt", "o_auditLog"]) {
        expect(names, t).toContain(t);
      }
      // 最终落地的表里**不得**出现暂存表（`005` 的 up 用 o_user_new 中转、down 用 o_user_old）
      for (const staging of ["o_user_new", "o_user_old"]) expect(names, staging).not.toContain(staging);
      // ⚠ 同上：迁移源码里的暂存表名必须是**字符串字面量**（`tools/migration-tables.cjs` 是源码解析，
      //   把实参抽成变量会让暂存表从解析结果里消失 → 门禁反过来要求给一张不存在的表登记策略）。
      const migrationSrc = fs.readFileSync(path.resolve(__dirname, "../src/db/migrations/005_accounts.ts"), "utf8");
      expect(migrationSrc).toContain('createTable("o_user_new"');
      expect(migrationSrc).toContain('renameTable("o_user_new", "o_user")');
      expect(migrationSrc).toContain('createTable("o_user_old"');
      expect(migrationSrc).toContain('renameTable("o_user_old", "o_user")');
      // 中转删除必须是 `dropTable`（**不带** IfExists）：`dropTableIfExists` 会被门禁的解析器
      // 当成"退役表"（`retiredTables`），那时 `o_user` 会被要求"已退役"，与它仍然存在矛盾。
      expect(migrationSrc).toContain('dropTable("o_user")');
      expect(migrationSrc).not.toContain('dropTableIfExists("o_user")');
      expect(await columnsOf(db, "o_account")).toEqual(["userId", "balanceMicro", "frozenMicro", "version", "updatedAt"]);
      expect(await indexesOf(db, "o_modelGrant")).toContain("o_modelgrant_userid_enabled_index");
      expect(await indexesOf(db, "o_auditLog")).toContain("o_auditlog_userid_createdat_index");
      expect(await indexesOf(db, "o_auditLog")).toContain("o_auditlog_action_createdat_index");
      // 复合主键：o_account(userId) / o_userSetting(userId,key) / o_loginAttempt(username,ip)
      const accountPk = (await db.raw("PRAGMA table_info(o_account)")) as Array<{ name: string; pk: number }>;
      expect(accountPk.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["userId"]);
      const userSettingPk = (await db.raw("PRAGMA table_info(o_userSetting)")) as Array<{ name: string; pk: number }>;
      expect(userSettingPk.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(["key", "userId"]);
      // 金额列必须是 64 位整数（微元；sqlite 侧是 bigint，mysql 侧由 u64/ms 保证）
      for (const col of ["balanceMicro", "frozenMicro"]) {
        const info = (await db.raw("PRAGMA table_info(o_account)")) as Array<{ name: string; type: string }>;
        expect(String(info.find((c) => c.name === col)?.type).toLowerCase()).toBe("bigint");
      }
    } finally {
      await db.destroy();
    }
  });
});
