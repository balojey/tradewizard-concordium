# TradeWizard

> AI prediction-trading platform for Polymarket — with accountability built into the agent itself.

TradeWizard turns prediction markets from speculative guessing into guided, intelligence-driven trading. A multi-agent system analyses live markets and produces explainable recommendations, and an autonomous Portfolio Manager executes them under hard risk limits.

This repository is the **Concordium Trusted Agents Hackathon** build. It takes the agent we already run and gives it what the brief asks for: a verified human behind it, a record of what it did that anyone can check, and — next — the ability to pay and be paid on its own.

---

## Why this submission fits the brief

The hackathon brief is "add trust and accountability to the AI agents you already have", and autonomous trading is the sharpest version of the problem: our agent **spends real money on someone's behalf**, and until now a counterparty had no way to know whether a named human stood behind it or a rented farm.

| Brief | What we built |
| --- | --- |
| Prove a verified human stands behind the agent | Agent registered in the CIS-8004 registry, its Polymarket key bound through CIS-8, carrying the Verified by Concordium badge |
| Keep a record of what it did | Every decision the agent makes is hashed into a Merkle root and pinned as registry metadata; subscribers get inclusion proofs they can recompute |
| Pay and get paid on its own | Designed, not yet built — x402 with sponsored fees, deliberately time-boxed behind the two above |

We did not migrate anything to Concordium. The agent keeps executing on Polygon/Polymarket; Concordium is the identity and audit anchor, which is exactly the "one agent, native to another chain" topology the registry documents.

---

## What already runs (the platform)

- **14 specialised intelligence agents** on every market — no conditional selection, all in parallel
- **11-stage analysis pipeline**: data preparation → memory → web research → parallel agents → deterministic signal fusion → bull/bear theses → cross-examination → deterministic consensus → risk-philosophy sizing → recommendation
- **Autonomous Portfolio Manager** that places and exits real Polymarket positions under stop-loss, take-profit, position-size and cumulative-loss limits
- **Real-time delivery** over WebSocket, email, push and webhook
- **On-chain subscriptions** in USDC.e on Polygon, with credits, plans and renewals

## What this build adds (the trust layer)

```
                     ┌─────────────────────────────┐
                     │  Concordium (identity)      │
   operator  ────────▶  account · CIS-8004 agent NFT │
   (verified human)   │  CIS-8 ← Polymarket key      │
                     └──────────────┬──────────────┘
                                    │  Agent Card + badge (public URL, pinned hash)
                     ┌──────────────▼──────────────┐
                     │  TradeWizard (execution)     │
                     │  decisions → Merkle root     │
                     │  root → agent metadata       │
                     └──────────────┬──────────────┘
                                    │  inclusion proof
                              subscriber verifies
```

| Piece | State |
| --- | --- |
| Registry client, badge policy, card hashing, Merkle proofs | ✅ built, 60 unit tests |
| `concordium_agents` / `concordium_audit_anchors` schema | ✅ built |
| Agent registry API + public card hosting | ✅ built, 32 handler tests |
| Epoch anchoring job (6-hourly, staged for signature) | ✅ built, 14 tests |
| Root anchored on-chain + proof verified | ✅ executed: `decisionRoot:20261117T101219.740Z` pinned on token `1224`, reads back identical |
| Inclusion-proof endpoint | ✅ built, verified against anchored root |
| Mint → live `badge_valid: true` | ✅ executed: token `1224` on testnet, 15/15 checks, zero issues |
| CIS-8 binding to the Polymarket signer | ✅ executed: `eip155:137` secp256k1 key registered and attached to token `1224` |
| x402 payments | ⛔ unproven, deferred by design |

Honest summary: **the identity half is live** — agent token `1224` on Concordium testnet, card hash pinned on-chain, `badge_valid: true` across all 15 checks. The audit mechanism is live too: a 5-decision epoch is pinned on token `1224` and reads back byte-identical, and an inclusion proof recomputes to that root. What is still unbuilt is the Aurora-backed proof endpoint — the code exists and is tested, but it needs the stack deployed. See `docs/concordium-spike.md` for exactly what was proven against the live service and what remains.

### How the pieces fit

1. **Identity.** The operator verifies once with a Concordium identity provider and registers their agent through our MCP client. The agent's Polymarket **signer** key (the EOA that authorises orders — not the Safe that holds funds) is bound on-chain via CIS-8, so identity on Concordium resolves to the key that actually trades on Polygon. The agent carries an A2A Agent Card at a public URL whose SHA-256 is pinned on-chain.
2. **Audit.** Every Portfolio Manager decision is already recorded with its action, conviction, reasoning and skip reason. The anchoring job hashes an epoch of decisions into a Merkle root and stages a registry metadata write pinning that root. A subscriber asks for an inclusion proof for their own trade and recomputes the root themselves.
3. **Refusal as evidence.** The proof endpoint rebuilds the epoch and **will not answer if the rebuild no longer reproduces the anchored root**. Editing or deleting a decision after the fact stops proofs rather than letting them verify against something else.

