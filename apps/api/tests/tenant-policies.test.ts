import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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
} from "@/db/policies";
import { BACKFILL_EXEMPT_TABLES, BACKFILL_TARGET_TABLES, SELF_CHECK_TABLES } from "@/db/legacy/backfill-userid";
import { currentTenant, currentUserId, requireTenantCtx, runWithTenant, TenantContextError } from "@/db/tenant-context";

/**
 * 建表清单**不在这里解析**：它只有一份实现 —— `tools/migration-tables.cjs`
 * （门禁 `tools/check-tenant-policies.cjs` 用的是同一个文件）。
 *
 * ⚠ 为什么必须共用：Phase 1c Task 1 之前，门禁硬编码只解析 `001_schema.ts`，而本文件自己抄了一份正则 ——
 *   于是"新迁移建的表"对**门禁**不可见（一登记策略就报"策略表里的表不在建表清单里"），
 *   而本文件那半条判据也会跟着漂。两处解析 = 两份真相 = 必漂。
 * ⚠ 另外，`apps/api/tests/` 在 `tools/` 之外，不能 `import` 一个 `.cjs` 的相对路径
 *   （vitest 的模块图会把它当 ESM 解析）。所以这里 `createRequire` + 读**门禁自己 require 的那一行**，
 *   把那行文本当成"单一来源"的锚点：门禁一旦改回硬编码/换文件，本用例当场红。
 */
