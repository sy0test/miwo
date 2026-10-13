/**
 * 门禁（Ruling 233 / Lead 审查 ④）：**迁移链的运行期闭包**里不得出现启动链模块。
 *
 * 为什么不是一个 in-process 的 `require.cache` 断言（Lead 原本的配方）：
 *   **实测** vitest 的模块运行器**不填** `require.cache` —— 在测试进程里
 *   `await import("@/db/migrations/index")` 之后，缓存里既没有 `migrations/index.ts` 也没有
 *   `backfill-userid.ts`（`CACHE_KEYS=12`、`HAS_MIG=0`，只有 debug/supports-color 这类无关 Node CJS 依赖）。
 *   拿它当判据是**恒真**的假绿 —— 所以改为 spawn 一个**真 CJS/tsx 进程**跑
 *   `scripts/check-migration-import-graph.ts`（那个脚本自己还会先断言"闭包确实被观测到了"，
 *   观测不到就 exit 3，绝不放过）。
 *
 * 为什么需要它：`connect.ts` → `migrations/index.ts` 在**启动链**上；一旦哪个 legacy/迁移模块
 * 顺手 `import` 了 `@/utils`/`@/utils/db`/`@/db/connect`，就会构成加载期循环
 * （实测 `TypeError: createKnex is not a function`）或让 `db:migrate` 触发启动 IIFE 的嵌套迁移。
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");

describe("迁移链的 import 图（门禁）", () => {
  it("迁移链的运行期闭包里没有 @/utils / @/utils/db / @/db/connect，且没有启动日志", () => {
    const r = spawnSync(process.execPath, ["--import=tsx", path.join("scripts", "check-migration-import-graph.ts")], {
      cwd: API_ROOT,
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out, `check-migration-import-graph 输出异常：${out}`).toMatch(/import_graph=/);
    expect(r.status, `迁移链闭包不干净（exit ${r.status}）：\n${out}`).toBe(0);
    expect(out).toMatch(/import_graph=CLEAN/);
  }, 200000);
});