The badge means *accountable*, not *endorsed* — Concordium does not review our code or behaviour, and the UI says so.

---

## Repository map

```
infra/                     # AWS CDK + Lambda backend (TypeScript)
  services/                # Lambda handlers, one directory per service
  services/shared/concordium/  # registry client, badge policy, card hashing, Merkle proofs
  services/concordium-agent/   # agent registry API + public Agent Card hosting
  services/concordium-anchor/  # epoch anchoring job
  scripts/concordium/      # CLI that drives the actual on-chain writes
  sql/001-schema.sql       # one consolidated, idempotent schema
tradewizard-frontend/      # Next.js 16 App Router customer app
tradewizard-admin/         # Next.js 16 App Router internal portal
remotion/                  # Demo video composition
docs/                      # Design records, hackathon assessment and spike results
.kiro/                     # Specification and steering artifacts
```

## Documentation

- [`docs/concordium-integration-assessment.md`](docs/concordium-integration-assessment.md) — what Concordium's registry, badge and x402 actually provide, and what each costs to integrate
- [`docs/concordium-spike.md`](docs/concordium-spike.md) — spike results: what was proven against the live testnet, what is blocked and why
- [`docs/concordium-testnet-setup.md`](docs/concordium-testnet-setup.md) — getting a testnet identity and account, and handing the key to the CLI
- [`docs/concordium-polymarket-mapping.md`](docs/concordium-polymarket-mapping.md) — which Polymarket key is the agent, and why we bind the signer EOA rather than the Safe
- [`docs/concordium-attestation.md`](docs/concordium-attestation.md) — anchoring a decision epoch on-chain and proving one trade's inclusion
- [`docs/devpost-submission.md`](docs/devpost-submission.md) — the written submission
- [`docs/devpost-vo-script.md`](docs/devpost-vo-script.md) — three-minute demo script
- [`infra/README.md`](infra/README.md) — deployment details
- [`.kiro/steering/`](.kiro/steering/) — authoritative architecture notes

## Getting started

```bash
# Backend
cd infra
npm install
./deploy.sh up dev          # CDK + secrets + database migration
npm test                    # 950 tests
npm run synth:dev           # typecheck + synthesise without deploying

# Frontend
cd ../tradewizard-frontend
npm install
cp .env.example .env.local
npm run dev                 # http://localhost:3000
```

Driving the Concordium side (account required):

```bash
cd infra
export CONCORDIUM_ACCOUNT=<your testnet account>
export CONCORDIUM_KEY_HEX=<account key>
node scripts/concordium/derive-key.mjs --address <testnet account> --dry-run
node scripts/concordium/agent.mjs info
node scripts/concordium/agent.mjs card  --name "..." --description "..." --uri https://.../agent-card.json
node scripts/concordium/agent.mjs register --uri https://.../agent-card.json --hash <sha256> --dry-run
node scripts/concordium/agent.mjs check   --token <token_address>

npx tsx scripts/concordium/anchor-proof.ts anchor --file ../docs/agents/example-decisions.json --token-id <token>
npx tsx scripts/concordium/anchor-proof.ts prove  --file ../docs/agents/example-decisions.json --decision <decision id>
```

## Prerequisites

| Requirement | Used by |
| --- | --- |
| Node.js 20 | all packages |
| AWS account | `infra/` (CDK) |
| Concordium testnet account + identity | agent registration (identity must be identity-verified) |
| Polygon platform wallet | USDC.e subscriptions, portfolio execution |
| Cognito user pool | authentication |

## Notes

- `AI_PROVIDER=bedrock` (default) or `nebius`; the switch only changes inference, never order execution.
- All transactional email goes through `infra/services/shared/email.ts`.
- The registry service holds no keys: every on-chain write is a sign-ready payload that the account owner signs. Our infrastructure never holds user signing keys.

## License

MIT — see [LICENSE](LICENSE).

This repository is the public hackathon snapshot. The upstream production
repository is private and is not covered by this licence; secrets, credentials
and customer data are not part of this snapshot.

---

**Disclaimer**: TradeWizard provides AI-generated analysis for educational and informational purposes. All trading involves risk. Past performance does not guarantee future results. Trade responsibly.
