/**
 * 租户上下文（spec §6.4）。用 Node 内建 AsyncLocalStorage，不引入依赖。
 *
 * ⚠ 两条实测出来的使用纪律（探针 A）：
 *  1. **HTTP**：必须写成 `runWithTenant(ctx, () => next())` —— 下游 handler 与它内部的所有
 *     `await` 都在同一个 async 上下文里，实测 `await` 之后仍拿得到 ctx。
 *  2. **事件监听器 / 定时器**：ctx 跟随 **async 资源的创建点**，不是"谁持有引用"——
 *     实测（探针 B）：在 `run()` **内**创建的 `setTimeout` 回调**拿得到** ctx。
 *     拿不到的是**在 `run()` 之外创建、或在 `run()` 之外被触发**的回调（同步 `emit` 在触发点的
 *     上下文里执行监听器），实测 `als.getStore()` 为 `undefined`。所以 socket 侧必须把每个事件
 *     处理器**显式包**在 `runWithTenant` 里（见 Task 5 的 `bindSocketTenant`），
 *     不能指望"连接时进过一次 run()，之后的事件就都带 ctx"。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type TenantRole = "user" | "admin";
export type TenantSource = "http" | "socket" | "system";

export interface TenantCtx {
  readonly userId: number;
  readonly role: TenantRole;
  /** 便于日志/审计串联；本阶段只用于错误文案（审计日志归 Phase 1c） */
  readonly requestId: string;
  readonly source: TenantSource;
}

export class TenantContextError extends Error {
  readonly httpStatus = 500;
  readonly code = "TENANT_NO_CONTEXT";
  constructor(message = "当前调用栈没有租户上下文：fail-closed，拒绝访问租户表") {
    super(message);
    this.name = "TenantContextError";
  }
}

const storage = new AsyncLocalStorage<TenantCtx>();

/** 在一个租户上下文里同步执行 `fn`（异步 fn 亦可，返回值原样传出）。 */
export function runWithTenant<T>(ctx: TenantCtx, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTenant(): TenantCtx | undefined {
  return storage.getStore();
}

export function currentUserId(): number | undefined {
  return storage.getStore()?.userId;
}

/** 拿不到 ctx 就抛（守卫层的默认行为；只有显式声明过的路径才允许无 ctx）。 */
export function requireTenantCtx(): TenantCtx {
  const ctx = storage.getStore();
  if (!ctx) throw new TenantContextError();
  return ctx;
}
