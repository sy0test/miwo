export type BillingRole = "user" | "admin";

export type BillingAccount = {
  balanceMicro: string;
  frozenMicro: string;
};

export type BillingAccountLoadState = {
  account: BillingAccount | null;
  loading: boolean;
  error: string;
};

export function getAvailableBalanceMicro(account: BillingAccount): string {
  return (BigInt(String(account.balanceMicro)) - BigInt(String(account.frozenMicro))).toString();
}

export async function loadBillingAccount(
  state: BillingAccountLoadState,
  fetchAccount: () => Promise<BillingAccount>,
): Promise<void> {
  state.loading = true;
  state.error = "";
  try {
    state.account = await fetchAccount();
  } catch (error) {
    state.error = error instanceof Error && error.message ? error.message : "账户加载失败，请重试";
  } finally {
    state.loading = false;
  }
}

export type RechargeAttemptInput = { userId: string | number; amount: string; note: string };
export type RechargeAttempt = { fingerprint: string; idempotencyKey: string };

export function getRechargeAttempt(
  input: RechargeAttemptInput,
  previous: RechargeAttempt | null,
  createKey: () => string,
): RechargeAttempt {
  const fingerprint = JSON.stringify([
    String(input.userId).trim(),
    input.amount.trim(),
    input.note.trim(),
  ]);
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, idempotencyKey: createKey() };
}

export type BillingLedgerEntry = {
  id: string | number;
  createdAt: string | number;
};

export type BillingUsageEntry = {
  vendorId: string;
  model: string;
  costMicro: string | number;
};

export type BillingUsageSummary = {
  vendorId: string;
  model: string;
  calls: number;
  costMicro: string;
};

function microInteger(value: string | number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError("Micro-CNY numbers must be safe integers; use a decimal string for large values");
  }
  return BigInt(String(value));
}

export function formatMicroToCny(value: string | number | bigint): string {
  const micro = microInteger(value);
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  const cents = (absolute + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  const sign = negative && cents > 0n ? "-" : "";
  return `${sign}${whole}.${fraction}`;
}

export function formatPriceMicroToCny(value: string | number | bigint): string {
  const micro = microInteger(value);
  if (micro < 0n) throw new RangeError("Price micro-CNY must not be negative");
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

export function parseCnyToMicro(input: string | number): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(input).trim());
  if (!match) throw new TypeError("CNY amount must be a non-negative decimal with at most 6 fractional digits");
  return (BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0")).toString();
}

export function hasInsufficientBalance(account: BillingAccount): boolean {
  return BigInt(String(account.balanceMicro)) <= BigInt(String(account.frozenMicro));
}

export function sortLedgerEntries<T extends BillingLedgerEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const timeDiff = Number(right.createdAt) - Number(left.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return String(right.id).localeCompare(String(left.id), undefined, { numeric: true });
  });
}

export function groupUsageByProviderModel(entries: BillingUsageEntry[]): BillingUsageSummary[] {
  const groups = new Map<string, BillingUsageSummary>();
  for (const entry of entries) {
    const key = `${entry.vendorId}\u0000${entry.model}`;
    const group = groups.get(key) ?? { vendorId: entry.vendorId, model: entry.model, calls: 0, costMicro: "0" };
    group.calls += 1;
    group.costMicro = (BigInt(group.costMicro) + microInteger(entry.costMicro)).toString();
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.vendorId.localeCompare(right.vendorId) || left.model.localeCompare(right.model));
}

export function getPendingManualOrders<T extends { channel: string; status: string }>(orders: T[]): T[] {
  return orders.filter((order) => order.channel === "manual_admin" && order.status === "pending");
}

export function getAccountViewState(input: { loading: boolean; account: BillingAccount | null; error: string }): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.account ? "ready" : "empty";
}

export function canManageBilling(role: BillingRole): boolean {
  return role === "admin";
}

const MODEL_GROUP_ERRORS: Record<string, string> = {
  "模型组参数无效": "模型组参数格式不正确，请检查模型组名称和所选模型。",
  "模型组包含重复模型": "模型组中包含重复模型，请调整后重试。",
  "模型组只能包含已配置的模型": "所选模型未在服务商配置中找到，请刷新配置后重试。",
  "模型组名称已存在": "模型组名称已存在，请更换名称。",
};

export function getModelGroupError(error: unknown): string {
  const value = error && typeof error === "object" ? error as { rawMessage?: unknown; message?: unknown } : {};
  const specific = typeof value.rawMessage === "string" ? MODEL_GROUP_ERRORS[value.rawMessage] : undefined;
  if (specific) return specific;
  return typeof value.message === "string" && value.message ? value.message : "模型组操作失败";
}
