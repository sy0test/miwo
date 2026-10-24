/**
 * 002_platform_seed 的单测（spec §5.2 ④）。
 *
 * 覆盖七件事：
 *   1. `seed/*.ndjson` 每行都是**完整** JSON（截断会当场炸）且非空；
 *   2. 仓库里的种子文件**不含凭据痕迹**（Step 2 的"导出物不泄漏凭证"落到回归网里）；
 *   3. `o_prompt` 的 4 条都在，且 `videoPromptGeneration.data` 有量级护栏（防被截断成 2000）；
 *   4. `o_agentDeploy` 21 行（19 条种子 + 016 补的 2 条转绘部署行，R1-G3）且关键 key 齐全；
 *   5. `o_setting` 只有平台键、**绝无 `tokenKey`**（Phase 1c 才把它彻底移出 DB）；
 *   6. `o_vendorConfig` 恰好 8 个空模板行（enable=0 / inputValues={} / models=[]）；
 *   7. **只插不改**：手工改过的行重跑 `up` 不被覆盖；第二次 `up` 插入 0 行；
 *      `down` 只删"仍是本仓库种子那一行"的记录（**逐列精确相等**，比较口径与 collation 无关）——
 *      运行期新增的、被运营改过的、只改了大小写的、以及 Task 6 先导入的同键老数据都存活
 *      （Task 5 独立审查修复 3 把判据从"身份键"改成"内容全等"；合并审查修复 1 再把比较口径
 *       从 SQL `=` 加固成 `BINARY`/`COLLATE BINARY` —— MySQL 的 `utf8mb4_0900_ai_ci` 下
 *       `=` **大小写不敏感**，"只把大小写改掉"的种子行会被旧判据误删）。
 *      ⚠ 那条"只改大小写必须存活"的**判别力用例在 `tests/mysql-integration.test.ts`**（门控真 MySQL）：
 *       sqlite 的 TEXT `=` 本身就是 BINARY 语义，同一用例在 sqlite 上加固前后**都绿** ——
 *       零判别力，写在这里只会是一条假门禁。
 *   8. 单份种子文件**缺失或 0 行**时 `up` 当场抛错、错误信息指名文件（Task 5 独立审查修复 1）。
 *      ⚠ 这条用例必须**就地改仓库里的种子文件**（候选路径里 `__dirname/seed` 永远第一个命中），
 *        因此带**跨进程锁** + **前置自检**（见下方 `withSeedMutationLock` 的头注）——
 *        否则两套测试并发跑会把那份被跟踪的源文件留成 0 字节。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { makeMigrationSource, MIGRATIONS } from "@/db/migrations";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-seed-"));
// ⚠ Windows 上一次性库文件的句柄可能还没释放完 → rmSync 会 EPERM（实测：某个用例红掉时
//    afterAll 会把 EPERM 记成"Failed Suites"，掩盖真正的失败原因）。重试几次即可。
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
function freshDb(): Knex {
  seq += 1;
  return createKnex({
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: path.join(TMP, `s${seq}.sqlite`) },
  } as MiwoConfig);
}
const SEED_DIR = path.resolve(__dirname, "..", "src", "db", "migrations", "seed");
const SEED_FILES = ["o_prompt.ndjson", "o_agentDeploy.ndjson", "o_setting.platform.ndjson", "o_vendorConfig.templates.ndjson"];

/**
 * ── 为什么下面第 8 条用例需要一把**跨进程锁**（Phase 1d review-D F-4 的实测延伸）──
 * 那条用例要验"单份种子缺失/0 行 ⇒ up 当场抛错"，而 `002_platform_seed` 的种子目录候选里
 * `__dirname/seed`（= 仓库里的真实 `src/db/migrations/seed/`）**永远第一个命中** ⇒ 想制造
 * "缺失/空"就只能**就地改这个被 git 跟踪的源文件**，再在 `finally` 里还原。
 *
 * 单跑没问题；**两套测试并发跑**时两个进程会互相踩这把"就地改—还原"：
 *   进程 A `rmSync(src)` → 进程 B `copyFileSync(src, stash)`（stash 到空/缺失）→ B 还原时把**空文件**写回
 *   ⇒ 仓库里那份 `o_vendorConfig.templates.ndjson` 被留成 **0 字节**（`git status` 变脏），
 *   且此后**任何**"在全新数据目录上跑迁移"的用例/验收（002 的前置闸门）都会整片变红
 *   —— 本会话实测：并发两套独占目录也各出 4 / 48 个 failed，全是这条引起的，**不是**产品缺陷。
 *
 * ⇒ 两件事一起做：
 *   ① **机级互斥**（锁文件放 `os.tmpdir()`，不放在每套测试自己的 TMP 里）：同一时刻只有一个进程
 *      处在"改—还原"窗口内。锁被 kill 留下超过 10 分钟按陈旧锁清掉。
 *   ② **前置自检**：进来就发现源文件已被上一位留成缺失/0 字节时，**明确报错并给出 `git restore` 命令**，
 *      而不是 stash 一个坏副本后级联出几十个红（那种红会掩盖真正的原因）。
 */
