/**
 * socket 生命周期（spec §9.5 "生产环境真机 bug"）。
 *
 * 历史 bug：`productionAgent.ts:148` 把 `disconnect` 挂在 **namespace** 上
 * （`nsp.on("disconnect", …)`），而 `disconnect` 是 **socket 级**事件 —— 监听器永远不触发，
 * 于是用户关掉页面/断网后 agent 继续烧 token（真机表现：后台一直有请求）。
 *
 * 为什么抽成独立文件：原代码里的处理函数依赖 token 校验（Phase 1c 正在改），直接跑起来测很脆；
 * 抽出来后"**必须挂在 socket 上** + **必须 abort** + **room 名 = `user:{id}`**"三条都成了可单测的不变式。
 *
 * ⚠ 配套的**静态**守卫：`git grep -n 'nsp.on("disconnect"' -- apps/api/src` 必须 **0 命中**
 *   （回归由"单测 + 静态断言"两处共同守住，单测证明行为、静态断言证明接线没被改回去）。
 */
export interface SocketLike {
  id: string;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  join?(room: string): unknown;
}

/**
 * 断开时中止该连接正在跑的任务。
 *
 * ⚠ **必须**通过 `socket.on("disconnect", …)` 注册（不是 `nsp.on`）—— 见文件头。
 * ⚠ `getAbort` 是**取值函数**而不是值：`abortController` 在每次 `chat` 时被替换
 *   （见 `productionAgent.ts` 的 `abortController = new AbortController()`），传值会捕获到过期的那一个。
 */
export function bindSocketLifecycle(
  socket: SocketLike,
  getAbort: () => { abort(reason?: unknown): void } | null,
  log: (m: string) => void = (m) => console.log(m),
): void {
  socket.on("disconnect", () => {
    const controller = getAbort();
    if (controller) controller.abort(new Error("socket disconnected"));
    log(`[socket] 已断开: ${socket.id}`);
  });
}

/**
 * 进度事件的目的地。room 名是**跨进程契约**：`user:{userId}`（`jobs/progressRelay.ts` 用它 emit）。
 *
 * ⚠ `userId` 一律由**服务端**推导（Phase 1c 的 `decodeSocketToken` → `TenantCtx.userId`），
 *   **绝不**从 `socket.handshake.auth` 里读客户端可伪造的 userId —— 那等于把租户隔离的洞开在 socket 上。
 *   `null`（未认证/平台连接）⇒ **不加入任何 room**（事件通道空转，而不是退化成全局广播）。
 */
export function joinUserRoom(socket: SocketLike, userId: number | null): void {
  if (userId === null || userId === undefined) return;
  socket.join?.(`user:${userId}`);
}
