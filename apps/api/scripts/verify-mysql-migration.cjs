#!/usr/bin/env node
/**
 * MySQL 侧的独立验收（CI 的 mysql job 用它；本机有 MySQL 时也能跑）。
 *
 * 用法（从 apps/api 下跑，需要 MIWO_DB_DRIVER=mysql + 一组 MIWO_DB_*）：
 *   node scripts/verify-mysql-migration.cjs
 * 退出码 0 = 通过。逐条打印 [通过]/[失败]。
 *
 * 断言（8 条，与 .github/workflows/ci.yml 的 mysql job 一一对应）：
 *   1. 目标库连得上、是 MySQL、库名与 MIWO_DB_NAME 一致、**且不是空库/未迁移库**
 *   2. `db:migrate` 幂等（跑两次，第二次 0 条）
 *   3. 业务表的自增 `id` 全部是 bigint unsigned，且清单**恰好等于** 001_schema 源码里用
 *      `t.pk(T)` 建的那批表（不是"手写一个 ≥N 的下界"，那种断言在空库/部分建表时也能过）
 *   4. 文本主键（o_setting.key / memories.id / memories.isolationKey / o_vendorConfig.id）都是 varchar(191)
 *   5. o_agentWorkData 的唯一键存在
 *   6. knex_migrations / knex_migrations_lock 存在
 *   7. down --all → up 能往返
 *   8. 子进程：`MIWO_TEST_MYSQL=1 vitest run tests/mysql-integration.test.ts` 全绿，且**没有 skip**
 *
 * ⚠【Ruling 120 同族：会空转的检查等于没有检查】两条空转护栏，任一条不满足立刻失败：
 *   A. **前置**：没设 MIWO_DB_DRIVER=mysql（或 DB 五项缺项）→ 直接红。**不默认落到 sqlite**：
 *      旧写法会在没人设变量时去连 sqlite 再报一堆"主键类型不对"，把"根本没测 MySQL"伪装成
 *      "MySQL 有 bug"。同理 `.tmp-migrate/mysql-probe.ts` 的输出必须先看到 `SERVER=` 才继续解析。
 *   B. **空源**：断言 1 里钉死"目标库的业务表数 > 0 且文本主键列回读齐 4 列"。一个只跑过
 *      `select version()` 的空库（001 建的表在 002.down 之后被全清、或库刚建出来还没迁移）
 *      会在"逐条比对"里**什么都比不出来还 exit 0** —— 那正是本脚本要拒绝的状态。
 *      实测证据见 task-9-report.md 的"空转护栏实测"一节（对空库跑 → 3 条红 / exit 1）。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const checks = [];
const pass = (n, d) => checks.push({ ok: true, n, d: d || "" });
const fail = (n, d) => checks.push({ ok: false, n, d: d || "" });

function run(cmd, args, extraEnv) {
  const r = spawnSync(cmd, args, {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(extraEnv || {}) },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** 取 `KEY=` 那一行之后的所有内容（JSON 里不会有裸换行，所以取一行就够）。 */
function field(out, key) {
  const m = out.match(new RegExp("^" + key + "=(.*)$", "m"));
  return m ? m[1].trim() : "";
}

