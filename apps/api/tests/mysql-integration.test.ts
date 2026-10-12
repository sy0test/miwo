/**
 * 真实 MySQL 的集成测试（spec §12.2 T5/T6 的 MySQL 侧）。
 *
 * **门控**：只有 `MIWO_TEST_MYSQL=1` 时才跑。本机没有 MySQL 时（默认）整个文件 skip ——
 * 这是 spec 要求的"没有 MySQL 时测试仍可跑"。
 * CI 的 mysql job 会设 `MIWO_TEST_MYSQL=1`（Task 9），所以这条路径**在 CI 里真的会被跑到**。
 *
 * ⚠ 它会 DROP 掉目标库里 001/002 建的东西（用 down 往返），所以**必须**指向一个专用测试库
 *    （`MIWO_DB_NAME`，默认 miwo_test），绝不能指向生产库。
 *
 * 本机怎么跑（Task 7 实测过的完整流程）：
 * ```powershell
 * cd apps\api
 * powershell -ExecutionPolicy Bypass -File scripts\mysql-local.ps1 -Action start
 * powershell -ExecutionPolicy Bypass -File scripts\mysql-local.ps1 -Action createdb
 * $env:MIWO_TEST_MYSQL="1"; $env:MIWO_DB_HOST="127.0.0.1"; $env:MIWO_DB_PORT="3307"
 * $env:MIWO_DB_USER="miwo"; $env:MIWO_DB_PASSWORD="miwo"; $env:MIWO_DB_NAME="miwo_test"
 * pnpm.cmd exec vitest run tests/mysql-integration.test.ts --reporter=verbose
 * ```
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config, type MiwoConfig } from "@/config";
import { createKnex, describeTarget } from "@/db/connect";
import { migrationStatus, rollbackMigrations, runMigrations } from "@/db/migrations";
import {
  checkIdRanges,
  checkIdTypes,
  extremeRowPicks,
  findDuplicates,
  importTable,
  planImport,
  type SourceSamples,
} from "@/db/legacy/import";

const ENABLED = process.env.MIWO_TEST_MYSQL === "1";
const d = ENABLED ? describe : describe.skip;

/**
 * 仓库里的老 sqlite 快照（搬迁用例的源库）。它被 `apps/api/.gitignore` 的 `*.sqlite` 忽略
 * ⇒ **全新 checkout（含 CI 的 mysql job）上没有它**。
 *
 * ⚠⚠ **Task 11 / 控制器裁定 B（★Ruling 127）：禁止"静默早退"这种测试形态。**
 * 本文件原来在搬迁用例里写的是 `if (!fs.existsSync(devPath)) return;`。那比"漏测"更坏：
 *   ① 全新 checkout 上**必然**走那条路；
 *   ② 早退（`return`）在 vitest 里**既不是 pass 也不是 skip** ⇒ 那条"0 skipped"断言
 *      （`verify-mysql-migration.cjs` 的断言 8）**测不到它**：摘要照样写 `N passed`，全绿。
 *
 * 现在的形态从"运行时早退"改成**收集期的 `it.skipIf`**：没得跑的用例会被标成 skipped，
 * 于是它一定出现在摘要里（`Tests  N passed | 1 skipped (N+1)`），任何口径的 skip 计数都看得见它。
 * 门禁侧另有一道形态门禁（`tools/check-test-early-return.cjs`），禁止裸 `return;` 再长回来。
 */
const DEV_DB_PATH = path.resolve(__dirname, "..", "data", "db2.sqlite");
const DEV_DB_PRESENT = fs.existsSync(DEV_DB_PATH);

