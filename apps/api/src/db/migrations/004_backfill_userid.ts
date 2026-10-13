/**
 * 004_backfill_userid —— 把 20 张租户表的 `userId` 按归属链回填，并把 `memories.isolationKey`
 * 改写成 socket/HTTP 两侧共用的新格式（spec §6.2 / §14 R5；Phase 1b Task 6）。
 *
 * ⚠ 迁移里**不允许** `--assign-to`：孤儿归给谁必须由操作者显式决定（手工跑
 *   `node --import=tsx scripts/backfill-userid.ts --apply --assign-to=<id>`），
 *   自动迁移只做"能推出来的部分"。
 * ⚠ 用传进来的 `trx`（knex 把迁移包在事务里），不要用外层 db（Phase 1a 的实测教训：
 *   `up` 里用外层 db 执行 DDL 会与迁移事务争抢连接/库锁，直接失败）。
 * ⚠ `up` 里跑一次自检断言（`assertBackfillConsistent`）：它只对**不变式**发火
 *   （"该填没填"的算术不符 / 已写库但 `memories` 键首段仍与 `userId` 不符）。
 *   孤儿留 NULL 是**预期**的，不算违规 —— 所以本迁移在真实库上不会因为孤儿而失败。
 * ⚠ 运维前置：**先备份**（拷到仓库外，见 `apps/api/README-db.md`）。
 */
import type { Knex } from "knex";
import { assertBackfillConsistent, backfillUserIds, formatBackfillReport } from "@/db/legacy/backfill-userid";

export default {
  name: "004_backfill_userid",

  async up(knex: Knex): Promise<void> {
    const report = await backfillUserIds(knex, { apply: true });
    // 迁移里只打日志（与 Phase 1a 的 003 同一取舍：运维扫一眼日志就够，不建"报告表"）
    console.log(`[migrate] 004_backfill_userid:\n${formatBackfillReport(report)}`);
    assertBackfillConsistent(report);
  },

  async down(): Promise<void> {
    // **不回滚数据**，三条理由：
    //  · 回填是"给已有行补归属"，不是新增事实；置回 NULL 只会让所有行对任何租户都不可见（fail-closed）
    //  · `memories.isolationKey` 的前缀已被改写，凭空无法还原成"当时的形状"
    //  · 真要回退，走 001_schema.down（删列/删表），那是 Phase 1a 的 down 路径
    // 与 Phase 1a 的 003（只报告不写盘、down 为 no-op）同一取舍。
  },
};
