/**
 * 002_platform_seed —— 平台级种子数据（spec §5.2 ④）。
 *
 * **唯一的纪律：只插不改（insert-if-absent）。** 绝不 UPDATE 已有行 ——
 * 这是 spec §5.2 ③ 点名要修掉的行为（旧 fixDB 每次启动覆写 o_prompt 全文，
 * 把运营改过的提示词冲掉）。
 *
 * 种子的来源是 `seed/*.ndjson`（由 `scripts/dump-platform-seed.cjs` 从 dev 库导出）。
 * 用 NDJSON 而不是内联字符串的原因：`o_prompt.data` 单行 20,982 字符，
 * 内联进 .ts 有被编辑器/计划文档截断的真实风险（Phase 0 的 fixDB.ts:239 就在计划里被截断过）。
 *
 * ⚠ **不 seed `o_setting.tokenKey`**（Phase 1c 会把它彻底移出 DB，spec §6.2）。导出脚本按
 *    白名单只取平台键，本文件 o_setting 段末尾还有一条显式断言兜住它。于是"**全新库**里没有
 *    tokenKey"是**预期状态**：应用侧的 JWT 密钥取自配置（`MIWO_JWT_SECRET`），见 `src/app.ts` 鉴权中间件。
 *
 * ⚠⚠ **【Phase 1c 裁定 1c-26】旧库里的 `tokenKey` 行不再让本迁移炸，而是被改名成 `jwtSecret`。**
 *    改前的行为是"只要 `o_setting` 里出现 `tokenKey` 就抛错"，而 `005_accounts` 才删它 —
 *    于是**真实升级路径在 002 就断了**（002 在 005 之前跑，鸡生蛋问题）：
 *    老库/用户真实库里本来就有 `o_setting.tokenKey`（`lib/initDB.ts` 时代的 JWT 密钥行）。
 *    改动依据：**用户真实库从未跑过任何迁移（没有 `knex_migrations` 表）⇒ 002 对该库尚未"发布"**
 *    （knex 按**文件名**记账，改内容不会让已迁移的库重跑）⇒ 现在改它是安全的窗口期。
 *    改法：`INSERT ... SELECT` 式的"改名"（旧键值搬进新键 `jwtSecret`，再删旧键）——
 *      · 语义不变：`src/auth/secret.ts` 的解析顺序本来就认 `jwtSecret` → `tokenKey` → 配置，
 *        改名后**同一把密钥**仍在库里，老令牌继续有效（不会因为一次升级把所有人踢下线）；
 *      · 仍然**只插不改**：目标键已存在时**跳过**（先喊一声），绝不覆盖运维显式设过的 `jwtSecret`；
 *      · 幂等：跑第二遍时 `tokenKey` 已不存在 ⇒ 什么都不做；
 *      · 全新库：没有 `tokenKey` ⇒ 不产生 `jwtSecret` 行 ⇒
 *        `verify-phase0.cjs` 的"o_setting 键集合恰好 = 种子键 + Task 1 两个开关"逐字不变。
 *    ⚠ 别把这条"搬"回 `005_accounts`：005 只能删 `tokenKey`，它管不到 002 之前的库状态。
 */
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { sqldialect, type Dialect } from "@/db/dialect";

/**
 * 种子目录的候选路径。
 *
 * ⚠ 为什么需要候选列表：`seed/*.ndjson` 是**运行时用 readFileSync 读的文件**，不是 `import`，
 *    所以 esbuild 打包 `data/serve/app.js` 时**不会**把它内联进产物（本计划编写时验证过这个前提：
 *    `apps/api/scripts/build.ts` 的 entryPoints 只有 `src/app.ts`，没有 asset/copy 配置）。
 *    于是 prod 必须让这个目录在某个候选位置存在，否则就是"只在 prod 才炸"的路径。
 *    → dev（tsx 直跑源码）：命中第 1 个
 *    → prod（cwd = apps/api）：命中第 2 个
 *    → 若将来构建脚本把 seed 拷到产物旁：命中第 3 个
 *    一个都找不到时**抛错**（绝不能静默地"seed 0 行"）。
 */
