# Warden Audit Integrity — Build Plan

**Target repository:** `tradewizard`
**Status:** Phases 1–2 implemented and deployed. Dev verified (47 rows, chain valid, tamper drill passed); production data verified (3 rows, chain valid); production portal rebuilt at `dba73d9` — the live bundle contains the Verify chain UI. Only the prod click-through remains. Phase 3 (HMAC anchor) not started, by decision. §15.1 has the open items and §15.2 the deliberate deviations.
**Implementation record:** `.kiro/specs/audit-chain-integrity/` (requirements, design, tasks) and architecture §8.3. Do not describe this capability as shipped until it is deployed and the dev verification in §15 is complete.
**Goal:** Make the operations audit log tamper-evident: hash-chain every row, verify the chain, and show the result in the portal.

Working product name for the portal: **Warden** (optional; the build can keep `tradewizard-admin` as the package name while the UI says “TradeWizard Warden — Operations Control Plane”).

Do not describe this capability as shipped until it is implemented, tested, and deployed.

---

## 1. Why this feature

The portal already has four-role RBAC, MFA, an append-only audit table, a per-user kill switch, runtime settings, support, and newsletter. The audit table is append-only by trigger, but a database-level actor could still rewrite rows, and a reader has no way to prove the log is intact.

A hash chain fixes that:

- Each row commits to the previous row.
- Changing any field breaks the chain at that row.
- A verification endpoint returns the first broken row.
- The Audit page shows whether the chain is verified or broken.

This is accountability without adding a second operator. The same people keep the same powers; the difference is that their actions become provable.

---

## 2. Current code map

Read these before changing anything:

| Area | Files |
|------|-------|
| Audit schema + trigger | `infra/sql/001-schema.sql` (`admin_audit_log`, `admin_audit_log_immutable`) |
| Audit write/complete | `infra/services/admin-api/lib/audit.ts` |
| Router + route matrix | `infra/services/admin-api/lib/router.ts`, `infra/services/admin-api/handler.test.ts` |
| Audit route | `infra/services/admin-api/routes/audit.ts` |
| Auth/RBAC | `infra/services/shared/admin-auth.ts` |
| Admin stack | `infra/lib/admin-stack.ts` |
| Portal audit UI | `tradewizard-admin/app/(app)/audit/page.tsx`, `components/audit/AuditView.tsx` |
| Portal API client | `tradewizard-admin/lib/admin-api.ts` |
| Architecture/runbook | `docs/admin-portal-architecture.md`, `docs/admin-portal-runbook.md` |

---

## 3. Requirements

- Every audit row is linked to the previous row by a SHA-256 hash.
- The row hash covers the immutable fields: id, actor, action, target, reason, before state, created_at, and previous hash.
- The completion state (status, after, error, completed_at) gets its own completion hash, so flipping a status is detectable.
- A verification endpoint checks the whole chain in order and returns the first broken row.
- The Audit page shows a verified badge, a Verify button, per-row hash details, and an export.
- Existing rows are backfilled; the operation is idempotent and safe to re-run.
- New audit writes are serialized so two concurrent mutations cannot fork the chain.
- A failure to write the audit row must fail the mutation. Never execute an unauditable action.

---

## 4. Schema

Add to `admin_audit_log`:

```sql
ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS prev_hash TEXT,
  ADD COLUMN IF NOT EXISTS row_hash TEXT,
  ADD COLUMN IF NOT EXISTS completion_hash TEXT,
  ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_row_hash
  ON admin_audit_log (row_hash) WHERE row_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_chain_order
  ON admin_audit_log (created_at, id);
```

Backfill in `created_at, id` order:

1. Disable `admin_audit_log_immutable` for the backfill.
2. Select rows ordered by `(created_at, id)`.
3. Compute `prev_hash` and `row_hash` in a script, not SQL string concatenation.
4. For terminal rows, compute `completion_hash` from the terminal state.
5. Re-enable the trigger.

Add a Node script: `infra/scripts/backfill-audit-chain.ts`.
It must be safe to re-run: only rows with `row_hash IS NULL` are processed, unless `--force` is passed for a dev reset.

Update the trigger so the completion fields are allowed on the pending → terminal transition, but still immutable afterward:

- Allowed to change: `status`, `after`, `error`, `completion_hash`, `completed_at`.
- Everything else remains immutable.
- `completion_hash` and `completed_at` must be null while `status = 'pending'`.
- `NEW.status` must be `succeeded` or `failed`.

---

## 5. Canonical hash

Create `infra/services/admin-api/lib/audit-chain.ts`:

```ts
export interface AuditChainRow {
  id: string;
  actorSub: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string;
  before: unknown;
  createdAt: string; // ISO
  prevHash: string | null;
  hashVersion: number;
}

export function canonicalAuditRow(row: AuditChainRow): string;
export function computeRowHash(row: AuditChainRow): string;
export function computeCompletionHash(input: {
  rowHash: string;
  status: 'succeeded' | 'failed';
  after: unknown;
  error: string | null;
  completedAt: string;
}): string;
```

