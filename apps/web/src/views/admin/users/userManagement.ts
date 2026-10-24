export type RechargeAttempt = { fingerprint: string; idempotencyKey: string };

export function createRechargeIdempotencyKey(
  cryptoApi: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto,
): string {
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function refreshSelectedUser<T extends { id: number }>(selected: T | null, rows: T[]): T | null {
  return selected ? rows.find((row) => row.id === selected.id) ?? selected : null;
}

export function canAccessAdminUsers(role: string): boolean {
  return role === "admin";
}

export function normalizeUserSearch(value: string): string {
  return value.trim();
}

export function validateGroupIds(values: number[]): number[] {
  if (values.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new TypeError("Group IDs must be positive safe integers");
  if (new Set(values).size !== values.length) throw new TypeError("Group IDs must not contain duplicates");
  return [...values];
}

export function buildUserRechargeAttempt(
  input: { userId: number; amount: string; note: string },
  previous: RechargeAttempt | null,
  createKey: () => string,
): RechargeAttempt {
  const fingerprint = JSON.stringify([String(input.userId).trim(), input.amount.trim(), input.note.trim()]);
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, idempotencyKey: createKey() };
}