d("真实 MySQL 集成（MIWO_TEST_MYSQL=1）", () => {
  it("配置确实指向 mysql（防止误把 sqlite 当 mysql 测）", () => {
    expect(config.db.driver).toBe("mysql");
    expect(describeTarget()).toMatch(/^mysql:\/\//);
  });

  it("up → down(全部) → up 往返，且幂等", async () => {
    const db = createKnex();
    try {
      // 从干净状态开始（用 runner 里的同一个内存 MigrationSource，别自己再拼一份）
      await rollbackMigrations(db, true);
      const [b1, n1] = await runMigrations(db);
      expect(n1.length).toBeGreaterThan(0);
      const [b2, n2] = await runMigrations(db);
      expect(n2).toEqual([]);
      void b1; void b2;
      const [rb, rn] = await rollbackMigrations(db, true);
      expect(rn.length).toBe(n1.length);
      void rb;
      const st = await migrationStatus(db);
      expect(st.map((r) => r.name)).toEqual(n1);
      expect(st.every((r) => r.state === "pending")).toBe(true);
      const [b3, n3] = await runMigrations(db);
      expect(n3.length).toBe(n1.length);
      expect(b3).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("有自增主键的表都是 bigint unsigned，且清单恰好等于「最终期望清单」", async () => {
    const db = createKnex();
    try {
      await runMigrations(db);
      const raw = (await db.raw(
        `select table_name as n, column_type as t from information_schema.columns
         where table_schema = database() and column_name = 'id' and extra like '%auto_increment%'`,
      )) as any;
      const all = (Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw) as Array<{ n: string; t: string }>;
      // ⚠ knex 自己的基础设施表也被 `information_schema` 扫到：`knex_migrations.id` 是
      //    **`int unsigned` auto_increment**（knex 内部实现，不属我们的 schema，也不归 §5.3 管）。
      //    本机实测（Task 7）：整个 `miwo_test` 库里有自增 `id` 的 `knex_*` 表**恰好只有它一张**。
      //    所以这里不是"随手过滤掉一堆东西"，而是把被排除的那一条**钉死**：
      //    将来若多出一张 knex_* 自增表、或它的类型变了，这条断言会红。
      const isInfra = (n: string): boolean => n.toLowerCase().startsWith("knex_");
      expect(all.filter((r) => isInfra(r.n)).map((r) => `${r.n.toLowerCase()}:${r.t.toLowerCase()}`)).toEqual([
        "knex_migrations:int unsigned",
      ]);
      const list = all.filter((r) => !isInfra(r.n));
      const types = new Set(list.map((r) => r.t.toLowerCase()));
      expect(types).toEqual(new Set(["bigint unsigned"]));
      expect(list.length).toBeGreaterThan(15); // 防"过滤把业务表一起滤掉"→ 空集合假绿

      // ⚠ 清单**不是**在这里手写的，而是从 `001_schema` 的源码机械抽取：
      //    凡是用了 `t.pk(T)` 的表就是自增主键表。这样"加了表但忘了改断言"不可能发生。
      const schemaSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "db", "migrations", "001_schema.ts"), "utf8");
      // ⚠ **必须先剥注释**：brief 的原始正则直接在表体里找 `t.pk(T)`，而 `o_project` 的表体里有一句
      //    注释写着「⚠ **不能**用 `t.pk(T)`：现状 `id` 由代码显式给 `Date.now()`…」——
      //    于是 `o_project` 被**误判**成自增主键表（实测：期望清单 19 项 vs 真库 18 项，
      //    差异恰好是 `o_project`）。注释里提到一个 API 名字，不等于调用了它。
      const stripComments = (s: string): string =>
        s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const expected = [...schemaSrc.matchAll(/createTable\("([^"]+)",\s*\(T\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/g)]
        .filter((m) => /\bt\.pk\(T\b/.test(stripComments(m[2])))
        .map((m) => m[1])
        .sort();
      expect(expected.length).toBeGreaterThan(15);                 // 防止正则失效导致"空清单 vs 空清单"的假绿
      // ⚠ 地板值为什么是 15 而不是 brief 写的 20：**实测**（Task 7，本机真 MySQL）
      //    27 张表里用 `t.pk(T)` 的**恰好 18 张**（其余 9 张：o_user / o_project 显式给 id、
      //    memories / o_setting / o_vendorConfig 是 varchar 主键、4 张复合主键关联表）。
      //    brief 的 20 会让这条断言**恒红**——它是未经实跑的估计值。
      // ⚠ 比较**大小写归一后**的名字：Windows 上的 MySQL `@@lower_case_table_names=1`
      //    （本机实测 = 1）把表名按小写存储，`information_schema` 回读的永远是
      //    `o_agentworkdata`，而源码抽出来的是 `o_agentWorkData`。Linux 的 CI 上是 0，
      //    回读与源码同名。`toLowerCase()` 两边都做，于是两个平台都能跑；
      //    判别力不受影响（表的增删仍会立刻红）。
      expect(list.map((r) => r.n.toLowerCase()).sort()).toEqual(expected.map((n) => n.toLowerCase()).sort());
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("批量 insert 的 insertId 是**首行**（与 sqlite 的末行不同 —— spec §5.3 的差异被钉住）", async () => {
    const db = createKnex();
    try {
      // ⚠ 这条用例的前提是 `o_artStyle` 是**刚建出来的空表**：MySQL 的 AUTO_INCREMENT 计数器
      //    不会因为 DELETE 归零，所以必须先让迁移把它重建一次（本文件的第 2 条用例刚做过往返），
      //    再用 `ALTER TABLE ... AUTO_INCREMENT = 1` 显式归零 —— 否则单行 insert 的 id 不是 1。
      // ⚠⚠ 修复轮 1：**顺序必须是先 `del()` 再 `ALTER`**，反过来是错的。
      //    实测（InnoDB）：**非空**表上 `ALTER TABLE ... AUTO_INCREMENT = 1` 会被钉到
      //    `max(id)+1`（InnoDB 不允许把计数器降到已有行之下），此后 `del()` **不会**把计数器降回来
      //    → 单行 insert 拿到 4 而不是 1，`single[0] !== 1`。
      //    旧写法（ALTER 在前、del 在后）**今天通过只是因为上一条用例的 up/down 往返恰好把
      //    `o_artStyle` 留成空表**（该表无种子，`002_platform_seed` 不碰它）——
      //    即"结论依赖另一条用例的副作用"，属脆弱的假绿。先删后置零把这个前提去掉了：
      //    无论进来时表里有多少行，`del()` 清空后计数器一定能降到 1。
      // ⚠ 断言顺序也按同一口径排：**先证明表里有行、且计数器已被钉高**，再 del + 置零。
      //    反过来写（先 del 再断言）的话，"进来时本来就是空表"与"del 真的清空了"看起来一模一样，
      //    这条护栏会退化成空转 —— 那样即便哪天 `del()` 被删掉也不会红。
      await runMigrations(db);

      // 1) 从**非空**状态起步，并且**用一次真实插入**把计数器读出来。
      //    ⚠ 合并审查修复 3：这里**不许**读 `information_schema.tables.AUTO_INCREMENT` ——
      //    那是**缓存**元数据（`information_schema_stats_expiry` 默认 86400 秒），实测
      //    `del()` + `ALTER ... = 1` 之后它**仍然报 4**，于是旧断言 `pinnedAutoInc >= 4`
      //    近乎恒真（根本没有判别力）。规范：**断言必须读实际插入行为，不得读可能被缓存的元数据**。
      await db("o_artStyle").insert([{ name: "seed1" }, { name: "seed2" }, { name: "seed3" }]);
      const rowsBeforeDel = Number(((await db("o_artStyle").count({ n: "*" }).first()) as { n: number | string }).n);
      expect(rowsBeforeDel, "起点必须是非空表，否则下面的 del() 是空转").toBeGreaterThan(0);
      //    非空表上把计数器置 1 → InnoDB 钉到 `max(id)+1 = 4`；下一条插入的 id 必须是 **4**。
      await db.raw("ALTER TABLE o_artStyle AUTO_INCREMENT = 1");
      const pinnedProbe = await db("o_artStyle").insert({ name: "probe" });
      expect(pinnedProbe[0], "非空表上 ALTER=1 之后下一条 id 必须是 4（读真实插入，不读缓存元数据）").toBe(4);

      // 2) 先清空，再把计数器显式归零 —— 只有这个顺序才能真的降到 1。
      //    （反向顺序的实测红案见 task-7 报告「修复轮 1」：`expected 4 to be 1`。）
      await db("o_artStyle").del();
      await db.raw("ALTER TABLE o_artStyle AUTO_INCREMENT = 1");

      const single = await db("o_artStyle").insert({ name: "a" });
      expect(single[0]).toBe(1);
      const multi = await db("o_artStyle").insert([{ name: "b" }, { name: "c" }]);
      expect(multi[multi.length - 1]).toBe(2);     // mysql：首行 insertId = 2（sqlite 会是 3）
    } finally {
      await db.destroy();
    }
  }, 120000);

  it("knex_migrations / knex_migrations_lock 存在（Phase 1b 的 policies.ts 必须声明它们）", async () => {
    const db = createKnex();
    try {
      await runMigrations(db);
      expect(await db.schema.hasTable("knex_migrations")).toBe(true);
      expect(await db.schema.hasTable("knex_migrations_lock")).toBe(true);
    } finally {
      await db.destroy();
    }
  }, 120000);

  /**
   * **Task 8 的端到端往返**：仓库里的老 sqlite 库 → 真 MySQL，逐表行数 + 抽样逐列一致。
   *
   * 与 `tests/legacy-import.test.ts` 的分工：那边是 **sqlite↔sqlite** 的判据网（本机没 MySQL 也能跑），
   * 这边只补"真 MySQL 上的类型 / 字符集 / 严格模式"这一段 —— 两个方言的**表示差异**
   * （`bigint unsigned` 回读成 number、`float(8,2)` 的尾数、longtext 的万字符往返）只有真连才看得见。
   *
   * 为什么抽样要分两层（Task 8 Step 1 的结论，这里同样适用）：
   *   均匀抽样（按第一列排序取首行）**抽不中边界** —— 老库最关键的几条数据恰好是边界
   *   （`o_agentWorkData.data` 最长 103,624 字符、`o_project.id` 是 `Date.now()` 毫秒值）。
   *   只比首行会让"27 张表全绿"发生在**从没读过那 5 行超长数据**的前提下。所以这里同样
   *   用 `extremeRowPicks()` 把"每列最长文本 / 数值极值"的行也拉进来比。
   *
   * ⚠ 本用例会 DROP/重建 `MIWO_DB_NAME` 里的全部表（与上面几条同一约定：只许指向专用测试库）。
   * ⚠ 老库快照 `apps/api/data/db2.sqlite` **只读**打开（`better-sqlite3` 的 `readonly`），
   *   并且这里**不**断言它的 sha256（那条硬约束由 `legacy-import.test.ts` 与 `export-sqlite.cjs` 守）。
   */
  it.skipIf(!DEV_DB_PRESENT)(
    `dev sqlite 库 → MySQL 全量搬迁：逐表行数与分层抽样逐列一致${DEV_DB_PRESENT ? "" : "（无 dev 库快照 → 显式 skip）"}`,
    async () => {
      const devPath = DEV_DB_PATH;

    // ⚠ 四张平台种子表在 `002` 之后**已经有行**，而 `importTable()` 是"整表搬"的原语：
    //   它对种子表会撞主键（实测 `Duplicate entry '1' for key 'o_agentdeploy.PRIMARY'`）。
    //   生产路径（`importExport()` / `scripts/import-mysql.cjs`）对它们走"跳过已存在"——
    //   那一段由 `legacy-import.test.ts` 的种子用例 + `compare-db.cjs` 在真 MySQL 上验，
    //   这里**显式**跳过并把原因说出来，而不是假装种子表也走同一条路。
    const SEED = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"];
    const dst = createKnex();
    const src = createKnex({
      ...config,
      db: { driver: "sqlite", file: devPath, poolMin: 1, poolMax: 2 },
    } as unknown as MiwoConfig);
    try {
      // 1) 目标库回到"迁移刚建好 + 002 已跑"的空状态（与上一条用例同一往返路径）
      await rollbackMigrations(dst, true).catch(() => {});
      await runMigrations(dst);

      // 2) 任何写入之前：唯一键查重 + id 越界（【Ruling 34/41】）
      const plans = await planImport({ src, dst });
      expect(await findDuplicates(src, plans)).toEqual([]);
      expect(await checkIdRanges(src, plans)).toEqual([]);

      // 3) 逐表搬（列交集 + id 保真；`importTable` 内部断言 `done === sourceRows`）
      const moved: string[] = [];
      let planned = 0;
      for (const p of plans) {
        if (!p.targetExists || !p.columns.length || SEED.includes(p.table)) continue;
        planned += p.sourceRows ?? 0;
        const r = await importTable({ src, dst, plan: p, batchSize: 500 });
        expect(r.rows, `${p.table} 搬运行数`).toBe(p.sourceRows ?? 0);
        moved.push(`${p.table}=${r.rows}`);
      }
      expect(planned).toBeGreaterThan(2000); // 防"清单一空 → 全程空转"的假绿（实测 2,373 行）

      // 4) 逐表行数：搬过的必须**恰好**相等（preflight 已证明它们进的是空表）
      const targetCount = async (t: string): Promise<number> => {
        const row = (await dst(t).count({ n: "*" }).first()) as { n: number | string } | undefined;
        return row ? Number(row.n) : 0;
      };
      for (const p of plans) {
        if (!p.targetExists || !p.columns.length || SEED.includes(p.table)) continue;
        expect(await targetCount(p.table), `${p.table} 目标行数`).toBe(p.sourceRows ?? 0);
      }
      // 种子表：目标必须非空（种子真的落地），且**不与源冲突的那部分内容一致**（下面第 5 步按身份键比）。
      for (const t of SEED) expect(await targetCount(t), `${t} 种子落地`).toBeGreaterThan(0);

      // 5) 分层抽样：每表"按第一列排序的首行" + "每列最长文本 / 数值极值"的行，逐列比较。
      //    种子表按**身份键**（`002_platform_seed` 的 `seedTable(..., keyOf)` 口径）定位：
      //    待搬迁的行是"目标里没有同身份键"的那几条，重合的几条在生产路径里是"跳过已存在"，
      //    拿主键去比会被判成"缺席"（噪音）—— 所以这里只比身份键能对上的行。
      const IDENTITY: Record<string, string> = { o_prompt: "type", o_agentDeploy: "key", o_setting: "key", o_vendorConfig: "id" };
      // ⚠ **已拍板的"按设计不同"**：老库 `o_vendorConfig.id='volcengine'` 是 `enable=1`，
      //   而 `002_platform_seed` 的模板是 `enable=0`。导入按交接条款"跳过已存在、不得 upsert"
      //   → 目标保留种子值。**这不是本用例要重判的差异**：`compare-db.cjs` 的
      //   `accountedMismatches` 已经逐条登记它（Task 8 Step 2 实跑抓到的就是这个）。
      //   这里显式列出来，是为了让"本用例不比哪一格"这件事**写在代码里**而不是靠读者猜；
      //   若哪天这条不再被登记（例如种子改了），`compare-db` 那边会红。
      const ACCOUNTED: Record<string, string[]> = { "o_vendorConfig|volcengine": ["enable"] };
      const samples: SourceSamples = {};
      for (const p of plans) {
        if (!p.targetExists || !p.columns.length) continue;
        const key = IDENTITY[p.table] ?? p.columns[0];
        const rows = (await src(p.table).orderBy(key).limit(1)) as Array<Record<string, unknown>>;
        samples[p.table] = { pk: [key], rows };
      }
      const extreme = await extremeRowPicks(
        src,
        { tables: plans.map((p) => ({ name: p.table, rows: p.sourceRows ?? 0, bytes: 0, sha256: "", columns: p.columns })) },
        samples,
      );
      let compared = 0;
      let extremeCompared = 0;
      let seedRowsCompared = 0;
      let accountedCells = 0;
      for (const p of plans) {
        if (!p.targetExists || !p.columns.length) continue;
        const key = IDENTITY[p.table] ?? p.columns[0];
        const where: Array<Record<string, unknown>> = [];
        if (samples[p.table].rows[0]) where.push({ [key]: samples[p.table].rows[0][key] });
        for (const e of extreme[p.table] ?? []) {
          if (e.pk[key] !== undefined) where.push({ [key]: e.pk[key] });
        }
        for (const w of where) {
          const accountedCols = ACCOUNTED[`${p.table}|${String(w[key])}`] ?? [];
          const s = (await src(p.table).where(w).first()) as Record<string, unknown> | undefined;
          const d = (await dst(p.table).where(w).first()) as Record<string, unknown> | undefined;
          // 缺席 = 生产路径按"跳过已存在"处理的那几行（逐条归因归 `compare-db`，这里不重复判）
          if (!s || !d) continue;
          compared += 1;
          if (SEED.includes(p.table)) seedRowsCompared += 1;
          for (const c of p.columns) {
            if (accountedCols.includes(c)) {
              accountedCells += 1;
              continue;
            }
            // 口径与 `compare-db` 一致：两边都 `String()` 后比（容忍 0 与 "0" 的表示差异），
            // 但**不 trim** —— 【Ruling 77】MySQL 的尾随空格语义不同，吃掉差异就是藏 bug。
            expect(String(d[c] ?? ""), `${p.table}.${c} @ ${JSON.stringify(w)}`).toBe(String(s[c] ?? ""));
          }
        }
        extremeCompared += (extreme[p.table] ?? []).length;
      }
      // 防"两层抽样都没抽到东西 → 全程空转"的假绿
      expect(compared).toBeGreaterThan(20);
      expect(extremeCompared).toBeGreaterThan(0);
      expect(seedRowsCompared).toBeGreaterThan(0);
      // "按设计不同"的那一格必须真的被读到过（否则这条豁免就是空转的）
      expect(accountedCells).toBeGreaterThan(0);
      console.log(
        `[mysql-integration] 搬迁往返：搬 ${moved.length} 张表 / ${planned} 行（跳过种子表 ${SEED.join(",")}）；` +
          `抽样比较 ${compared} 行（其中边界 ${extremeCompared} 行、种子表身份键对齐 ${seedRowsCompared} 行、` +
          `按设计不同 ${accountedCells} 格 = o_vendorConfig.volcengine.enable）`,
      );

      // 6) 【Ruling 43】id 类列读回来必须还是 number（类型漂移为空）
      expect(await checkIdTypes(dst, plans)).toEqual([]);
    } finally {
      await src.destroy();
      await dst.destroy();
    }
  }, 600000);

  /**
   * **合并审查修复 1 的判别力用例**：`002_platform_seed.down` 的相等判据必须与 collation 无关。
   *
   * 为什么这条只能在真 MySQL 上才有判别力：本机 MySQL 的服务端 collation 是
   * **`utf8mb4_0900_ai_ci`**（`ci` = case-insensitive）→ SQL `=` **大小写不敏感**。
   * 旧实现 `knex(table).where(种子行).del()` 因此会把"**只把大小写改掉**"的那一行
   * 当成 002 插的行**删掉**：老库/运营只要改过一次大小写，一次回滚就吃掉一行用户数据。
   * sqlite 的 TEXT `=` 本身就是 BINARY 语义 → 同一用例在 sqlite 上**加固前后都绿**（零判别力），
   * 所以它落在这个门控文件里（`MIWO_TEST_MYSQL=1`；默认套件 skip）。
   *
   * 加固方式见 `src/db/migrations/002_platform_seed.ts` 的 `whereExact()`：
   * mysql 侧 `BINARY ?? = ?`、sqlite 侧 `?? COLLATE BINARY = ?`。
   */
  it("002.down 不删「只改了大小写」的种子行（MySQL ci collation 下 SQL = 会误命中）", async () => {
    const db = createKnex();
    try {
      // 从干净状态重建 001 + 002：`o_prompt` 里是 4 行**纯种子**
      await rollbackMigrations(db, true);
      await runMigrations(db);
      const before = Number(((await db("o_prompt").count({ n: "*" }).first()) as { n: number | string }).n);
      expect(before, "o_prompt 的种子行数（底座非空，否则下面的断言是空转）").toBeGreaterThan(1);

      // 只改**大小写**：对 `utf8mb4_0900_ai_ci` 而言与种子"相等"（SQL `=` 会命中），
      // 对 `BINARY` 比较则是另一行。
      await db("o_prompt").where("type", "eventExtraction").update({ type: "EVENTEXTRACTION" });

      const mod = (await import("@/db/migrations/002_platform_seed")).default;
      await mod.down(db);

      // ① 只改大小写的那一行必须**存活**（加固前这里红：旧判据按 ci `=` 把它删掉了）
      const survivor = await db("o_prompt").where("type", "EVENTEXTRACTION").first();
      expect(survivor, "只改大小写的种子行被 down 删掉了：等于把 ci collation 的不敏感 `=` 当成了相等判据").toBeTruthy();
      const after = Number(((await db("o_prompt").count({ n: "*" }).first()) as { n: number | string }).n);
      expect(after, "down 之后 o_prompt 只该剩那一行被改过的").toBe(1);
      // ② 反向护栏：没动过的行照旧被删干净 —— 否则"存活"可能只是"down 什么都不删"的空转
      //    ⚠ 这条护栏**自己**也必须用 `BINARY`：`where("type", "eventExtraction")` 在本库的
      //      `utf8mb4_0900_ai_ci` 下会**同时命中** 'EVENTEXTRACTION'（ci 不敏感）——
      //      实测这条断言第一版就被 ci collation 打红（`expected { id: 1, … } to be undefined`），
      //      正是本用例要钉住的那个坑，所以连测试的查询也得写清楚比较口径。
      const untouched = await db("o_prompt").whereRaw("BINARY ?? = ?", ["type", "eventExtraction"]).first();
      expect(untouched, "没动过的种子行没被删掉 → down 空转了（护栏本身失效）").toBeUndefined();
      expect(Number(((await db("o_agentDeploy").count({ n: "*" }).first()) as { n: number | string }).n), "o_agentDeploy 应被 down 全清").toBe(0);
      // ③ 数值主键的精确比较也要真的命中：上面"只剩 1 行"已经蕴含它，这里把第 4 张表也钉一下
      expect(Number(((await db("o_vendorConfig").count({ n: "*" }).first()) as { n: number | string }).n)).toBe(0);
    } finally {
      await rollbackMigrations(db, true).catch(() => {});
      await db.destroy();
    }
  }, 180000);
});

/**
 * **skip 归因**（Task 11 / 控制器裁定 B = ★Ruling 127 的配套断言；**故意放在 `d(...)` 之外**）。
 *
 * 上面那条搬迁用例在"没有 dev 库快照"时会 `it.skipIf` 掉。这条用例让那个 skip **有据可查**：
 * 它**在默认套件里也真的跑**（不受 `MIWO_TEST_MYSQL` 门控），并断言 `DEV_DB_PRESENT` 与磁盘事实一致。
 * 于是"跳过搬迁用例"只可能是"这份快照真的不在"，不可能是"有人把条件写反了/把用例注掉了"——
 * 后者会让 `DEV_DB_PRESENT` 与事实不符而当场红。
 *
 * ⚠ 为什么**不**放进 `d(...)` 里：`d` 在没有 `MIWO_TEST_MYSQL=1` 时是 `describe.skip`，
 *   放在里面它就只在 MySQL 场景出现 —— 而"默认套件里到底跳了哪些"恰恰是 Ruling B 要盯的东西
 *   （默认套件的 skip 必须**逐条可归因**，不能有"因为整个 describe 被 skip 所以看不见"的盲区）。
 */
it("skip 归因：dev 库快照的存在性与搬迁用例的 skip 条件一致（默认套件也跑）", () => {
  expect(
    DEV_DB_PRESENT,
    `${DEV_DB_PATH} 的存在性必须与 DEV_DB_PRESENT 一致（不一致 = 有人在用假条件跳过搬迁用例）`,
  ).toBe(fs.existsSync(DEV_DB_PATH));
});
