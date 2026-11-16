# Warden Invite Links — Design & Delivery Plan

**Status:** Agreed 2026-11-12. Not started; slice 1 is the first PR.
**Audience:** whoever builds or operates invite links.
**Companion docs:** `docs/admin-portal-architecture.md` (the **binding** portal
spec — RBAC, audit, route table, §14.1 execution order, §14.4 progress log),
`docs/admin-portal-runbook.md` (operating procedures), `docs/support-tickets-plan.md`
and `docs/newsletter-plan.md` (same slice/progress pattern).

> This document is the design detail and slice log for one feature. When code and
> `admin-portal-architecture.md` disagree, the architecture doc wins. Each slice
> also appends a row to **§15** here and to architecture §14.4.

---

## 1. What this is

Today the only ways to give someone Warden access are:

1. **Members → Add member** with their email (owner types it), or
2. `infra/scripts/seed-admin.ts` on a machine with AWS credentials.

Both require knowing the person's email, and (1) has a sharp edge: it **attaches
the admin group to an existing Cognito user with that email**, which is how a
customer account got portal access on 2026-11-03 and lost its product login
(architecture §6.1, runbook §1).

This feature adds a third path: an owner mints a **link that carries a role**,
shares it, and anyone who opens it can create their own dedicated admin account.
The link can be revoked at any time, expires, and is capped by use count. Every
account created through the Warden — link or dialog — is registered on an
**aliased `+warden` address** (`azeezbalogun74@gmail.com` →
`azeezbalogun74+warden@gmail.com`), which guarantees a dedicated Cognito identity
and structurally removes the shared-account failure mode.

## 2. Decisions

| # | Decision | Consequence |
|---|---|---|
| 1 | **Links carry a role** (`analyst`/`support`/`admin`/`owner`) chosen at creation. | One link per audience; reusing the same link for mixed roles is not supported. Changing the role means a new link. |
| 2 | **The link is revocable, expiring, and use-capped.** | Three independent limits; revocation is immediate for *new* registrations. |
| 3 | **Every Warden account is created on `+warden`.** | Dedicated identity by construction. Collision with a customer account is impossible unless the person already holds `x+warden@`. |
| 4 | **Registration creates the account through the existing invite machinery** (`AdminCreateUser` → forced password change → TOTP), never a new auth flow. | One sign-in path to maintain. The person still chooses their own password and enrols their own authenticator. |
| 5 | **The invitation email is sent by us via `shared/email.ts` (Resend), not Cognito's default sender** — for both the public link flow and the manual Add-member dialog. | Consistent with `AGENTS.md` ("all transactional email goes through `shared/email.ts`") and actually deliverable. Cognito's sender is `no-reply@verificationemail.com`, 50/day, spam-prone. Cost: the API generates and briefly holds a **one-time** temporary password. |
| 6 | **Only the SHA-256 of the token is stored; the URL is shown once.** | A database leak yields no live links. Lost link → create a new one. |
| 7 | **The token travels in the URL fragment** (`/join#t=<token>`) and in POST bodies. | It never reaches API Gateway access logs, CloudWatch, or `Referer`. |
| 8 | **The public join surface is a separate Lambda and a separate API Gateway resource with no authorizer.** | The authenticated router keeps its property "every route declares a minimum role", so the RBAC matrix test stays meaningful; the unauthenticated surface gets its own tight IAM. |
| 9 | **Any role is allowed on a link, including `owner`.** | Matches the operator's ask. The create dialog and the runbook state plainly that an owner link is equivalent to handing over the keys. |
| 10 | **Manual Add-member also aliases and refuses customer accounts.** | Closes the 2026-11-03 vector. Behaviour change, called out in §9. |
| 11 | **The product refuses any `+tag` address.** | Keeps the alias namespace out of the customer namespace; a Warden identity can never double as a product account. Enforced in `auth-magic-sync`, mirrored in the login form. |

### 2.1 What v1 deliberately does not do

- No per-address allowlist on a link (the operator does not have the addresses —
  that is the point of the feature).
- No role change on an existing link (revoke + create).
- No automatic removal of people who already registered when a link is revoked
  (that stays the audited member removal — with one exception, §6.5).
