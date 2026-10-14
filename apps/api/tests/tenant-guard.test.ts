import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createKnex } from "@/db/connect";
import type { MiwoConfig } from "@/config";
import { configDefaults } from "./helpers/config-fixture";
import { makeTenantAware, parseTableSpec, JOIN_METHODS, TenantIsolationError, PlatformWriteDeniedError } from "@/db/tenant-guard";
import { PolicyNotFoundError, TABLE_POLICIES, TENANT_TABLES } from "@/db/policies";
import { TenantContextError, type TenantCtx } from "@/db/tenant-context";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-tenant-guard-"));
// ⚠ 每个 fixture 一个**独立**的 sqlite 文件（brief 的共享文件名版本在本机实跑会红：
//    文件被上一个 destroy 后仍存在于盘上 → 下一个用例 createTable 撞 "already exists"）。
//    每例自证：21 条用例各自建库，互不依赖执行顺序。
let seq = 0;
const opened: any[] = [];
afterAll(async () => {
  for (const k of opened) await k.destroy().catch(() => {}); // 失败用例可能没走到 destroy
  fs.rmSync(TMP, { recursive: true, force: true });
});

function cfg(file: string): MiwoConfig {
  return {
    ...configDefaults(),
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    db: { driver: "sqlite", file },
  };
}

/** 每张用到的表都按 001_schema 的最小子集建：只建测试需要的列（列名与迁移一致）。 */
async function fixture() {
  const knex = createKnex(cfg(path.join(TMP, `guard-${++seq}.sqlite`)));
  opened.push(knex);
  await knex.schema.createTable("o_project", (t) => { t.bigIncrements("id"); t.integer("userId"); t.text("name"); });
  await knex.schema.createTable("o_assets", (t) => { t.bigIncrements("id"); t.integer("userId"); t.integer("projectId"); t.integer("imageId"); t.text("name"); });
  await knex.schema.createTable("o_image", (t) => { t.bigIncrements("id"); t.integer("userId"); t.integer("assetsId"); t.text("filePath"); });
  await knex.schema.createTable("o_tasks", (t) => { t.bigIncrements("id"); t.integer("userId"); t.integer("projectId"); t.text("state"); t.text("describe"); });
  await knex.schema.createTable("o_setting", (t) => { t.string("key").primary(); t.text("value"); });
  await knex("o_project").insert([{ id: 100, userId: 7, name: "A" }, { id: 200, userId: 8, name: "B" }]);
  await knex("o_assets").insert([
    { id: 1, userId: 7, projectId: 100, imageId: 11, name: "A-asset" },
    { id: 2, userId: 8, projectId: 200, imageId: 21, name: "B-asset" },
    { id: 3, userId: 7, projectId: 100, imageId: null, name: "A-noimage" },
  ]);
  await knex("o_image").insert([{ id: 11, userId: 7, assetsId: 1, filePath: "/a.png" }, { id: 21, userId: 8, assetsId: 2, filePath: "/b.png" }]);
  await knex("o_tasks").insert([{ id: 1, userId: 7, projectId: 100, state: "进行中" }, { id: 2, userId: 8, projectId: 200, state: "进行中" }]);
  await knex("o_setting").insert({ key: "tokenKey", value: "sec" });
  return knex;
}

function withCtx(knex: any, ctx: TenantCtx | undefined, policies?: Record<string, any>) {
  let current = ctx;
  const db = makeTenantAware(knex, { getCtx: () => current, policies });
  return { db, setCtx: (c: TenantCtx | undefined) => { current = c; } };
}
const userA: TenantCtx = { userId: 7, role: "user", requestId: "r", source: "http" };
const admin: TenantCtx = { userId: 1, role: "admin", requestId: "r", source: "http" };

