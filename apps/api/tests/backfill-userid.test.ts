/**
 * `userId` 回填 + `memories` 旧键回填（Phase 1b Task 6）—— 判别力用例（工具层）。
 *
 * 覆盖 brief 的 8 条 + 本任务书要求的**三层验证**（Ruling 228 / 审查者输入 D、E）：
 *   ① 静态自洽：回填后三张表的 `userId IS NULL` 计数 = 期望；**键首段 == userId 的违规计数 = 0**；
 *   ② 守卫层**两向**：用行自己的 `userId` 建 ctx 必须查到；换一个 `userId` 必须查不到（都不抛）；
 *   ③ 负向对照：**键正确但 `userId=NULL`** 的行 → 守卫读 **0 行且不抛错**（"静默不可见"真实存在）；
 *   ④ `assertBackfillConsistent` 的**红端**（少填一个 / 键首段违规 → 必须抛）。
 *
 * ⚠ 全程在 `%TEMP%` 一次性库上（`MIWO_DATA_DIR` 之外），**不碰** `apps/api/data/db2.sqlite`。
 * ⚠ 键格式复用 socket 侧**同一个** `buildIsolationKey`（用"等于它的输出"+"首零段归一化"两条断言钉住）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";
import { makeTenantAware } from "@/db/tenant-guard";
import { buildIsolationKey } from "@/socket/tenant";
import {
  assertBackfillConsistent,
  assertDeriveColumns,
  backfillUserIds,
  firstProjectIdInFlowData,
  formatBackfillReport,
  rewriteIsolationKey,
  targetSpecOf,
  type BackfillReport,
} from "@/db/legacy/backfill-userid";

const API_ROOT = path.resolve(__dirname, "..");
/** 13 位（真实 `Date.now()` 量级）：`o_imageFlow.flowData` 兜底那条正则要求 6 位以上。 */
const LONG_PROJECT = 2000000000200;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-backfill-"));
function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  };
}
let knex: any;

const ctxOf = (userId: number): TenantCtx => ({ userId, role: "user", requestId: "t", source: "system" });

/**
 * 剥掉 `//` 行注释与 `/* … *\/` 块注释（**字符串字面量里的 `//` 不处理**——本用例只比对 import 语句，
 * 够用且简单）。
 * ⚠ 立这条的由来（Lead 规范 / 审查者踩过的假阳性）：审查者第一版 import-graph 脚本因为
 * `isolation-key.ts` 的**注释里**有 `import u from "@/utils"` 这句解释文字，把 `@/utils` 判成可达。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 只读快照：所有租户表的 userId 分布（用于 dry-run / down 的"没有写库"断言）。 */
async function snapshot(): Promise<string> {
  const tables = [
    "o_project", "o_tasks", "o_novel", "o_event", "o_eventChapter", "o_script", "o_assets", "o_image",
    "o_storyboard", "o_agentWorkData", "o_video", "o_videoTrack", "o_imageFlow", "o_assets2Storyboard",
    "o_scriptAssets", "o_shotAssets", "o_assetsRole2Audio", "o_segment", "o_shot", "memories",
  ];
  const out: string[] = [];
  for (const t of tables) {
    const rows: any[] = await knex(t).select("*").orderBy("rowid").catch(async () => await knex(t).select("*"));
    out.push(`${t}:${JSON.stringify(rows.map((r) => ({ u: r.userId ?? null, k: r.isolationKey ?? null })))}`);
  }
  return out.join("\n");
}