const nodeRequire = createRequire(process.cwd() + "/vitest-probe.js");
const GATE_SRC = fs.readFileSync(path.resolve(__dirname, "../../../tools/check-tenant-policies.cjs"), "utf8");
const GATE_REQUIRE = /const \{ collectMigrationTables \} = require\(path\.join\(__dirname, "([^"]+)"\)\);/.exec(GATE_SRC);
const PARSER_REL = GATE_REQUIRE ? GATE_REQUIRE[1] : "";
const parser = PARSER_REL
  ? (nodeRequire(path.resolve(__dirname, "../../../tools", PARSER_REL)) as {
      collectMigrationTables: () => {
        files: string[];
        createdTables: string[];
        deployedTables: string[];
        droppedTables: string[];
        retiredTables: string[];
        stagingTables: string[];
      };
    })
  : null;

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
  it("建表清单由单一来源解析（门禁与本文件的解析器是同一个文件）", () => {
    // 门禁里必须**没有**残留"只解析 001_schema"的硬编码
    expect(GATE_SRC).not.toMatch(/001_schema\.ts"?\s*,\s*"utf8"/);
    expect(PARSER_REL, "门禁里的解析器 require 行没找到 —— 解析器换位置了？").toBe("migration-tables.cjs");
    expect(parser, `载不到解析器 tools/${PARSER_REL}`).not.toBeNull();
    const parsed = parser!.collectMigrationTables();
    // 下界自证：解析器失灵（0 张表）时必须响亮失败，不能"0 === 0"放行
    expect(parsed.files.length).toBeGreaterThanOrEqual(6);
    expect(parsed.deployedTables.length).toBeGreaterThanOrEqual(33);
    // 暂存表（005 的 `o_user_new` / down 的 `o_user_old`）不得出现在"最终落地的表"里
    expect([...parsed.stagingTables].sort()).toEqual(["o_user_new", "o_user_old"]);
    for (const t of parsed.stagingTables) expect(parsed.deployedTables).not.toContain(t);
  });

  it("全部迁移建出的表都在策略表里，且没有任何策略对应不存在的表", () => {
    const parsed = parser!.collectMigrationTables();
    const created = parsed.deployedTables;
    const declared = Object.keys(TABLE_POLICIES).filter((t) => !INFRA_TABLES.has(t)).sort();
    expect(declared).toEqual(created); // 双向相等：少一张 / 多一张都红
    // 35 张既有表 + 4 张账务表 + 2 张准入表 + 5 张授权分组表 = 46 张。
    expect(created).toHaveLength(46);
    // ⚠ 退役表口径 = "被 dropTableIfExists 删过 **且从没被创建过**"（005/006 的 down 也删自建表，
    //   把那些算成"退役"会让这条断言永久对不上 —— 解析器里有详细说明）
    expect(parsed.retiredTables).toEqual(["o_skillAttribution", "o_skillList"]);
  });

  it("28 张租户表（含账务表、准入表与用户组成员关系）", () => {
    expect(TENANT_TABLES.slice().sort()).toEqual(
      [
        "memories", "o_account", "o_agentWorkData", "o_assets", "o_assets2Storyboard", "o_assetsRole2Audio",
        "o_event", "o_eventChapter", "o_image", "o_imageFlow", "o_modelGrant", "o_novel", "o_project",
        "o_script", "o_scriptAssets", "o_segment", "o_shot", "o_shotAssets", "o_storyboard", "o_tasks",
        "o_video", "o_videoTrack", "o_usage", "o_ledger", "o_order", "o_dailyQuotaAdmission", "o_usageAdmission",
        "o_userGroupMembership",
      ].sort(),
    );
    expect(TENANT_TABLES).toHaveLength(28);
    expect(USER_COLUMN).toBe("userId");
  });

  it("★ 三方一致（Phase 1c Task 1 改写的不变量）：TENANT == 回填目标 ∪ {o_project} ∪ 豁免", () => {
    const tenant = [...TENANT_TABLES].sort();
    const backfill = [...BACKFILL_TARGET_TABLES].sort();
    const exempt = [...BACKFILL_EXEMPT_TABLES].sort();
    const selfCheck = [...SELF_CHECK_TABLES].sort();
    // 新增租户表均为迁移后创建的空表，不进入历史归属回填。
    expect(exempt).toEqual(["o_account", "o_dailyQuotaAdmission", "o_ledger", "o_modelGrant", "o_order", "o_usage", "o_usageAdmission", "o_userGroupMembership"]);
    // ① 并集恰好覆盖全部租户表（"多一张租户表但没归类"必红）
    expect([...new Set(["o_project", ...backfill, ...exempt])].sort()).toEqual(tenant);
    // ② 自检表 == TENANT − EXEMPT（豁免表没有历史行，不进自检）
    expect(selfCheck).toEqual(tenant.filter((t) => !exempt.includes(t)));
    expect(SELF_CHECK_TABLES).toEqual(["o_project", ...BACKFILL_TARGET_TABLES]);
    // ③ 回填目标 == TENANT − EXEMPT − {o_project}
    expect(backfill).toEqual(tenant.filter((t) => t !== "o_project" && !exempt.includes(t)));
    expect(backfill).toHaveLength(19);
  });

  it("knex 基础设施表被显式声明（否则 fail-closed 会拒绝它们）", () => {
    expect([...INFRA_TABLES].sort()).toEqual(["knex_migrations", "knex_migrations_lock"]);
    expect(policyOf("knex_migrations")).toBe("platform");
    expect(policyOf("knex_migrations_lock")).toBe("platform");
  });

  it("平台表集合与附录 A 一致（账号族表、Phase 1d 队列表及 Phase 2 定价表）", () => {
    const platform = Object.entries(TABLE_POLICIES).filter(([, p]) => p === "platform").map(([t]) => t).sort();
    expect(platform).toEqual(
      [
        "knex_migrations", "knex_migrations_lock", "o_agentDeploy", "o_artStyle", "o_auditLog", "o_gate",
        "o_invite", "o_job", "o_loginAttempt", "o_modelPrompt", "o_price", "o_prompt", "o_setting", "o_user",
        "o_userSetting", "o_vendorConfig", "o_modelGroup", "o_modelGroupItem", "o_userGroup", "o_userGroupModelGroup",
      ].sort(),
    );
    // ⚠ 登录发生在建租户 ctx 之前 ⇒ 账号族的承载表**必须**是 platform（无 ctx 可读）
    for (const t of ["o_user", "o_invite", "o_loginAttempt", "o_userSetting", "o_auditLog"]) {
      expect(policyOf(t), t).toBe("platform");
    }
    // ⚠ Phase 1d Task 1：队列表/槽位表必须是 platform —— 若被改成 tenant，worker 的
    //   `claim`/`reclaim` 在系统身份（userId=0）下会注入 `userId = 0`，一条候选都查不到。
    //   判别力由 `tests/job-store.test.ts` 的"守卫 + 系统身份"组承担（真跑一次 claim）。
    for (const t of ["o_job", "o_gate"]) {
      expect(policyOf(t), t).toBe("platform");
    }
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

  /**
   * ⚠【Phase 1c Task 11】这条用例**取代**了原来那条"admin 桥接的判别力"（它当时断言
   * `roleOfUserId(1) === "admin"`）。
   *
   * 那个函数已随旧形状 token（`{id,name}`）的退役一起删除：它在新链路上**没有任何调用方**，
   * 而"按 id===1 判 admin、不读 DB"这件事只要被接回鉴权链就是一条提权路 —— 旧用例却还在钉住它的行为。
   * 现在钉的是"**原语真的不在了**"（删掉的是机制本身，所以"再加回来"必须从零写起），
   * 而"旧形状 `{id:1}` 令牌 ⇒ 401"由 `tests/auth-legacy-retired.test.ts` 在**真应用 + 真 HTTP** 上钉住。
   */
  it("★ admin 判定只信 DB：`roleOfUserId` 与两侧的 legacy 分支**都已从源码中消失**", () => {
    const read = (rel: string): string => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // ⚠ 判据刻意钉在"**声明/调用**"上，而不是"文本里出现过这个词"：注释里保留"它已经删了、
    //   为什么删"的说明是有价值的（本文件自己的注释也在提它）—— 只要**导出/调用**不在，机制就不在。
    expect(read("src/db/policies.ts"), "policies.ts 不得再**导出** roleOfUserId（按 id===1 判 admin 的过渡桥接）").not.toMatch(
      /export\s+function\s+roleOfUserId/,
    );
    expect(read("src/auth/tokens.ts"), "tokens.ts 不得再**提供**旧形状的验签原语").not.toMatch(/export\s+function\s+verifyLegacyToken/);
    for (const rel of ["src/middleware/auth.ts", "src/socket/tenant.ts"]) {
      expect(read(rel), `${rel} 不得再**调用** verifyLegacyToken（legacy 分支已退役）`).not.toMatch(/verifyLegacyToken\s*\(/);
    }
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
