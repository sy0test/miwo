/**
 * 迁移机制的单测（spec §5.2）。
 *
 * 覆盖五件事：
 *   1. 清单 `MIGRATIONS` 与磁盘上的 `src/db/migrations/*.ts` **一一对应**（既防"清单里写了个不存在的名字"，
 *      也防"写了迁移文件但忘了注册"）；
 *   2. `runMigrations` 幂等（第二次跑 0 条）；
 *   3. `knex_migrations` 里每个名字恰好一行；
 *   4. `rollbackMigrations(db, true)` 能把库回滚到空、且回滚后还能再 up（往返）；
 *   5. `migrationStatus` 能区分 done / pending，并给出真实 batch 号。
 * 另加一条负向断言：清单里出现未知名字时**抛错**，而不是静默跳过。
 *
 * ⚠ 有一条**慢用例**默认跳过，用 `MIWO_TEST_SLOW=1 pnpm test` 才会跑：它在 up 里故意用**外层 db**
 *    做 DDL，让迁移事务与它争抢同一个连接 / 库锁，直到驱动超时才失败。它是"up 必须用 trx"这条
 *    约定唯一的自动化守卫，**不要因为慢就删掉**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import type { Migration } from "@/db/migrations";
import { MIGRATIONS, makeMigrationSource, migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-migrate-"));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "src", "db", "migrations");
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
    db: { driver: "sqlite", file: path.join(TMP, `m${seq}.sqlite`) },
  } as MiwoConfig;
  return createKnex(cfg);
}

const NAMES = MIGRATIONS.map((m) => m.name);

describe("迁移机制（spec §5.2）", () => {
  let db: Knex;
  beforeEach(() => {
    db = freshDb();
  });
  // ⚠ 连接池由 afterEach 收（而不是让每个用例在末尾自己 destroy）：用例中途断言失败时也能收干净，
  //    否则残留的 sqlite 句柄会让 vitest 卡在退出。
  afterEach(async () => {
    await db.destroy();
  });

  it("清单非空、名字唯一、且与 migrations/*.ts 文件一一对应", () => {
    expect(NAMES.length).toBeGreaterThan(0);
    expect(new Set(NAMES).size).toBe(NAMES.length);
    // ⚠⚠ 【Ruling 24·必做】**顺序**必须守：knex **不排序** —— `Migrator.listAll` 原样返回
    //    `getMigrations()`（knex/lib/migrations/migrate/Migrator.js:5-7,22-27,747-751），
    //    返回顺序 / 执行日志 / `knex_migrations` 里的行**全是数组顺序**。
    //    实测：把数组故意写成 `[003, 001, 002]` → 执行顺序就是 `[003, 001, 002]`，
    //    而**改动前这一条断言不存在** ⇒ 新库会**静默按错序执行**（schema 状态难以解释）。
    //    Task 5/6 都要往同一数组追加，而 `db:generate` 只提醒"别忘 import"、不提醒顺序。
    //    ⚠ **不要**在 `makeMigrationSource` 里偷偷 `sort()` 来"修"这条：那会掩盖数组写错，
    //      且让 `--status` 的输出顺序与真实执行顺序脱钩（本门禁要的恰恰是"数组本身有序"）。
    expect(NAMES).toEqual([...NAMES].sort());
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.ts$/.test(f))
      .map((f) => f.replace(/\.ts$/, ""));
    // 每个迁移都要有同名文件（防止"清单里写了个不存在的名字"）
    for (const n of NAMES) expect(files).toContain(n);
    // 每个文件都要在清单里（防止"写了迁移但忘了注册"）
    for (const f of files) expect(NAMES).toContain(f);
  });

  it("first run applies everything, second run is a no-op（幂等）", async () => {
    const [b1, n1] = await runMigrations(db);
    expect(b1).toBe(1);
    expect(n1).toEqual(NAMES);
    const [b2, n2] = await runMigrations(db);
    expect(n2).toEqual([]); // 没有新迁移
    expect(b2).toBe(1); // knex 在没有新迁移时不加 batch：返回的是当前 max(batch)
  });

  it("knex_migrations 表里每个名字恰好一行", async () => {
    await runMigrations(db);
    const rows = (await db("knex_migrations").select("name")) as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual([...NAMES].sort());
  });

  it("down 能回滚到空库，且回滚后可以再 up（往返）", async () => {
    const [up1] = await runMigrations(db);
    expect(up1).toBe(1);
    const [batch, names] = await rollbackMigrations(db, true);
    expect(batch).toBe(1);
    expect([...names].sort()).toEqual([...NAMES].sort());
    const after = await migrationStatus(db);
    expect(after.every((r) => r.state === "pending")).toBe(true);
    expect(after.every((r) => r.batch === null)).toBe(true);
    const [b2, n2] = await runMigrations(db);
    // ⚠ batch 号不是"历史批次自增"，而是 `max(batch) + 1`（knex 3.3 的 _latestBatchNumber）。
    //    全回滚后 knex_migrations 是空表 → max=0 → 重新从 1 开始（实测值就是 1，不是 2）。
    expect(b2).toBe(1);
    expect([...n2].sort()).toEqual([...NAMES].sort());
    const again = await migrationStatus(db);
    expect(again.every((r) => r.state === "done" && r.batch === 1)).toBe(true);
  });

  it("status 能区分 done / pending，并带出真实 batch", async () => {
    const before = await migrationStatus(db);
    expect(before.map((r) => r.name)).toEqual(NAMES);
    expect(before.every((r) => r.state === "pending" && r.batch === null)).toBe(true);
    await runMigrations(db);
    const after = await migrationStatus(db);
    expect(after.every((r) => r.state === "done" && r.batch === 1)).toBe(true);

    // 追加一条**新**迁移：knex 的 batch 号是 `max(batch) + 1`（不是历史计数器），所以第二批是 2。
    // 这条断言也是 CLI `[已执行] … (batch 2)` 与"回滚一批只回滚最后一批"的地基。
    const extra: Migration = {
      name: "899_tmp_extra",
      async up(): Promise<void> {},
      async down(): Promise<void> {},
    };
    const [b2, n2] = (await db.migrate.latest({ migrationSource: makeMigrationSource([...MIGRATIONS, extra]) })) as [number, string[]];
    expect(b2).toBe(2);
    expect(n2).toEqual([extra.name]);
    const rows = (await db("knex_migrations").select("name", "batch").orderBy("name")) as Array<{ name: string; batch: number }>;
    // ⚠ 期望值**由清单推导**而不是硬编码两条：清单每加一条迁移（Task 5 的 002、Task 6 的 003…）
    //    这里就自动跟着长，不需要再改测试。语义仍是"清单里的每条都是 batch 1、额外那条是 batch 2"，
    //    且按名字排序（"899_tmp_extra" 排在 0xx 之后）——断言强度没有变化。
    expect(rows).toEqual([...NAMES.map((n) => ({ name: n, batch: 1 })), { name: extra.name, batch: 2 }]);
    // status 报的是**清单**里的条目（不是 `knex_migrations` 全表）。
    // 这里顺带验证一个真实行为：DB 里出现清单外的迁移时，knex 的清单校验会**响亮报错**
    // （"The migration directory is corrupt, the following files are missing: <name>"），
    // 而不是给出一份假装完整的 status —— 拿旧代码连新库的人必须看到它。
    await expect(migrationStatus(db)).rejects.toThrow(/corrupt/);
  });

  it("清单里出现未知名字时抛错，而不是静默跳过", async () => {
    const src = makeMigrationSource(MIGRATIONS);
    await expect(src.getMigration("999_does_not_exist")).rejects.toThrow(/找不到迁移/);
  });

  it.skipIf(process.env.MIWO_TEST_SLOW !== "1")(
    "up 里用 trx（而不是外层 db）—— 否则迁移必然失败（实测教训）",
    async () => {
      // 造一条"用外层 db 做 DDL"的坏迁移，断言它**确实失败**：这就是为什么约定必须写进注释与 README。
      // 实测（本机，sqlite/better-sqlite3）：
      //   · knex 给 sqlite 的连接池是 **min 1 / max 1**（`db.client.pool` → {min:1,max:1,acquireTimeoutMillis:60000}），
      //     而迁移事务已经占着那唯一一条连接 → 外层的 createTable 只能排 tarn 的队；
      //   · 60.0s 后抛 `KnexTimeoutError: Knex: Timeout acquiring a connection. The pool is probably full.
      //     Are you missing a .transacting(trx) call?`（knex 的报错文案正好点出了这个坑）。
      // ⚠ 因为它要整 60s，vitest 默认 testTimeout 只有 5s → 这里必须显式给超时（见末尾第 3 个参数）。
      const bad: Migration[] = [
        {
          name: "900_bad_uses_outer_db",
          async up(): Promise<void> {
            await db.schema.createTable("t_bad", (t) => {
              t.increments("id");
            });
          },
          async down(): Promise<void> {
            /* 坏迁移不该被执行到 down */
          },
        },
      ];
      await expect(db.migrate.latest({ migrationSource: makeMigrationSource(bad) })).rejects.toThrow(
        // 主判据是实测到的 KnexTimeoutError；后面两个是"万一将来池配置变宽"时的等价失败面
        //（拿不到连接 ⇒ 拿不到写锁）。三种都必须让这条坏迁移失败，不能静默通过。
        /Timeout acquiring a connection|KnexTimeoutError|database is locked|SQLITE_BUSY/i,
      );
    },
    180_000,
  );
});
