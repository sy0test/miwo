/**
 * SQLite → 目标库的搬迁链单测（Task 6）。
 *
 * 为什么全部跑 sqlite↔sqlite：本机没有 MySQL 服务端（`apps/api/vitest.config.ts` 的
 * `MIWO_TEST_MYSQL` 开关就是为这件事留的）。导入/比对/查重的**代码路径与方言无关**，
 * 所以先在这里把它测对；真 MySQL 的端到端只补"行数 + 抽样"证据（Task 8）。
 * 本文件**不**声称验过 MySQL —— 与方言相关的分支单独断言（`oversizeBlocks`）。
 *
 * 覆盖：
 *   1. 列交集（源多列丢弃 / 目标多列留 NULL）
 *   2. id 保真：`Date.now()` 量级的 id 原值搬运 + 类型是 number
 *   3. 唯一键查重（【Ruling 34/41 ①】）
 *   4. id 越界（> 2^53−1）
 *   5. 无 `id` 列的表也能整表搬完（游标分页的静默丢行回归网）
 *   6. `importExport` 端到端：NDJSON → 空目标库；**bigint 类型与数值都不变**（【Ruling 43】）
 *   7. 平台种子表"跳过已存在"、`o_setting.tokenKey` **绝不导回**、内容不同的跳过要计数（Task 5 交接条款）
 *   8. 目标库非空 / 缺表 → preflight 拒绝
 *   9. 超长值（`varchar(255)` 装 300 字符）：sqlite 只登记、mysql 阻断（【Ruling 34/41 ②③】）
 *  10. 两库比对：抽样单元格深比较能抓到差异；缺席归因区分"按设计没搬"与"搬丢了"
 *  11. 反例：老库**不能**原地跑迁移（29+ 张老表、没有 `knex_migrations`），且本用例全程不改写 dev 库 sha256
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource } from "@/db/migrations";
import {
  checkIdRanges,
  checkIdTypes,
  compareRows,
  findDuplicates,
  importExport,
  importTable,
  nonEmptyBusinessTables,
  outOfRangeValues,
  oversizeBlocks,
  oversizeValues,
  planImport,
  plansFromManifest,
  readExportManifest,
  UNIQUE_KEYS,
  valuesEqual,
  type ExportManifest,
  type SourceSamples,
} from "@/db/legacy/import";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-legacy-"));
// ⚠ Windows 上一次性库文件的句柄可能还没释放完 → rmSync 会 EPERM（同 migration-seed.test.ts）。
afterAll(() => {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
      return;
    } catch {
      /* 再试 */
    }
  }
});
let seq = 0;
function db(name: string): Knex {
  seq += 1;
  return createKnex({
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `${name}-${seq}.sqlite`) },
  } as MiwoConfig);
}
/** 已迁移到最新（001_schema + 002_platform_seed）的空目标库。 */
async function migrated(name: string): Promise<Knex> {
  const d = db(name);
  await d.migrate.latest({ migrationSource: makeMigrationSource() });
  return d;
}

/** 造一个"老库"：两张表，其中一张带目标库没有的列，另一张的目标列更多。 */
async function legacy(): Promise<Knex> {
  const d = db("legacy");
  await d.schema.createTable("o_project", (T) => {
    T.integer("id").primary(); T.string("name"); T.integer("userId"); T.integer("createTime");
  });
  await d("o_project").insert([
    { id: 1750000000000, name: "A", userId: 1, createTime: 1 },
    { id: 1750000000001, name: "B", userId: 2, createTime: 2 },
  ]);
  await d.schema.createTable("o_agentWorkData", (T) => {
    T.integer("id").primary(); T.integer("projectId"); T.integer("episodesId"); T.string("key"); T.string("data");
    T.string("legacyOnlyColumn");
  });
  await d("o_agentWorkData").insert([
    { id: 1, projectId: 1, episodesId: 1, key: "a", data: "{}", legacyOnlyColumn: "x" },
    { id: 2, projectId: 1, episodesId: 2, key: "b", data: "{}", legacyOnlyColumn: "y" },
  ]);
  return d;
}

