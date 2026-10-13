/**
 * 门禁：**迁移链的运行期闭包**里不得出现启动链模块（Ruling 233 / Task 6 加固）。
 *
 *   cd apps/api
 *   node --import=tsx scripts/check-migration-import-graph.ts      # exit 0 = 干净
 *
 * 为什么必须在**独立进程**里跑（别改成 vitest 内的 `require.cache` 断言）：
 * 实测 vitest 的模块运行器**不填** `require.cache` —— 在测试进程里 `await import("@/db/migrations/index")`
 * 之后，缓存里既没有 `migrations/index.ts` 也没有 `backfill-userid.ts`（`HAS_MIG=0`，只有 12 个
 * 无关的 Node CJS 依赖），拿它当判据是**恒真**的假绿。真 CJS/tsx 进程里缓存是**被填满**的，
 * 所以本脚本自己先断言"闭包确实被观测到了"（否则 exit 3），再断言里面没有启动链模块。
 *
 * ⚠ 判据是**运行期闭包**，不是源码正则：多行 import、动态 import、`require` 别名都逃不掉。
 * ⚠ 只 import 迁移链本身（`@/db/migrations/index`），**不** import 任何启动链模块 —— 否则自证循环。
 * ⚠ 顺带断言"没有启动日志"（`数据库文件:` / `已应用迁移`）：出现就说明有模块在 import 期碰了数据库。
 */
import type { Knex } from "knex";

/** 不许出现在迁移链闭包里的模块（相对仓库根的路径片段）。 */
const FORBIDDEN = [
  "src\\utils.ts",
  "src/utils.ts",
  "src\\utils\\db.ts",
  "src/utils/db.ts",
  "src\\db\\connect.ts",
  "src/db/connect.ts",
];

async function main(): Promise<void> {
  const cache: Record<string, unknown> = require.cache as any;
  const before = new Set(Object.keys(cache));
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => { logs.push(args.map((a) => String(a)).join(" ")); };
  try {
    await import("@/db/migrations/index");
  } finally {
    console.log = original;
  }
  const added = Object.keys(require.cache as any).filter((k) => !before.has(k));
  const closureHasMigrations = added.some((k) => /migrations[\\/]index\.ts$/.test(k));
  const closureHasBackfill = added.some((k) => /backfill-userid\.ts$/.test(k));
  if (!closureHasMigrations || !closureHasBackfill) {
    console.error(
      `[import-graph] 观测失败：闭包里没看到迁移模块（migrations/index=${closureHasMigrations}，backfill-userid=${closureHasBackfill}）` +
        ` —— 说明本脚本的"运行期闭包"判据在当前运行时下失效（会变成恒真假绿）。请修判据，别放过。`,
    );
    process.exit(3);
  }
  const forbiddenHits = added.filter((k) => FORBIDDEN.some((f) => k.endsWith(f)));
  const startupLogs = logs.filter((l) => /数据库文件:|已应用迁移|\[migrate\]/.test(l));
  const ok = forbiddenHits.length === 0 && startupLogs.length === 0;
  console.log(
    `[import-graph] 迁移链闭包 ${added.length} 个模块；启动链模块命中 ${forbiddenHits.length}；启动日志 ${startupLogs.length}`,
  );
  for (const h of forbiddenHits) console.log(`  ✗ 被拉进来：${h}`);
  for (const l of startupLogs) console.log(`  ✗ 启动日志：${l}`);
  console.log("import_graph=" + (ok ? "CLEAN" : "DIRTY"));
  process.exit(ok ? 0 : 1);
}

// `Knex` 这个 import 只是为了让本文件在 typecheck 下与其它脚本同形；不参与运行。
void (null as unknown as Knex);

main().catch((err) => {
  console.error("[import-graph] 失败：", err);
  process.exit(2);
});
