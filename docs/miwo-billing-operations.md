# Phase 2 Billing Operations

## Money and ledger

- Currency is integer micro-CNY: `1 CNY = 1,000,000 micro-CNY`. Accept decimal CNY only to six fractional digits. Keep calculations exact (`bigint` in memory, decimal integer strings at database boundaries); never use floating-point conversion for charge, balance, price, or reconciliation decisions.
- Run `pnpm verify:phase2` from the repository root for the disposable end-to-end acceptance flow. It creates a fresh SQLite data directory under the OS temporary directory and removes it after the test; it does not use the configured application database.
- The ledger is append-only. Do not edit or delete historical ledger entries to correct a balance; investigate the linked order/job/usage, then use the authorized audited adjustment procedure.
- A reservation moves available funds to frozen funds. On known completion, settlement charges recorded actual usage and releases the unused reservation. Insufficient funds should stop submission before committed business/job rows.

## Manual admin recharge

1. Verify the target user and requested amount with the requester. Enter an exact CNY amount; reject negative, over-precision, or mismatched values.
2. Create a pending `manual_admin` recharge order. This is an operator-confirmed payment path, not evidence of an external payment.
3. Confirm the order only after independently confirming receipt and the exact amount. Record the operator/reason through the admin flow. Confirmation must credit once and atomically link the paid order, account change, and recharge ledger entry.
4. Verify the order status, credited amount, and ledger entry for that user. On a replay or mismatch, stop and reconcile; do not create a second order/credit to compensate.

Never fabricate a payment callback, external trade ID, or provider confirmation. Real payment callbacks remain deferred pending a real signature protocol and credentials.

## Prices and model access

- A price change is a new effective-dated price row. Never edit or delete a historical price. Set its effective time deliberately; calls resolve the latest price effective at call time. Avoid two prices for the same vendor/model/unit at the same effective time, which is ambiguous.
- Before enabling a model grant, verify its user, vendor/model (or agent key), and intended `enabled` and daily-limit settings. Disabled or over-quota grants must be resolved before provider dispatch. Active-job concurrency is enforced separately from the grant's daily call limit.
- Generation estimates use the effective configured price and bounded request quantity; missing/ambiguous prices fail closed. Do not substitute an arbitrary tariff.

## Worker uncertainty and recovery

A provider may have succeeded even if the worker timed out or crashed before recording the result. Treat this as **uncertain**, not as a failed call: the reservation remains frozen, and unknown provider outcomes are not automatically refunded. A retry must not silently double-charge or dispatch an untracked call.

Use the reconciliation report to find unresolved provider outcomes and job/reservation drift. Check provider evidence and job/usage attribution, then use the authorized audited recovery path to record known usage or resolve the case. The reconciliation CLI below is read-only; it does not repair drift. Do not release an uncertain reservation merely to clear a report.

## Billing reconciliation (read-only)

Run from `apps/api` with the intended database configuration available to the process. Confirm the resolved database target before running; do not let a missing environment value silently select a local database. The CLI requires non-negative safe-integer epoch milliseconds, `from < to`, and `--dry-run`. `from` is inclusive and `to` exclusive.

Example: reconcile the UTC day 2026-10-12:

```powershell
node --env-file-if-exists=.env --import=tsx scripts/reconcile-billing.ts --from 1791763200000 --to 1791849600000 --dry-run
```

The range selects immutable ledger, usage, order, and related event anchors. Account balances, job states, and order state are read as they exist **when the command executes**; this is not an as-of historical snapshot. A report can therefore include current state produced by events outside the selected window when those events relate to an in-window anchor. Preserve the JSON output and investigate each drift before any separate, audited correction. No `--apply` option exists for this CLI.

The report covers account-versus-ledger balance/frozen drift, job-versus-reservation terminal drift, duplicate or missing usage keys, unresolved provider outcomes, and order-versus-credit drift. An empty report only describes the chosen event window and current-at-execution checks; it is not proof of external provider or payment correctness.

## Storage operations

Local storage is the default (`MIWO_STORAGE_DRIVER=local`). To select S3-compatible storage, set `MIWO_STORAGE_DRIVER=s3` and configure `MIWO_S3_ENDPOINT`, `MIWO_S3_BUCKET`, `MIWO_S3_REGION`, `MIWO_S3_ACCESS_KEY_ID`, and `MIWO_S3_SECRET_ACCESS_KEY`; `MIWO_S3_SESSION_TOKEN` is optional, and `MIWO_S3_FORCE_PATH_STYLE` accepts `true` or `false`. The endpoint must be an HTTP(S) URL without embedded credentials, query, or fragment. S3 mode fails startup when required settings are absent or invalid. Media uses the configured local cache directory (`MIWO_MEDIA_DIR`, or `<MIWO_DATA_DIR>/oss`; S3 cache is under `.s3-cache`). Keep credentials in the deployment's secret store/environment, never in this guide or logs. Validate bucket, region, endpoint, network access, and cache capacity with the storage operator before switching modes.

## External gates not verified here

Do not treat local/static tests as live-service validation. MySQL integration, real S3/MinIO interoperability, live payment processing/signatures, and external vendor behavior/usage remain unverified until exercised against the actual configured services. Browser task progress, nginx/TLS runtime, external CI, and public smoke are also not established by this guide. Record the environment and evidence for any later live validation; do not claim a gate passed without running it.