const SEED_MUTATION_LOCK = path.join(os.tmpdir(), "miwo-seed-mutation.lock");
const SEED_LOCK_STALE_MS = 10 * 60_000;
const SEED_LOCK_WAIT_MS = 45_000;

async function withSeedMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(SEED_MUTATION_LOCK, "wx")); // 原子创建：已存在 ⇒ EEXIST
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(SEED_MUTATION_LOCK).mtimeMs > SEED_LOCK_STALE_MS) {
          fs.rmSync(SEED_MUTATION_LOCK, { force: true }); // 陈旧锁（上个进程被 kill）
          continue;
        }
      } catch {
        /* 刚被别的进程删掉，下一轮重试即可 */
      }
      if (Date.now() - t0 > SEED_LOCK_WAIT_MS) {
        throw new Error(`[migration-seed.test] 等种子文件锁超时（${SEED_LOCK_WAIT_MS}ms，锁=${SEED_MUTATION_LOCK}）：另一个进程可能卡在同类用例里。`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(SEED_MUTATION_LOCK, { force: true });
  }
}

/** 已迁移到最新（001_schema + 002_platform_seed）的一次性库。调用方负责 destroy。 */
async function migratedDb(): Promise<Knex> {
  const db = freshDb();
  await db.migrate.latest({ migrationSource: makeMigrationSource() });
  return db;
}