describe("守卫：主表条件与跨租户读", () => {
  it("只回自己的行；按越权 id 查返回空", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect((await db("o_assets").select("name").orderBy("id")).map((r: any) => r.name)).toEqual(["A-asset", "A-noimage"]);
    expect(await db("o_assets").where("id", 2).first()).toBeUndefined();
    expect((await db("o_assets").whereIn("id", [1, 2]).select("name")).map((r: any) => r.name)).toEqual(["A-asset"]);
    await knex.destroy();
  });

  it("join 到租户表时条件进 ON 子句（leftJoin 语义保住：右侧缺行仍保留左行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const rows = await db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").select("o_assets.name", "o_image.filePath").orderBy("o_assets.id");
    expect(rows).toEqual([{ name: "A-asset", filePath: "/a.png" }, { name: "A-noimage", filePath: null }]);
    const sql = db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").select("o_assets.name").toSQL();
    expect(sql.sql).toContain("and `o_image`.`userId` = ?");
    expect(sql.sql).toContain("where `o_assets`.`userId` = ?");
    expect(sql.bindings).toEqual([7, 7]);
    await knex.destroy();
  });

  it("inner join 也拿不到别的租户的行", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const rows = await db("o_assets").join("o_image", "o_assets.imageId", "o_image.id").select("o_image.filePath");
    expect(rows.map((r: any) => r.filePath)).toEqual(["/a.png"]);
    await knex.destroy();
  });

  it("别名写法（o_assets as a / o_image as i）也要注入", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const sql = db("o_assets as a").join("o_image as i", "a.imageId", "i.id").select("a.name").toSQL();
    expect(sql.sql).toContain("and `i`.`userId` = ?");
    expect(sql.sql).toContain("where `a`.`userId` = ?");
    await knex.destroy();
  });
});

describe("守卫：写路径", () => {
  it("insert 自动填 ctx.userId（单条与数组都是）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await db("o_tasks").insert({ id: 3, projectId: 100, state: "进行中" });
    await db("o_tasks").insert([{ id: 4, projectId: 100, state: "进行中" }, { id: 5, projectId: 100, state: "进行中" }]);
    expect((await knex("o_tasks").whereIn("id", [3, 4, 5]).select("userId")).map((r: any) => r.userId)).toEqual([7, 7, 7]);
    await knex.destroy();
  });

  it("insert 显式写别人的 userId → 抛 TenantIsolationError；写自己的 → 放行", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(db("o_tasks").insert({ id: 6, projectId: 200, userId: 8, state: "x" })).rejects.toThrow(TenantIsolationError);
    await db("o_tasks").insert({ id: 7, projectId: 100, userId: 7, state: "x" });
    expect((await knex("o_tasks").where("id", 7).first()).userId).toBe(7);
    await knex.destroy();
  });

  it("update/del 不带 where 也只影响本租户（实测：跨租户 update 影响 0 行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(await db("o_tasks").where("id", 2).update({ state: "hacked" })).toBe(0);
    expect((await knex("o_tasks").where("id", 2).first()).state).toBe("进行中");
    expect(await db("o_tasks").update({ state: "all" })).toBe(1);
    expect(await db("o_tasks").del()).toBe(1);
    expect((await knex("o_tasks").select("id")).map((r: any) => r.id)).toEqual([2]);
    await knex.destroy();
  });

  it("事务里的 trx 也被守卫（探针 F：trx 跨租户 update 影响 0 行、insert 自动填）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await db.transaction(async (trx: any) => {
      await trx("o_tasks").where("id", 2).update({ state: "hacked" });
      await trx("o_tasks").insert({ id: 30, projectId: 100, state: "trx" });
    });
    expect((await knex("o_tasks").where("id", 2).first()).state).toBe("进行中");
    expect((await knex("o_tasks").where("id", 30).first()).userId).toBe(7);
    await knex.destroy();
  });
});