const SEED_DIR_CANDIDATES = [
  path.join(__dirname, "seed"),
  path.join(process.cwd(), "src", "db", "migrations", "seed"),
  path.join(process.cwd(), "data", "serve", "migrations", "seed"),
];

let seedDirCache: string | null = null;
function seedDir(): string {
  if (seedDirCache) return seedDirCache;
  for (const c of SEED_DIR_CANDIDATES) if (fs.existsSync(c)) { seedDirCache = c; return c; }
  throw new Error(
    `[seed] 找不到种子目录，尝试过：\n  ${SEED_DIR_CANDIDATES.join("\n  ")}\n` +
      `处置：dev 从 apps/api 下跑；prod 确保 seed/ 与产物同级或被拷到 data/serve/migrations/seed/。`,
  );
}

/**
 * 四份种子文件**全部必需**（Task 5 独立审查修复 1）。
 *
 * ⚠ 为什么缺失/空文件必须**抛错**而不是"返回空数组"：原来的 `if (!fs.existsSync(p)) return []`
 *    让"单个文件漏拷 / 被清空 / 被截断成 0 行"表现为 `插入 0 / 共 0` 的**静默通过** —— 迁移记入
 *    `knex_migrations`、服务照常起来、只是平台提示词/Agent 行全没了。这正是 Phase 0 最担心的
 *    `o_prompt` 漏拷通道（`fixDB.ts:239` 曾在计划文档里被截断过）。**不得**改回"缺失即空"。
 */
const SEED_FILES = ["o_prompt.ndjson", "o_agentDeploy.ndjson", "o_setting.platform.ndjson", "o_vendorConfig.templates.ndjson"] as const;

function readNdjson<T = Record<string, unknown>>(file: string): T[] {
  const p = path.join(seedDir(), file);
  if (!fs.existsSync(p)) {
    throw new Error(
      `[seed] 种子文件缺失：${file}（在 ${seedDir()} 里）。四份种子全部必需：${SEED_FILES.join(" / ")}。` +
        `处置：从仓库重新取回该文件（git restore），或重跑 scripts/dump-platform-seed.cjs 导出。`,
    );
  }
  const lines = fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(
      `[seed] 种子文件为空（0 行）：${file}（${p}）。"0 行 = 种 0 行"必须响亮失败，` +
        `否则新库里该表整表缺失却会被记成"迁移成功"。`,
    );
  }
  return lines.map((l, i) => {
    try {
      return JSON.parse(l) as T;
    } catch (e) {
      throw new Error(`[seed] ${file}:${i + 1} 不是合法 JSON（文件被截断了？）：${(e as Error).message}`);
    }
  });
}

/**
 * 下行删除的**行形状**（Task 5 独立审查修复 3；合并审查修复 1 加固了比较口径）。
 *
 * ⚠ 为什么 down **不能**按身份键（`type` / `key` / `id`）删：Task 6 会先把老库数据导进来，
 *    若老库/运营已经写入了**同键但不同内容**的行，002 的 `up` 会跳过它们（只插不改），
 *    而按键删的 `down` 会把**不是 002 插的**那些行删掉 —— 回滚就不是"撤销本迁移"，
 *    而是"删用户数据"。改成"种子行的全部列**逐列精确相等**"判定后，down 只可能删掉
 *    "仍是本仓库种子那一行"的记录（**不是**"逐字节相同"这么强的说法：见下面 `whereExact`
 *    列出的两条表示层语义 —— 数值列走数值比较、`BINARY` 只保证文本列按字节比）。
 *    代价：运营改过的种子行在 down 时**保留**（rollback 后重跑 002 也不会再插回它，
 *    因为 `seedTable` 的身份键判定仍认为它存在）—— 这是**有意偏保守**：
 *    "少删一行"可以人工补回，"多删一行运营数据"不可恢复。
 *
 * ⚠ 只对**目标表真实存在的列**做全等判定（用 up 插入时 pick 出来的同一条行），
 *    否则列名对不上会变成 `no such column`。
 */
