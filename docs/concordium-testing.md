# Testing the Concordium integration

Four layers, cheapest first. Each one catches a different class of mistake, and
the later ones only make sense if the earlier ones pass.

```bash
cd infra && npm run build && npm test          # layer 1: unit
npx tsx scripts/concordium/agent.mjs info      # layer 2: on-chain CLI
npx tsx scripts/concordium/e2e.ts --link-fixtures   # layer 3: deployed API
```

## Layer 1 — unit tests (no chain, no AWS)

```bash
cd infra
npm run build     # tsc, typechecks the handlers and the scripts
npm test          # vitest
```

Covers the parts that are pure logic and the parts that fail silently:

| Suite | What it pins down |
| --- | --- |
| `services/shared/concordium/*` | MCP client envelope and errors, badge policy (`verified`/`registered`/`unknown`), byte-exact card hashing, Merkle root and inclusion proofs, ordered-pair hashing |
| `services/concordium-agent/handler.test.ts` | every route, auth failures, UUID gating, card hash mismatch, card hash → 409, token-address shape, proof rebuild refusal |
| `services/concordium-anchor/handler.test.ts` | staging, duplicate epochs, per-agent failure isolation, the ASCII-root encoding, metadata key format |

This layer is where a regression should be caught. Anything it cannot express —
real chain state, real Cognito, real Postgres — belongs to the layers below.

## Layer 2 — on-chain CLI (needs a funded testnet account)

One-time setup: `docs/concordium-testnet-setup.md`.

```bash
cd infra
export CONCORDIUM_ACCOUNT=43WTW…
export CONCORDIUM_KEY_HEX=$(CONCORDIUM_SEED_PHRASE="…" \
  npx tsx scripts/concordium/derive-key.mjs --address "$CONCORDIUM_ACCOUNT" \
  | grep CONCORDIUM_KEY_HEX | cut -d= -f2)

node scripts/concordium/agent.mjs info                       # contracts + network health
node scripts/concordium/agent.mjs card …                     # build a card, print its hash
node scripts/concordium/agent.mjs register … --dry-run       # sign without submitting
node scripts/concordium/agent.mjs check --token <address>    # badge verdict
npx tsx scripts/concordium/anchor-proof.ts anchor --file … --token-id 1224
npx tsx scripts/concordium/anchor-proof.ts prove  --file … --decision <id>
npx tsx scripts/concordium/anchor-proof.ts tamper --file … --decision <id>
```

Always run `--dry-run` first: it exercises build → sign → serialise against the
real chain nonce and tells you the transaction size without spending anything.

## Layer 3 — deployed API end to end

Requires the stack up (`./deploy.sh up dev`) and database access:

```bash
cd infra
set -a && source .env.dev && set +a
export DB_SECRET_ARN=tw-dev-concordium-db-credentials
export DB_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier tw-dev-concordium-postgres --region us-east-1 \
  --query "DBInstances[0].Endpoint.Address" --output text)

npx tsx scripts/concordium/seed-demo.ts --decisions     # fixture agent + decisions
npx tsx scripts/concordium/e2e.ts --link-fixtures       # 25 checks
```

`e2e.ts` creates a Cognito test user in the namespaced pool, authenticates with
`ADMIN_USER_PASSWORD_AUTH` (including `SECRET_HASH`), provisions the `users` row
the post-confirmation trigger would create, and then asserts:

| Group | Assertions |
| --- | --- |
| Auth | token issued; unauthenticated list is 401 |
| Create | 201, status `pending`, public card URL |
| Card | wrong hash → 400; correct hash stored |
| Hosting | public 200; served SHA-256 equals the pinned hash; `no-store` |
| Mint | a token already claimed by another agent → 409 |
| Verify | live registry call → `trust: verified`, no error issues |
| Anchors | epoch list is non-empty; epoch decisions expose a leaf but no reasoning |
| Proof | 200; recomputes to the root; on-chain value matches |
| Tamper | decision edited → 409 `epoch_not_reproducible`, then restored |
| Guards | unknown agent 404; non-UUID card id 404 |

`--link-fixtures` repoints the seeded agent and its sessions at the test user so
the authenticated read paths run against real data (token 1224, a real anchored
epoch, real decisions) instead of an empty agent. Without it you get the write
path only.

## What is still untested

- **x402 payments** — not built. Nothing to test.
- **The accountability panel** (`components/concordium/TrustPanel.tsx`) is
  type-checked and included in a production build, and every endpoint it calls
  is covered by the e2e (agents, verify, anchors, epoch decisions, proof). What
  is *not* automated is the visual check: it needs a magic-link login, so the
  render itself is verified by eye. Its card-integrity row hashes the served
  bytes with `crypto.subtle` in the browser, which is the one check that does
  not go through our API.
- **Ownership checks on mint** — the API records whatever token address it is
  given; canonical validity is decided by the registry at verification time.
  Making `mint` call the registry's `token_address` tool and compare would close
  that gap.
- **Concurrency** — two simultaneous anchors for one agent are covered by a
  unique index and a duplicate-detection test, but not by a load test.

## Bugs this sequence actually caught

Worth recording, because each was invisible to the layer above it:

1. **Non-UUID path ids 500'd.** Only visible against a real Postgres — the
   in-memory repository accepted any string. Found by curling the deployed URL.
2. **The anchoring job staged an unwritable payload.** Raw Merkle bytes are
   rejected by CIS-8004 (`-7208`); the CLI had been fixed, the service had not.
   Found by confirming a staged anchor on chain.
3. **The mint route validated a token address with the account regex**, so every
   genuine CIS-2 address was rejected. Found by the e2e's first real mint.
4. **A claimed token returned 500 instead of 409.** The unique index fired and
   the handler had no mapping for it. Found by the same e2e.
5. **The proof endpoint could not read its own on-chain value.** It expected a
   32-byte digest; the registry stores the 64-character root as UTF-8 text. Found
   by the e2e's `onChain.matches` assertion.
