import { AsyncLocalStorage } from "node:async_hooks";
import { currentTenant } from "@/db/tenant-context";

export interface AiBillingContext {
  userId: number;
  jobId?: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<AiBillingContext>();
const pendingTasks = new Map<string, Set<Promise<unknown>>>();

function taskKey(context: AiBillingContext): string | null {
  return context.jobId === undefined ? null : `${context.userId}:${context.jobId}`;
}

export function trackAiBillingTask<T>(context: AiBillingContext, task: Promise<T>): Promise<T> {
  const key = taskKey(context);
  if (key === null) return task;
  let tasks = pendingTasks.get(key);
  if (!tasks) pendingTasks.set(key, (tasks = new Set()));
  tasks.add(task);
  const remove = () => {
    tasks!.delete(task);
    if (tasks!.size === 0) pendingTasks.delete(key);
  };
  void task.then(remove, remove);
  return task;
}

export async function waitForAiBillingTasks(context: AiBillingContext): Promise<void> {
  const key = taskKey(context);
  if (key === null) return;
  while (pendingTasks.has(key)) {
    await Promise.allSettled([...pendingTasks.get(key)!]);
  }
}

function validateContext(context: AiBillingContext): void {
  if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
    throw new TypeError("AI billing context userId must be a positive safe integer");
  }
  if (typeof context.requestId !== "string" || context.requestId.length === 0) {
    throw new TypeError("AI billing context requestId must be a non-empty string");
  }
  if (context.jobId !== undefined && typeof context.jobId !== "string") {
    throw new TypeError("AI billing context jobId must be a string when provided");
  }
  const tenant = currentTenant();
  if (tenant && tenant.userId !== context.userId) {
    throw new Error(`AI billing context userId ${context.userId} does not match tenant userId ${tenant.userId}`);
  }
}

export async function withAiBillingContext<T>(context: AiBillingContext, fn: () => T | Promise<T>): Promise<T> {
  validateContext(context);
  return storage.run({ ...context }, fn);
}

export function currentAiBillingContext(): AiBillingContext {
  const context = storage.getStore();
  if (!context) throw new Error("AI billing context is not available");
  return context;
}