/** 写一份"导出物"（NDJSON + manifest），形状与 `scripts/export-sqlite.cjs` 的产物一致。 */
function writeExport(
  name: string,
  tables: Array<{ name: string; columns: string[]; rows: Array<Record<string, unknown>> }>,
  extras: Partial<ExportManifest> = {},
): { dir: string; manifest: ExportManifest } {
  const dir = path.join(TMP, `export-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: ExportManifest = {
    generatedAt: new Date().toISOString(),
    source: "(fixture)",
    sourceSha256Before: "fixture",
    sourceSha256After: "fixture",
    tables: [],
    duplicates: [],
    badIds: [],
    columnStats: {},
    oversizeValues: [],
    ...extras,
  };
  for (const t of tables) {
    const body = t.rows.map((r) => JSON.stringify(r)).join("\n") + (t.rows.length ? "\n" : "");
    const buf = Buffer.from(body, "utf8");
    fs.writeFileSync(path.join(dir, `${t.name}.ndjson`), buf);
    manifest.tables.push({
      name: t.name,
      rows: t.rows.length,
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      columns: t.columns,
    });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, manifest };
}

describe("SQLite → 目标库 搬迁（spec §12.2 T5）", () => {
  it("planImport：列交集正确（源多的列被丢弃、目标多的列留 NULL）", async () => {
    const src = await legacy();
    const dst = await migrated("target");
    const plans = await planImport({ src, dst, tables: ["o_project", "o_agentWorkData"] });
    const proj = plans.find((p) => p.table === "o_project")!;
    // 源也有 userId → 它会**被写**（不该出现在 missingTargetColumns 里）
    expect(proj.columns).toContain("userId");
    expect(proj.columns).toContain("createTime");
    expect(proj.missingTargetColumns).not.toContain("userId");
    expect(proj.missingTargetColumns).toContain("artStyle"); // 目标新增/源没有的列 → 留 NULL
    const awd = plans.find((p) => p.table === "o_agentWorkData")!;
    expect(awd.droppedSourceColumns).toEqual(["legacyOnlyColumn"]);
    expect(awd.columns).not.toContain("legacyOnlyColumn");
    expect(awd.missingTargetColumns).toContain("userId"); // 目标新增的列
    expect(awd.targetColumnTypes!.projectId).toBe("integer");
    await src.destroy();
    await dst.destroy();
  });

  it("导入保真：Date.now() 量级的 id 原值搬运（不是重新分配），且读回来是 number", async () => {
    const src = await legacy();
    const dst = await migrated("target");
    const plans = await planImport({ src, dst, tables: ["o_project"] });
    const r = await importTable({ src, dst, plan: plans[0] });
    expect(r.rows).toBe(2);
    expect(r.targetRowsAfter - r.targetRowsBefore).toBe(2);
    const ids = (await dst("o_project").orderBy("id").pluck("id")) as number[];
    expect(ids).toEqual([1750000000000, 1750000000001]);
    for (const id of ids) expect(typeof id).toBe("number");
    expect(await checkIdTypes(dst, plans)).toEqual([]);
    await src.destroy();
    await dst.destroy();
  });

  it("唯一键查重：源库有重复 → findDuplicates 报出来", async () => {
    const src = db("dup");
    await src.schema.createTable("o_agentWorkData", (T) => {
      T.integer("id"); T.integer("projectId"); T.integer("episodesId"); T.string("key"); T.string("data");
    });
    await src("o_agentWorkData").insert([
      { id: 1, projectId: 1, episodesId: 1, key: "k", data: "{}" },
      { id: 2, projectId: 1, episodesId: 1, key: "k", data: "{}" },
    ]);
    const dst = await migrated("target");
    const plans = await planImport({ src, dst, tables: ["o_agentWorkData"] });
    const dups = await findDuplicates(src, plans);
    expect(dups).toHaveLength(1);
    expect(dups[0].key).toEqual(UNIQUE_KEYS.o_agentWorkData);
    expect(Number((dups[0].rows[0] as { n: number | string }).n)).toBe(2);
    await src.destroy();
    await dst.destroy();
  });

  it("id 越界：> 2^53-1 的字符串 id 会被 checkIdRanges 抓到（且是全表扫，不是只看前一万行）", async () => {
    const src = db("bigid");
    await src.schema.createTable("o_project", (T) => { T.string("id", 191).primary(); T.string("name"); });
    await src("o_project").insert({ id: "9007199254740993", name: "too-big" }); // 2^53+1
    const plans = await planImport({ src, dst: src, tables: ["o_project"] });
    const bad = await checkIdRanges(src, plans);
    expect(bad.some((b) => b.value === "9007199254740993")).toBe(true);
    await src.destroy();
  });

  it("无 id 列的表（复合主键）也能整表搬完 —— 游标分页不能静默丢行", async () => {
    // 复现 brief 原写法（`columns[0]` 当游标）的缺陷：`o_assets2Storyboard.columns[0]`
    // 是 `storyboardId`，**不唯一** → 跨批次边界的行会被跳过。
    const src = db("composite");
    await src.schema.createTable("o_assets2Storyboard", (T) => {
      T.integer("storyboardId").notNullable();
      T.integer("assetId").notNullable();
      T.primary(["storyboardId", "assetId"]);
    });
    const rows = [];
    for (let i = 1; i <= 1200; i += 1) rows.push({ storyboardId: Math.ceil(i / 3), assetId: i });
    // ⚠ 必须分批插：sqlite 的 SQLITE_MAX_COMPOUND_SELECT 默认 500，一次性 insert 1200 行会
    //    `too many terms in compound SELECT`（这是 knex 的 insert 展开方式，与本用例要验的分页无关）。
    for (let i = 0; i < rows.length; i += 100) await src("o_assets2Storyboard").insert(rows.slice(i, i + 100));
    const dst = await migrated("target");
    const plans = await planImport({ src, dst, tables: ["o_assets2Storyboard"] });
    const r = await importTable({ src, dst, plan: plans[0], batchSize: 100 });
    expect(r.rows).toBe(1200);
    expect(Number((await dst("o_assets2Storyboard").count({ n: "*" }).first() as { n: number }).n)).toBe(1200);
    await src.destroy();
    await dst.destroy();
  });

  it("importExport 端到端：bigint 往返 —— 类型与数值都不变（【Ruling 43】）", async () => {
    const fixture = writeExport("bigint", [
      {
        name: "o_project",
        columns: ["id", "name", "userId", "createTime"],
        rows: [
          { id: 1791385147125, name: "A", userId: 1, createTime: 1791385147130 },
          // 故意用字符串形式：老库/某条链路把 bigint 读成 string 时，导入**必须**归一化成 number
          { id: "1790872173375", name: "B", userId: "2", createTime: "1790872173399" },
        ],
      },
    ]);
    const dst = await migrated("target");
    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    expect(res.applied).toBe(true);
    expect(res.idTypeDrift).toEqual([]);
    const rows = (await dst("o_project").select("id", "name", "userId", "createTime").orderBy("id")) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual([1790872173375, 1791385147125]);
    // 类型：三个数字列读回来都必须是 number；文本列保持 string
    for (const r of rows) {
      expect(typeof r.id, "id").toBe("number");
      expect(typeof r.userId, "userId").toBe("number");
      expect(typeof r.createTime, "createTime").toBe("number");
      expect(typeof r.name, "name").toBe("string");
    }
    // 数值：与源（归一化后）逐个相等，不是"字符串相等"
    expect(rows[0].id).toBe(1790872173375);
    expect(rows[1].createTime).toBe(1791385147130);
    // NDJSON 里的原始值是字符串（证明上面那条真的走了归一化）
    expect(JSON.parse(fs.readFileSync(path.join(fixture.dir, "o_project.ndjson"), "utf8").split("\n")[1]).id).toBe("1790872173375");
    await dst.destroy();
  });

  it("平台种子表：跳过已存在（不 upsert）、绝不导回 tokenKey、内容不同的跳过要计数", async () => {
    const fixture = writeExport("seed", [
      {
        name: "o_setting",
        columns: ["key", "value"],
        rows: [
          { key: "shotsEngine", value: "legacy" }, // 与 002 的种子同键不同内容 → 跳过（不覆盖）
          { key: "tokenKey", value: "jwt-secret" }, // 绝不导回
          { key: "agentUseMode", value: "1" }, // 老库独有的键 → 导入
        ],
      },
    ]);
    const dst = await migrated("target");
    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    const o = res.outcomes.find((x) => x.table === "o_setting")!;
    expect(o.inserted).toBe(1);
    expect(o.skippedExisting).toBe(1);
    expect(o.skippedDifferent).toBe(1); // "跳过"里内容不同的那一条必须被算出来
    expect(o.skippedForbidden).toBe(1);
    expect(await dst("o_setting").where("key", "tokenKey").first()).toBeUndefined();
    expect(((await dst("o_setting").where("key", "shotsEngine").first()) as { value: string }).value).toBe("v2");
    expect(((await dst("o_setting").where("key", "agentUseMode").first()) as { value: string }).value).toBe("1");
    expect(res.expectedAbsent.map((e) => e.reason)).toContain("forbidden-setting-key");
    await dst.destroy();
  });

  it("preflight：目标库业务表非空 / 缺表 → 拒绝写入", async () => {
    const fixture = writeExport("nonempty", [
      { name: "o_image", columns: ["id", "filePath", "state"], rows: [{ id: 1, filePath: "a.png", state: "done" }] },
    ]);
    const dst = await migrated("target");
    await dst("o_image").insert({ filePath: "already-here.png" });
    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    expect(res.applied).toBe(false);
    expect(res.blocking.map((b) => b.kind)).toContain("non-empty-target");
    expect(Number((await dst("o_image").count({ n: "*" }).first() as { n: number }).n)).toBe(1); // 一行都没写
    await dst.destroy();

    // 缺表：目标库还没迁移
    const empty = db("schema-less");
    const res2 = await importExport({ dst: empty, dir: fixture.dir, apply: true, log: () => {} });
    expect(res2.blocking.map((b) => b.kind)).toContain("missing-target-table");
    await empty.destroy();
  });

  it("超长值：sqlite 只登记（不阻断、不截断）；mysql 阻断（【Ruling 34/41 ②】）", async () => {
    const long = "x".repeat(300);
    // ⚠ 修复轮 2：`o_agentWorkData.data` 已放宽为 longtext（老库实测最长 103,624 字符，
    //   varchar(255) 会让真 MySQL 直接 `Data too long`）→ 它**不再**是有长度上限的列，
    //   所以"超长值的判据与处置"改用**仍是 varchar(255)** 的 `key` 来验（判据强度不变），
    //   并额外断言放宽后的 `data` 不再被判超长。
    const fixture = writeExport("oversize", [
      {
        name: "o_agentWorkData",
        columns: ["id", "projectId", "episodesId", "key", "data", "createTime", "updateTime"],
        rows: [{ id: 1, projectId: 1791385147125, episodesId: 1, key: long, data: long, createTime: 1, updateTime: 2 }],
      },
    ]);
    const dst = await migrated("target");
    const plans = await plansFromManifest(dst, fixture.manifest);
    const found = oversizeValues(plans[0], [{ key: long, data: long }]);
    expect(found).toHaveLength(1);
    expect(found[0].column).toBe("key");
    expect(found[0].declaredLength).toBe(255);
    expect(found[0].maxChars).toBe(300);
    // 修复轮 2 的反向断言：`data` 放宽到 longtext 后，连 103,624 字符都不再算超长
    expect(oversizeValues(plans[0], [{ data: "x".repeat(103624) }])).toHaveLength(0);

    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    expect(res.applied).toBe(true);
    expect(res.oversize).toHaveLength(1);
    // sqlite 不强制 varchar 长度 → 不阻断、也不截断（真 MySQL 会 Data too long，见下）
    expect(res.blocking.filter((b) => b.kind === "oversize-value")).toHaveLength(0);
    const row = (await dst("o_agentWorkData").where("id", 1).first()) as { key: string; data: string };
    expect(row.key.length).toBe(300);
    expect(row.data.length).toBe(300);
    await dst.destroy();

    // --allow-oversize：**丢弃**并逐条登记（绝不截断）
    const dst2 = await migrated("target");
    const res2 = await importExport({ dst: dst2, dir: fixture.dir, apply: true, allowOversize: true, log: () => {} });
    expect(res2.outcomes[0].skippedUnrepresentable).toBe(1);
    expect(res2.outcomes[0].inserted).toBe(0);
    expect(res2.expectedAbsent.map((e) => e.reason)).toContain("skipped-unrepresentable");
    expect(await dst2("o_agentWorkData").first()).toBeUndefined();
    await dst2.destroy();

    // mysql 目标：同一份导出物在严格模式下会失败 → 必须阻断（本机没有 MySQL，
    // 所以断言的是**判据函数**而不是真连一个 MySQL；真机端到端归 Task 8）
    expect(oversizeBlocks("mysql", false)).toBe(true);
    expect(oversizeBlocks("mysql", true)).toBe(false);
    expect(oversizeBlocks("sqlite", false)).toBe(false);
  });

  it("越界数值：`int` 列装 `Date.now()` 毫秒值会被报出（第 4 个 MySQL-only 缺口）", async () => {
    // `001_schema` 给 o_segment.projectId / o_shot.projectId 建的是 `int`（不是 u64），
    // 而老库这两列存的是 o_project.id = Date.now() 毫秒值 → 真 MySQL `Out of range value`。
    // sqlite 的 INTEGER 是 64 位，本机永远不炸，所以只能靠这条机械检查提前发现。
    const fixture = writeExport("overflow", [
      {
        name: "o_segment",
        columns: ["id", "projectId", "scriptId", "segmentIndex", "manual"],
        rows: [{ id: 1, projectId: 1791385147125, scriptId: 8, segmentIndex: 1, manual: 0 }],
      },
    ]);
    const dst = await migrated("target");
    const plans = await plansFromManifest(dst, fixture.manifest);
    // ⚠ 判据只在 **mysql 目标**上成立：sqlite 的列类型把 `int` 与 `bigint unsigned` 都报成
    //    `integer`（`t.u64()` 在 sqlite 上就是 `t.integer`）→ 拿 sqlite 的 columnInfo 去判位宽
    //    必然假阳性（实测会把 10 个 bigint 外键列误报成越界）。所以这里**显式构造 mysql 形态的
    //    columnInfo**（projectId: "int"）来断言判据本身。
    const asMysql = { ...plans[0], targetColumnTypes: { ...plans[0].targetColumnTypes, projectId: "int" } };
    const found = outOfRangeValues(asMysql, [{ projectId: 1791385147125 }]);
    expect(found.map((f) => `${f.table}.${f.column}`)).toEqual(["o_segment.projectId"]);
    expect(found[0].declaredType).toBe("int");
    expect(found[0].hi).toBe(2147483647);
    expect(found[0].max).toBe(1791385147125);

    // sqlite 目标：**不**下越界结论，只登记一条"位宽未验证"（诚实口径）
    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    expect(res.applied).toBe(true);
    expect(res.outOfRange).toEqual([]);
    expect(res.issues.map((i) => i.kind)).toContain("numeric-range-unverified");
    expect(res.blocking.filter((b) => b.kind === "numeric-overflow")).toHaveLength(0);
    // 值在 sqlite 上是原样落地的（真 MySQL 会 Out of range / 被夹断）
    expect(((await dst("o_segment").where("id", 1).first()) as { projectId: number }).projectId).toBe(1791385147125);
    expect(res.idTypeDrift).toEqual([]);
    await dst.destroy();
  });

  it("compareRows：行数用 expectedTargetRows 判、抽样单元格深比较能抓到差异", async () => {
    const fixture = writeExport("compare", [
      {
        name: "o_project",
        columns: ["id", "name", "userId", "createTime"],
        rows: [
          { id: 1791385147125, name: "A", userId: 1, createTime: 10 },
          { id: 1791385147126, name: "B", userId: 2, createTime: 20 },
        ],
      },
    ]);
    const dst = await migrated("target");
    const res = await importExport({ dst, dir: fixture.dir, apply: true, log: () => {} });
    expect(res.applied).toBe(true);
    const manifest = readExportManifest(fixture.dir);
    const plans = await plansFromManifest(dst, manifest);
    const samples: SourceSamples = {
      o_project: {
        pk: ["id"],
        rows: [
          { id: 1791385147125, name: "A", userId: 1, createTime: 10 },
          { id: 1791385147126, name: "B", userId: 2, createTime: 20 },
        ],
      },
    };
    const good = await compareRows({ dst, manifest, samples, plans, outcomes: res.outcomes, expectedAbsent: res.expectedAbsent });
    expect(good.ok).toBe(true);
    expect(good.tables[0].rowsMatch).toBe(true);
    expect(good.tables[0].samplesChecked).toBe(2);
    expect(good.tables[0].mismatches).toEqual([]);

    // 改一格 → 必须抓到（这条就是"抽样深比较"的判别力）
    await dst("o_project").where("id", 1791385147126).update({ name: "B-tampered" });
    const bad = await compareRows({ dst, manifest, samples, plans, outcomes: res.outcomes, expectedAbsent: res.expectedAbsent });
    expect(bad.ok).toBe(false);
    expect(bad.tables[0].mismatches.map((m) => m.column)).toContain("name");
    expect(bad.tables[0].mismatches[0].reason).toContain("类型/值不同");
    await dst.destroy();
  });

  it("valuesEqual 的判据（不 trim、不把数字串当数字、bigint 与浮点容差）", () => {
    // 【Ruling 77】MySQL 的 ci collation / 尾随空格语义不同 → 比较器**不许**把差异吃掉
    expect(valuesEqual("a ", "a").equal).toBe(false);
    expect(valuesEqual("A", "a").equal).toBe(false);
    expect(valuesEqual("123", 123).equal).toBe(false);
    expect(valuesEqual("x", "x").equal).toBe(true);
    // bigint 归一化（两个驱动下的合法表示）
    expect(valuesEqual(BigInt(1791385147125), 1791385147125).equal).toBe(true);
    // 浮点：表示差异（MySQL float vs sqlite REAL）用 1e-6 相对容差
    expect(valuesEqual(4.300000190734863, 4.3).equal).toBe(true);
    expect(valuesEqual(4.3, 5.3).equal).toBe(false);
    // NULL / undefined 同义
    expect(valuesEqual(null, undefined).equal).toBe(true);
    expect(valuesEqual(null, 0).equal).toBe(false);
  });

  it("nonEmptyBusinessTables：种子表不算非空，其余表算", async () => {
    const dst = await migrated("target");
    const plans = await planImport({ src: dst, dst, tables: ["o_setting", "o_prompt", "o_image"] });
    const nonEmpty = nonEmptyBusinessTables(plans).map((p) => p.table);
    expect(nonEmpty).not.toContain("o_setting");
    expect(nonEmpty).not.toContain("o_prompt");
    expect(nonEmpty).toEqual([]); // o_image 空
    await dst.destroy();
  });

  it("⚠ 反例：**不能**在已存在的 dev 库（29 张老表）上原地跑 001_schema —— 必须撞 'table already exists'", async () => {
    // 这条断言是**故意要红的**：它把"老库不能原地迁移"这条限制钉成可执行的文档，
    // 免得下一个人在 apps/api/data/db2.sqlite 上跑 `pnpm dev` 看到 table already exists 以为迁移写错了。
    const devPath = path.resolve(__dirname, "..", "data", "db2.sqlite");
    if (!fs.existsSync(devPath)) return; // CI 上没有 dev 库
    // ⚠ 顺带把【Ruling 1】的"源库只读"钉进回归网：本用例前后 dev 库的 sha256 必须一致。
    const sha = () => crypto.createHash("sha256").update(fs.readFileSync(devPath)).digest("hex");
    const before = sha();
    const db2 = createKnex({
      env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
      storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
      jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: devPath },
    } as MiwoConfig);
    // ⚠ 这里不能真的拿 dev 库去跑迁移（会往 dev 库里写 knex_migrations 与可能的部分表）。
    //    所以只在**打开前**断言"dev 库里已经有 29 张表且没有 knex_migrations"，
    //    这就是"原地跑必然撞表"的充分证据。
    const tables = (await db2("sqlite_master").where("type", "table").whereNot("name", "like", "sqlite_%").pluck("name")) as string[];
    expect(tables.length).toBeGreaterThanOrEqual(29);
    expect(tables).toContain("o_project");
    expect(tables).not.toContain("knex_migrations");
    // 结论（也是 README.md 第「不支持在老库上原地跑迁移」一节的内容）：
    //   老库必须走"导出 → 空目标库先迁移 → 导入"（scripts/export-sqlite.cjs + import-mysql.cjs），
    //   不能在原地跑 001_schema。真 MySQL 上的完整往返由 Task 8 覆盖。
    await db2.destroy();
    expect(sha(), "dev 库被改写了（搬迁链对源库必须只读）").toBe(before);
  });
});