describe("守卫：fail-closed", () => {
  it("没有 ctx → 租户表抛 TenantContextError；平台表读仍然放行（登录前要取 tokenKey）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, undefined);
    expect(() => db("o_assets")).toThrow(TenantContextError);
    expect(await db("o_setting").where("key", "tokenKey").first()).toEqual({ key: "tokenKey", value: "sec" });
    await knex.destroy();
  });

  it("未声明的表抛 PolicyNotFoundError；退役表报「退役」；knex 基础设施表已声明", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(() => db("o_unknown_table")).toThrow(PolicyNotFoundError);
    expect(() => db("o_skillList")).toThrow(/退役/);
    // 真断言（修复轮 1）：`typeof 拒绝的 Promise === "object"` 会恒真，测不到"放行"方向
    expect(db("knex_migrations").toSQL().sql).toContain("knex_migrations");
    await knex.destroy();
  });

  it("平台表写：普通用户 403 语义（PlatformWriteDeniedError），admin 放行", async () => {
    const knex = await fixture();
    const { db, setCtx } = withCtx(knex, userA);
    expect(() => db("o_setting").insert({ key: "k", value: "v" })).toThrow(PlatformWriteDeniedError);
    expect(() => db("o_setting").where("key", "tokenKey").update({ value: "x" })).toThrow(PlatformWriteDeniedError);
    setCtx(admin);
    await db("o_setting").insert({ key: "k", value: "v" });
    await db("o_setting").where("key", "k").del();
    await knex.destroy();
  });

  it("global 策略：读放行、写**任何角色**都抛（本阶段表映射未用到，用覆盖策略表验语义）", async () => {
    const knex = await fixture();
    await knex.schema.createTable("o_artStyle", (t) => { t.bigIncrements("id"); t.text("name"); });
    const { db } = withCtx(knex, admin, { ...TABLE_POLICIES, o_artStyle: "global" });
    expect(await db("o_artStyle").select("id")).toEqual([]);            // 读放行
    expect(() => db("o_artStyle").insert({ name: "x" })).toThrow(TenantIsolationError);
    expect(() => db("o_artStyle").where("id", 1).delete()).toThrow(TenantIsolationError);
    await knex.destroy();
  });

  it("危险方法在租户查询上封禁；在平台查询上不误伤", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    for (const call of [
      () => db("o_assets").orWhere("id", 2),
      () => db("o_assets").whereRaw("1=1"),
      () => db("o_assets").joinRaw("left join o_image on 1=1"),
      () => db("o_assets").crossJoin("o_image"),
      () => db("o_assets").union([knex("o_assets")]),
      () => db("o_assets").truncate(),
    ]) expect(call).toThrow(TenantIsolationError);
    expect(await db("o_setting").where("key", "tokenKey").orWhere("key", "x").select("key")).toEqual([{ key: "tokenKey" }]);
    await knex.destroy();
  });

  it("raw 的处置：提及租户表 → 抛；纯表达式（GROUP_CONCAT）→ 放行", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(() => db.raw("select count(*) from o_tasks")).toThrow(TenantIsolationError);
    // 真断言（修复轮 1）：纯表达式必须真的能建出 SQL 并执行，而不是 typeof 一个对象
    expect(db.raw("GROUP_CONCAT(name)").toSQL().sql).toContain("GROUP_CONCAT(name)");
    const grouped = await db("o_assets").select(db.raw("GROUP_CONCAT(name) as names"));
    expect(grouped[0].names).toBe("A-asset,A-noimage");
    await knex.destroy();
  });
});

describe("守卫：执行前 SQL 复核（判别力）", () => {
  it("平台查询的投影里塞租户子查询 → 拦（探针 G：执行期复核失败）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(db("o_setting").select(knex.raw("(select count(*) from o_tasks) as n")).where("key", "tokenKey")).rejects.toThrow(TenantIsolationError);
    await knex.destroy();
  });

  it("★ 把注入进 ON 子句的租户条件手工拆掉 → 执行时必须红（证明复核不是恒真）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const q: any = db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").select("o_assets.name", "o_image.filePath");
    const joinClause = q._statements.find((s: any) => s.grouping === "join");
    joinClause.clauses = []; // 模拟"注入失效"
    await expect(Promise.resolve(q)).rejects.toThrow(/执行期复核失败/);
    await knex.destroy();
  });

  it("clone() 之后仍是守卫：主表条件不重复、join 仍注入", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const cloned: any = db("o_assets").clone();
    expect(cloned.toSQL().bindings).toEqual([7]);
    const sql = cloned.leftJoin("o_image", "o_assets.imageId", "o_image.id").select("o_assets.name").toSQL();
    expect(sql.sql).toContain("and `o_image`.`userId` = ?");
    await knex.destroy();
  });

  it("正常查询不误报（含 LIKE 参数里出现别的表名）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(await db("o_tasks").where("describe", "like", "%o_segment%").select("id")).toEqual([]);
    expect((await db("o_tasks").select("state")).length).toBe(1);
    await knex.destroy();
  });
});

