/**
 * 比对链的**边界抽样**步骤（Task 8 Step 1）——由 `scripts/compare-db.cjs` 生成并 spawn。
 *
 * 为什么单独一步、而不是塞进 `.cjs`：
 *   1. "每列最长文本 / 数值极值"的取数逻辑必须**可被单测覆盖**，而它是 Knex 代码 → 落在
 *      `src/db/legacy/import.ts` 的 `extremeRowPicks()` 里（与比对同源、可单测）；
 *   2. 本文件只做三件事：读源库（**只读**）→ 调 `extremeRowPicks()` → 把抽中的行补进
 *      `source-samples.json`。写成**一次性 runner**（每次运行重新生成，落在 gitignored 的
 *      `.tmp-migrate/` 下）与 `import-mysql.cjs` / `compare-db.cjs` 的既有做法一致。
 *
 * ⚠ 为什么"补行"要回源库按主键取整行，而不是把 `extremeRowPicks()` 返回的行直接拼出来：
 *   边界查询只 `SELECT` 了主键 + 那一列（大表上按列取极值，不能把 10 万字符的行整行拉回来 ×226 列）。
 *   抽中的"行"必须与均匀抽样**同一口径**（整行、逐列），否则逐列比较就缺列。
 *
 * ⚠ tsx 下 `.ts` 不能顶层 await（本仓库约定）→ 包在 `main()` 里。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createKnex, describeTarget } from "@/db/connect";
import type { MiwoConfig } from "@/config";
import {
  extremeRowPicks,
  pkSignature,
  type ExportManifest,
  type ExtremePick,
  type ReadonlySqliteSource,
  type SourceSamples,
} from "@/db/legacy/import";

const args = process.argv.slice(2);
const argOf = (p: string, d: string): string => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : d;
};
const API_ROOT = path.resolve(__dirname, "..");
const DIR = path.resolve(API_ROOT, argOf("--manifest=", path.join(".tmp-migrate", "export")));
const SRC = path.resolve(API_ROOT, argOf("--src=", path.join("data", "db2.sqlite")));

function openSqlite(file: string): ReadonlySqliteSource {
  const require_ = createRequire(__filename);
  let Ctor: new (f: string, o?: { readonly?: boolean }) => ReadonlySqliteSource;
  try {
    Ctor = require_(path.join(API_ROOT, "node_modules", "better-sqlite3")) as typeof Ctor;
  } catch {
    Ctor = require_("better-sqlite3") as typeof Ctor;
  }
  return new Ctor(file, { readonly: true });
}

async function main(): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) as ExportManifest;
  const samplesPath = path.join(DIR, "source-samples.json");
  const samples = JSON.parse(fs.readFileSync(samplesPath, "utf8")) as SourceSamples;
  const sqlite = openSqlite(SRC);
  // 均匀层抽中的行先全登记成 `uniform`；下面每补一行边界行再追加一条 `extreme`。
  const pickKinds: Record<string, Array<{ pk: Record<string, unknown>; kind: "uniform" | "extreme" }>> = {};
  for (const t of manifest.tables) {
    const sample = samples[t.name];
    if (!sample) continue;
    pickKinds[t.name] = sample.rows.map((r) => ({
      pk: Object.fromEntries(sample.pk.map((c) => [c, r[c]])),
      kind: "uniform" as const,
    }));
  }

  // 源库以 readonly 打开；每条 SQL 都是 SELECT。
  const src = createKnex({
    db: { driver: "sqlite", file: SRC, poolMin: 1, poolMax: 2 },
  } as unknown as MiwoConfig);
  console.log(`[compare] 边界抽样：源 ${SRC}（只读），目标 ${describeTarget()}`);
  try {
    const picks = await extremeRowPicks(src, manifest, samples);
    let added = 0;
    const covered: string[] = [];
    for (const [table, list] of Object.entries(picks)) {
      const sample = samples[table];
      if (!sample) continue;
      const known = new Set(sample.rows.map((r) => pkSignature(Object.fromEntries(sample.pk.map((c) => [c, r[c]])))));
      const cols = new Set<string>();
      const stmt = sqlite.prepare(
        `SELECT * FROM "${table}" WHERE ${sample.pk.map((c) => `"${c}" = ?`).join(" AND ")}`,
      );
      for (const p of list as ExtremePick[]) {
        const where = Object.fromEntries(sample.pk.map((c) => [c, p.pk[c]]));
        const sig = pkSignature(where);
        cols.add(`${p.column}:${p.metric}`);
        if (known.has(sig)) continue; // 均匀层已经抽中这一行 → 不重复加
        const row = stmt.get(...sample.pk.map((c) => p.pk[c])) as Record<string, unknown> | undefined;
        if (!row) {
          console.warn(`[compare] ⚠ ${table} 的边界行取不回来（主键 ${sig}）—— 跳过`);
          continue;
        }
        known.add(sig);
        sample.rows.push(row);
        pickKinds[table].push({ pk: where, kind: "extreme" });
        added += 1;
      }
      if (cols.size) covered.push(`${table}(${cols.size})`);
    }
    fs.writeFileSync(samplesPath, `${JSON.stringify(samples, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(DIR, "pick-kinds.json"), `${JSON.stringify(pickKinds, null, 2)}\n`, "utf8");
    const totalRows = Object.values(samples).reduce((s, v) => s + v.rows.length, 0);
    console.log(`[compare] 边界抽样补入 ${added} 行（去重后共抽 ${totalRows} 行，逐行比全部列）`);
    console.log(`[compare] 边界覆盖：${covered.join(" ")}`);
  } finally {
    await src.destroy();
    sqlite.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
