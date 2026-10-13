/**
 * 租户隔离键的**纯格式实现**（spec §6.2 / §10.2 Tier 0 #12）：
 * `${userId}:${projectId}:${agentType}[:episodesId]`。
 *
 * ⚠ 为什么它在这里、而不是在 `@/socket/tenant`（Task 6 实测的**结构性**原因，Lead 已授权搬移）：
 *   `db/migrations/004_backfill_userid.ts` 会被**启动链**加载（`connect.ts` → `migrations/index.ts`
 *   → `004`），而 `@/socket/tenant` 顶层 `import u from "@/utils"` → `@/utils/db` → `@/db/connect`
 *   —— 从迁移链 import 它就构成**加载期循环**，实测症状：
 *     · `TypeError: createKnex is not a function`（`utils/db.ts:26` 在 `connect.ts` 执行到函数声明之前调它）；
 *     · `@/utils` 的 default 对象里 `db` 变成 `undefined`；
 *     · `tests/backfill-userid.test.ts` **收集阶段即崩**，`db:migrate` / 应用启动同理。
 *   本模块**只依赖类型**（不 import `@/utils`、不 import 启动链）⇒ 迁移/回填链依赖它是安全的。
 *   `@/socket/tenant` 把这两个函数**再导出**（re-export），所以对外接口与行为一字不变。
 *
 * **唯一真相就在这里**：socket 侧、HTTP 侧（`getMemory`/`clearMemory`/`delProject`）、回填侧
 * 全部走这一份实现；谁想改键格式，只改这一处。
 */
import type { TenantCtx } from "@/db/tenant-context";

/**
 * 集号取值：**按值判定**，不是 `??`。
 * 前端在"还没选集"时会发 `-1` / `0` / `undefined`（`apps/web/src/stores/productionAgent.ts:44-48`），
 * `??` 拦不住 `-1` —— 那会拼出一个带 `:-1` 的键，与 HTTP 侧的键静默错开。
 * 规则：**正整数才采用**，其余一律当作"没有集号"。
 */
export function pickEpisodesId(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** spec §6.2 / §10.2 #12 的键格式：`${userId}:${projectId}:${agentType}[:episodesId]`。 */
export function buildIsolationKey(ctx: Pick<TenantCtx, "userId">, projectId: number, agentType: string, episodesId?: number | null): string {
  const ep = pickEpisodesId(episodesId);
  return [ctx.userId, projectId, agentType, ...(ep ? [ep] : [])].join(":");
}