describe("守卫：knex 结构契约（升级护栏）", () => {
  it("join 族方法名集合与 knex Builder.prototype 的 /join/i 完全一致（knex 新增方法 → 本用例红）", async () => {
    const knex = await fixture();
    const qb: any = knex("o_assets");
    const builderProto = Object.getPrototypeOf(Object.getPrototypeOf(qb));
    const names: string[] = Object.getOwnPropertyNames(builderProto).filter((n) => /join/i.test(n));
    expect(names.slice().sort()).toEqual([...JOIN_METHODS, "crossJoin", "joinRaw", "_joinType"].sort());
    await knex.destroy();
  });

  it("parseTableSpec 对无法解析的目标 fail-closed（对象形式 / 原始 SQL 一律抛）", () => {
    expect(parseTableSpec("o_assets")).toEqual({ table: "o_assets", alias: "o_assets" });
    expect(parseTableSpec("o_assets as a")).toEqual({ table: "o_assets", alias: "a" });
    expect(parseTableSpec("`o_assets`")).toEqual({ table: "o_assets", alias: "o_assets" });
    expect(() => parseTableSpec({ i: "o_image" })).toThrow(PolicyNotFoundError);
    expect(() => parseTableSpec(1)).toThrow(PolicyNotFoundError);
  });

  it("策略表只有 tenant/platform 两态（本阶段无 global 表，结论 2），且租户表 22 张", () => {
    const values = new Set(Object.values(TABLE_POLICIES));
    expect([...values].sort()).toEqual(["platform", "tenant"]); // 本阶段无 global（结论 2）
    // ⚠【Phase 1c Task 1】20 → 22（`006_quota_grants` 的 `o_account` / `o_modelGrant`）
    expect(TENANT_TABLES.length).toBe(22);
  });
});

/**
 * 修复轮 1（独立审查 Ruling 188/189/191）。每条都先红后绿，红端原文见 task-2-report.md「修复轮 1」。
 * 这些用例钉的是"fail-closed 契约在哪些路径不成立"，不是新功能。
 */