beforeAll(async () => {
  knex = createKnex(cfg(path.join(TMP, "backfill.sqlite")));
  await runMigrations(knex); // 真跑 001–004 之前的全部迁移，拿到真 schema
  const ins = (table: string, rows: any[]) => knex(table).insert(rows);
  // A=7 → project 100；B=8 → project 200；孤儿 → project 300（userId NULL）
  // `LONG_PROJECT`（13 位，与真实 `Date.now()` id 同数量级）专供 `o_imageFlow` 的 flowData 兜底：
  // 那个正则刻意要求 **6 位以上**（真实 id 是 13 位；放宽会误伤 `oss/300/a.png` 这类相对路径）。
  await ins("o_project", [
    { id: 100, userId: 7, name: "A" },
    { id: 200, userId: 8, name: "B" },
    { id: 300, userId: null, name: "orphan" },
    { id: LONG_PROJECT, userId: 8, name: "B2" },
  ]);
  await ins("o_script", [{ id: 11, projectId: 100 }, { id: 12, projectId: 200 }, { id: 13, projectId: 300 }]);
  await ins("o_assets", [{ id: 21, projectId: 100 }, { id: 22, projectId: 200 }, { id: 23, projectId: 300 }, { id: 24, projectId: 100 }]);
  await ins("o_image", [{ id: 31, assetsId: 21 }, { id: 32, assetsId: 22 }, { id: 33, assetsId: 23 }]);
  await ins("o_tasks", [{ id: 41, projectId: 100 }, { id: 42, projectId: 200 }, { id: 43, projectId: 300 }]);
  await ins("o_novel", [{ id: 51, projectId: 100 }, { id: 52, projectId: 200 }]);
  await ins("o_eventChapter", [{ id: 61, eventId: 71, novelId: 51 }, { id: 62, eventId: 72, novelId: 52 }, { id: 63, eventId: 73, novelId: 51 }, { id: 64, eventId: 73, novelId: 52 }]);
  await ins("o_event", [{ id: 71, name: "只有 A" }, { id: 72, name: "只有 B" }, { id: 73, name: "跨项目（多义）" }]);
  await ins("o_storyboard", [{ id: 81, projectId: 100 }, { id: 82, projectId: 200 }]);
  await ins("o_shot", [{ id: 91, projectId: 100 }, { id: 92, projectId: 200 }]);
  await ins("o_segment", [{ id: 101, projectId: 100, scriptId: 11, segmentIndex: 1 }, { id: 102, projectId: 200, scriptId: 12, segmentIndex: 1 }]);
  await ins("o_video", [{ id: 111, projectId: 100 }, { id: 112, projectId: 200 }]);
  await ins("o_videoTrack", [{ id: 121, projectId: 100 }, { id: 122, projectId: 200 }]);
  await ins("o_agentWorkData", [{ id: 131, projectId: 100, episodesId: 1, key: "k" }, { id: 132, projectId: 200, episodesId: 1, key: "k" }]);
  await ins("o_assets2Storyboard", [{ storyboardId: 81, assetId: 21 }, { storyboardId: 82, assetId: 22 }]);
  await ins("o_scriptAssets", [{ scriptId: 11, assetId: 21 }, { scriptId: 12, assetId: 22 }]);
  await ins("o_shotAssets", [{ shotId: 91, assetId: 21 }, { shotId: 92, assetId: 22 }]);
  await ins("o_assetsRole2Audio", [{ assetsAudioId: 21, assetsRoleId: 24 }, { assetsAudioId: 22, assetsRoleId: 22 }]);
  // o_imageFlow：第 1 行主链（o_assets.flowId）通；第 2 行主链断、只能靠 flowData 兜底
  // ⚠ flowData 里的 projectId 必须是 **6 位以上**（`firstProjectIdInFlowData` 的正则口径 = 真实 id 量级）：
  //   brief 初稿夹具写的是 `200/scene/a.png`（3 位）却期望回填出 8 —— 与它自己的正则**自相矛盾**
  //   （那正是 brief 的函数单测用 13 位 `1790518568661` 的原因）。这里按正则口径用 `LONG_PROJECT`。
  await ins("o_imageFlow", [
    { id: 141, flowData: "{}" },
    { id: 142, flowData: JSON.stringify({ n: { url: `${LONG_PROJECT}/scene/a.png` } }) },
  ]);
  await knex("o_assets").where("id", 21).update({ flowId: 141 });
  await ins("memories", [
    { id: "m1", isolationKey: "100:scriptAgent", type: "message", content: "a", createTime: 1 },
    { id: "m2", isolationKey: "200:productionAgent:3", type: "message", content: "b", createTime: 2 },
    { id: "m3", isolationKey: "300:scriptAgent", type: "message", content: "c", createTime: 3 },
  ]);
});
afterAll(async () => { await knex.destroy(); fs.rmSync(TMP, { recursive: true, force: true }); });

