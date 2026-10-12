#!/usr/bin/env node
/**
 * 生成一份**合成**的 dev 库快照，让"sqlite → MySQL 全量搬迁"那条集成用例在没有真实
 * `apps/api/data/db2.sqlite` 的环境里（首要是 **CI 的 mysql job**）也能**真的跑起来**。
 *
 * ── 为什么需要它（Task 11 暴露出的真缺口，控制器裁定 B = ★Ruling 127 的必然推论）──
 * 那条用例的源库是 `apps/api/data/db2.sqlite`，而它被 `apps/api/.gitignore` 的 `*.sqlite` 忽略
 * ⇒ 全新 checkout（含 CI）上**必然不存在**。改动前它靠 `if (!fs.existsSync(devPath)) return;`
 * **静默早退**：既不是 pass 也不是 skip，"0 skipped"那条断言看不见它，摘要照样全绿。
 * 那条早退被改成 `it.skipIf` 之后，缺口就从"假装通过"变成"**诚实但空着**"——
 * `verify-mysql-migration.cjs` 的断言 8 会看到 1 skipped 并判红。
 *
 * 修法有两条，本脚本选的是**更好**的那条：
 *   (a) 放宽断言 8 让它容忍那 1 条 skip —— 那是**削弱门禁**；
 *   (b) **给 CI 一份可用的源库**，让那条用例真的跑 —— 本脚本。
 * 选 (b) 的理由：被跳过的恰恰是"整库搬迁 + 逐表行数 + 分层抽样逐列一致"这条端到端判据，
 * 也正是 Phase 1a 最该在自动化环境里被跑到的东西。用合成库跑它，比让它 skip 强得多。
 *
 * ── 它生成的形状（与真库**同构**，不是"随便一个 sqlite 文件"）──
 *   · 表/列结构：`001_schema` 建出来的 27 张业务表。做法是**在一次性目录里跑一次真迁移**，
 *     不手抄 DDL —— 手抄的 schema 会与 `001_schema` 漂移，而那正是本仓库反复抓过的坑。
 *   · 平台种子表（`o_prompt` / `o_agentDeploy` / `o_setting` / `o_vendorConfig`）**保持种子行**，
 *     与真库一致（那条用例对它们走"跳过已存在"，并断言目标侧非空）。
 *   · 非种子表里塞 `--rows`（默认 2001）行**填充数据**：用例有一条
 *     `expect(planned).toBeGreaterThan(2000)`（防"清单一空 → 全程空转"的假绿），
 *     合成库必须越过它，否则那条**真**断言会红。
 *
 * ⚠ **它绝不覆盖真实 dev 库**：目标存在就拒绝（`--force` 也不删——那是真库时不可恢复）。
 * ⚠ **它不新增任何 `MIWO_*` 环境变量**；一次性目录与目标路径都由计算得出。
 * ⚠ CI 上这一步之后 `tools/check-copy.cjs` 必须仍然通过：`*.sqlite` 在 `.gitignore` 里
 *   （`apps/api/.gitignore`），`check-copy` 查的是 **git 索引**，磁盘上的新文件不会让它红。
 *
 * 用法（在 apps/api 下）：
 *   node scripts/gen-dev-db-fixture.cjs                      # 写到 apps/api/data/db2.sqlite
 *   node scripts/gen-dev-db-fixture.cjs --out=<路径>          # 写到别处（本地自测用）
 *   node scripts/gen-dev-db-fixture.cjs --rows=2500
 * 退出码：0 = 生成成功；1 = 目标已存在 / 迁移或写入失败。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const API_ROOT = path.resolve(__dirname, "..");
const guard = require("./db-target-guard.cjs");
const args = process.argv.slice(2);
const argOf = (p, d) => {
  const a = args.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : d;
};
const OUT = path.resolve(API_ROOT, argOf("--out=", path.join("data", "db2.sqlite")));
const ROWS = Number(argOf("--rows=", "2001"));

/**
 * 非种子表（除四张平台种子表之外的业务表）里，往哪些表塞填充行。
 * ⚠ 必须**铺开**而不是只填一张表：那条用例断言
 *   `compared > 20` / `extremeCompared > 0` / `seedRowsCompared > 0` / `accountedCells > 0`
 *   —— 全是"抽样真的抽到了东西"的防空转判据。只填一张表会让 `seedRowsCompared` 恒为 0
 *   （实测：`expected 0 to be greater than 0`）。
 */