describe("守卫：修复轮 1（M1–M6 / L1 / L5 / L6 / L7）", () => {
  it("M1a: .catch() 也做执行前复核（修复前：租户子查询被 resolve 成 [{n:2}]）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    let caught: unknown = null;
    const out = await db("o_setting").select(knex.raw("(select count(*) from o_tasks) as n")).catch((e: unknown) => {
      caught = e;
      return "handled";
    });
    expect(caught).toBeInstanceOf(TenantIsolationError);
    expect(out).toBe("handled");
    await knex.destroy();
  });

  it("M1b: .catch() 也做执行前复核（修复前：平台 builder 换表后 resolve 出两租户全部行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    let caught: unknown = null;
    const out = await db("o_setting").from("o_tasks").select("id").catch((e: unknown) => {
      caught = e;
      return "handled";
    });
    expect(caught).toBeInstanceOf(TenantIsolationError);
    expect(out).toBe("handled");
    await knex.destroy();
  });

  it("M1c: .finally() 也做执行前复核（修复前：resolve 出两租户全部行，finally 照跑）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    let ran = false;
    await expect(db("o_setting").from("o_tasks").select("id").finally(() => { ran = true; })).rejects.toThrow(TenantIsolationError);
    expect(ran).toBe(true);
    await knex.destroy();
  });

  it("M2: update 的 payload 写别人的 userId → 抛；写自己的 / 不写 → 放行", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(db("o_tasks").update({ userId: 8 })).rejects.toThrow(TenantIsolationError);
    await expect(db("o_tasks").where("id", 2).update("userId", 8)).rejects.toThrow(TenantIsolationError);
    expect((await knex("o_tasks").select("id", "userId").orderBy("id")).map((r: any) => r.userId)).toEqual([7, 8]);
    expect(await db("o_tasks").update({ state: "ok" })).toBe(1);
    expect(await db("o_tasks").where("id", 1).update({ userId: 7 })).toBe(1);
    await knex.destroy();
  });

  it("M3: 事务里的 trx.raw 提及租户表 → 抛（修复前：真的改了别人的行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(
      db.transaction(async (trx: any) => { await trx.raw("update o_tasks set state = 'hacked' where id = 2"); }),
    ).rejects.toThrow(TenantIsolationError);
    expect((await knex("o_tasks").where("id", 2).first()).state).toBe("进行中");
    await knex.destroy();
  });

  it("M4: raw 的表名匹配不区分大小写（修复前：delete from O_TASKS 真的删行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(() => db.raw("delete from O_TASKS where id = 1")).toThrow(TenantIsolationError);
    expect(() => db.raw("select id from O_TASKS")).toThrow(TenantIsolationError);
    expect(() => db.raw("update O_Tasks set state = 'x'")).toThrow(TenantIsolationError);
    expect((await knex("o_tasks").select("id")).length).toBe(2);
    await knex.destroy();
  });

  it("M5a: 平台 builder 换表（.from(租户表)）后的 update/del → 执行前复核拦（修复前：改 2 行 / 删 2 行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, admin); // 实测前提：平台表写要 admin ctx
    await expect(db("o_setting").from("o_tasks").update({ state: "hacked" })).rejects.toThrow(TenantIsolationError);
    await expect(db("o_setting").from("o_tasks").del()).rejects.toThrow(TenantIsolationError);
    expect((await knex("o_tasks").select("state")).map((r: any) => r.state)).toEqual(["进行中", "进行中"]);
    await knex.destroy();
  });

  it("M5b: 平台查询 WHERE/HAVING 里的租户子查询 → 拦（修复前：whereRaw 那条返回 1 行）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(db("o_setting").whereRaw("key in (select 'tokenKey' from o_tasks where o_tasks.userId = 8)").select("key"))
      .rejects.toThrow(TenantIsolationError);
    await expect(db("o_setting").select("key").where("key", "tokenKey").havingRaw("1 = (select count(*) from o_tasks)"))
      .rejects.toThrow(TenantIsolationError);
    await knex.destroy();
  });

  it("L1: insert 被拒时链条不断（.onConflict().merge() 仍以 TenantIsolationError 拒绝，不留 unhandledRejection）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    await expect(db("o_tasks").insert({ id: 6, userId: 8, state: "x" }).onConflict("id").merge()).rejects.toThrow(TenantIsolationError);
    expect(await knex("o_tasks").where("id", 6).first()).toBeUndefined();
    await knex.destroy();
  });

  it("M6（本轮新增发现）: 租户表的 onConflict() upsert → fail-closed（修复前：逃出守卫，且 merge payload 能把本租户的行改名到别人名下）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    expect(() => db("o_tasks").insert({ id: 1, state: "stolen" }).onConflict("id").merge()).toThrow(TenantIsolationError);
    expect(() => db("o_tasks").insert({ id: 1, state: "stolen" }).onConflict("id").merge({ userId: 8 })).toThrow(TenantIsolationError);
    expect((await knex("o_tasks").where("id", 1).first()).userId).toBe(7);
    await knex.destroy();
  });

  it("L5: db.trx 与 transaction 是同一个函数（修复前：运行时 undefined，接口声明在撒谎）", () => {
    const fake: any = () => ({});
    fake.transaction = () => "tx";
    const db = makeTenantAware(fake, { getCtx: () => userA });
    expect(typeof db.trx).toBe("function");
    expect(db.trx).toBe(db.transaction);
  });

  /**
   * 修复轮 2 / Task 3 接线时实测发现的缺陷：M3 把 `trx.raw` 写成"复用顶层 `guarded.raw` 的
   * 同一个实现"，而顶层实现内部是 `knex.raw(...)`（**根连接**）⇒ 事务里的**合法** raw
   * 跑到了事务外；sqlite 池 max=1 时与持有唯一连接的事务互等 ⇒ 用例挂到超时。
   * 本用例前半段就是那个"真的在事务里跑一次 raw"的场景（修复前必红）。
   */
  it("M3b（Task 3）: trx.raw 绑定事务自己（事务内能跑），且仍拦租户表", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const out = await db.transaction(async (trx: any) => trx.raw("select 1 as one"));
    expect(out).toBeTruthy();
    // 同一处仍然拦租户表（M3 的判据不许回到"直接透传"）
    await expect(
      db.transaction(async (trx: any) => trx.raw("update o_tasks set state='hacked' where id=2")),
    ).rejects.toThrow(TenantIsolationError);
    // trx("表") 仍走守卫；事务真的提交得下去
    await db.transaction(async (trx: any) => {
      await trx("o_assets").where("id", 1).update({ name: "A-renamed" });
    });
    expect((await knex("o_assets").where("id", 1).first()).name).toBe("A-renamed");
    await knex.destroy();
  }, 15000);

  it("L6: transaction(container, config) 把 config 透传给 knex（修复前 arg2 被丢掉）", () => {
    const calls: any[][] = [];
    const fake: any = () => ({});
    fake.transaction = (...args: any[]) => { calls.push(args); return "tx"; };
    const db = makeTenantAware(fake, { getCtx: () => userA });
    const container = async (trx: any) => trx;
    const config = { doNotRejectOnRollback: true };
    expect(db.transaction(container, config)).toBe("tx");
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe(config);          // config 原样透传
    expect(calls[0][0]).not.toBe(container);   // container 被 guardTrx 包过
  });

  it("L7: clone 不共享 joins 数组（平台表上：本体的 join 不再误伤克隆体的 orWhere）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const base: any = db("o_setting");
    const clone: any = base.clone();
    base.join("o_tasks", "o_tasks.id", "=", "o_setting.key").select("o_setting.key").toSQL();
    expect(() => clone.orWhere("key", "x")).not.toThrow(); // 修复前：共享 joins ⇒ 误禁
    clone.join("o_tasks", "o_tasks.id", "=", "o_setting.key");
    expect(() => clone.orWhere("key", "x")).toThrow(TenantIsolationError); // 自己 join 过之后仍然禁
    await knex.destroy();
  });
});

