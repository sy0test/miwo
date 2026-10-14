/**
 * worker 进程入口（spec §4.1：api 与 worker 共用同一镜像、不同启动命令）。
 *
 * ⚠ 本文件必须被 esbuild 打成 `data/serve/worker.js`（Task 5），systemd/容器都指向它。
 * ⚠ 本仓库是 CJS：**不能有顶层 await** —— 一切包在 main() 里（Phase 1a Ruling 21）。
 *
 * ── 与 brief 的两处偏离（都按**实际导出**写，登记在 groupB-report.md）──
 *  1. brief 写 `import { db } from "@/utils/db"` —— 该模块**没有**命名导出 `db`（Phase 1c 已删，
 *     只剩默认导出的**受守卫** handle 与显式的 `systemDb`）。写命名 `{ db }` 会当场撞
 *     `tools/check-tenant-exceptions.cjs` 的 `BARE_DB_IMPORT_RE`（"谁再写回来当场红"）。
 *     这里按 `src/jobs/index.ts` 的既有写法：`import u from "@/utils"` 拿受守卫的 `u.db`。
 *     **不需要** `systemDb`：队列自身的特权写由 `src/jobs/store.ts` 内部的 `runAsAuth()` 统一代行。
 *  2. brief 的 `hasTable("o_job")` 探针是"Phase 1a 没导出就绪信号"时的兜底。实际有显式信号：
 *     `@/utils/db` 导出 `dbReady`（连接 → 迁移），所以这里 **await dbReady**，再用 hasTable 复核
 *     （探针的坑照 brief 的警告：`hasTable` 返回可 await 的 QueryBuilder，**必须 await**）。
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { config } from "@/config";
import u, { dbReady } from "@/utils";
import { jobRegistry } from "@/jobs/registry";
import { JOB_POLICY } from "@/jobs/policy";
import { createJobStore } from "@/jobs/store";
import { startWorkerLoop } from "@/jobs/worker";

async function main(): Promise<void> {
  // 1) 等 Phase 1a 的启动序列完成（连接 → 迁移 → 可用）。
  await dbReady;
  const db = u.db as unknown as Knex;
  for (let i = 0; i < 60; i += 1) {
    // ⚠ 必须 await hasTable：它返回的是恒真的 QueryBuilder。
    if (await db.schema.hasTable("o_job")) break;
    if (i === 59) throw new Error("[worker] 等待数据库就绪超时（o_job 表不存在）");
    await new Promise((r) => setTimeout(r, 500));
  }

  const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const store = createJobStore({ db, registry: jobRegistry });
  const runner = startWorkerLoop({ store, registry: jobRegistry, workerId });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] 收到 ${signal}，优雅停机中（最多 ${JOB_POLICY.shutdownGraceMs}ms）…`);
    await runner.stop();
    console.log("[worker] 已停机");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => {
    // 这里**只记日志不退出**是有意的：与 api 的 err.ts 现状一致（改成优雅退出属 Phase 1c Tier 1 #16）。
    // 但必须让它可见 —— worker"看起来在跑、实际半残"是最难查的形态。
    console.error("[worker] 未处理的 Promise 拒绝：", e);
  });

  console.log(`[worker] 已启动 workerId=${workerId} env=${config.env} 并发上限=${JOB_POLICY.globalMaxRunning} 租约=${JOB_POLICY.leaseMs}ms`);
  await runner.done;
}

main().catch((e) => {
  console.error("[worker] 启动失败：", e);
  process.exit(1);
});