const SEED_TABLES = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"];

/**
 * 四张种子表的**身份键**列 —— 与 `tests/mysql-integration.test.ts` 里那张
 * `IDENTITY` 表（`{ o_prompt: "type", o_agentDeploy: "key", o_setting: "key", o_vendorConfig: "id" }`）
 * 同一口径。合成库必须按同一套身份键造样本，否则"源/目标同身份键那几行"对不上。
 */
const IDENTITY_KEY = {
  o_prompt: "type",
  o_agentDeploy: "key",
  o_setting: "key",
  o_vendorConfig: "id",
};

if (!Number.isInteger(ROWS) || ROWS < 1) {
  console.error(`--rows 必须是 >=1 的整数，实际 "${argOf("--rows=", "")}"`);
  process.exit(1);
}
if (fs.existsSync(OUT)) {
  console.error(
    `拒绝执行：目标已存在 → ${OUT}\n` +
      "  本脚本只负责**造一份新的合成快照**，绝不覆盖任何已有文件：\n" +
      "  · 如果那是真实 dev 库（apps/api/data/db2.sqlite），覆盖它是**不可恢复**的；\n" +
      "  · 如果那是别处的一份快照，删掉它再来（本脚本不做删除）。",
  );
  process.exit(1);
}

/** 一次性工作目录（迁移在这里跑，成功后才搬到 OUT）。 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-devdb-fixture-"));
const workDb = path.join(WORK, "db2.sqlite");

function cleanup() {
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* %TEMP% 里的残骸由系统清理；不掩盖真正失败的原因 */
  }
}

/**
 * 哪些表的 `id` 是**数据库自动分配**的（`001_schema` 里用了 `t.pk(T)`）。
 *
 * ⚠ 必须**从 `001_schema.ts` 机械抽取**，不能靠"主键叫 id 就当自增"猜：
 *   实测踩过两次，都是同一个错判：
 *     ① `memories.id` 叫 id 但是 `varchar(191)` —— sqlite 只对 `INTEGER PRIMARY KEY`
 *        自动补 rowid，漏赋值就 `NOT NULL constraint failed: memories.id`；
 *     ② `o_user.id` 叫 id、类型也是整数，但 `001_schema` **没有**用 `t.pk(T)` ⇒ 它**不自增**，
 *        漏赋值时 sqlite 悄悄写 NULL，搬到 MySQL 才炸 `Column 'id' cannot be null`。
 *    判据只能是"源码里到底调没调用 `t.pk(T)`"（与 `verify-mysql-migration.cjs` 断言 3、
 *    `tests/mysql-integration.test.ts` 的期望清单同一口径）。
 */