- No PreSignUp Cognito trigger: the product's only account-creating path is
  `auth-magic-sync`, which enforces the plus-tag rule. A direct `SignUp` call is
  not a product surface. Revisit if the product ever adds native Cognito sign-up.

---

## 3. Email aliasing

`infra/services/shared/admin-email.ts` — the single implementation, shared by the
join API and the member dialog.

```ts
interface AdminEmail { original: string; adminEmail: string; changed: boolean }
export function toAdminEmail(raw: string): AdminEmail
```

Rules, in order:

1. Trim; lowercase the whole address (Cognito treats the email alias
   case-insensitively for sign-in; lowercasing avoids two identities that differ
   only by case).
2. Split on the **last** `@`. Fewer than one `@`, empty local part, empty domain,
   or a result over 254 characters → `BAD_REQUEST`.
3. If the local part already ends with `+warden` → unchanged (`changed: false`).
4. Otherwise append `+warden` to the local part *as typed*:
   `john+work@gmail.com` → `john+work+warden@gmail.com`. We never strip an existing
   tag, because on some corporate servers a plus-tag is meaningful routing, and
   stripping it would silently redirect a person's mail.
5. Return the original alongside the result so the UI can show the difference.

Edge cases the tests must cover: plain address, already-aliased (idempotent),
existing `+tag`, uppercase, subdomain, local part at the length limit, missing
`@`, whitespace, trailing dot.

**Provider caveat.** Plus addressing is a receiver convention. Gmail, Outlook,
Fastmail, Proton and Yahoo support it; a few corporate servers reject it, and the
invitation would bounce. The join page always shows the exact address it will
use, and the owner's fallback is a manual add with an explicit address (§9).

---

## 4. Data model

Appended to `infra/sql/001-schema.sql`, idempotently (one consolidated file; do
not create `002-*.sql`).

```sql
CREATE TABLE IF NOT EXISTS admin_invite_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash        TEXT NOT NULL UNIQUE,             -- sha256 hex; never the token
  role              TEXT NOT NULL
                      CHECK (role IN ('analyst','support','admin','owner')),
  created_by_sub    TEXT NOT NULL,
  created_by_email  TEXT NOT NULL,
  reason            TEXT NOT NULL,                    -- min 8 chars, same rule as audit
  expires_at        TIMESTAMPTZ NOT NULL,
  max_uses          INTEGER NOT NULL DEFAULT 5
                      CHECK (max_uses BETWEEN 1 AND 50),
  use_count         INTEGER NOT NULL DEFAULT 0,
  revoked_at        TIMESTAMPTZ,
  revoked_by        TEXT,
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_invite_links_created
  ON admin_invite_links (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_invite_redemptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      UUID NOT NULL REFERENCES admin_invite_links(id) ON DELETE CASCADE,
  cognito_sub  TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_invite_redemptions_link
  ON admin_invite_redemptions (link_id, created_at DESC);
```

No membership state is mirrored in Postgres — Cognito groups remain the single
source of truth (architecture D3). This table only records *how* someone got in.

Audit rows for redemptions use a system actor (see §7.4).

---

## 5. Flows

### 5.1 Owner creates a link

1. **Members → Invite links → Create link.**
2. Fields: role, lifetime (`24h` / `72h` / `7d` / `30d` / `365d`, default `7d`), max uses
   (default 5, range 1–50), reason (≥8 chars, mandatory).
3. Fresh auth required (`requireFreshAuth`, 10 min) — same as every other
   membership change. `ReauthNotice` handles the dead end.
4. Response returns the URL **once**:
   `https://warden.tradewizard.live/join#t=<base64url-32-bytes>`.
5. Dialog shows the URL with a copy button and a warning (owner links get an
   extra sentence). After dismissal the URL is unrecoverable.
6. Audited: `admin.invite_link.create`, `before: null`,
   `after: { role, expiresAt, maxUses, linkId }` — never the token or hash.

### 5.2 Invitee registers

1. Opens the link → `/join` (public route). The page reads `location.hash`,
   strips `#t=`, and calls `POST /join/lookup`.
2. Page shows the role and asks for their email (optional full name).
3. Live preview: **"You will sign in as `name+warden@gmail.com`"**, with the
   address updateable only by editing the email field.