function pickColumns(row: Record<string, unknown>, cols: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k, v]) => cols.has(k) && v !== undefined));
}

/**
 * 单列的"**精确**相等"谓词（合并审查修复 1）。
 *
 * ⚠ 为什么不能直接用 `knex(table).where(row)`：MySQL 服务端 collation 是
 *    **`utf8mb4_0900_ai_ci`**（`ai` = accent-insensitive，`ci` = **case-insensitive**），
 *    于是 SQL `=` 是**大小写不敏感**的：实测（真 MySQL 8.4.11）`'EVENTEXTRACTION' = 'eventExtraction'`
 *    为真。后果是一条**真实的数据丢失路径**：运营/老库把某个种子行只改了大小写（或只改了声调符号），
 *    旧 `down` 就会把它当成 002 插的行**删掉**。所以判据必须与 collation 无关：
 *      · mysql：`BINARY ?? = ?` —— 两侧都按**字节**比；
 *      · sqlite：`?? COLLATE BINARY = ?` —— 显式指定 BINARY，不依赖列的默认 collation
 *        （本仓库 `001_schema` 里没有任何列声明 `COLLATE NOCASE`，但判据不该依赖这一点）。
 *    ⚠ 两条**不是**"逐字节相同"的说法（README 与本文件的旧措辞已改正）：
 *      ① 非文本列走的是**数值**比较（`BINARY intcol = 4` 在 MySQL 里仍是数值相等）；
 *      ② 尾随空格：实测在 `utf8mb4_0900_ai_ci` 的列上 `t = 'a'` **不**匹配 `'a '`（0900 系列是 NO PAD）——
 *         即"只加一个尾随空格"的行在**旧判据下本来就会存活**，那是 collation 的副作用而不是设计；
 *         加固后它是**显式**的（`BINARY` 让大小写与尾随空格都参与比较）。
 *         ⚠ 反例口径别搞混：两个**字面量** `'a ' = 'a'` 在本机返回 1，因为那走的是**连接** collation
 *         （本机 mysql CLI 是 `gbk_chinese_ci`，PAD SPACE）而不是列的 collation —— "列 vs 绑定值"
 *         才是 `down` 的实际形状。（实测原文见合并审查修复轮报告。）
 *    方向不变：**少删一行**（可人工补回）优于**多删一行运营数据**（不可恢复）。
 *
 * ⚠ 没有任何字符串插值进 SQL：`??` 是 knex 的**标识符**占位符（列名来自 `columnInfo()` 的
 *    真实列名或种子文件的键），值一律走 `?` 绑定参数。
 */
function whereExact(qb: Knex.QueryBuilder, col: string, value: unknown, dialect: Dialect): Knex.QueryBuilder {
  if (value === undefined || value === null) return qb.whereNull(col);
  const v = value as Knex.Value;
  return dialect === "mysql" ? qb.whereRaw("BINARY ?? = ?", [col, v]) : qb.whereRaw("?? COLLATE BINARY = ?", [col, v]);
}

/** 按主键列判断"是否已存在"，只插不存在的。返回插入的行数。 */
async function seedTable(
  trx: Knex,
  table: string,
  rows: Array<Record<string, unknown>>,
  keyOf: (r: Record<string, unknown>) => Record<string, unknown>,
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const where = keyOf(row);
    const exists = await trx(table).where(where).first();
    if (exists) continue;
    await trx(table).insert(row);
    inserted += 1;
  }
  return inserted;
}