describe("002_platform_seed", () => {
  it("种子文件都是合法 NDJSON（截断会当场炸）", () => {
    for (const f of fs.readdirSync(SEED_DIR).filter((x) => x.endsWith(".ndjson"))) {
      const lines = fs.readFileSync(path.join(SEED_DIR, f), "utf8").split(/\r?\n/).filter((l) => l.trim());
      for (const [i, l] of lines.entries()) {
        expect(() => JSON.parse(l), `${f}:${i + 1}`).not.toThrow();
      }
      expect(lines.length, f).toBeGreaterThan(0);
    }
    // 四份种子都必须存在（少一份 = seed 静默为空，prod 直接不可用）
    expect(fs.readdirSync(SEED_DIR).filter((x) => x.endsWith(".ndjson")).sort()).toEqual([...SEED_FILES].sort());
  });

  it("种子文件里不含凭据痕迹（导出白名单的回归网）", () => {
    // ⚠ 这些串在任何一份种子里出现都说明**导出的白名单被绕过**（例如把 o_vendorConfig 带 key 的行、
    //    或 o_setting.tokenKey 写进了文件）。Step 2 的哨兵实验证明过这个判别力：
    //    `scripts/dump-platform-seed.cjs` 对白名单行只写常量，对非白名单行整行跳过。
    const forbidden = ["tokenKey", "apiKey", "api_key", "sk-", "Bearer ", "password", "secret", "Authorization"];
    for (const f of SEED_FILES) {
      const body = fs.readFileSync(path.join(SEED_DIR, f), "utf8");
      for (const needle of forbidden) expect(body, `${f} 含 ${needle}`).not.toContain(needle);
    }
  });

  it("o_prompt 的 4 条都要在，且 data 长度与源库一致（不被截断）", async () => {
    const db = await migratedDb();
    const rows = await db("o_prompt").select("type", "name");
    const types = rows.map((r: any) => r.type).sort();
    expect(types).toEqual(["audioBindPrompt", "eventExtraction", "scriptAssetExtraction", "videoPromptGeneration"]);
    const video = await db("o_prompt").where("type", "videoPromptGeneration").first();
    // ⚠ 实测源库该行 20,982 字符；允许上游微调但必须有量级护栏（防止被截断成 2000）
    expect(String(video.data).length).toBeGreaterThan(15000);
    await db.destroy();
  });

  it("o_agentDeploy 21 行（19 种子 + 016 的 2 条转绘部署行），关键 key 都在", async () => {
    const db = await migratedDb();
    const keys = (await db("o_agentDeploy").pluck("key")).sort();
    // 19 = 002 种子的 19 条；+2 = 016_redraw_pipeline 补的 reconcileAgent / storyboardAgent（R1-G3）
    expect(keys.length).toBe(21);
    for (const k of ["scriptAgent", "productionAgent", "universalAi", "ttsDubbing", "redrawAgent", "redrawAgent:analysisAgent", "productionAgent:storyboardTableAgent", "redrawAgent:reconcileAgent", "redrawAgent:storyboardAgent"]) {
      expect(keys).toContain(k);
    }
    await db.destroy();
  });

  it("o_setting 只有平台键，绝无 tokenKey（含 Phase 1c Task 1 的两个平台开关）", async () => {
    const db = await migratedDb();
    const keys = (await db("o_setting").pluck("key")).sort();
    expect(keys).not.toContain("tokenKey");
    expect(keys.length).toBeGreaterThan(0);
    // 只 seed 平台键：**002 种下的那 4 个**键与导出文件一一对应
    // ⚠【Phase 1c Task 1】`005_accounts` 有意再补两个平台开关（`registrationMode` / `allowDbAdminOps`）⇒
    //   总行数 = 种子行数 + 2。这里改成"种子键逐个都在 + 总行数 = 种子 + Task1 的 2 个"，
    //   判别力不变（仍是**精确**相等，且逐个点名），但不再把"别的迁移补的平台键"误报成"种多了"。
    const seededKeys = fs
      .readFileSync(path.join(SEED_DIR, "o_setting.platform.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l).key as string)
      .sort();
    const TASK1_KEYS = ["allowDbAdminOps", "registrationMode"];
    for (const k of seededKeys) expect(keys, `种子键 ${k} 不在库里`).toContain(k);
    for (const k of TASK1_KEYS) expect(keys, `Task1 平台键 ${k} 不在库里`).toContain(k);
    expect(keys).toEqual([...seededKeys, ...TASK1_KEYS].sort());
    // 新库显式 v2（"未设置" = legacy，会让结构化分镜写入被拒）
    expect((await db("o_setting").where("key", "shotsEngine").first()).value).toBe("v2");
    await db.destroy();
  });

  it("o_vendorConfig 的 8 个模板行都是空模板（enable=0、inputValues={}）", async () => {
    const db = await migratedDb();
    const rows = await db("o_vendorConfig").select("*");
    // ⚠ 顺序是 ASCII 排序："vidu" < "volcengine"（'i' < 'o'），不要按直觉把 volcengine 放前面
    expect(rows.map((r: any) => r.id).sort()).toEqual(["atlascloud", "deepseek", "klingai", "minimax", "miwo", "openai", "vidu", "volcengine"]);
    for (const r of rows as any[]) {
      expect(r.inputValues, r.id).toBe("{}");
      expect(r.models, r.id).toBe("[]");
      expect(r.enable, r.id).toBe(0);
    }
    await db.destroy();
  });

  it("只插不改：手工改过 o_prompt / o_setting / o_vendorConfig 后重跑 up 不覆盖", async () => {
    const db = await migratedDb();
    await db("o_prompt").where("type", "audioBindPrompt").update({ data: "运营手工改过的内容" });
    await db("o_setting").where("key", "shotsEngine").update({ value: "legacy" });
    await db("o_vendorConfig").where("id", "miwo").update({ enable: 1, inputValues: "{\"baseURL\":\"https://ops.example\"}" });
    // 直接再调一次 up（绕过 knex_migrations）
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.up(db);
    const row = await db("o_prompt").where("type", "audioBindPrompt").first();
    expect(row.data).toBe("运营手工改过的内容");
    expect((await db("o_setting").where("key", "shotsEngine").first()).value).toBe("legacy");
    const vendor = await db("o_vendorConfig").where("id", "miwo").first();
    expect(vendor.enable).toBe(1);
    expect(vendor.inputValues).toBe("{\"baseURL\":\"https://ops.example\"}");
    await db.destroy();
  });

  it("up 幂等：第二次 up 四张表的行数都不变（插入 0 行）", async () => {
    const db = await migratedDb();
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    const count = async (t: string) => Number(((await db(t).count({ n: "*" }).first()) as any).n);
    const tables = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"];
    const before = await Promise.all(tables.map(count));
    await mod.up(db);
    const after = await Promise.all(tables.map(count));
    expect(after).toEqual(before);
    // 而且第一次迁移本身就"插满了"（不是 0 行 -> 0 行的假幂等）
    expect(before[0]).toBe(4);
    // o_agentDeploy：19 条 002 种子 + 2 条 016 部署行
    expect(before[1]).toBe(21);
    // ⚠【Phase 1c Task 1】`o_setting` 的 4 是**002 的种子行数**；`005_accounts` 另补 2 个平台开关 ⇒ 6
    expect(before[2]).toBe(6);
    expect(before[3]).toBe(8);
    await db.destroy();
  });

  it("down 只删自己种下的行：运行期新增的行存活", async () => {
    const db = await migratedDb();
    await db("o_prompt").insert({ type: "runtimeCustom", name: "运行期新增", data: "keep me" });
    await db("o_vendorConfig").insert({ id: "runtimeVendor", inputValues: "{\"k\":1}", models: "[]", enable: 1 });
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.down(db);
    const rows = (await db("o_prompt").select("type")).map((r: any) => r.type);
    expect(rows).toEqual(["runtimeCustom"]);
    expect((await db("o_vendorConfig").pluck("id"))).toEqual(["runtimeVendor"]);
    // 表本身还在（down 不该删表；建表是 001 的事）
    expect(await db.schema.hasTable("o_prompt")).toBe(true);
    await db.destroy();
  });

  // ---- 以下为 Task 5 独立审查修复 3/4 补出的用例 ----

  /**
   * 修复 3 的**核心判别力**：down 的判据是"种子那一行的全部列都精确相等"（collation 无关），
   * 不是"身份键相同"。
   *
   * 旧实现按 `type` / `key` / `id` 删：Task 6 会先把老库数据导进来，若老库（或运营）已经写了
   * **同键但不同内容**的行，002 的 up 跳过它（只插不改），旧 down 却会把它删掉 ——
   * 回滚变成"删用户数据"。下面先在 down 之前把种子行改成"运营内容"，它必须活下来。
   */
  it("down 不删被改过的种子行（同键不同内容 = 不是 002 插的形态）", async () => {
    const db = await migratedDb();
    await db("o_prompt").where("type", "audioBindPrompt").update({ data: "运营手工改过的内容" });
    await db("o_setting").where("key", "shotsEngine").update({ value: "legacy" });
    await db("o_vendorConfig").where("id", "miwo").update({ enable: 1, inputValues: "{\"baseURL\":\"https://ops.example\"}" });
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.down(db);
    // 改过的三行都还在（旧实现会把它们按身份键删掉）
    expect((await db("o_prompt").where("type", "audioBindPrompt").first()).data).toBe("运营手工改过的内容");
    expect((await db("o_setting").where("key", "shotsEngine").first()).value).toBe("legacy");
    expect((await db("o_vendorConfig").where("id", "miwo").first()).enable).toBe(1);
    // 而没动过的种子行照旧被删干净：down 仍然是"可回滚"的，不是"什么都不删"
    expect(await db("o_prompt").where("type", "eventExtraction").first()).toBeUndefined();
    // ⚠ seed ndjson 已在 M2 补齐那两条（新库由 002 直接种下，老库由 016 insert-if-absent 补），
    //   所以 002 的 down 会把它们一并删掉 —— 这里回到"整表为空"。
    expect(await db("o_agentDeploy").first()).toBeUndefined();
    expect(await db("o_setting").where("key", "modelDtype").first()).toBeUndefined();
    await db.destroy();
  });

  /**
   * 修复 3 的**前提**（"精确相等"判定真的成立）：up 插入的行形状必须与 down 的判定形状一致，
   * 否则 down 会一行都删不掉（"看着安全、实际不可回滚"）。
   *
   * ⚠ 断言形状 = 目标表真实列的集合：这也是 `o_setting` 走 `pickColumns`（修复 3 后半）的回归网。
   * ⚠ 这里的"相等"是**逐列的精确比较**（mysql 侧 `BINARY`、sqlite 侧 `COLLATE BINARY`），
   *    不是"SQL `=`" —— 后者在 MySQL 的 `utf8mb4_0900_ai_ci` 下大小写不敏感（合并审查修复 1）。
   */
  it("种子的列集合与目标表一致，且 down 能把 002 插的行全部删掉", async () => {
    const db = await migratedDb();
    const pairs: Array<[string, string]> = [
      ["o_prompt", "o_prompt.ndjson"],
      ["o_agentDeploy", "o_agentDeploy.ndjson"],
      ["o_setting", "o_setting.platform.ndjson"],
      ["o_vendorConfig", "o_vendorConfig.templates.ndjson"],
    ];
    for (const [table, file] of pairs) {
      const cols = new Set(Object.keys((await db(table).columnInfo()) as Record<string, unknown>));
      for (const [i, line] of fs.readFileSync(path.join(SEED_DIR, file), "utf8").split(/\r?\n/).filter((l) => l.trim()).entries()) {
        const keys = Object.keys(JSON.parse(line));
        // 多一列（源库特有列）会被 pickColumns 静默丢掉 —— 那会让该表**永远删不干净**，所以这里必须红
        expect(keys.filter((k) => !cols.has(k)), `${file}:${i + 1} 有目标表不存在的列`).toEqual([]);
      }
    }
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.down(db);
    // ⚠【Phase 1c Task 1】判据改成"002 种下的**那些键**确实被删干净"，而不是"o_setting 整表为空"：
    //   `005_accounts` 的 2 个平台开关（registrationMode / allowDbAdminOps）**不归 002 管**，
    //   002 的 down 不该、也不能删它们（那是另一个迁移的行）。原断言在"全量迁移的库"上会要求
    //   002 越界删别人的行 —— 那才是错的语义。
    const REMAINING_OK = new Set(["registrationMode", "allowDbAdminOps"]);
    for (const [table, file] of pairs) {
      const n = Number(((await db(table).count({ n: "*" }).first()) as any).n);
      if (table !== "o_setting") {
        expect(n, `${table} 没被 down 清空`).toBe(0);
        continue;
      }
      const left = ((await db("o_setting").pluck("key")) as string[]).sort();
      expect(left.filter((k) => !REMAINING_OK.has(k)), `o_setting 里 002 的种子行没被 down 清空`).toEqual([]);
      expect(left.length, `o_setting 只剩 005 的平台开关（${n} 行）`).toBe(REMAINING_OK.size);
      void file;
    }
    await db.destroy();
  });

  /** 修复 3 的**误伤面**：down 不得碰"同身份键但内容不同"的行（模拟 Task 6 先导入老数据）。 */
  it("down 不误伤 Task 6 先导入的同键老数据（键相同、内容不同）", async () => {
    const db = await migratedDb();
    // 模拟"Task 6 先导入"：把 002 插的行换成同键不同内容（= 老库那一行的样子）
    await db("o_prompt").where("type", "eventExtraction").update({ id: 999, name: "老库的事件提取", data: "OLD", useData: "x" });
    const mod = (await import("@/db/migrations/002_platform_seed")).default;
    await mod.down(db);
    const row = await db("o_prompt").where("type", "eventExtraction").first();
    expect(row, "同键但内容不同的行被 down 删掉了（正是修复 3 要防的误伤）").toBeTruthy();
    expect(row.name).toBe("老库的事件提取");
    await db.destroy();
  });

  /** 修复 1 的**可执行**回归网：单文件缺失 / 空文件必须抛错（错误信息要指名文件），不是静默 seed 0 行。 */
  it("种子文件缺失或为空时 up 抛错（错误信息指名文件）", async () => {
    const src = path.join(SEED_DIR, "o_vendorConfig.templates.ndjson");
    // ① 前置自检：上一位（被 kill / 并发）若把它留成缺失或 0 字节，这里**明确报错**，不要去 stash 一个坏副本
    if (!fs.existsSync(src) || fs.statSync(src).size === 0) {
      throw new Error(
        `[migration-seed.test] 种子文件已被上一次运行留成"缺失/0 字节"：${src}\n` +
          `  ⇒ 先跑：git restore apps/api/src/db/migrations/seed/o_vendorConfig.templates.ndjson\n` +
          `  （本用例会在 __TEMP__/miwo-seed-mutation.lock 上加跨进程锁；这里报错说明上一次是在持锁期间被强杀的）`,
      );
    }
    // ② 整个"改源文件—还原"窗口放进**跨进程锁**里（见文件头注释：并发跑会互相踩）
    await withSeedMutationLock(async () => {
      const stash = path.join(TMP, "o_vendorConfig.templates.ndjson.stash");
      fs.copyFileSync(src, stash);
      // ⚠ 这两个库**只跑 001_schema**（不跑 002）：若跑过 002，`o_vendorConfig` 里已经有 8 行，
      //    "0 行"就证明不了"抛错发生在真的什么都没插的时候"。只建表 → up 一失败，四张表必须全空。
      const db1 = freshDb();
      const db2 = freshDb();
      const schemaOnly = makeMigrationSource(MIGRATIONS.filter((m) => m.name === "001_schema"));
      await db1.migrate.latest({ migrationSource: schemaOnly });
      await db2.migrate.latest({ migrationSource: schemaOnly });
      const countAll = async (db: Knex) => {
        const out: number[] = [];
        for (const t of ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"]) {
          out.push(Number(((await db(t).count({ n: "*" }).first()) as any).n));
        }
        return out;
      };
      try {
        // ① 缺失：up 必须抛错，且错误信息指名是哪一份文件
        fs.rmSync(src);
        await expect(
          (async () => {
            const mod = (await import("@/db/migrations/002_platform_seed")).default;
            await mod.up(db1);
          })(),
        ).rejects.toThrow(/o_vendorConfig\.templates\.ndjson/);

        // ② 空文件（0 行）：同样必须抛错 —— 这正是"静默 seed 0 行"的那条通道
        fs.writeFileSync(src, "");
        await expect(
          (async () => {
            const mod = (await import("@/db/migrations/002_platform_seed")).default;
            await mod.up(db2);
          })(),
        ).rejects.toThrow(/o_vendorConfig\.templates\.ndjson/);

        // ③ 两种情况下四张表都必须**一行都没有**：证明 up 不是"插了一半再炸"
        expect(await countAll(db1)).toEqual([0, 0, 0, 0]);
        expect(await countAll(db2)).toEqual([0, 0, 0, 0]);
      } finally {
        // 逐字节还原（用 copy 而不是写回字符串，避免行尾/BOM 被测试改写）
        fs.copyFileSync(stash, src);
        fs.rmSync(stash);
        await db1.destroy();
        await db2.destroy();
      }
      // 还原后必须一切照旧（证明本用例没有留下副作用）
      const db3 = await migratedDb();
      expect(Number(((await db3("o_vendorConfig").count({ n: "*" }).first()) as any).n)).toBe(8);
      await db3.destroy();
    });
  }, 60000);
});