4. Submit → `POST /join/register`. The server:
   1. resolves the token hash and **reserves a use atomically**
      (`UPDATE … SET use_count = use_count + 1, last_used_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND use_count < max_uses RETURNING *`; zero rows → 409 with the precise
      state);
   2. aliases the email; refuses if that Cognito identity already exists (409);
   3. `AdminCreateUser` (`MessageAction: "SUPPRESS"`, `email_verified: true`) and
      `AdminSetUserPassword` (`Permanent: false`) with a generated temporary
      password;
   4. `AdminAddUserToGroup` with the link's role group;
   5. inserts the redemption row;
   6. sends the invitation email via `shared/email.ts`;
   7. writes the audit row(s).
   On any failure after step 1, the use is compensated (decrement) and the
   audit row is completed `failed`.
5. Success card shows the exact sign-in address, tells them to check that inbox
   (including the spam folder), and links to `/login`.

### 5.3 Invitee signs in

`/login` accepts the ordinary address and resolves its `+warden` alias before
calling Cognito: the resolved identity is returned to the provider, so the
`NEW_PASSWORD_REQUIRED` and TOTP challenge responses use the right username.
Accounts created before aliasing still work — a rejected alias identity falls
back to the address as typed. Then: existing `NEW_PASSWORD_REQUIRED` step (they
choose their own password) → existing TOTP enrolment (`/bootstrap`) → `/overview`.

### 5.4 Owner revokes a link

1. **Members → Invite links → Revoke** (reason + fresh auth).
2. `revoked_at` set; every later lookup/register returns the revoked state
   immediately.
3. Optional checkbox (default **on**): **"Also disable accounts created by this
   link that never signed in"** — for each redemption whose Cognito status is
   `FORCE_CHANGE_PASSWORD`, call `AdminDisableUser`. This closes the gap where a
   burned link leaves week-long temporary passwords live. Accounts that have
   already signed in are never touched.
4. Audited: `admin.invite_link.revoke`, `after: { linkId, disabled: n }`.
5. Registered members remain members until removed in the member table (existing,
   audited, with `AdminUserGlobalSignOut`).

### 5.5 Link state machine

```
active ──(expires_at < now())──────────▶ expired
   │──(use_count >= max_uses)──────────▶ exhausted
   └──(revoked_at set)─────────────────▶ revoked
```
Terminal states are computed, not stored (except `revoked_at`). No un-revoke.

---

## 6. Backend

### 6.1 Owner routes (authenticated router, `admin-api`)

| Method | Path | Min role | Notes |
|---|---|---|---|
| `GET` | `/admin/invite-links` | owner | list + computed status + uses + last used; no token |
| `POST` | `/admin/invite-links` | owner | fresh auth; returns URL **once** |
| `GET` | `/admin/invite-links/{id}/redemptions` | owner | who came through it |
| `DELETE` | `/admin/invite-links/{id}` | owner | fresh auth; `{ reason, disableUnclaimed? }` |

Every route: zod body validation, audit row written before the action, idempotency
not required (create is naturally non-repeatable because the URL is not stored;
revoke is idempotent-by-state → 409 if already revoked).

Route rows are added to the RBAC matrix in `handler.test.ts`; the build fails
without them (architecture §13).

### 6.2 Public routes (new `admin-join` Lambda, no authorizer)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/join/lookup` | `{ token }` | `{ status, role, expiresAt, remainingUses }` |
| `POST` | `/join/register` | `{ token, email, fullName? }` | `{ adminEmail, role, status: 'invited' }` |

**Unknown token → 404**; a token that exists but is expired/exhausted/revoked →
**200 with `status`**, so the page can explain the situation. Guessing a live
token is 256-bit infeasible; distinguishing "unknown" from "inactive" for a
*known* token is useful and not a leak.