export default {
  name: "002_platform_seed",

  async up(knex: Knex): Promise<void> {
    const columnsOf = async (table: string): Promise<Set<string>> => {
      const info = (await knex(table).columnInfo()) as Record<string, unknown>;
      return new Set(Object.keys(info));
    };

    // ---- 前置闸门：四份种子**先全部读进来**，任何一份缺失/为空/JSON 坏都在**写库之前**抛错 ----
    // ⚠ 为什么要在开头就全读一遍（Task 5 独立审查修复 1 的加强）：四张表的插入是**分开执行**的，
    //    若把读文件放在各段里，`o_vendorConfig.ndjson` 缺失时前 3 张表**已经插好了**才抛错 ——
    //    留一个"半迁移"的库（knex 的 `migrations.disableTransactions` 未开时不会被回滚）。
    //    先读后写让"缺文件"变成**干净的 fail-fast**：库要么没动，要么插满。
    const seedRows = {
      prompt: readNdjson("o_prompt.ndjson"),
      agent: readNdjson("o_agentDeploy.ndjson"),
      setting: readNdjson("o_setting.platform.ndjson"),
      vendor: readNdjson("o_vendorConfig.templates.ndjson"),
    };

    // ---- o_prompt（4 条：事件提取 / 剧本资产提取 / 视频提示词生成 / 音色绑定）----
    {
      const cols = await columnsOf("o_prompt");
      const rows = seedRows.prompt.map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_prompt", rows, (r) => ({ type: r.type }));
      console.log(`[seed] o_prompt: 插入 ${n} / 共 ${rows.length}`);
    }

    // ---- o_agentDeploy（19 行：4 个基行 + 13 个高级子键 + 2 个转绘行）----
    {
      const cols = await columnsOf("o_agentDeploy");
      const rows = seedRows.agent.map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_agentDeploy", rows, (r) => ({ key: r.key }));
      console.log(`[seed] o_agentDeploy: 插入 ${n} / 共 ${rows.length}`);
    }

    // ---- o_setting（只平台键；dev 库里实测 4 个：shotsEngine / switchAiDevTool / modelOnnxFile / modelDtype。
    //      `shotsAutoRepair` 在 dev 库里**不存在**，所以不在导出物里 —— 与"未设置 = 默认关"同义）----
    {
      // ⚠ 这里同样要过 `pickColumns`（Task 5 独立审查修复 3）：另三张表都走的这条口径，
      //    o_setting 原先直接插导出原行 → 源库该表**多一列**（哪怕只是别的部署加的列）
      //    就会在 insert 时报 `no such column`。四张表一律"只 pick 目标表真实存在的列"。
      const cols = await columnsOf("o_setting");
      const rows = seedRows.setting.map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_setting", rows, (r) => ({ key: r.key }));
      console.log(`[seed] o_setting: 插入 ${n} / 共 ${rows.length}`);

      // ---- 【裁定 1c-26】旧库里的 `tokenKey` 行：**改名**成 `jwtSecret`（而不是抛错）----
      // 判据与理由见文件头「裁定 1c-26」一节。三条不变式：
      //   ① 目标键已存在 ⇒ **不覆盖**（运维/更早的迁移设过的值优先），只报告；
      //   ② 旧键不存在 ⇒ 完全不动（全新库 = 本条的常态，键集合不因此多一行）；
      //   ③ 幂等：第二遍时旧键已经没了。
      const legacy = (await knex("o_setting").where("key", "tokenKey").select("value").first()) as { value: string | null } | undefined;
      if (legacy) {
        const already = await knex("o_setting").where("key", "jwtSecret").first();
        if (already) {
          console.log("[seed] o_setting.tokenKey 存在，但 jwtSecret 已存在 → **不覆盖**，仅删除旧键（裁定 1c-26）");
          await knex("o_setting").where("key", "tokenKey").delete();
        } else {
          await knex("o_setting").insert({ key: "jwtSecret", value: legacy.value });
          await knex("o_setting").where("key", "tokenKey").delete();
          console.log("[seed] o_setting.tokenKey → jwtSecret（旧库升级：同一把密钥换到新键，老令牌继续有效；裁定 1c-26）");
        }
      }
      // 显式断言：**种子文件**不得把 tokenKey 种进来（"旧库里有它"是唯一允许的来源，
      // 且上面那一段一定会把它改名走）。所以迁移结束时库里**不应再有** tokenKey。
      const hasTokenKey = await knex("o_setting").where("key", "tokenKey").first();
      if (hasTokenKey) throw new Error("[seed] o_setting 里出现了 tokenKey：本阶段不允许把 JWT 密钥留在旧键上");
    }

    // ---- o_vendorConfig（8 个空模板行；带凭据的源库行绝不导出）----
    {
      const cols = await columnsOf("o_vendorConfig");
      const rows = seedRows.vendor.map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_vendorConfig", rows, (r) => ({ id: r.id }));
      console.log(`[seed] o_vendorConfig: 插入 ${n} / 共 ${rows.length}`);
    }
  },

  async down(knex: Knex): Promise<void> {
    // ⚠ 【裁定 1c-26】`up` 把旧的 `o_setting.tokenKey` 改名成了 `jwtSecret`，`down` **不回改**：
    //    它不是本迁移"种进去的一行"（不满足下面那套"种子行逐列精确相等"的判据），
    //    而把它改回旧键等于把"JWT 密钥留在旧键上"这个状态又造出来 —— 与 `005_accounts` 的
    //    删除方向相反。**如实登记的取舍**：`001 → 002 → down` 之后库里会留下一行 `jwtSecret`，
    //    这是"升级过的库不会真正回到未升级形状"的一部分（up/down 的往返一致性由
    //    `tests/migrations.test.ts` 与 `tests/accounts-migration.test.ts` 分别覆盖，二者都以
    //    "全新库（本来就没有 tokenKey）"为起点，所以那条路径不受影响）。
    // 只删**本迁移插进去的那些行**：判据是"种子那一行的全部列都精确相等"（collation 无关，见 `whereExact`），
    // 而不是"身份键相同"。
    // ⚠ 详见 pickColumns() 上方的说明 —— 按身份键删会把 Task 6 导入的同键老数据一起删掉。
    // ⚠ **不能**退回 `knex(table).where(row).del()`：MySQL 的 `utf8mb4_0900_ai_ci` 下 SQL `=`
    //    大小写不敏感，会把"只改了大小写"的行误删（数据丢失路径，回归网见
    //    `tests/mysql-integration.test.ts` 的「down 不删只改了大小写的种子行」，那条只在真 MySQL 上才有判别力）。
    // ⚠ 表不存在 / 列不存在时**跳过**（down 必须能在"up 没跑完"的库上收尾，不能反过来炸）。
    const dialect = sqldialect(knex);
    const tables = ["o_prompt", "o_agentDeploy", "o_setting", "o_vendorConfig"] as const;
    const files = ["o_prompt.ndjson", "o_agentDeploy.ndjson", "o_setting.platform.ndjson", "o_vendorConfig.templates.ndjson"] as const;
    for (const [i, table] of tables.entries()) {
      if (!(await knex.schema.hasTable(table))) continue;
      const cols = new Set(Object.keys((await knex(table).columnInfo()) as Record<string, unknown>));
      const rows = readNdjson(files[i]).map((r) => pickColumns(r, cols));
      // 逐行一条 DELETE，条件是"种子行的每一列都精确相等"：只有真正由 002 插入且此后
      // **没被改过**（连大小写都没变）的行才会命中。一条 UPDATE 就让它落到"保留"一侧 ——
      // 这是本修复的安全方向。
      for (const row of rows) {
        if (Object.keys(row).length === 0) continue;
        let q = knex(table);
        for (const [col, value] of Object.entries(row)) q = whereExact(q, col, value, dialect);
        await q.del();
      }
    }
  },
};