Rules:

- Canonical JSON: sorted object keys, no whitespace, `null` preserved.
- `row_hash = sha256(canonicalAuditRow(row))`.
- `completion_hash = sha256(canonical({ rowHash, status, after, error, completedAt }))`.
- Include `hash_version` so the algorithm can evolve.

---

## 6. Write path

Change `writeAuditLog`:

1. Open a transaction on the passed client.
2. `SELECT pg_advisory_xact_lock(hashtext('admin_audit_log_chain'))`.
3. Select the current head: `ORDER BY created_at DESC, id DESC LIMIT 1` for `row_hash`.
4. Compute `prev_hash` and `row_hash`.
5. Insert the row with both hashes.
6. Commit.

This keeps the existing contract: the audit row commits before the side effect.

Change `completeAudit`:

1. Compute `completion_hash` and `completed_at` from the terminal state.
2. Update `status`, `after`, `error`, `completion_hash`, `completed_at`.
3. The trigger enforces the allowed transition.

If the audit chain write fails, the mutation must fail. Do not execute an unauditable action.

---

## 7. Verification endpoint

Add `GET /admin/audit/verify?from=&to=&limit=5000`:

- Minimum role: `analyst` (read-only).
- Cursor/bounded; default last 1,000 rows, max 5,000.
- Recompute each row hash in `(created_at, id)` order.
- Check `prev_hash` equals the previous row's `row_hash`.
- For terminal rows, recompute `completion_hash`.
- Return:

```json
{
  "valid": true,
  "checked": 1234,
  "from": "2026-11-02T...",
  "to": "2026-11-12T...",
  "head": "sha256:...",
  "firstBrokenId": null,
  "firstBrokenReason": null,
  "verifiedAt": "..."
}
```

If broken, return `200` with `valid: false` and the first broken row. Do not 500: a broken chain is a finding, not a server error.

Add the hashes to the existing audit list/detail response so the UI can show them.

---

## 8. Optional hardening: HMAC anchor

If time permits, add HMAC-SHA256 with a key in Secrets Manager:

- New secret: `tw-{env}-audit-hmac-key`.
- `AUDIT_HMAC_SECRET_ARN` on `admin-api`.
- `row_hmac = HMAC(key, row_hash)`, `completion_hmac = HMAC(key, completion_hash)`.
- Verification recomputes both.
- A DB-only actor cannot forge a valid HMAC without the key.

This is the difference between “tamper-evident if you trust the database” and “tamper-evident against the database.” Do the hash chain first; add HMAC only after it is stable.

---

## 9. Audit UI

Update `tradewizard-admin/app/(app)/audit/page.tsx`:

- Header badge: **Chain verified** / **Chain broken** / **Not verified**.
- Button: **Verify chain** → `GET /admin/audit/verify`.
- Row detail: show `row_hash`, `prev_hash`, `completion_hash`, `hash_version`.
- Filter: status, actor, action, target, date.
- Export: JSON (and CSV if easy) of the filtered rows including hashes.
- Empty state: “No audit rows yet.”

Do not show a green badge until the user clicks Verify or a background query returns `valid: true`. Never label an unverified chain as verified.

---

## 10. Tests

- Unit: canonical JSON and hash stability for fixed fixtures.
- Unit: changing any immutable field changes `row_hash`.
- Unit: changing status/after/error changes `completion_hash`.
- Integration: two concurrent `writeAuditLog` calls produce a single chain, no fork.
- Integration: backfill is idempotent.
- Integration: verification returns `valid: false` and the correct first broken row after a deliberate dev-only row edit.
- Handler: `GET /admin/audit/verify` role matrix and pagination.
- UI: typecheck; Audit page renders verified/broken states.

---

## 11. Acceptance criteria

- Every new audit row has `prev_hash`, `row_hash`, `hash_version`.
- Terminal rows have `completion_hash` and `completed_at`.
- Verification passes on a fresh dev database.
- A deliberate edit to an old row makes verification fail at that row.
- The audit page shows the state and the hashes.
- `npm test`, `npm run build`, and `npm run synth:dev` pass.

---

## 12. Kiro workflow

Create one spec before implementing:

```
.kiro/specs/audit-chain-integrity/
  requirements.md
  design.md
  tasks.md
```

Use the existing hooks:

- `admin-typecheck` after admin TypeScript edits.
- `infra-typecheck` after infra edits.
- `spec-task-followthrough` to close tasks and reconcile docs.

Update `.kiro/steering/tech.md` with the audit-chain invariants. Update `.kiro/steering/structure.md` with the new `lib/audit-chain.ts` and `scripts/backfill-audit-chain.ts` paths.

---

## 13. Implementation order

### Phase 1 — Schema and hashing (1–2 days)

1. Schema + trigger update + backfill script.
2. `audit-chain.ts` canonicalization and hashing.
3. `writeAuditLog` / `completeAudit` transaction + advisory lock.
4. Unit and integration tests.