function autoPkTables() {
  const src = fs.readFileSync(path.join(API_ROOT, "src", "db", "migrations", "001_schema.ts"), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
  const out = new Set();
  for (const m of src.matchAll(/createTable\("([^"]+)",\s*\(T\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/g)) {
    if (/\bt\.pk\(T\b/.test(strip(m[2]))) out.add(m[1]);
  }
  if (out.size < 10) throw new Error(`从 001_schema 抽出的自增主键表只有 ${out.size} 张 ⇒ 抽取正则失效，拒绝继续`);
  return out;
}

/** 用**真迁移**把结构建出来（`MIWO_DATA_DIR` 指向一次性目录 ⇒ 护栏放行）。 */
function migrate() {
  return spawnSync(process.execPath, ["--import=tsx", "scripts/db-migrate.ts"], {
    cwd: API_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
    env: {
      ...process.env,
      MIWO_ENV: "dev",
      MIWO_PORT: "10599",
      MIWO_HOST: "127.0.0.1",
      MIWO_JWT_SECRET: "devdb-fixture-secret-at-least-32-bytes-000",
      MIWO_DB_DRIVER: "sqlite",
      MIWO_DATA_DIR: WORK,
    },
  });
}

function main() {
  // 自证：护栏在这一组 env 下必须**放行**（一次性目录），否则说明推导写错了。
  const verdict = guard.repoDevDbVerdict({
    env: { MIWO_DATA_DIR: WORK, MIWO_DB_DRIVER: "sqlite" },
    argv: [],
  });
  if (verdict.blocked) {
    console.error(`内部错误：一次性目录被护栏拦住了（不该发生）→ ${verdict.reason}`);
    process.exit(1);
  }

  const mig = migrate();
  if (mig.status !== 0) {
    console.error("迁移失败（无法用真迁移建出结构）：");
    console.error(String(mig.stdout || "").slice(-1500));
    console.error(String(mig.stderr || "").slice(-1500));
    process.exit(1);
  }
  if (!fs.existsSync(workDb)) {
    console.error(`迁移没有建出 ${workDb}`);
    process.exit(1);
  }

  let Database;
  try {
    Database = require(path.join(API_ROOT, "node_modules", "better-sqlite3"));
  } catch {
    Database = require("better-sqlite3");
  }

  const db = new Database(workDb);
  try {
    // ---- 断言结构确实是 27 张业务表（不许"迁移没跑成功但文件在"这种假成功）----
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .filter((n) => !n.startsWith("knex_"));
    if (tables.length !== 27) {
      throw new Error(`期望 27 张业务表，实际 ${tables.length}：${tables.join(",")}`);
    }

    // ---- 平台种子表保持非空（那条用例会断言"目标侧种子落地 + 身份键对齐"）----
    for (const t of SEED_TABLES) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      if (!(n > 0)) throw new Error(`种子表 ${t} 在合成库里是空的（迁移的 002 没跑？）`);
    }
    // 给四张种子表各**补一行**"非 tokenKey 的普通身份键"。为什么必须补：
    // 那条用例对种子表按**身份键**抽样（`o_prompt.type` / `o_agentDeploy.key` /
    // `o_setting.key` / `o_vendorConfig.id`），并断言 `seedRowsCompared > 0`
    // —— 即"至少要有一行源/目标身份键能对上"。只靠 002 的种子行不行：
    // 用例搬的是**源库（本合成库）**的行，源里只有 002 那批种子是"目标里有、被跳过"的，
    // 但用例把 `SEED` 表整体排除在 `importTable` 之外，它们的**抽样**仍按身份键做 ——
    // 源侧必须真的有键能与目标对上（实测：不加这一段 `expected 0 to be greater than 0`）。
    const seedRow = {
      // ⚠ 列名以 `001_schema` 为准（`o_prompt` 是 name/type/data/useData，**没有** value 列）。
      o_prompt: { name: "fixtureSeedPrompt", type: "fixtureSeedPrompt", data: "fixture" },
      o_agentDeploy: { key: "fixtureSeedAgent", name: "fixtureSeedAgent" },
      // ⚠ 用**真实种子键** `shotsEngine`（值也同 002 的 "v2"）：用例对种子表按身份键抽样，
      //    并且要求 `seedRowsCompared > 0`（"至少一行源/目标身份键能对上"）。
      //    自造一个 `fixtureSeedPrompt` 之类的键**不满足**那条 —— 目标里没有那个键，
      //    `src/dst` 两端找不到同一行 ⇒ `continue` ⇒ 计数为 0（实测 `expected 0 to be greater than 0`）。
      //    用真实键还有第二个好处：它就是 `verify-phase0` 断言的那条 `shotsEngine = v2`。
      o_setting: { key: "shotsEngine", value: "v2" },
      // `enable` 取 **1**：与 002 的模板（0）**故意不同** —— 这正是用例里 `ACCOUNTED`
      //   登记的那一格 `o_vendorConfig|volcengine: [enable]`（真库就是 1），
      //   而用例有一条 `expect(accountedCells).toBeGreaterThan(0)`
      //   （"按设计不同的那一格必须真的被读到过，否则这条豁免就是空转的"）。
      //   取 0 会让 `accountedCells` 恒为 0（实测 `expected 0 to be greater than 0`）。
      o_vendorConfig: { id: "volcengine", inputValues: "{}", models: "[]", enable: 1 },
    };
    // ⚠ 四张种子表在迁移（002）之后**已经有行**了，所以我这些身份键样本多半是"已存在"：
    //    · 存在 → **不插**，把需要对齐的那几列改过去（`o_vendorConfig.enable` 要从种子的 0 改成 1）；
    //    · 不存在 → 插一行。
    //    只判"存在就不插"会让 enable 停在 0 ⇒ `accountedCells` 恒为 0、断言红（实测踩过）。
    const seedUpsert = {
      o_vendorConfig: { enable: 1 },
    };
    for (const [t, row] of Object.entries(seedRow)) {
      // ⚠ **判定存在性只能按身份键**（`o_setting.key` / `o_vendorConfig.id` / …），
      //    不能把整行都放进 WHERE：那样"已存在但某列同值不同"的行会被判成"不存在" →
      //    走 INSERT → 撞主键 `UNIQUE constraint failed: o_vendorConfig.id`（实测踩过）。
      //    这正是"按身份键对齐"的语义：身份键在就更新那几列，不在才插。
      const identity = IDENTITY_KEY[t];
      if (!identity) throw new Error(`种子表 ${t} 没有登记身份键列（身份键 = 用例 IDENTITY 的口径）`);
      const has = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${identity}" = ?`).get(row[identity]).n;
      if (has) {
        const patch = seedUpsert[t] || {};
        const patchKeys = Object.keys(patch);
        if (patchKeys.length) {
          db.prepare(`UPDATE "${t}" SET ${patchKeys.map((k) => `"${k}" = ?`).join(", ")} WHERE "${identity}" = ?`).run(
            ...patchKeys.map((k) => patch[k]),
            row[identity],
          );
        }
      } else {
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO "${t}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
          ...keys.map((k) => row[k]),
        );
      }
    }

    // ---- 填充非种子表 ----
    // ⚠ 目标：让那条集成用例的每一条"防空转"判据都真的抽到东西。
    //   `--rows` 那一份**只写进 `o_image`**（它是单列主键、构造代价最低），保证
    //   `planned > 2000`；其余非种子表各 `PER_TABLE` 行，保证抽样覆盖多张表。
    const PER_TABLE = 3;
    // ⚠ 只有 `001_schema` 里用了 `t.pk(T)` 的表才由数据库分配 id（见 autoPkTables 的注释）。
    const AUTO_PK = autoPkTables();
    const now = 1791385147125; // 与真库同量级：让 initLine 的数值也落在 bigint 范围里

    const nonSeed = tables.filter((t) => !SEED_TABLES.includes(t));
    for (const t of nonSeed) {
      const isFiller = t === "o_image";
      const n = isFiller ? ROWS : PER_TABLE;
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
      const pk = cols.filter((c) => c.pk > 0);
      const pkNames = new Set(pk.map((c) => c.name));
      const numeric = (decl) => /^(tinyint|smallint|mediumint|int|integer|bigint|unsigned big int|int2|int8|real|double|float|numeric|decimal)/i.test(String(decl || ""));
      // ⚠⚠ `autoPk` **必须**同时要求"单列主键、名叫 id、类型是整数族、且 `001_schema` 里用了 `t.pk(T)`"。
      //    少任何一条都会错判（实测踩过两次，详见 `autoPkTables()` 的注释）。
      const autoPk =
        pk.length === 1 &&
        /^id$/i.test(pk[0].name) &&
        numeric(pk[0].type) &&
        AUTO_PK.has(t);
      // ⚠ `key` 列要排除：`o_agentDeploy.key` 是复合唯一键的一部分，给每行同一个值更安全
      //    （顺序递增会让第二行撞唯一键）。其余非 id 的数值列用 1-based 行号。
      const shape = cols.map((c) => ({
        name: c.name,
        numeric: numeric(c.type),
        keepSequential: /Id$/.test(c.name) || c.name === "id",
      }));

      // ⚠ 主键列**必须**赋值，否则 `NOT NULL constraint failed: memories.id`（实测）：
      //    · 自增 `id` 跳过（交给 sqlite 的 rowid）；
      //    · **文本主键**（`memories.id`）与显式 id（`o_project.id`）必须显式给。
      const insertCols = shape.filter((c) => !(autoPk && /^id$/i.test(c.name))).map((c) => c.name);
      const sql = `INSERT INTO "${t}" (${insertCols.map((c) => `"${c}"`).join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`;
      const stmt = db.prepare(sql);
      const fill = db.transaction((count) => {
        for (let i = 1; i <= count; i += 1) {
          const row = insertCols.map((name) => {
            const c = shape.find((s) => s.name === name);
            // 文本主键：每行一个唯一字符串（`memories.id` 是 varchar 主键）
            if (pkNames.has(name) && !c.numeric) return `fixture-${t}-${i}`;
            if (/^id$/i.test(name) && !autoPk) return now + i; // o_project 这类显式 id
            if (c.numeric) return c.keepSequential ? i : c.name === "key" ? 1 : i;
            if (/^key$/i.test(name)) return t === "o_agentWorkData" ? "fixture" : `fixture${t}`;
            if (/^(type)$/i.test(name)) return `fixture_${i}`;
            if (/^(name|title)$/i.test(name)) return `${t}_${i}`;
            return `${t}.${name}#${i}`;
          });
          stmt.run(row);        }
      });
      fill(n);
    }

    const got = db.prepare(`SELECT COUNT(*) AS n FROM "o_image"`).get().n;
    if (got !== ROWS) throw new Error(`o_image 期望 ${ROWS} 行，实际 ${got}`);

    // ---- 目标库唯一键列**不许有重复**（用例里 `findDuplicates` 会断言为空；自造数据不能自己撞）----
    for (const [t, keys] of [
      ["o_agentWorkData", ["projectId", "episodesId", "key"]],
      ["o_segment", ["scriptId", "segmentIndex"]],
    ]) {
      const k = keys.map((c) => `"${c}"`).join(", ");
      const dup = db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT ${k} FROM "${t}" GROUP BY ${k} HAVING COUNT(*) > 1)`)
        .get().n;
      if (dup) throw new Error(`合成的 ${t} 有 ${dup} 组重复唯一键（自造数据自己撞了）`);
    }

    db.pragma("journal_mode = DELETE");
    db.prepare("VACUUM").run();
    console.log(`[devdb-fixture] 填充：o_image=${ROWS}；其余 ${nonSeed.length - 1} 张非种子表各 ${PER_TABLE} 行`);
  } finally {
    db.close();
  }

  // ---- 搬到位（目标存在性在上面已经检查过；这里再查一次，避免并发/竞态）----
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (fs.existsSync(OUT)) {
    console.error(`拒绝覆盖（搬运前复检）：${OUT}`);
    process.exit(1);
  }
  fs.copyFileSync(workDb, OUT + ".part");
  fs.renameSync(OUT + ".part", OUT);

  const sha = require("crypto").createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
  console.log(`[devdb-fixture] 已生成：${OUT}`);
  console.log(`[devdb-fixture] 27 张业务表；o_image 填充 ${ROWS} 行；其余非种子表各 3 行；四张种子表保持 002 的种子行 + 1 行身份键样本`);
  console.log(`[devdb-fixture] ${fs.statSync(OUT).size} 字节  sha256=${sha}`);
}

try {
  main();
} finally {
  cleanup();
}