Error codes stay inside the closed set (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`,
`RATE_LIMITED`, `UPSTREAM_FAILED`, `INTERNAL`).

### 6.3 Infrastructure

- New `infra/services/admin-join/handler.ts` (Node 20, 512 MB, 20 s).
- IAM: `cognito-idp:AdminCreateUser`, `AdminSetUserPassword`,
  `AdminAddUserToGroup`, `AdminGetUser`, `AdminDisableUser`, `ListUsers` on the
  pool; DB secret read; rate-limit table read/write. Nothing else — no S3, no
  queues, no risk engine.
- Env: `USER_POOL_ID`, DB vars, `ADMIN_APP_URL`, `EMAIL_PROVIDER`,
  `RESEND_*`, `RATE_LIMIT_TABLE`.
- API Gateway: new root resource `/join` with `{proxy+}`, `ANY`, integrated with
  the new Lambda and **no `authOptions`**. Same CORS allowlist as the admin API
  (the join page is served from the admin origin). Stage throttle applies.
- `admin-api` gains `AdminSetUserPassword`? No — only `admin-join` sets
  passwords. `admin-api` gains nothing new except DB tables (already covered).
- `admin-stack.ts` output/env: `ADMIN_APP_URL` for building the link
  (prod `https://warden.tradewizard.live`, dev `http://localhost:3001`).

### 6.4 Rate limiting

Reuse `lib/rate-limit.ts` semantics on the existing rate-limit DynamoDB table:

| Key | Limit | TTL |
|---|---|---|
| `join#ip#<sourceIp>` | 5 / hour | 1 h |
| `join#link#<linkId>` | 10 / hour | 1 h |
| `join#global` | 50 / day | 24 h |

Exceeding → `429 RATE_LIMITED` with a friendly message. Unlike the admin limits
(fail-open), the **global** counter fails closed for registration: a broken
counter must not turn into an unbounded account-creation/email-sending vector.
Per-IP and per-link stay fail-open so a DynamoDB blip does not block a legitimate
invitee.

### 6.5 Invitation email (Resend)

Sent through `shared/email.ts` (never a direct provider call), from the existing
`SUPPORT_FROM_EMAIL` identity (`support@tradewizard.live`), **no Reply-To** — the
support plan deliberately has no inbound mailbox yet (§5 there). Copy states that
plainly.

Contents:

- Subject: "Your TradeWizard Warden access".
- The **exact sign-in address** (`x+warden@…`) — this is the point of the feature.
- The temporary password.
- "You will be asked to choose your own password, then add an authenticator
  (TOTP)." Temporary passwords are valid for 7 days (pool
  `tempPasswordValidity`).
- Link to `ADMIN_APP_URL/login`.
- Warning that the account is for the operations portal only and must not be
  used for the customer product.

Temporary password generation: 20 characters from an unambiguous alphabet,
guaranteed to contain upper, lower and digit (pool policy: ≥8, upper, lower,
digit). Never logged, never audited, never returned in an API response.

**Failure handling.** If Cognito creation succeeds but the email fails, retry
once, then return `502 UPSTREAM_FAILED` with
`details: { accountCreated: true, emailSent: false }` and complete the audit row
`failed`. The reserved use is **not** released — the account exists, so giving
the slot back would allow a second account. The runbook documents the owner-side
recovery (Cognito `admin-set-user-password` + resend, or disable + new link).
Failures *before* the account exists release the use.

The manual Add-member dialog uses the same email sender and temporary-password
generator; a delivery failure there is reported in the response (`emailSent:
false`) without undoing the account or the group.

### 6.6 Audit

| Action | Actor | When |
|---|---|---|
| `admin.invite_link.create` | owner identity | link minted |
| `admin.invite_link.revoke` | owner identity | link revoked |
| `admin.member.self_register` | system (`invite-link:<id>`) | account created through a link |

The system actor needs a small helper — `writeSystemAuditLog(client, { actorSub,
actorEmail, action, ... })` in `lib/audit.ts` wrapping `insertChainedAuditRow`
directly — because `writeAuditLog` takes an `AdminIdentity` whose role is the
four-role union. Values: `actorSub = invite-link:<linkId>`,
`actorEmail = <the +warden address>`, `actorRole = 'system'`. This matches the
"system" precedent used by plan-override expiry.

The token, its hash, and the temporary password never appear in `before`,
`after`, `error`, or logs.

---

## 7. Frontend (`tradewizard-admin/`)

### 7.1 Routes

| Path | Guard | Purpose |
|---|---|---|
| `/join` | **public** | link landing + registration |
| `/members` | authed, owner-only UI | existing members + new Invite links panel |

`proxy.ts`: treat `/join` like `/login` for the unauthenticated case, but do not
redirect an authenticated visitor away from it (an operator may open their own
link to check it). Everything else unchanged.

