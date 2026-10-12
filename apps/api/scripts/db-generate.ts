/**
 * 生成一条新迁移的骨架，强制命名约定（spec §5.2）。
 * 用法：pnpm.cmd run db:generate -- <kebab-case-描述>
 *   例：pnpm.cmd run db:generate -- add-job-table
 *      → apps/api/src/db/migrations/002_add-job-table.ts
 *
 * 约定：
 *   - 文件名 `<三位序号>_<kebab-case>.ts`，序号 = 当前最大序号 + 1
 *   - `name` 字段必须与文件名（去扩展名）**逐字相同**，否则 `knex_migrations` 里会出现两个名字
 *   - 骨架里预置 `up`/`down` 与一段"必须有 down"的注释
 *   - 生成后必须手工把新迁移 import 进 `src/db/migrations/index.ts` 的 `MIGRATIONS` 数组
 */
import fs from "fs";
import path from "path";

const DIR = path.resolve(__dirname, "..", "src", "db", "migrations");
const desc = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
if (!desc || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(desc)) {
  console.error("用法：pnpm.cmd run db:generate -- <kebab-case-描述>（例：add-job-table）");
  process.exit(1);
}
const existing = fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.ts$/.test(f)).sort();
const next = String((existing.length ? Number(existing[existing.length - 1].slice(0, 3)) : 0) + 1).padStart(3, "0");
const name = `${next}_${desc}`;
const file = path.join(DIR, `${name}.ts`);
if (fs.existsSync(file)) {
  console.error(`已存在：${file}`);
  process.exit(1);
}
fs.writeFileSync(
  file,
  `import type { Knex } from "knex";
import { types } from "@/db/dialect";

export default {
  name: "${name}",
  async up(knex: Knex): Promise<void> {
    const t = types(knex);
    void t;
    // TODO: 写变更。规矩（spec §5.2）：
    //   1. 幂等：用 knex.schema.hasTable / hasColumn 守卫，重复执行不报错
    //   2. 成对：down 必须能把自己 up 出来的东西精确撤掉
    //   3. 种子只插不改：insert 前先查存在性，**绝不覆盖已有行**
    //   4. 不要在 up/down 里读 app 的其它模块（迁移必须能在最小依赖下跑）
  },
  async down(knex: Knex): Promise<void> {
    void knex;
    // TODO: 精确撤销 up
  },
};
`,
  "utf8",
);
console.log(`已生成 ${path.relative(path.resolve(__dirname, ".."), file)}`);
console.log(`⚠ 别忘了把它 import 进 src/db/migrations/index.ts 的 MIGRATIONS 数组。`);