(async () => {
  // ---- 前置护栏 A：必须是 mysql 目标，且不是"空转" ----
  const envDriver = String(process.env.MIWO_DB_DRIVER || "");
  if (envDriver !== "mysql") {
    console.error(
      `verify-mysql-migration: MIWO_DB_DRIVER 必须是 mysql，实际 "${envDriver}"。\n` +
        "  本脚本只验 MySQL 分支；不设变量时默认的 sqlite 目标**不属于**本脚本的判据范围，\n" +
        "  继续跑只会把'根本没连 MySQL'报成'MySQL 有 bug'。CI 的 mysql job 在 job 级 env 里设了它。",
    );
    process.exit(2);
  }
  const missing = ["MIWO_DB_HOST", "MIWO_DB_PORT", "MIWO_DB_USER", "MIWO_DB_NAME"].filter(
    (k) => String(process.env[k] || "").trim() === "",
  );
  if (missing.length) {
    console.error("verify-mysql-migration: 缺少 MySQL 连接变量 " + missing.join(", "));
    process.exit(2);
  }

  // ---- 1) 直连一次（用 tsx 复用 src/db/connect.ts 的装配；不依赖 mysql CLI）----
  const probe = path.join(API_ROOT, ".tmp-migrate", "mysql-probe.ts");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(
    probe,
    `
import { config } from "@/config";
import { createKnex, describeTarget } from "@/db/connect";
(async () => {
  console.log("TARGET=" + describeTarget() + " DIALECT=" + config.db.driver);
  const db = createKnex();
  const v = await db.raw("select version() as v");
  const rows = Array.isArray(v) ? v[0] : v;
  console.log("SERVER=" + JSON.stringify(rows));
  const t = await db.raw("select count(*) as n from information_schema.tables where table_schema = database()");
  const tRows = Array.isArray(t) && Array.isArray(t[0]) ? t[0] : t;
  console.log("TABLES=" + JSON.stringify(tRows));
  const tb = await db.raw(
    "select count(*) as n from information_schema.tables where table_schema = database() and table_name not like 'knex\\\\_%'",
  );
  const tbRows = Array.isArray(tb) && Array.isArray(tb[0]) ? tb[0] : tb;
  console.log("BIZ_TABLES=" + JSON.stringify(tbRows));
  await db.destroy();
})().catch((e) => { console.error("PROBE_FAILED " + e.message); process.exit(1); });
`,
    "utf8",
  );
  const p = run(process.execPath, ["--import=tsx", probe]);
  const serverLine = field(p.out, "SERVER");
  const target = field(p.out, "TARGET");
  // ⚠ 空转护栏 A 的后半段：没有 SERVER= 就**不许**继续解析（否则 "解析不到 = 空数组 = 全绿"）。
  if (p.code !== 0 || !serverLine) {
    fail("1 连得上 MySQL", p.out.slice(0, 800));
  } else {
    const bizTables = Number((JSON.parse(field(p.out, "BIZ_TABLES") || "[{}]")[0] || {}).n || 0);
    // ⚠ 空转护栏 B —— **fail fast，且在产生任何副作用之前**：
    //    一个空库（刚建出来、或上一次 002.down 把表全清了）在这里就该停住。继续往下跑有两个坏处：
    //      ① 断言 2/7 会**直接把迁移跑起来**，把"空库"改造成"非空库"——等于用自己的副作用把
    //         被测状态抹掉，之后再红也说不清是"进来时就空"还是"被我跑出来的"；
    //      ② 断言 3–6 在"空 vs 空"上做比对，会给出**全绿**（会空转的检查 = 没有检查，Ruling 120 同族）。
    //    所以这里是硬退出（exit 1），不是"记一条失败然后继续"。
    if (!(bizTables > 0)) {
      fail(
        "1 连得上 MySQL（空库护栏）",
        `目标是 MySQL，但库里**一张业务表都没有**（非 knex_* 表 0 张）⇒ 空转护栏触发，` +
          `在跑任何迁移之前直接判红（后续 7 条断言不再执行，避免用自己的迁移副作用掩盖"进来时就是空库"）。` +
          ` TARGET=${target} SERVER=${serverLine}`,
      );
      console.log(`  [失败] 1 连得上 MySQL（空库护栏） —— ${checks[0].d}`);
      console.log(`\n--- 摘要：通过 0 / 1（空转护栏：空库直接红，未执行其余 7 条断言）---`);
      process.exit(1);
    }
    pass("1 连得上 MySQL", `TARGET=${target} SERVER=${serverLine} 业务表 ${bizTables} 张`);
  }

  // ---- 2) 迁移幂等 ----
  const m1 = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"]);
  const m2 = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"]);
  if (m1.code === 0 && m2.code === 0 && /无新迁移/.test(m2.out)) pass("2 迁移幂等", m2.out.trim());
  else fail("2 迁移幂等", (m1.out + m2.out).slice(0, 800));

  // ---- 3–6) 用 mysql2 直查 information_schema ----
  const inspect = path.join(API_ROOT, ".tmp-migrate", "mysql-inspect.ts");
  fs.writeFileSync(
    inspect,
    `
import { createKnex } from "@/db/connect";
(async () => {
  const db = createKnex();
  const ai = await db.raw("select table_name n, column_type t from information_schema.columns where table_schema=database() and column_name='id' and extra like '%auto_increment%'");
  const aiRows = Array.isArray(ai) && Array.isArray(ai[0]) ? ai[0] : ai;
  const txt = await db.raw("select table_name n, column_name c, column_type t from information_schema.columns where table_schema=database() and ((table_name='o_setting' and column_name='key') or (table_name='memories' and column_name in ('id','isolationKey')) or (table_name='o_vendorConfig' and column_name='id'))");
  const txtRows = Array.isArray(txt) && Array.isArray(txt[0]) ? txt[0] : txt;
  const uq = await db.raw("select index_name n from information_schema.statistics where table_schema=database() and table_name='o_agentWorkData' and non_unique=0 and index_name<>'PRIMARY'");
  const uqRows = Array.isArray(uq) && Array.isArray(uq[0]) ? uq[0] : uq;
  const t = await db.raw("select table_name n from information_schema.tables where table_schema=database() and table_name in ('knex_migrations','knex_migrations_lock')");
  const tRows = Array.isArray(t) && Array.isArray(t[0]) ? t[0] : t;
  console.log("AI=" + JSON.stringify(aiRows));
  console.log("TXT=" + JSON.stringify(txtRows));
  console.log("UQ=" + JSON.stringify(uqRows));
  console.log("MIG=" + JSON.stringify(tRows));
  await db.destroy();
})().catch((e) => { console.error("INSPECT_FAILED " + e.message); process.exit(1); });
`,
    "utf8",
  );
  const ins = run(process.execPath, ["--import=tsx", inspect]);
  const parseField = (key) => {
    const raw = field(ins.out, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  };
  if (ins.code !== 0 || parseField("AI") === null || parseField("TXT") === null) {
    fail("3 主键类型", ins.out.slice(0, 800));
    fail("4 文本主键", "见 3（information_schema 回读失败，不是'比对通过'）");
    fail("5 唯一键", "见 3");
    fail("6 迁移表", "见 3");
  } else {
    // ---- 3) 自增 id 清单：排除 knex_* 基础设施表后，必须**恰好等于** 001_schema 源码抽出的清单 ----
    // ⚠ 为什么不照抄 brief 的 `ai.length >= 23`：那是**未实跑的估计值**。实测（本机真 MySQL 8.4.11）
    //    自增 id 列共 19 列 = 18 张业务表 + knex_migrations(int unsigned)。`>= 23` 会让这条**恒红**；
    //    而若反过来只写 `>= 15`，空库/建了一半的库也能过 ⇒ 那是会空转的断言。
    //    这里改成**与源码清单逐名比对**（口径与 tests/mysql-integration.test.ts 的「清单恰好等于
    //    最终期望清单」一致），任何表的增删都会立刻红，且不依赖手写数字。
    const allAi = parseField("AI") || [];
    if (!allAi.length) {
      fail("3 主键类型", "information_schema 回读到的自增 id 列为 0 ⇒ 库是空的/未迁移（空转），判红");
    } else {
      const isInfra = (n) => String(n).toLowerCase().startsWith("knex_");
      const infra = allAi.filter((r) => isInfra(r.n));
      const biz = allAi.filter((r) => !isInfra(r.n));
      const badType = biz.filter((r) => String(r.t).toLowerCase() !== "bigint unsigned");
      // 期望清单从 001_schema 源码机械抽取（先剥注释：注释里提到 t.pk(T) 不等于调用了它）。
      const schemaSrc = fs.readFileSync(path.join(API_ROOT, "src", "db", "migrations", "001_schema.ts"), "utf8");
      const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const expected = [
        ...schemaSrc.matchAll(/createTable\("([^"]+)",\s*\(T\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/g),
      ]
        .filter((m) => /\bt\.pk\(T\b/.test(stripComments(m[2])))
        .map((m) => m[1]);
      const norm = (a) => a.map((s) => String(s).toLowerCase()).sort();
      if (badType.length) {
        fail("3 主键类型", `非 bigint unsigned：${JSON.stringify(badType)}`);
      } else if (expected.length < 10) {
        fail("3 主键类型", `从 001_schema 源码抽出的期望清单只有 ${expected.length} 条 ⇒ 抽取正则失效，判红（不是"空清单 vs 空清单"）`);
      } else if (JSON.stringify(norm(biz.map((r) => r.n))) !== JSON.stringify(norm(expected))) {
        const got = norm(biz.map((r) => r.n));
        const want = norm(expected);
        fail(
          "3 主键类型",
          `业务表自增 id 清单与 001_schema 的 t.pk(T) 清单不一致：` +
            `缺 ${JSON.stringify(want.filter((x) => !got.includes(x)))} / 多 ${JSON.stringify(got.filter((x) => !want.includes(x)))}`,
        );
      } else {
        pass(
          "3 主键类型",
          `${biz.length} 张业务表全部 bigint unsigned auto_increment，且清单与 001_schema 的 t.pk(T) 清单逐名一致（基础设施表：${JSON.stringify(
            infra.map((r) => `${r.n}:${r.t}`),
          )}）`,
        );
      }
    }

    // ---- 4) 文本主键 ----
    const txt = parseField("TXT") || [];
    const badTxt = txt.filter((r) => !/^varchar\(191\)$/.test(String(r.t).toLowerCase()));
    if (txt.length !== 4) {
      fail("4 文本主键", `期望回读到 4 列（o_setting.key / memories.id / memories.isolationKey / o_vendorConfig.id），实际 ${txt.length} 列：${JSON.stringify(txt)}`);
    } else if (badTxt.length) {
      fail("4 文本主键", `非 varchar(191)：${JSON.stringify(badTxt)}`);
    } else {
      pass("4 文本主键", JSON.stringify(txt));
    }

    // ---- 5) o_agentWorkData 唯一键 ----
    const uq = parseField("UQ") || [];
    if (uq.some((r) => /o_agentworkdata_pid_epid_key_unique/i.test(String(r.n)))) pass("5 唯一键", JSON.stringify(uq));
    else fail("5 唯一键", `没找到 o_agentWorkData 的非主键唯一索引，实际 ${JSON.stringify(uq)}`);

    // ---- 6) 迁移表 ----
    const mig = (parseField("MIG") || []).map((r) => String(r.n).toLowerCase()).sort();
    if (JSON.stringify(mig) === JSON.stringify(["knex_migrations", "knex_migrations_lock"])) pass("6 迁移表", JSON.stringify(mig));
    else fail("6 迁移表", `期望恰好这两张，实际 ${JSON.stringify(mig)}`);
  }

  // ---- 7) down --all → up ----
  const dn = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts", "--down", "--all"]);
  const up = run(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "scripts/db-migrate.ts"]);
  if (dn.code === 0 && up.code === 0 && /完成|无新迁移/.test(up.out)) pass("7 down→up", dn.out.trim() + " || " + up.out.trim());
  else fail("7 down→up", (dn.out + up.out).slice(0, 800));

  // ---- 8) 集成测试 ----
  // ⚠ 用 require.resolve 解析 vitest 入口：pnpm 的 .bin shim 在 Windows 上是 .CMD/.ps1，
  //    直接 spawn 会在某些环境下失败（本机实测 pnpm 的 .ps1 被执行策略拦截）。
  //    require.resolve("vitest/vitest.mjs") 在 Windows 与 Linux 上都能解析到真实 JS 入口。
  let vitestEntry = null;
  try {
    vitestEntry = require.resolve("vitest/vitest.mjs", { paths: [API_ROOT] });
  } catch (e) {
    fail("8 集成测试", "解析不到 vitest/vitest.mjs：" + e.message);
  }
  if (vitestEntry) {
    // ⚠ 不用 `--reporter=dot`：默认 reporter 的摘要里有 **`Tests  N passed | M skipped (T)`**，
    //    我们要断言 `skipped` 数量为 0 —— 这正是"测试被静默跳过会伪装成通过"的护栏。
    const it = run(process.execPath, [vitestEntry, "run", "tests/mysql-integration.test.ts", "--reporter=default"], {
      MIWO_TEST_MYSQL: "1",
    });
    const summary = (it.out.match(/^\s*Tests\s+.*$/m) || [""])[0].trim();
    const filesSummary = (it.out.match(/^\s*Test Files\s+.*$/m) || [""])[0].trim();
    // ⚠ 断言口径（**实测**，vitest 3.2.7；本脚本第一版口径写错，实测红过）：
    //    · **全跑**时摘要文本里**一个字都不提 skipped** —— 例如 "Tests  7 passed (7)"；
    //    · 有 skip 时才追加，例如 "Tests  6 passed | 1 skipped (7)"。
    //    所以判据是"没有任何非零 skipped"，**不是**"必须出现 0 skipped"（后者在全绿时恒红）。
    //    判别力边界：vitest 在 0 skipped 时不可能打印 "skipped"（本机三种报表实测），
    //    反之只要有一例被 skip，摘要里必然出现 skipped ⇒ 这条断言不会漏报。
    const skipCount = (s) => {
      const m = s.match(/(\d+)\s+skipped/i);
      if (m) return Number(m[1]);
      return /\bskipped\b/i.test(s) ? 1 : 0;
    };
    const totalSkip = skipCount(summary) + skipCount(filesSummary);
    const ranN = Number((summary.match(/(\d+)\s+passed/) || [])[1] || 0);
    const hasFail = /\bfailed\b|\bunhandled\b/i.test(summary) || /\bfailed\b/i.test(filesSummary);
    if (!summary) fail("8 集成测试", "vitest 输出里找不到 `Tests …` 摘要行（无法证明测试真的跑了）：\n" + it.out.slice(-1200));
    else if (it.code !== 0) fail("8 集成测试", it.out.slice(-1200));
    else if (hasFail) {
      // 反向护栏：即使退出码是 0，摘要里出现 failed 也要红（防"退出码被谁吃掉"）。
      fail("8 集成测试", `摘要里出现 failed："${summary}" / "${filesSummary}"\n` + it.out.slice(-800));
    } else if (totalSkip > 0) {
      fail(
        "8 集成测试",
        `有测试被跳过（skip 会伪装成通过）：Tests 摘要 = "${summary}"，Test Files 摘要 = "${filesSummary}"\n` +
          it.out.slice(-800),
      );
    } else if (!(ranN > 0)) {
      fail("8 集成测试", `摘要里 passed 数为 0："${summary}" ⇒ 没有任何用例真的跑过\n` + it.out.slice(-800));
    } else {
      pass("8 集成测试", `${summary}（无 skipped）`);
    }
  }

  for (const c of checks) console.log(`  [${c.ok ? "通过" : "失败"}] ${c.n}${c.ok ? (c.d ? " —— " + c.d : "") : " —— " + c.d}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n--- 摘要：通过 ${checks.length - failed.length} / ${checks.length} ---`);
  process.exit(failed.length ? 1 : 0);
})();
