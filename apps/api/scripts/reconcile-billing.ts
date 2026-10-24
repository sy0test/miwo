import guard from "./db-target-guard.cjs";

export interface ReconcileBillingCliArgs {
  from: number;
  to: number;
  dryRun: true;
}

export const USAGE = [
  "Usage: pnpm run reconcile:billing -- --from <epoch-ms> --to <epoch-ms> --dry-run",
  "  --from <epoch-ms>  Inclusive start of the reconciliation range.",
  "  --to <epoch-ms>    Exclusive end of the reconciliation range.",
  "  --dry-run          Required; reconciliation is read-only in all modes.",
].join("\n");

function parseEpoch(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative epoch-millisecond integer`);
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) throw new Error(`${flag} must be a safe integer epoch-millisecond value`);
  return epoch;
}

export function parseArgs(argv: string[]): ReconcileBillingCliArgs {
  const args = [...argv];
  if (args[0] === "--") args.shift();

  let from: number | undefined;
  let to: number | undefined;
  let dryRun = false;
  const seen = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    seen.add(flag);

    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag !== "--from" && flag !== "--to") throw new Error(`unknown flag or argument: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    i += 1;
    const epoch = parseEpoch(value, flag);
    if (flag === "--from") from = epoch;
    else to = epoch;
  }

  if (from === undefined) throw new Error("missing required flag: --from <epoch-ms>");
  if (to === undefined) throw new Error("missing required flag: --to <epoch-ms>");
  if (!dryRun) throw new Error("missing required flag: --dry-run");
  if (from >= to) throw new Error("invalid interval: --from must be less than --to");

  return { from, to, dryRun: true };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [{ config }, { reconcileBilling }, { createKnex }] = await Promise.all([
    import("@/config"),
    import("@/billing/reconcile"),
    import("@/db/connect"),
  ]);
  // Guard the resolved target before createKnex: opening SQLite can create the file.
  guard.requireRepoDevDbAllowed({
    argv,
    driver: config.db.driver,
    ...(config.db.driver === "sqlite" ? { file: config.db.file } : {}),
    what: "reconcile:billing",
  });

  const db = createKnex();
  try {
    const report = await reconcileBilling(db, args);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message, usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