### 7.2 Screens

- `components/members/InviteLinksPanel.tsx` — table: role, created by, created,
  expires, uses `n/max`, status pill, last used; Create and Revoke actions.
  Uses `Page`/`Panel`/`Dialog`/`ReauthNotice` per architecture §9.1; no new
  primitives.
- `CreateInviteLinkDialog` — role select (owner gets an explicit warning line),
  lifetime, max uses, reason ("Why are you making this change?"). Success state
  shows the URL once with copy; closing loses it.
- `RevokeInviteLinkDialog` — reason, "disable accounts that never signed in"
  checkbox (default on), warning about how many redemptions exist.
- `app/join/page.tsx` + `components/join/JoinForm.tsx` — lookup → email →
  preview → submit → success card; explicit `expired` / `revoked` / `exhausted` /
  `not-found` states with "ask the owner for a new link".
- Login page: one-line hint — "Warden accounts sign in with the `+warden` address
  you registered with."
- `hooks/useInviteLinks.ts`; type additions in `types/admin.ts`; audit actions
  added to `constants/audit-actions.ts`.

### 7.3 UX rules that matter here

- Show the resolved address **before** submit, not after — a person who does not
  receive plus-mail must learn it before an account exists.
- The success card is the only place the sign-in address is stated unambiguously;
  make it copyable.
- Never render the link URL again after the create dialog closes.
- Errors are specific (§9.2 of the architecture): "That link was revoked on
  12 Nov 2026", not a generic toast.

---

## 8. Security analysis

| Threat | Mitigation |
|---|---|
| Link forwarded beyond the intended people | Expiry, use cap, revocation, per-redemption visibility in the members UI |
| Stolen link used before the owner notices | Per-IP/hour limits, `admin.member.self_register` audit rows naming the link, revoke + disable-unclaimed |
| Owner link leaked | Same controls, plus an explicit warning at creation and in the runbook; the blast radius is the whole portal, so short lifetimes are recommended |
| Token harvested from logs/URLs | Fragment URL, POST body only, hash-only storage, no token in audit or logs |
| Account enumeration at the public endpoint | Registration reveals "already registered" only for the address the caller typed; lookup reveals link state only, never member data |
| Email spam / account-creation flood | Global daily cap fails **closed**, per-IP and per-link limits, API Gateway throttle, token required |
| Temp password intercepted | One-time, 7-day expiry, forced change at first sign-in, TOTP required before any admin route works (authorizer) |
| Customer account takeover by aliasing | Aliasing produces a *new* identity; the product identity is never touched. Manual add now refuses customer accounts (§9) |
| A Warden identity doubles as a product account | The product rejects every `+tag` address at `auth-magic-sync` (server) and in the login form, so the alias namespace stays disjoint (`shared/email-policy.ts`) |

Residual risks, accepted and documented: a link is a bearer token; an invitee
with a provider that rejects plus-addressing cannot register; revocation does not
retroactively remove people who already signed in.

---

## 9. Manual Add-member hardening (same PR boundary as slice 4)

`POST /admin/admins` changes:

1. Resolve the typed address with `toAdminEmail` **before** any Cognito call.
2. If the typed address belongs to an existing **non-admin** Cognito user →
   `409 CONFLICT`: "That address belongs to a product account. Invite
   `<alias>` instead.", with the alias in `details.adminEmail`. No group is
   attached (this is the 2026-11-03 vector).
3. If the typed address (or its alias) already belongs to an **admin** → current
   behaviour (add / conflict) unchanged, so existing members stay manageable.
4. If nobody matches → create with the **aliased** address; dialog shows the
   resolved address before confirming and the success message repeats it.
