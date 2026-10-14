/**
 * ★ 账本 **1d-4ⓐ**（D 组必修）：迁移文件名口径的**机械守卫**。
 *
 * 缺陷原样：项目**自己的生成器**（`pnpm run db:generate` → `apps/api/scripts/db-generate.ts`）
 * 强制 kebab-case 描述，产出如 `007_job-queue.ts`；而 `tools/migration-tables.cjs` 的文件名正则
 * 旧口径是 `^(\d{3})_[A-Za-z0-9_]+\.ts$` —— **不允许连字符** ⇒ 照项目生成器走的迁移会被
 * **静默漏掉**：它对 `check-tenant-policies` **隐形**（且报错文案误导成"策略表里的表不在建表清单里"）。
 *
 * ⚠ 这是"门禁的**收录能力**"缺陷，**不是判据放宽**：修完之后，被收录的迁移**仍必须真的登记策略**，
 *   否则 `check-tenant-policies` 照样红（本文件不改变那条判据）。
 *
 * 判别力：修复前 `MIGRATION_FILE_RE.test("007_job-queue.ts") === false`（本用例红）→ 修复后 true。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mt = require(path.resolve(__dirname, "..", "..", "..", "tools", "migration-tables.cjs")) as {
  MIGRATION_FILE_RE: RegExp;
  findAllMigrations: () => string[];
  collectMigrationTables: () => { files: string[]; createdTables: string[] };
};

/** 生成器正在用的命名正则（`apps/api/scripts/db-generate.ts`）——两条判据必须对齐。 */
const GENERATOR_RE = /^\d{3}_.+\.ts$/;
/** 旧口径（**故意**保留一份，用来证明新口径确实收紧了"收录能力"）。 */
const OLD_RE = /^(\d{3})_[A-Za-z0-9_]+\.ts$/;

describe("迁移文件名口径（账本 1d-4ⓐ：kebab-case 必须被收录）", () => {
  it("★ kebab-case（项目生成器的产物）必须被 migration-tables 收录", () => {
    expect(mt.MIGRATION_FILE_RE.test("007_job-queue.ts"), "kebab-case 迁移必须被收录（1d-4ⓐ）").toBe(true);
    expect(mt.MIGRATION_FILE_RE.test("012_add-vendor-gate.ts")).toBe(true);
    // 旧格式必须**继续**支持（不能为了修它而砍掉既有的 snake_case 迁移）
    expect(mt.MIGRATION_FILE_RE.test("001_schema.ts")).toBe(true);
    expect(mt.MIGRATION_FILE_RE.test("006_quota_grants.ts")).toBe(true);
  });

  it("★ 判别力：旧口径确实**不**收 kebab-case（证明这次改的是真东西，不是恒真）", () => {
    expect(OLD_RE.test("007_job-queue.ts"), "旧口径不收 kebab-case —— 这正是缺陷本身").toBe(false);
    expect(OLD_RE.test("001_schema.ts")).toBe(true);
    // 新口径 ⊋ 旧口径：旧的能收的，新的必须都还能收
    for (const f of ["001_schema.ts", "007_job_queue.ts", "012_x.ts"]) {
      expect(OLD_RE.test(f)).toBe(true);
      expect(mt.MIGRATION_FILE_RE.test(f)).toBe(true);
    }
  });

  it("★ 与**项目生成器**的口径对齐（生成器可产出的名字，解析器必须都收）", () => {
    // 生成器的 desc 正则（db-generate.ts）：kebab-case，逐字复制一份在这（对齐判据）
    const descRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const samples = ["add-job-table", "job-queue", "vendor-gate", "abc"];
    for (const d of samples) {
      expect(descRe.test(d), `生成器会接受 ${d}`).toBe(true);
      const file = `007_${d}.ts`;
      expect(GENERATOR_RE.test(file), `生成器的 glob 认可 ${file}`).toBe(true);
      expect(mt.MIGRATION_FILE_RE.test(file), `\`${file}\` 必须被 migration-tables 收录（否则对 check-tenant-policies 隐形）`).toBe(true);
      // 反向：生成器拒绝的 desc（大写下划线）不该被当成合法迁移名
      expect(descRe.test("Add_Job")).toBe(false);
    }
  });

  it("★ 反向恒真/漏收守卫：`findAllMigrations()` 返回的每个文件都必须被口径认可，且覆盖当前全部迁移", () => {
    const files = mt.findAllMigrations();
    expect(files.length, "当前仓库里应有多条迁移").toBeGreaterThanOrEqual(8);
    for (const f of files) expect(mt.MIGRATION_FILE_RE.test(f), `${f} 必须被口径认可`).toBe(true);
    // 与**目录实际内容**对照：目录里符合生成器 glob 的文件一个都不能漏
    const dir = path.resolve(__dirname, "..", "src", "db", "migrations");
    const onDisk = fs.readdirSync(dir).filter((f) => GENERATOR_RE.test(f)).sort();
    expect(files, "收录清单必须与目录内容（按生成器 glob）逐一相等").toEqual(onDisk);
    // 并且这些文件都被真正解析过（不是空跑）
    const collected = mt.collectMigrationTables();
    expect(collected.files).toEqual(files);
    expect(collected.createdTables.length).toBeGreaterThan(0);
  });
});
