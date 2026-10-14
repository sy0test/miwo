/**
 * WebSocket 侧的租户上下文（spec §6.4 / §10.2 Tier 0 #9）。
 *
 * ⚠ 为什么必须 `bindSocketTenant`：**实测**（计划正文探针 A）
 *    「在 `als.run()` 内注册、之后才被 emit 触发的监听器，`getStore()` 是 `undefined`」。
 *    也就是说"连接时进过一次 run()"对后续的 `socket.on("chat", …)` **无效** ——
 *    必须在**注册时**把每个 handler 显式包进 `runWithTenant`。没有这一层，agent 链路会在第一次
 *    `u.db` 访问时抛 `TenantContextError`（响亮，但 `src/socket/**` + `src/agents/**` 的
 *    19 处 `u.db("o_…")` 全部拿不到 ctx ⇒ **AI 剧本/视频生成功能是死的**）。
 *
 * ⚠ 只包"**事件回调入口**"，**不要**再给回调内部的 timer/`await` 套一层：
 *    ALS 跟随 async 资源的**创建点**，`run()` 内创建的 await/timer 回调本来就带 ctx
 *    （Ruling 219/220 的实测口径；过度包裹只会增加复杂度）。
 *
 * ⚠ 归属校验：改造前 `isolationKey` / `projectId` 完全由客户端指定（spec §3.2 的决定性证据），
 *    本模块把它们改成"服务端从 token + 库里推导"。`buildIsolationKey` 就是**唯一**的键格式真相，
 *    HTTP 侧（`getMemory` / `clearMemory` / `delProject`）必须用同一个函数，否则读写键会静默错开。
 *
 * ⚠ 密钥优先级与 HTTP 中间件**逐字对齐**（Ruling 220 #3 的裁定）：库值优先、
 *    `config.jwtSecret` 兜底（`config.ts` 的模块级 fail-fast ⇒ 兜底恒非空）、都拿不到才拒连。
 *    Phase 1c Task 3 起这条链抽成 `@/auth/secret` 的 `resolveJwtSecret()`（**唯一实现**，
 *    HTTP 侧与这里共用；Task 1 把 `tokenKey` 行从 `o_setting` 删掉后新增了 `o_setting.jwtSecret`
 *    作为新位置，读取顺序见该文件头）。连接期读 `o_setting` 继续走 `u.db`
 *    （platform 表读**无 ctx 也放行**），**不**新增第 8 个 `systemDb` 使用者（Ruling 220 #4）。
 * ⚠ token 形状：新形状（`typ`/`tv`）与旧形状（`{id}`，Phase 1b 夹具在用）**都接受**
 *    —— 与 `@/middleware/auth` 的判据一致（理由见 `@/auth/tokens` 文件头限制 2）。
 */
import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import u from "@/utils";
import { resolveJwtSecret } from "@/auth/secret";
import { verifyLegacyToken, verifyToken } from "@/auth/tokens";
import { loadUserCtx } from "@/auth/service";
import { roleOfUserId } from "@/db/policies";
import { currentTenant, runWithTenant, type TenantCtx } from "@/db/tenant-context";

/** 连接期验签 → 租户 ctx（失败一律 `null`，调用方据此 `socket.disconnect()`）。 */
export async function decodeSocketToken(rawToken: unknown): Promise<TenantCtx | null> {
  const token = String(rawToken ?? "").replace("Bearer ", "").trim();
  if (!token) return null;
  let secret: string;
  try {
    secret = await resolveJwtSecret();
  } catch {
    return null; // 库还没就绪等异常：一律拒连，不把连接挂在半成品状态
  }
  try {
    const claims = verifyToken(token, "access", secret);
    const user = await loadUserCtx(claims.uid);
    if (!user || user.status !== "active" || user.tokenVersion !== claims.tv) return null;
    return { userId: user.id, role: user.role, requestId: randomUUID(), source: "socket" };
  } catch {
    const legacy = verifyLegacyToken(token, secret);
    if (!legacy) return null;
    return { userId: legacy.userId, role: roleOfUserId(legacy.userId), requestId: randomUUID(), source: "socket" };
  }
}

/** 把该 socket **之后注册**的每个事件 handler 都包进同一个 ctx（返回原 socket，便于链式写法）。 */
export function bindSocketTenant(socket: Socket, ctx: TenantCtx): Socket {
  const originalOn = socket.on.bind(socket);
  (socket as any).on = (event: string, handler: (...args: any[]) => any) => {
    originalOn(event, (...args: any[]) => runWithTenant(ctx, () => handler(...args)));
    return socket;
  };
  return socket;
}

/**
 * ⚠ 键格式（`pickEpisodesId` / `buildIsolationKey`）的**唯一真相**已搬到 `@/db/isolation-key`
 *   （Task 6 / Lead 授权）：这里只**再导出**，对外接口与行为一字不变。
 *   搬移原因（实测）：`db/migrations/004_*` 会被启动链加载，而本模块顶层 `import u from "@/utils"`
 *   → `@/utils/db` → `@/db/connect`；从迁移链 import 本模块就构成**加载期循环**
 *   （`TypeError: createKnex is not a function`）。纯格式函数不依赖启动链，所以它能安全地待在 `db/` 下。
 */
export { pickEpisodesId, buildIsolationKey } from "@/db/isolation-key";

/**
 * 归属校验：必须在**与 `ctx` 匹配的 `runWithTenant(ctx, …)`** 里调用 ——
 * 守卫按 ALS 里的 `ctx.userId` 过滤，"别人的 id"查不到（`whereIn` 后返回 undefined）。
 * 这里额外核对一次"当前 ALS 里的 ctx 就是传进来的 ctx"：不匹配 ⇒ 直接 `null`（fail-closed），
 * 免得调用方拿着 A 的 ctx 却在 B 的 run 里拿到 B 的行。
 */
async function resolveOwned(table: "o_project" | "o_script", ctx: TenantCtx, rawId: unknown): Promise<number | null> {
  const live = currentTenant();
  if (!live || live.userId !== ctx.userId) return null;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await u.db(table).where("id", id).first();
  return row ? id : null;
}

/** 该项目是否存在**且属于 `ctx.userId`**；否则 `null`。 */
export async function resolveOwnedProject(ctx: TenantCtx, projectIdRaw: unknown): Promise<number | null> {
  return resolveOwned("o_project", ctx, projectIdRaw);
}

/** 该剧本是否存在**且属于 `ctx.userId`**；否则 `null`。 */
export async function resolveOwnedScript(ctx: TenantCtx, scriptIdRaw: unknown): Promise<number | null> {
  return resolveOwned("o_script", ctx, scriptIdRaw);
}

