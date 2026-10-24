import { createHash } from "node:crypto";

export interface GrantIdentity {
  agentKey?: string | null;
  vendorId?: string | null;
  model?: string | null;
}

export function grantIdentityKey(grant: GrantIdentity): string | null {
  const identity = grant.agentKey != null
    ? ["agent", grant.agentKey]
    : grant.vendorId != null && grant.model != null
      ? ["model", grant.vendorId, grant.model]
      : null;
  if (!identity) return null;
  const kind = identity[0];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${kind}:${digest}`;
}
