import type { Knex } from "knex";

type DbInteger = number | string | bigint;

function dailyLimit(value: DbInteger | null): number | null {
  if (value === null) return null;
  const limit = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Model grant dailyLimit is invalid");
  return limit;
}

export class GrantNotFoundError extends Error {
  readonly status = 403;

  constructor(resource: "model" | "agent", identity: string) {
    super(resource === "model"
      ? `当前账号无权使用模型：${identity}`
      : `当前账号无权使用智能体：${identity}`);
    this.name = "GrantNotFoundError";
  }
}

function denied(resource: "model" | "agent", identity: string): GrantNotFoundError {
  return new GrantNotFoundError(resource, identity);
}

export async function resolveModelGrant(
  db: Knex,
  userId: number,
  vendorId: string,
  model: string,
): Promise<{ dailyLimit: number | null }> {
  const rows = (await db("o_userGroupMembership as membership")
    .join("o_userGroupModelGroup as mapping", "mapping.userGroupId", "membership.userGroupId")
    .join("o_modelGroupItem as item", "item.modelGroupId", "mapping.modelGroupId")
    .where("membership.userId", userId)
    .where({ "item.vendorId": vendorId, "item.model": model, "item.enabled": true })
    .select("item.dailyLimit")) as Array<{ dailyLimit: DbInteger | null }>;

  if (rows.length === 0) throw denied("model", `${vendorId}/${model}`);
  const limits = rows.map((row) => dailyLimit(row.dailyLimit)).filter((limit): limit is number => limit !== null);
  return { dailyLimit: limits.length === 0 ? null : Math.min(...limits) };
}

export async function resolveAgentGrant(
  db: Knex,
  userId: number,
  agentKey: string,
): Promise<{ dailyLimit: number | null }> {
  const rows = (await db("o_modelGrant")
    .where({ userId, agentKey, enabled: true })
    .select("dailyLimit")) as Array<{ dailyLimit: DbInteger | null }>;
  if (rows.length === 0) throw denied("agent", agentKey);
  if (rows.length > 1) throw new Error(`Ambiguous Agent grant for ${agentKey}`);
  return { dailyLimit: dailyLimit(rows[0].dailyLimit) };
}