### Phase 2 — Verification and UI (1–2 days)

1. `GET /admin/audit/verify` + tests.
2. Audit UI badge/details/export.
3. Dev verification: create rows, verify, edit a row in a scratch DB, verify fails.

### Phase 3 — Hardening (1 day, optional)

1. HMAC anchor via Secrets Manager.
2. Seed a demo audit chain for screenshots.
3. Update runbook and security checklist.

---

## 14. Risks

| Risk | Mitigation |
|------|------------|
| Audit backfill locks the table | Run in a transaction, disable the trigger only for the backfill, test on dev first, use `--dry-run`. |
| Chain fork under concurrency | Advisory lock around select-head + insert; unique `row_hash` index as a backstop. |
| HMAC key unavailable | Fail the mutation; never write an unverifiable audit row. |
| Long verification on a large log | Bound the range, default to last 1,000 rows, max 5,000, and report the checked range. |
| UI overstates integrity | Never show “verified” without a successful verification response. |

---

## 15. Definition of done

- [x] Audit chain schema, backfill, hashing, verification endpoint, and UI.
  — schema + trigger in `001-schema.sql`; `services/shared/audit-chain.ts`;
  `GET /admin/audit/verify` and `/export`; audit page badge/details/filters/export.
- [x] Tests: unit, integration, handler, RBAC matrix, UI typecheck.
  — 21 hash/verifier unit tests, 9 writer/backfill unit tests, 7 handler tests,
  route-matrix rows for both new routes, 5 DB-gated integration tests,
  `tsc --noEmit` and `next lint` clean.
- [x] `npm run build`, `npm test`, and `npm run synth:dev` green.
  — `npm run verify` passes; 638 tests, 5 skipped (DB-gated).
- [x] Dev verification: chain valid → tamper detected.
  — dev: 47 rows sealed, `chain verified`; tamper drill on a throwaway database
  on the same RDS instance detects the edited row (`row_hash_mismatch`, exit 1)
  and `--force` reseals it. No dev row was edited.
- [x] Runbook, architecture, security checklist, and Kiro spec updated.
  — architecture §7.2/§7.3/§8.3/§11/§12/§13/§14.4, runbook §4.1–4.5 and
  troubleshooting, `.kiro/specs/audit-chain-integrity/`, steering tech + structure.
- [ ] Portal docs updated only after the feature ships.
  — dev is live and verified; the **production portal has not been rebuilt**
  (the code is still uncommitted), so the "ships" claim stays open.

### 15.1 Open items

| Item | State |
|---|---|
| Production portal UI | Deployed: Amplify job 8 built `dba73d9` and succeeded; the served chunk contains the Verify chain UI |
| Prod click-through | The last check: `warden.tradewizard.live/audit` → Verify chain → expect **3 rows**, green |
| HMAC anchor (§8) | Not built, deliberately. The chain is tamper-evident against application and database mistakes, not against someone who can read Secrets Manager; §8.3 says so explicitly |

### 15.2 Deviations from this plan (all deliberate)

1. **Canonical hashing lives in `services/shared/audit-chain.ts`**, with
   `admin-api/lib/audit-chain.ts` re-exporting it. The hourly maintenance job
   (`services/shared/plan-overrides.ts`) appends system audit rows; if the
   algorithm lived only in `admin-api`, those rows would be written outside the
   chain or the two writers would drift.
2. **The trigger allows a terminal row on INSERT**, not only on UPDATE. The plan
   said `NEW.status` must be `succeeded` or `failed` (an UPDATE rule); system
   expiries are born terminal, so INSERT accepts them *with* both completion
   fields and rejects a pending row that carries them.
3. **`id` and `created_at` are generated in Node and inserted explicitly.**
   Hashing the Node clock while letting Postgres default `created_at`
   (microseconds vs milliseconds) would fail every row on read.
4. **Integration tests are DB-gated** (`AUDIT_TEST_DATABASE_URL`) because the
   repo has no database in CI. They were run against a real RDS scratch database
   for this build, not merely type-checked.
5. **Extra response fields** on verify: `coversGenesis` and `limit`, so the UI
   cannot imply it checked the whole log when it checked a window.
6. **`app/(app)/audit/page.tsx` is unchanged.** It is a three-line Suspense
   wrapper; every UI change is in `components/audit/AuditView.tsx`.

### 15.3 Optional naming applied

The plan called "Warden" an optional working name. It was applied as UI strings
only: browser title/template and `applicationName`, PWA manifest `name`/`short_name`,
login panel, sidebar, topbar, app-shell brand, offline page, and the TOTP issuer.
Package, Cognito client, Amplify app and repository paths remain
`tradewizard-admin` — no infrastructure identifier was renamed.

---

## 16. Handoff note

Build this in `tradewizard`. Update the architecture doc, runbook, security checklist, and Kiro spec when it ships. Do not describe the capability as shipped until it is implemented, tested, and deployed.
