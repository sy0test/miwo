# API and Web Verification Repair Plan

> **For agentic workers:** Execute this plan task-by-task and preserve all pre-existing worktree changes. Do not commit or contact/modify the Ubuntu server.

**Goal:** Repair the known API test/gate failures and Web type-check errors, then produce fresh verification evidence for a traceable local deployment candidate.

**Architecture:** Keep the API and Web changes in separate tracks. API edits align stale tests and tenant inventories with current migrations, route sources, and exported policy facts; Web edits restore correct dependency and component type contracts without weakening checks or changing model-access behavior. Finish with full package verification and a review of the complete dirty diff.

**Tech Stack:** TypeScript, Vitest, Knex, Vue 3, Vite, pnpm.

**Spec:** Approved repair scope from the conversation; source contracts in `apps/api/src/db/migrations/014_access_groups.ts`, `apps/api/tests/tenant-policies.test.ts`, `apps/api/src/routes/billing/admin/recharges.ts`, and existing Web component/runtime types. No separate feature spec applies.

## Global Constraints

- Preserve every pre-existing tracked and untracked change; do not reset, revert, clean, or overwrite unrelated user work.
- Do not change authorization, model visibility, billing reserve/settle/release behavior, migrations, or production routes to satisfy stale assertions.
- Add no `any`, skipped type checks, or broad compiler suppressions to make Web type-check pass.
- Do not commit, publish, create `deploy/.env`, connect to the Ubuntu server, or change server state.
- Treat `o_userGroupMembership` as the current 28th tenant table and eighth backfill exemption, as already asserted by `tenant-policies.test.ts`.

---

### Task 1: Align API Tests With Current Source Contracts

**Files:**
- Modify: `apps/api/tests/accounts-migration.test.ts`
- Modify: `apps/api/tests/backfill-userid.test.ts`
- Modify: `apps/api/tests/migrations.test.ts`
- Modify: `apps/api/tests/phase2-acceptance.test.ts`
- Modify: `apps/api/tests/router-generation.test.ts`
- Modify: `apps/api/tests/tenant-guard.test.ts`

**Interfaces:**
- Source of migration order: `MIGRATIONS` in `apps/api/src/db/migrations/index.ts`.
- The recharge create endpoint requires an UUID `idempotencyKey` and immediately creates a paid order; pending-order confirmation is a separate flow.
- Current route-generation source contains 184 route pairs.

- [ ] **Step 1: Confirm the focused failing tests are red**

Run from `code/miwo`:

```powershell
pnpm --dir apps/api exec vitest run tests/accounts-migration.test.ts tests/backfill-userid.test.ts tests/migrations.test.ts tests/phase2-acceptance.test.ts tests/router-generation.test.ts tests/tenant-guard.test.ts
```

Expected: the stale migration names, exemption list, recharge contract, route counts, and tenant-table count fail as previously observed.

- [ ] **Step 2: Update migration and table expectations only**

Extend migration arrays in `accounts-migration.test.ts` through `013_account_bootstrap` and `014_access_groups`; rollback order must be `014_access_groups`, then `013_account_bootstrap`, then prior migrations. In `migrations.test.ts`, use `014_access_groups` as the terminal migration. Add `o_userGroupMembership` to the expected backfill-exempt list and change the tenant-table length assertion from 27 to 28.

- [ ] **Step 3: Correct the recharge acceptance fixture to the endpoint contract**

In `phase2-acceptance.test.ts`, supply `idempotencyKey: crypto.randomUUID()` in the create request. Assert that the successful direct recharge is already paid and credited; do not attempt to confirm that newly created paid order. Keep pending-order confirmation coverage in its dedicated route tests.

- [ ] **Step 4: Update route-generation assertions to the observed source count**

Change all three static route-pair/count expectations in `router-generation.test.ts` from 183 to 184. Do not regenerate or otherwise write `src/router.ts` as a side effect of the test helper.

- [ ] **Step 5: Run the focused API tests**

Run the command from Step 1 again. Expected: all six focused test files pass.

### Task 2: Reconcile API Tenant Gates and Exception Inventory

**Files:**
- Modify: `apps/api/tests/tenant-db-bypass.test.ts`
- Modify: `apps/api/tests/tenant-gates.test.ts` only if a stale assertion is found there
- Modify: `apps/api/src/db/tenant-exceptions.json`
- Modify: `tools/check-tenant-policies.cjs`
- Modify: `apps/api/src/db/policies.ts` only for its stale table-count comment

**Interfaces:**
- `tools/check-tenant-exceptions.cjs --record` mechanically scans existing API source and preserves manual annotations only when a recorded finding remains stable.
- `tools/check-tenant-policies.cjs` imports policy/backfill facts from source and independently validates the 28-table, 8-exemption state.
- `routes/billing/admin/groups.ts` uses `systemDb` only in an admin-protected delete path to test whether a user group has members before deletion; review that path and existing group-route tests before registering it.

- [ ] **Step 1: Establish the gate failures and inspect the changed exception sources**

Run:

```powershell
node tools/check-tenant-exceptions.cjs
node tools/check-tenant-policies.cjs
```

Expected: exception inventory drift and stale 27/7 policy thresholds are reported. Review the exact query contexts in `apps/api/src/billing/grants.ts`, `apps/api/src/routes/billing/admin/users.ts`, `apps/api/src/routes/modelSelect/getModelList.ts`, `apps/api/src/db/migrations/013_account_bootstrap.ts`, and `apps/api/src/routes/billing/admin/groups.ts` before recording annotations.

