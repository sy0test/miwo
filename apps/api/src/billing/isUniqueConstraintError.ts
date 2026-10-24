const UNIQUE_CODES = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY", "ER_DUP_ENTRY"]);

export function isUniqueConstraintError(error: unknown): boolean {
  const value = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if (typeof value?.code === "string" && UNIQUE_CODES.has(value.code)) return true;
  if (value?.errno === 1062) return true;
  return /UNIQUE constraint failed|Duplicate entry/i.test(String(value?.message ?? ""));
}