5. Existing plain-email admins (e.g. the owner's own `azeezbalogun74@gmail.com`)
   keep working exactly as today; `/admin/me` still reports `linked: true` for
   them and the overview keeps its warning.

Runbook §1.1 is updated to match.

---

## 10. Slices

Each slice is independently deployable to dev, independently verifiable, and
**not done until §15 and architecture §14.4 carry a row**.

| # | Slice | Depends on | Definition of done |
|---|---|---|---|
| 1 | **Email normalizer** — `shared/admin-email.ts` + unit tests | — | `toAdminEmail` covered by the edge cases in §3; no behaviour change anywhere yet |
| 2 | **Links: schema + owner API + UI** — migration, 4 routes, audit actions, matrix rows, members panel | 1 | Owner can mint/list/revoke a link in dev; URL shown once; revoke takes effect on lookup; audit rows visible; `npm run verify` green |
| 3 | **Public join** — `admin-join` Lambda, `/join/{proxy+}` without authorizer, Resend invitation, `/join` page | 2 | End-to-end in dev: create link → incognito → register → email arrives → sign in as `+warden` → password change → TOTP → `/overview`; revocation, expiry and exhaustion produce the right states; rate limits return 429 |
| 4 | **Add-member hardening** — alias + refuse customer accounts, dialog copy, runbook §1.1 | 1 | Adding a customer address returns 409 with the alias and changes nothing; adding an unknown address creates `x+warden@`; existing admins unaffected |
| 5 | **Docs + hardening sweep** — architecture §6/§7/§8/§9/§12/§14, runbook section, threat table, progress rows | 3, 4 | Doc and code agree; §12 checklist rows added; full manual pass recorded |

Deliberately ordered so the risky public surface lands **after** the owner-side
controls exist, and so the aliasing rule is proven before the unauthenticated
endpoint depends on it.

---

## 11. Verification

**Automated (infra, `npm test` / `npm run verify`)**

- Normalizer: the §3 edge cases, including idempotence and length limits.
- Product email policy: `hasPlusTag` rejects every tag form and allows plain
  addresses; `auth-magic-sync` returns `400 PLUS_TAG_NOT_SUPPORTED` before any
  Cognito call.
- `admin-join`: unknown/expired/revoked/exhausted tokens; race on `max_uses`
  (two concurrent registrations for a 1-use link → exactly one account);
  existing identity → 409; Cognito failure → compensated use + `failed` audit;
  Resend failure → `502` + `accountCreated: true`.
- Owner routes: RBAC matrix rows (a route without one fails the build); fresh
  auth enforced; revoke twice → 409; token/hash absent from every audit payload
  and log line (grep-style assertion).
- Migration: run `001-schema.sql` twice against a fresh DB; verify the new
  tables and constraints are idempotent.

**Automated (admin)**

- `npm run typecheck`, `npm run lint`, `npm run build`.

**Manual (dev, recorded in the progress log)**

1. Mint an `analyst` link; open it in a private window; register with a Gmail
   address; confirm the page names `x+warden@gmail.com`.
2. Confirm the Resend email arrives with the same address and a temp password.
3. Sign in, change the password, enrol TOTP, land on `/overview` with analyst
   read-only nav.
4. Mint a 1-use link; use it twice → second attempt shows `exhausted`.
5. Revoke a link with an unclaimed invite → lookups say revoked, the unclaimed
   account reports `UserStatus: DISABLED` in Cognito.
6. Flame the endpoint: >5 registrations from one IP → 429.
7. `GET /admin/audit/verify` still reports a valid chain after all of the above.

---

## 12. Docs updated in the same PRs

- `docs/admin-portal-architecture.md`: §6.1 (dedicated identities → aliasing and
  links), new §6.6 "Invite links and email aliasing", §7.2 route table, §7.4
  shared refactors (`admin-email.ts`, system audit writer), §7.7 IAM table, §8.1
  tables, §9.1 layout, §12 checklist additions (token hashing, fragment URL,
  public-endpoint rate limits, no credentials in logs), §14.1 slice rows, §14.4
  progress rows.
- `docs/admin-portal-runbook.md`: "Invite someone with a link" (issue, share,
  revoke, recovery when an address is mistyped or the email never arrives), and
  the §1.1 update for aliasing.
- `AGENTS.md`: one line pointing at this plan, next to the newsletter and support
  pointers.

---

## 13. Operational notes

- **Mistyped address.** The account exists with a wrong `x+warden@`. Recovery:
  disable it (Cognito), then mint a new link. It can never be retargeted.
- **No email arrives.** Check the person's provider supports plus addressing;
  check Resend's delivery log; check the Cognito user exists with
  `FORCE_CHANGE_PASSWORD`. Fall back to a manual add with an explicit address.
- **Link leaked.** Revoke with disable-unclaimed on, then review the redemption
  list and the audit log (`admin.member.self_register` rows name the link).
- **Cost.** Negligible: one Lambda invocation per registration and per lookup,
  one Resend email per member.

## 14. Follow-ups deliberately not in v1

1. **Per-address pre-approval** on a link (allowlist) for teams that do know the
   addresses.
2. **"Resend invitation"** owner action for a pending `FORCE_CHANGE_PASSWORD`
   account.
3. **Custom Cognito invitation template** — unnecessary while we send the email
   ourselves, but relevant if the product ever starts using SES for pool mail.
4. **Product-side guard** rejecting `+warden` addresses at customer sign-up, to
   keep the two identity families visibly separate.
5. **Link labels/notes** so several live links are distinguishable in the table
   (v1 has role + creator + timestamp).

---

## 15. Slice log

Append a row per PR. Never rewrite history; if something is reversed, add a row.

| Date | Slice | Status | What landed |
|---|---|---|---|
| 2026-11-12 | Plan | Agreed | Design accepted: role-carrying revocable links, `+warden` aliasing on every Warden account, Resend-delivered invitations, separate unauthenticated join Lambda, manual-add hardening |
| 2026-11-12 | 1 — Normalizer | Done | `services/shared/admin-email.ts` (`toAdminEmail`, `isAdminAlias`) + 27 tests: append `+warden`, idempotent, existing `+tag` preserved, case folding, structural validation, 254-char ceiling |
| 2026-11-12 | 2 — Schema + owner API + UI | Code done | `admin_invite_links` + `admin_invite_redemptions` (token hash only, role/uses CHECKs); `shared/invite-token.ts` (32-byte token, SHA-256, derived status) and `shared/invite-links.ts` (atomic `reserveInviteUse`); four owner routes with fresh auth + mandatory reason + `admin.invite_link.*` audits; revoke can disable unclaimed accounts; Members panel with one-time URL, revoke dialog, redemption drill-down; RBAC matrix rows. 405 admin-api tests |
| 2026-11-12 | 3 — Public join | Code done | `admin-join` Lambda behind `/join/lookup` and `/join/register`, own API Gateway resource without the authorizer, creation-only IAM; aliased registration with `AdminCreateUser` (suppressed) + `AdminSetUserPassword(Permanent:false)` + group add + redemption + Resend invitation; atomic use reservation with compensation; 5/h/IP, 10/h/link, 50/day global (fails closed); `writeSystemAuditLog` for the `system` actor; role model extracted to `shared/admin-roles.ts`; `/join` page reads the fragment and clears it; `proxy.ts` exemption; login prefill. 22 join tests |
| 2026-11-12 | 4 — Add-member hardening | Code done | Manual add aliases, refuses product accounts via `users.cognito_sub`, keeps existing admins working, shows the resolved address; both invite paths now deliver through `shared/admin-invite-email.ts` (Resend) instead of Cognito's sender. Tests cover the customer refusal and the aliased invite |
| 2026-11-12 | 5 — Docs | Done | Architecture §6.6, §7.2, §7.4, §7.7, §8.1, §8.4, §9.1, §12, §14.1, §14.4; runbook §1.1a/§1.1b; `AGENTS.md` pointer; this log |
| 2026-11-12 | 6 — Lifetime + login aliasing | Code done | Link lifetime ceiling raised to 365 days (server `MAX_INVITE_LIFETIME_HOURS = 8760`, UI option added). Login resolves the `+warden` alias automatically and returns the identity that authenticated so challenge responses use it; falls back to the typed address once if Cognito rejects the alias, preserving pre-aliasing accounts |
| 2026-11-12 | 7 — `+warden` tag + product guard | Code done | Alias tag renamed from `+admin` to `+warden` across code, tests and docs (no deployed accounts existed). New `shared/email-policy.ts`: the product refuses **any** `+tag` address — enforced in `auth-magic-sync` (`400 PLUS_TAG_NOT_SUPPORTED`) and mirrored in the product login form, which validates before Magic sends a code. The error copy deliberately never mentions the portal. Tests: policy unit cases + handler 400s. |
| — | Dev verification | **Pending** | Create → register → email → sign-in → TOTP; revocation/expiry/exhaustion states; rate-limit 429; audit chain still verifies. Checklist in §11 |