describe("回填工具函数", () => {
  it("flowData 兜底：取路径首段的 projectId（dev 库那行是 `1790518568661/role/…`）", () => {
    expect(firstProjectIdInFlowData(JSON.stringify({ n: { url: "1790518568661/role/a.png" } }))).toBe(1790518568661);
    expect(firstProjectIdInFlowData("no-path-here")).toBeNull();
    expect(firstProjectIdInFlowData(null)).toBeNull();
  });

  it("isolationKey 改写：老格式加前缀；已是新格式返回 null（幂等）", () => {
    expect(rewriteIsolationKey(7, "100:scriptAgent")).toBe("7:100:scriptAgent");
    expect(rewriteIsolationKey(7, "7:100:scriptAgent")).toBeNull();
    expect(rewriteIsolationKey(7, "bad")).toBeNull();
  });

  it("★ 键复用 socket 侧**同一个** buildIsolationKey（含集号段保留与首零归一化）", () => {
    // 与 socket 写入侧逐字符相同 ⇒ HTTP/socket 都能寻址
    expect(rewriteIsolationKey(7, "100:scriptAgent")).toBe(buildIsolationKey(ctxOf(7), 100, "scriptAgent"));
    expect(rewriteIsolationKey(7, "100:productionAgent:11")).toBe(buildIsolationKey(ctxOf(7), 100, "productionAgent", 11));
    // **保留老键的集号段**（老键第 3 段 = o_script.id）
    expect(rewriteIsolationKey(7, "1791385147125:productionAgent:7")).toBe("7:1791385147125:productionAgent:7");
    // 判别力：走 buildIsolationKey 会把首零段归一化；"自己拼串"的实现会留下 `:0011`
    expect(rewriteIsolationKey(7, "100:productionAgent:0011")).toBe("7:100:productionAgent:11");
    // 非正/非数字的集号段：**不改写**（返回 null，交给自检报告，不猜）
    expect(rewriteIsolationKey(7, "100:productionAgent:abc")).toBeNull();
    expect(rewriteIsolationKey(7, "100:productionAgent:0")).toBeNull();
  });

  it("源码层判据：键格式来自**中性纯模块** @/db/isolation-key（唯一真相），迁移链不得拉 @/utils", () => {
    // ⚠ **必须先剥注释**（Lead 立的规范 / 审查者踩过的假阳性）：`isolation-key.ts` 的注释里就写着
    //   `import u from "@/utils"` 这句解释文字；不剥注释会把"解释为什么不能 import"判成"可达"。
    const src = stripComments(fs.readFileSync(path.join(API_ROOT, "src", "db", "legacy", "backfill-userid.ts"), "utf8"));
    expect(src).toMatch(/from "@\/db\/isolation-key"/);
    // 不许**从** `@/socket/tenant` import/require：那里顶层 `import u from "@/utils"` → `@/utils/db`
    // → `@/db/connect`，从迁移链进来会构成加载期循环（实测 `TypeError: createKnex is not a function`）。
    expect(src).not.toMatch(/^\s*import[^\n]*@\/socket\/tenant/m);
    expect(src).not.toMatch(/require\(\s*["']@\/socket\/tenant["']\s*\)/);
    expect(src).toMatch(/buildIsolationKey\(/);
    // 纯 knex query builder：不许出现 raw
    expect(src).not.toMatch(/\.raw\s*\(/);
  });
});

describe("dry-run 与 apply", () => {
  it("dry-run：不改库（逐表快照逐字节相同），但报告里给出计划数", async () => {
    const before = await snapshot();
    const report = await backfillUserIds(knex, { apply: false });
    expect(await snapshot()).toBe(before);
    const assets = report.tables.find((t) => t.table === "o_assets")!;
    expect(assets.nullBefore).toBe(4);
    expect(assets.updated).toBe(3);            // 21/22/24 可推导；23 属孤儿项目
    expect(assets.orphans).toHaveLength(1);
    expect(report.projects.withoutUser.map((p) => Number(p.id))).toEqual([300]);
    await expect(knex("o_assets").where("id", 21).first()).resolves.toMatchObject({ userId: null });
  });

  it("apply：20 张表按链回填；孤儿留 NULL；事件多义不写", async () => {
    await backfillUserIds(knex, { apply: true });
    const checks: Array<[string, number | string, number]> = [
      ["o_tasks", 41, 7], ["o_tasks", 42, 8],
      ["o_script", 11, 7], ["o_script", 12, 8],
      ["o_assets", 21, 7], ["o_assets", 22, 8], ["o_assets", 24, 7],
      ["o_image", 31, 7], ["o_image", 32, 8],
      ["o_novel", 51, 7], ["o_eventChapter", 61, 7],
      ["o_storyboard", 81, 7], ["o_shot", 91, 7], ["o_segment", 101, 7],
      ["o_video", 111, 7], ["o_videoTrack", 121, 7], ["o_agentWorkData", 131, 7],
      ["memories", "m1", 7],
    ];
    for (const [table, id, userId] of checks) {
      const row: any = await knex(table).where("id", id).first();
      expect(`${table}#${id}=${row?.userId}`).toBe(`${table}#${id}=${userId}`);
    }
    expect((await knex("o_assets2Storyboard").where({ storyboardId: 81, assetId: 21 }).first()).userId).toBe(7);
    expect((await knex("o_scriptAssets").where({ scriptId: 12, assetId: 22 }).first()).userId).toBe(8);
    expect((await knex("o_shotAssets").where({ shotId: 92, assetId: 22 }).first()).userId).toBe(8);
    expect((await knex("o_assetsRole2Audio").where({ assetsAudioId: 21, assetsRoleId: 24 }).first()).userId).toBe(7);
    expect((await knex("o_imageFlow").where("id", 141).first()).userId).toBe(7);   // 主链
    expect((await knex("o_imageFlow").where("id", 142).first()).userId).toBe(8);   // flowData 兜底
    expect((await knex("o_event").where("id", 71).first()).userId).toBe(7);
    expect((await knex("o_event").where("id", 72).first()).userId).toBe(8);
    expect((await knex("o_event").where("id", 73).first()).userId).toBeNull();     // 多义 → 不写
    expect((await knex("o_tasks").where("id", 43).first()).userId).toBeNull();     // 孤儿 → 不写
    expect((await knex("memories").where("id", "m1").first()).isolationKey).toBe("7:100:scriptAgent");
    expect((await knex("memories").where("id", "m2").first()).isolationKey).toBe("8:200:productionAgent:3");
    expect((await knex("memories").where("id", "m3").first()).userId).toBeNull();
  });

  it("幂等：第二次 apply 一行都不改（20 张表的 updated 全为 0）", async () => {
    const before = await snapshot();
    const report = await backfillUserIds(knex, { apply: true });
    expect(await snapshot()).toBe(before);
    expect(report.tables.every((t) => t.updated === 0)).toBe(true);
    expect(report.memoriesKeys.rewritten).toBe(0);
  });

  it("--assign-to：孤儿项目的行（以及 rows 报告里的孤儿）归给指定用户", async () => {
    const before = await snapshot();
    const report = await backfillUserIds(knex, { apply: true, assignTo: 1 });
    expect(await snapshot()).not.toBe(before);
    expect((await knex("o_project").where("id", 300).first()).userId).toBe(1);
    expect((await knex("o_tasks").where("id", 43).first()).userId).toBe(1);
    expect((await knex("memories").where("id", "m3").first()).userId).toBe(1);
    expect(report.assignedTo).toBe(1);
  });

  it("归属链收敛到 o_project.userId：改项目归属后重跑，子表跟着变", async () => {
    await knex("o_project").where("id", 200).update({ userId: 9 });
    await knex("o_script").where("id", 12).update({ userId: null });
    await backfillUserIds(knex, { apply: true });
    expect((await knex("o_script").where("id", 12).first()).userId).toBe(9);
  });
});

describe("★三层验证（Ruling 228 / 审查输入 D、E）", () => {
  it("① 静态自洽：**每一张**目标表的 NULL 计数 = 应剩、键首段违规 = 0（回填后）", async () => {
    const report = await backfillUserIds(knex, { apply: true });
    // 覆盖 19 张目标表 + `o_project`（审查 P2-2：只覆盖 3 张时"某表整表误判孤儿"看不见）
    expect(report.selfCheck.length).toBe(20);
    expect(report.selfCheck[0].table).toBe("o_project");
    for (const s of report.selfCheck) {
      expect(s.userIdNull, `${s.table}：NULL 实际必须等于应剩`).toBe(s.expectedNull);
      expect(s.keyHeadMismatch, `${s.table}：键首段违规必须为 0`).toBe(0);
      expect(s.suspiciousAllOrphan, `${s.table}：本项目场景下不该出现"整表孤儿"`).toBe(false);
    }
    expect(() => assertBackfillConsistent(report)).not.toThrow();
    // 报告文本里必须能看到自检表（运维口径）+ 全部 20 行
    const text = formatBackfillReport(report);
    expect(text).toMatch(/自检/);
    for (const s of report.selfCheck) expect(text).toContain(`${s.table}:`);
  });

  it("★ 审查 P2-2 根因拦截：`assertDeriveColumns` 对'漏选外键列'当场抛（D3 的根因）", () => {
    expect(() => assertDeriveColumns([{ id: 1, userId: null }], targetSpecOf("o_script")!.derive, "o_script")).toThrow(/外键列/);
    expect(() => assertDeriveColumns([{ id: 1, userId: null, projectId: 100 }], targetSpecOf("o_script")!.derive, "o_script")).not.toThrow();
    // `o_event` 的 derive 不声明外键列（靠 `o_eventChapter` 索引）⇒ 不误报
    expect(() => assertDeriveColumns([{ id: 1, userId: null }], targetSpecOf("o_event")!.derive, "o_event")).not.toThrow();
  });

  it("★ 审查 P2-2 可疑信号：整表都是孤儿且项目索引非空 ⇒ warnings 点名（不抛错，避免启动路径假失败）", async () => {
    // 造一个"项目存在但 userId=NULL"的项目 + 一条属于它的 o_videoTrack 行
    await knex("o_project").insert({ id: 400, userId: null, name: "orphan-only" });
    await knex("o_videoTrack").insert({ id: 123, projectId: 400, userId: null });
    try {
      const report = await backfillUserIds(knex, { apply: true });
      const vt = report.selfCheck.find((s) => s.table === "o_videoTrack")!;
      expect(vt).toMatchObject({ userIdNull: 1, expectedNull: 1, updated: 0, orphans: 1, suspiciousAllOrphan: true });
      expect(report.warnings.join("\n")).toMatch(/o_videoTrack/);
      expect(formatBackfillReport(report)).toMatch(/可疑/);
      // ⚠ 它**不**让断言抛错（真库上可能有合法的全孤儿表；004.up 在启动路径上）
      expect(() => assertBackfillConsistent(report)).not.toThrow();
    } finally {
      await knex("o_videoTrack").where("id", 123).del();
      await knex("o_project").where("id", 400).del();
    }
  });

  it("② 守卫层两向：用自己的 userId 查得到；换一个 userId 查不到（都不抛错）", async () => {
    const guarded: any = makeTenantAware(knex, { getCtx: currentTenant });
    const keyM1 = "7:100:scriptAgent";
    // ⚠ **await 必须在 `runWithTenant` 的 async 回调里面**：守卫的"执行前复核"在**执行时**读 ctx，
    //   写 `runWithTenant(ctx, () => builder.first())`（返回 thenable、到外面 await）会在复核时
    //   看不到 ctx → `TenantIsolationError: … 0 个 ctx.userId 绑定`（本任务实测，已立为硬规则）。
    const mine = await runWithTenant(ctxOf(7), async () => await guarded("memories").where({ isolationKey: keyM1 }).first());
    expect(mine?.id).toBe("m1");
    const other = await runWithTenant(ctxOf(8), async () => await guarded("memories").where({ isolationKey: keyM1 }).first());
    expect(other, "换一个租户必须查不到（守卫注入 userId=8）").toBeUndefined();
    // 反向：8 的键在 8 下查得到、在 7 下查不到
    const keyM2 = "8:200:productionAgent:3";
    expect((await runWithTenant(ctxOf(8), async () => await guarded("memories").where({ isolationKey: keyM2 }).first()))?.id).toBe("m2");
    expect(await runWithTenant(ctxOf(7), async () => await guarded("memories").where({ isolationKey: keyM2 }).first())).toBeUndefined();
  });

  it("★★ ALS 纪律（本任务发现，立为硬规则）：返回 thenable 到外面 await ⇒ 复核时看不到 ctx（坏形态）；async 回调内 await ⇒ 正常（好形态）", async () => {
    const guarded: any = makeTenantAware(knex, { getCtx: currentTenant });
    const q = () => guarded("memories").where({ isolationKey: "7:100:scriptAgent" }).first();
    // 坏形态：builder 在 run 里**创建**，但 await 发生在 run **之外** ⇒ 执行期复核时 getCtx() 为 undefined
    const bad = await runWithTenant(ctxOf(7), () => q()).then(
      () => null,
      (e: any) => e,
    );
    expect(bad?.name, "坏形态必须响亮失败（而不是静默返回空）").toBe("TenantIsolationError");
    expect(String(bad?.message)).toMatch(/0 个 ctx\.userId 绑定/);
    // 好形态：await 在 run 内
    const good = await runWithTenant(ctxOf(7), async () => await q());
    expect(good?.id).toBe("m1");
  });

  it("③ 负向对照：**键正确但 userId=NULL** 的行 → 守卫读 0 行且**不抛错**（静默不可见真实存在）", async () => {
    await knex("memories").insert({ id: "neg-1", isolationKey: "7:100:scriptAgent", type: "message", content: "key-ok-but-null-user", createTime: 9, userId: null });
    try {
      const guarded: any = makeTenantAware(knex, { getCtx: currentTenant });
      // 未加守卫的裸读能看见它（证明"行在库里"，排除"根本没插进去"的假绿）
      expect((await knex("memories").where("id", "neg-1").first())?.id).toBe("neg-1");
      // 守卫读：0 行、**不抛错**（这正是"只改键不改 userId ⇒ 看起来回填成功了、实际还是读不到"的形态）
      const viaGuard = await runWithTenant(ctxOf(7), async () => {
        try {
          return { rows: await guarded("memories").where({ id: "neg-1" }).select("id"), err: null as any };
        } catch (e) {
          return { rows: null as any, err: e };
        }
      });
      expect(viaGuard.err, "守卫读 NULL userId 的行**不许抛错**（是静默过滤，不是响亮失败）").toBeNull();
      expect(viaGuard.rows).toEqual([]);
      // 对照：把 userId 补上，立刻可见 ⇒ 证明缺的就是那一列
      await knex("memories").where("id", "neg-1").update({ userId: 7 });
      expect((await runWithTenant(ctxOf(7), async () => await guarded("memories").where({ id: "neg-1" }).first()))?.id).toBe("neg-1");
    } finally {
      await knex("memories").where("id", "neg-1").del();
    }
  });

  it("④ 自检断言的红端：少填一个（NULL 计数对不上）/ 键首段违规 → 必须抛", () => {
    const entry = (over: Partial<BackfillReport["selfCheck"][number]> = {}): BackfillReport["selfCheck"][number] => ({
      table: "memories",
      userIdNull: 1,
      expectedNull: 1,
      keyHeadMismatch: 0,
      updated: 1,
      orphans: 0,
      suspiciousAllOrphan: false,
      ...over,
    });
    const base = (): BackfillReport => ({
      applied: true,
      assignedTo: null,
      projects: { total: 3, withUser: 2, withoutUser: [{ id: 300, name: "orphan" }] },
      tables: [],
      memoriesKeys: { total: 0, rewritten: 0, skipped: 0 },
      selfCheck: [
        { ...entry(), table: "o_script", updated: 2 },
        { ...entry(), table: "o_project", updated: 0 },
        entry(),
      ],
      warnings: [],
    });
    expect(() => assertBackfillConsistent(base())).not.toThrow();
    // 红端 1：实际 NULL 比"应剩"的多一个（= 有一行该填没填）
    const short = base();
    short.selfCheck[2] = entry({ userIdNull: 2 });
    expect(() => assertBackfillConsistent(short)).toThrow(/memories/);
    // 红端 2：键首段 != userId（= 键改错了/漏改）
    const badKey = base();
    badKey.selfCheck[2] = entry({ keyHeadMismatch: 1 });
    expect(() => assertBackfillConsistent(badKey)).toThrow(/键首段/);
    // 红端 3：**任意一张表**（不再只 3 张）少填也会被抓住
    const shortTable = base();
    shortTable.selfCheck[0] = { ...entry({ userIdNull: 3 }), table: "o_script", updated: 2, expectedNull: 2 };
    expect(() => assertBackfillConsistent(shortTable)).toThrow(/o_script/);
    // dry-run 例外：还没写库 ⇒ 剩余违规只作"待修复"信息，不抛（否则真库上 dry-run 必红）
    const dry = base();
    dry.applied = false;
    dry.selfCheck[2] = entry({ userIdNull: 3, expectedNull: 3, keyHeadMismatch: 92 });
    expect(() => assertBackfillConsistent(dry)).not.toThrow();
    // "整表可疑孤儿"是**警告级**：即便 applied 也不抛（避免服务器启动路径假失败）
    const suspicious = base();
    suspicious.selfCheck[0] = { ...entry(), table: "o_script", updated: 0, orphans: 8, userIdNull: 8, expectedNull: 8, suspiciousAllOrphan: true };
    expect(() => assertBackfillConsistent(suspicious)).not.toThrow();
  });
});

describe("迁移 004", () => {
  it("up 是幂等回填；down 是 no-op（不动任何数据）", async () => {
    const mod = (await import("@/db/migrations/004_backfill_userid")).default;
    const before = await snapshot();
    await mod.down();
    expect(await snapshot()).toBe(before);
    await mod.up(knex);
    expect(await snapshot()).toBe(before);
  });
});
