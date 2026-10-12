/**
 * ⚠ 临时脚手架（Phase 1a / Task 4）：`apps/api/scripts/verify-phase0.cjs` 在一次性空库上
 *    **先迁移、再种入最小 `o_setting` 行**，否则验收打不到任何接口。删除条件见下。
 *
 * ── 为什么需要它 ──
 * 本 Task 起，应用启动走**迁移**（`001_schema`），而全新库里**没有任何种子数据**。
 * `apps/api/src/app.ts` 的鉴权中间件要求 `o_setting` 里存在 `tokenKey`，否则**每个**请求都返回 444
 * （连只读的 `configHealth?summary=1` 都被挡在白名单之前）。
 * `initDB.ts` 的 `initData` 原来负责种这些行，但它已不在启动路径上（Task 4 摘除），
 * 正式的接替者是种子迁移 **`002_platform_seed`（Task 5 产出）**。
 *
 * ── 删除条件（Task 5 落地后） ──
 * `002_platform_seed` 进入 `MIGRATIONS` 后，`db:migrate` 自己就会种下 `tokenKey`，
 * 于是 `verify-phase0.cjs` 里对本文件的调用可以连同本文件一起删掉（**它不在任何产品路径上**）。
 *
 * ── 用法（verify-phase0.cjs 自动调用）──
 *   node --import=tsx scripts/verify-phase0-seed-min.ts     # cwd 必须是 apps/api
 *
 * ⚠ 幂等（`onConflict().ignore()`），只碰下面这两行，绝不清表、绝不改别的数据。
 */
import crypto from "node:crypto";
import { createKnex, describeTarget } from "@/db/connect";

async function main(): Promise<void> {
  const db = createKnex();
  try {
    console.log(`[seed-min] target: ${describeTarget()}`);
    const rows = [
      { key: "tokenKey", value: crypto.randomUUID().slice(0, 8) },
      // 与 initDB 的种子同口径：新库显式 v2（"未设置" = legacy，会让结构化分镜写入被拒）
      { key: "shotsEngine", value: "v2" },
    ];
    for (const row of rows) {
      await db("o_setting").insert(row).onConflict("key").ignore();
    }
    const after = await db("o_setting").select("key", "value").whereIn("key", ["tokenKey", "shotsEngine"]);
    console.log(`[seed-min] o_setting now: ${JSON.stringify(after)}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[seed-min] failed:", err);
  process.exit(1);
});
