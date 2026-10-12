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
 *    白名单只取平台键，本文件末尾还有一条显式断言兜住它。于是"新库里没有 tokenKey"是**预期状态**：
 *    应用侧的 JWT 密钥取自配置（`MIWO_JWT_SECRET`），见 `src/app.ts` 鉴权中间件。
 */
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

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

function readNdjson<T = Record<string, unknown>>(file: string): T[] {
  const p = path.join(seedDir(), file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch (e) {
        throw new Error(`[seed] ${file}:${i + 1} 不是合法 JSON（文件被截断了？）：${(e as Error).message}`);
      }
    });
}

/** 只 pick 目标表真实存在的列（导出的行可能带源库特有的列，例如 o_agentDeploy 的 id 顺序）。 */
function pickColumns(row: Record<string, unknown>, cols: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k)));
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

    // ---- o_prompt（4 条：事件提取 / 剧本资产提取 / 视频提示词生成 / 音色绑定）----
    {
      const cols = await columnsOf("o_prompt");
      const rows = readNdjson("o_prompt.ndjson").map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_prompt", rows, (r) => ({ type: r.type }));
      console.log(`[seed] o_prompt: 插入 ${n} / 共 ${rows.length}`);
    }

    // ---- o_agentDeploy（19 行：4 个基行 + 13 个高级子键 + 2 个转绘行）----
    {
      const cols = await columnsOf("o_agentDeploy");
      const rows = readNdjson("o_agentDeploy.ndjson").map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_agentDeploy", rows, (r) => ({ key: r.key }));
      console.log(`[seed] o_agentDeploy: 插入 ${n} / 共 ${rows.length}`);
    }

    // ---- o_setting（只平台键；dev 库里实测 4 个：shotsEngine / switchAiDevTool / modelOnnxFile / modelDtype。
    //      `shotsAutoRepair` 在 dev 库里**不存在**，所以不在导出物里 —— 与"未设置 = 默认关"同义）----
    {
      const rows = readNdjson("o_setting.platform.ndjson");
      const n = await seedTable(knex, "o_setting", rows, (r) => ({ key: r.key }));
      console.log(`[seed] o_setting: 插入 ${n} / 共 ${rows.length}`);
      // 显式断言：tokenKey 绝不进新库（Phase 1c 会把它彻底移出 DB，spec §6.2）
      const hasTokenKey = await knex("o_setting").where("key", "tokenKey").first();
      if (hasTokenKey) throw new Error("[seed] o_setting 里出现了 tokenKey：本阶段不允许把 JWT 密钥放进数据库");
    }

    // ---- o_vendorConfig（8 个空模板行；带凭据的源库行绝不导出）----
    {
      const cols = await columnsOf("o_vendorConfig");
      const rows = readNdjson("o_vendorConfig.templates.ndjson").map((r) => pickColumns(r, cols));
      const n = await seedTable(knex, "o_vendorConfig", rows, (r) => ({ id: r.id }));
      console.log(`[seed] o_vendorConfig: 插入 ${n} / 共 ${rows.length}`);
    }
  },

  async down(knex: Knex): Promise<void> {
    // 只删本迁移会插入的那些平台行；**不动**运行期新增的行
    const prompts = readNdjson<{ type: string }>("o_prompt.ndjson").map((r) => r.type);
    const deploys = readNdjson<{ key: string }>("o_agentDeploy.ndjson").map((r) => r.key);
    const settings = readNdjson<{ key: string }>("o_setting.platform.ndjson").map((r) => r.key);
    const vendors = readNdjson<{ id: string }>("o_vendorConfig.templates.ndjson").map((r) => r.id);
    if (await knex.schema.hasTable("o_prompt")) await knex("o_prompt").whereIn("type", prompts).del();
    if (await knex.schema.hasTable("o_agentDeploy")) await knex("o_agentDeploy").whereIn("key", deploys).del();
    if (await knex.schema.hasTable("o_setting")) await knex("o_setting").whereIn("key", settings).del();
    if (await knex.schema.hasTable("o_vendorConfig")) await knex("o_vendorConfig").whereIn("id", vendors).del();
  },
};
