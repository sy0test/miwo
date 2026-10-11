/**
 * 显式生成 src/types/database.d.ts（原为启动期 dev 分支的副作用）。
 * 用法：node --env-file-if-exists=.env --import=tsx scripts/gen-db-types.ts
 *
 * ⚠ 两处与"直接 import ../src/utils/db"不同的必需细节（Task 9 实测）：
 *  1) 必须先 import `../src/utils`：`utils.ts` 的 `export default { db, ... }` 是在**求值时**捕获
 *     `@/utils/db` 的默认导出的，而 `db.ts` → `fixDB.ts` → `utils.ts` 是循环导入。若让 db.ts 当入口，
 *     它的求值会在 fixDB 的 import 处被打断，于是 utils 捕获到 `db: undefined`，
 *     `fixDB` 一调用就抛 `TypeError: import_utils.default.db is not a function`（实测原文）。
 *     先 import utils（= app.ts 的装配顺序 utils → db → fixDB）就没有这个问题。
 *  2) 末尾必须 `process.exit(0)`：utils 的依赖图上有常驻句柄（定时器/连接池），不显式退出进程会挂住。
 */
process.env.MIWO_GEN_DB_TYPES = "1";

async function main() {
  // 导入 utils 会级联导入 db.ts，从而触发 initKnexType（受 MIWO_GEN_DB_TYPES 控制）
  await import("../src/utils");
  // 给 initKnexType 的异步写盘留出时间
  await new Promise((r) => setTimeout(r, 2000));
  console.log("database.d.ts 生成流程已触发");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
