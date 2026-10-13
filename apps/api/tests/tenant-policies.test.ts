import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DROPPED_TABLES,
  INFRA_TABLES,
  TABLE_POLICIES,
  TENANT_TABLES,
  USER_COLUMN,
  PolicyNotFoundError,
  isTenantTable,
  policyOf,
  roleOfUserId,
} from "@/db/policies";
import { currentTenant, currentUserId, requireTenantCtx, runWithTenant, TenantContextError } from "@/db/tenant-context";

const SCHEMA_SRC = fs.readFileSync(path.resolve(__dirname, "../src/db/migrations/001_schema.ts"), "utf8");

/**
 * 从 001_schema.ts 里机械抽出建表名与删表名（与 DDL 静态断言同一套路）。
 *
 * ⚠ **已知边界：这条正则只认一种 `createTable` 写法**——`createTable(` 之后紧跟**双引号**
 *   字面量表名，且表名字符集限 `[A-Za-z0-9_]`。写成 `createTable(\n  'o_x'`（单引号）、
 *   模板串、变量/常量名、或经 `knex.schema` 别名调用时**抽不到**。
 *   ⚠ 此时**长度兜底 `expect(created).toHaveLength(27)` 拦不住**：非常规写法新增的表若**也没登记**
 *   进 `TABLE_POLICIES`，则"长度仍是 27"与下面那条 `declared` ↔ `created` 双向相等**同时成立**
 *   （两边**一起**少了同一张表）⇒ 静默放行。要真封住这条边界得改用 AST（TypeScript compiler API），
 *   或落到 Task 8 的 `tools/check-tenant-policies.cjs`（它的正则也须一并收紧）。
 */