describe("守卫：成员面与 Phase 1a 白名单一致（Task 3 接线时发现的缺口）", () => {
  it("对象成员 fn/schema/client/migrate/seed 原样挂上（修复前：全是 undefined）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const u: any = db;
    // 形状必须与 utils/db.ts 的 DB_MEMBERS / tests/db-driver.test.ts 的口径**一字不差**：
    // knex 3.x 实测 `fn/schema/client/migrate/seed` 是 object、`ref/destroy` 是 function。
    for (const m of ["fn", "schema", "client", "migrate", "seed"]) {
      expect(typeof u[m], m).toBe("object");
      expect(u[m], m).not.toBeNull();
    }
    for (const m of ["ref", "destroy"]) expect(typeof u[m], m).toBe("function");
    // "object" 不等于"空对象占位"：点名关键成员（这才是"真的挂上去了"的证据）
    expect(typeof u.schema.createTable, "schema.createTable").toBe("function");
    expect(typeof u.schema.hasTable, "schema.hasTable").toBe("function");
    expect(typeof u.migrate.latest, "migrate.latest").toBe("function");
    expect(typeof u.seed.run, "seed.run").toBe("function");
    expect(typeof u.fn.now, "fn.now").toBe("function");
    expect(u.client, "client 是 knex 的 Client 实例").toBeTruthy();
    // 对象成员必须是 knex 自己的那类对象（不能是形状不同的替身）。
    // ⚠ 不能用 `toBe(knex.schema)` 判同一性：`schema` 是 getter，**每次访问都新建**一个
    //   SchemaBuilder（实测 `knex.schema !== knex.schema`）—— 1a 的白名单同样是"取一次快照"。
    //   所以判据取"构造函数同类"（`client` 也一并钉住）。
    expect((u.schema as any).constructor.name).toBe((knex as any).schema.constructor.name);
    expect((u.client as any).constructor.name).toBe((knex as any).client.constructor.name);
    await knex.destroy();
  });

  it("守卫自己的 transaction/raw/trx 不被成员镜像覆盖（仍是守卫实现）", async () => {
    const knex = await fixture();
    const { db } = withCtx(knex, userA);
    const u: any = db;
    // 覆盖它就等于把守卫换回裸 knex：`raw` 必须仍然拦租户表 SQL
    expect(() => u.raw("delete from o_tasks where id = 1")).toThrow(TenantIsolationError);
    expect(u.trx).toBe(u.transaction);
    await knex.destroy();
  });
});