- [ ] **Step 2: Add a failing assertion for the new `systemDb` importer**

Add `routes/billing/admin/groups.ts` to `SYSTEM_DB_USERS` in `tenant-db-bypass.test.ts`, then run:

```powershell
pnpm --dir apps/api exec vitest run tests/tenant-db-bypass.test.ts
```

Expected: this test continues to fail until the exact importer set is updated in the exception inventory; its explicit-import and no-bare-`db` assertions must pass for the new route.

- [ ] **Step 3: Update mechanically stale policy counts**

In `tools/check-tenant-policies.cjs`, change the hard-coded tenant count and corresponding diagnostic/comment from 27 to 28, and exemption count/diagnostic from 7 to 8. Update the `policies.ts` count comment to 28. Do not alter the source table arrays or policy assignments.

- [ ] **Step 4: Record and review exception inventory drift**

Run:

```powershell
node tools/check-tenant-exceptions.cjs --record
```

Inspect the resulting JSON diff. Preserve existing notes and phase1b evidence. For every new join/raw/systemDb finding, add a specific `confirmed`, `note`, and valid `phase1b` disposition/evidence based on the reviewed source context. Ensure `groups.ts` is explicitly documented as admin-only cross-tenant membership checking, not as a general-purpose bypass. Keep any changed line numbers, file counts, and scan scope synchronized with the scanner output.

- [ ] **Step 5: Run API tenant gate tests and direct gate commands**

Run:

```powershell
pnpm --dir apps/api exec vitest run tests/tenant-db-bypass.test.ts tests/tenant-gates.test.ts tests/tenant-policies.test.ts
node tools/check-tenant-exceptions.cjs
node tools/check-tenant-policies.cjs
```

Expected: all test files pass; both direct gates exit 0 and inventory entries are fully annotated.

### Task 3: Restore Web Type Contracts

**Files:**
- Modify: `apps/web/package.json` and the workspace lockfile if required
- Modify: `apps/web/tsconfig.app.json`
- Modify: `apps/web/src/utils/global.ts` or the existing Electron bridge declaration owner
- Modify only the affected editor, selection, workbench, and theme components identified below

**Interfaces:**
- Vite client types provide `import.meta.glob` and `?worker` module declarations.
- The runtime Electron bridge type must match the actual preload implementation and remain optional in browser-only runtime if Electron is not guaranteed.
- The app setting mode is `"auto" | "light" | "dark"`; editor theme props accept only concrete themes. Resolve or omit `auto` at the editor boundary, following `views/scriptAgent/index.vue`.
- Workbench model types must match actual parent-provided data; do not add defaults that fabricate invalid model values.

- [ ] **Step 1: Reproduce the Web type-check failure**

Run:

```powershell
pnpm --filter @miwo/web type-check
```

Expected: the existing 47 diagnostics are reproduced before edits.

- [ ] **Step 2: Repair missing module and ambient declarations**

Declare `@types/lodash` in the Web package's development dependencies and update the workspace lockfile with pnpm. Add `vite/client` to `tsconfig.app.json` using the project's existing TypeScript configuration pattern. Add the correct optional Electron bridge type only after checking the preload/runtime implementation; do not use an untyped global.

- [ ] **Step 3: Normalize editor theme inputs and narrow component values**

At each editor binding reported by the type-check, map the `auto` preference to the existing supported behavior (`undefined` where the component already uses that convention, or an explicitly resolved light/dark value). Preserve literal theme values with a tuple/union type. Narrow nullable scroll targets before passing them to the component and initialize `activeTrackIndex` as `ref<number>(0)`. Explicitly declare the event-analysis step union to include the default `"To3"` and other used steps.

- [ ] **Step 4: Correct workbench model and callback contracts**

Give `modeMenu.vue` a concrete model type accepted by Vue's `defineModel` macro and normalize TDesign `SelectValue` before emitting the string mode. In `video.vue`, use the actual `TrackItem` shape from the parent rather than a `void` factory or unresolved generic. Align `WorkbenchData` between `views/production/index.vue` and `views/production/node/workbench.vue`; preserve required fields if the runtime requires them, otherwise make only genuinely optional fields optional based on the data producer.

- [ ] **Step 5: Run Web verification**

Run:

```powershell
pnpm --filter @miwo/web type-check
pnpm --filter @miwo/web test
pnpm --filter @miwo/web build-only
```

Expected: type-check exits 0, all existing Web tests pass, and Vite builds the Monaco worker imports successfully.

### Task 4: Full Verification and Deployment Candidate Review

**Files:** No additional files unless verification reveals a concrete regression; do not alter deployment configuration in this task.

- [ ] **Step 1: Run full API verification**

Run from `code/miwo`:

```powershell
pnpm --dir apps/api test
pnpm --dir apps/api typecheck
```

Expected: API tests and type-check exit 0. Zero-cost reservation cases, if present in the existing suite, must remain on the standard reserve/settle/release path.

- [ ] **Step 2: Re-run full Web verification**

Run the three commands from Task 3, Step 5, after all API changes are integrated.

- [ ] **Step 3: Review only this task's diff and the dirty worktree**

Inspect `git status --short` and `git diff --` for each touched path. Confirm no pre-existing user changes were reverted, no generated router or unrelated files were modified, and no secrets or deployment environment file was introduced. Record the exact passing command outputs and the tested source revision for the later deployment handoff.

- [ ] **Step 4: Stop before server operations**

Do not deploy or run commands on the Ubuntu host. Present the verification evidence and provide the deployment steps for the user to execute manually in a separate approved step.