function schemaTables(): { created: string[]; dropped: string[] } {
  const created = [...SCHEMA_SRC.matchAll(/createTable\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const dropped = [...SCHEMA_SRC.matchAll(/dropTableIfExists\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  return { created: [...new Set(created)].sort(), dropped: [...new Set(dropped)].sort() };
}

/**
 * 抓取同步抛出的错误对象（`toThrow` 只能证明"抛了"，钉不住 `code` / `httpStatus`）。
 * ⚠ 为什么要钉：Task 4 的 `ISOLATION_CODES` 与 403/500 映射**按这两个字面量判分支**
 *   （`ISOLATION_CODES.has(err.code)` / `Number(err.httpStatus) || 500`）：字符串一改，
 *   隔离错误就会从 403/500 掉进"交给既有错误中间件"的兜底分支 —— 且不会有任何用例变红。
 */
function grabError(fn: () => unknown): { code?: unknown; httpStatus?: unknown } {
  try {
    fn();
  } catch (e) {
    return e as { code?: unknown; httpStatus?: unknown };
  }
  return {};
}

describe("策略表（spec §6.2 / 附录 A）", () => {
  it("001_schema 的镜像没变（27 建 / 2 删）——变了就必须回来核对策略表", () => {
    const { created, dropped } = schemaTables();
    expect(created).toHaveLength(27);
    expect(dropped).toEqual(["o_skillAttribution", "o_skillList"]);
  });

  it("每一张在库表都有策略，且没有任何策略对应不存在的表", () => {
    const { created } = schemaTables();
    const declared = Object.keys(TABLE_POLICIES).filter((t) => !INFRA_TABLES.has(t)).sort();
    expect(declared).toEqual(created); // 双向相等：少一张 / 多一张都红
  });

  it("20 张租户表（Phase 1a 账本 Ruling 32 的口径，不是 spec 正文的 18）", () => {
    expect(TENANT_TABLES.slice().sort()).toEqual(
      [
        "memories", "o_agentWorkData", "o_assets", "o_assets2Storyboard", "o_assetsRole2Audio", "o_event",
        "o_eventChapter", "o_image", "o_imageFlow", "o_novel", "o_project", "o_script", "o_scriptAssets",
        "o_segment", "o_shot", "o_shotAssets", "o_storyboard", "o_tasks", "o_video", "o_videoTrack",
      ].sort(),
    );
    expect(TENANT_TABLES).toHaveLength(20);
    expect(USER_COLUMN).toBe("userId");
  });

  it("knex 基础设施表被显式声明（否则 fail-closed 会拒绝它们）", () => {
    expect([...INFRA_TABLES].sort()).toEqual(["knex_migrations", "knex_migrations_lock"]);
    expect(policyOf("knex_migrations")).toBe("platform");
    expect(policyOf("knex_migrations_lock")).toBe("platform");
  });

  it("平台表集合与附录 A 一致", () => {
    const platform = Object.entries(TABLE_POLICIES).filter(([, p]) => p === "platform").map(([t]) => t).sort();
    expect(platform).toEqual(
      [
        "knex_migrations", "knex_migrations_lock", "o_agentDeploy", "o_artStyle", "o_modelPrompt",
        "o_prompt", "o_setting", "o_user", "o_vendorConfig",
      ].sort(),
    );
  });

  it("未声明的表与退役表都必须抛错，不许静默放行", () => {
    expect(() => policyOf("o_unknown_table")).toThrow(PolicyNotFoundError);
    expect(() => policyOf("sqlite_master")).toThrow(PolicyNotFoundError);
    // L2：策略错误的 code / httpStatus 必须被钉住（Task 4 的 ISOLATION_CODES + 500 映射依赖这两个字面量）。
    const notFound = grabError(() => policyOf("o_unknown_table"));
    expect(notFound.code).toBe("POLICY_NOT_FOUND");
    expect(notFound.httpStatus).toBe(500);
    // ⚠ 原型链键必须也抛错：裸下标 `tableMap[table]` 会让 Object.prototype 的继承键
    //    绕过 fail-closed（独立审查实跑证实：policyOf("constructor") 曾返回 <function Object>，
    //    toString/valueOf/__proto__ 全部不抛）；把 hasOwnProperty 判定删掉，这条即变红。
    for (const protoKey of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      expect(() => policyOf(protoKey)).toThrow(PolicyNotFoundError);
    }
    for (const t of DROPPED_TABLES) expect(() => policyOf(t)).toThrow(/退役/);
    // L1：`DROPPED_TABLES` 的**成员**必须逐个钉死 —— 只遍历集合成员的话，把它清空（或增删一个）
    //     本文件仍然全绿，而 Task 2 的守卫要消费这张集合。
    expect([...DROPPED_TABLES].sort()).toEqual(["o_skillAttribution", "o_skillList"]);
    expect(isTenantTable("o_assets")).toBe(true);
    expect(isTenantTable("o_setting")).toBe(false);
  });

  it("admin 桥接的判别力：只有 userId=1 是 admin（Phase 1c 由 o_user.role 取代）", () => {
    expect(roleOfUserId(1)).toBe("admin");
    for (const id of [0, 2, 7, 999]) expect(roleOfUserId(id)).toBe("user");
  });
});

describe("租户上下文（spec §6.4）", () => {
  const ctx = { userId: 7, role: "user" as const, requestId: "r-1", source: "http" as const };

  it("run() 内外可见性：外面拿不到、里面拿得到、await 之后还在", async () => {
    expect(currentTenant()).toBeUndefined();
    await runWithTenant(ctx, async () => {
      expect(currentTenant()).toEqual(ctx);
      await new Promise((r) => setTimeout(r, 5));
      expect(currentUserId()).toBe(7);
    });
    expect(currentTenant()).toBeUndefined();
  });

  it("没有 ctx 时 requireTenantCtx 必须抛，而不是返回默认值", () => {
    expect(() => requireTenantCtx()).toThrow(TenantContextError);
    expect(() => requireTenantCtx()).toThrow(/fail-closed/);
    // L2：同样钉住 code / httpStatus（Task 4 的 ISOLATION_CODES 认 "TENANT_NO_CONTEXT"）。
    const noCtx = grabError(() => requireTenantCtx());
    expect(noCtx.code).toBe("TENANT_NO_CONTEXT");
    expect(noCtx.httpStatus).toBe(500);
  });

  it("⚠ 在 run() 内注册、之后才触发的监听器拿不到 ctx —— 这是 socket 必须显式包装的原因", async () => {
    const { EventEmitter } = await import("node:events");
    const ee = new EventEmitter();
    let seen: unknown = "NOT_CALLED";
    runWithTenant(ctx, () => {
      ee.on("evt", () => {
        seen = currentTenant() ?? null;
      });
    });
    ee.emit("evt");
    expect(seen).toBeNull(); // 探针 A 实测（`als_emitter_registered_inside_run = null`）
  });
});
