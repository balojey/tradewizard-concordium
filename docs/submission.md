# TradeWizard — accountable autonomous trading

**Concordium Trusted Agents Hackathon** · Encode Club · 2026

We took a prediction-market trading agent that already spends real money on-chain and made it answerable: a verified human stands behind it, its decisions are anchored so anyone can prove what it did, and registration is an API call plus a signature rather than a promise.

Repository: **https://github.com/balojey/tradewizard-concordium** (MIT)

---

## Status, precisely

The distinction between "built", "verified against the live service" and "executed on chain" is the whole point of this submission, so it gets stated first.

| | |
| --- | --- |
| **Executed on chain** | Agent token **1224** (`JyP9XfKVsCUMaaEsDtyoS`) minted on Concordium testnet by an identity-backed account; card hash pinned; `badge_valid: true` on all 15 registry checks; a `eip155:137` Polymarket **signer** key bound via CIS-8 and attached to the token |
| **Executed on chain** | An epoch of **three live-market decisions** anchored on token 1224 (tx `50e859b8…`, root `c6dc1081…`): each decision came from a real analysis of a real Polymarket market by the 14-agent pipeline, and each was a genuine `NO_TRADE` refusal with its own consensus/edge numbers. The root reads back byte-identical from the chain, an inclusion proof recomputes to it, and editing a decision afterwards makes the proof endpoint refuse with `409`. The same three markets are subscribed at a one-day interval, so the trail keeps growing |
| **Executed on chain** | Self-serve registration: the API returned a sign-ready payload, an external signer submitted it, and the mint was confirmed back into the API (testnet token `1454`) |
| **Deployed and running** | `TradeWizard-Concordium-Dev-*` in `us-east-1`; the anchoring job has run every 6 hours for a week with zero errors; the proof endpoint is live and covered end to end |
| **In the product** | An accountability panel on the Portfolio Manager page, with a one-line status on the portfolio page: badge state, live re-verify, browser-side card hash check, anchored epochs, per-decision proofs, and the `409` rendered as what it means. A signed-in user with no agent gets a registration flow — create, card (generated and hosted by the app), wallet-signed register, confirm — instead of a dead end |
| **Not built** | x402 payments. Designed, costed, and deliberately deferred — see below |
| **Not verified** | Browser-wallet signing. `payload`/`confirm` are proven with a local signer; the wallet connector is not wired in yet |

969 backend tests pass. A 28-check end-to-end suite runs against the deployed stack on every change.

---

## The problem

TradeWizard runs an autonomous agent that places real Polymarket positions with real money. It decides on its own to enter, hold or exit, under risk limits it cannot talk itself out of.

That is exactly the kind of agent this programme is about, and it has an obvious hole: a counterparty, a subscriber, or a regulator looking at a Polymarket strategy has no way to tell whether a named, accountable human stands behind it or whether it is a rented farm with a nice interface. The trades are on-chain; the accountability is not.

Two consequences follow. **Attribution:** someone verifiable must stand behind the agent, provably, without publishing who they are. **Audit:** the agent's decisions must be checkable by someone who does not trust our database.

## What was already running

This is not a weekend prototype wearing a badge. The platform behind it is live: 14 specialised intelligence agents analyse every market in parallel and fund into a deterministic consensus stage, and an autonomous Portfolio Manager places and exits positions under stop-loss, take-profit, position-size and cumulative-loss limits.

Crucially, it already records **why** it acted: every decision row stores its action, whether edge and alignment thresholds were met, a conviction score, written reasoning, and — when it declined — a skip reason. That log is the raw material for the audit half.

## What we added

### 1. A verified human behind the agent

The operator verifies once with a Concordium identity provider. Their agent is registered in the CIS-8004 registry as an NFT owned by that identity-backed account, with:

- an **A2A Agent Card** at a public URL whose SHA-256 is pinned on-chain, so the card cannot be swapped after the fact;
- a **CIS-8 binding** to the agent's `secp256k1` **Polymarket signer** key — the EOA that authorises orders, not the Safe or Deposit Wallet that merely holds the funds;
- the **Verified by Concordium badge** embedded as an A2A capability extension.

Verification is one unauthenticated HTTP GET:

```
GET https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9XfKVsCUMaaEsDtyoS
→ badge_valid: true   ·   15/15 checks   ·   no issues
```

The badge means **accountable, not endorsed**. Concordium has not reviewed our code, behaviour or results, and the product says so in those words.

### 2. An audit trail that survives not trusting us

Each epoch of decisions is hashed into a Merkle tree and only the root is written on-chain, as metadata on the agent NFT. The decisions are the platform's own: the epoch anchored on token 1224 covers three live Polymarket markets the agent analysed and then declined to trade. A subscriber asks for an inclusion proof for their own trade and recomputes the root against the value committed on chain. Nothing per-trade is published.

The part we are proudest of: **the proof endpoint refuses to answer when the epoch no longer rebuilds to its anchored root.** Delete or edit a decision after the fact and proofs stop being served rather than quietly verifying against a rewritten history. Pruning a row stops being a silent edit and becomes a detectable event.

### 3. Registration as an API, not a ritual

Minting, pinning a card, binding a key and linking it to the token are four owner-authorised writes. Our service holds no keys, so the API builds the sign-ready payload for each step and records the outcome once it is submitted:

| Step | Endpoint |
| --- | --- |
| create the record | `POST /concordium/agents` |
| publish the card (hash validated) | `POST /concordium/agents/{id}/card` |
| get a sign-ready payload | `POST /concordium/agents/{id}/payload` |
| record the submitted step | `POST /concordium/agents/{id}/confirm` |
| verify against the registry | `POST /concordium/agents/{id}/verify` |

Any signer can produce the signature — a wallet connector, a CLI, a custodian. That is what makes the model honest: we never hold a key that can write to someone's agent.

### 4. Payments — deliberately deferred

x402 lets an agent pay per call over plain HTTP with sponsored fees, so a user never holds CCD. We scoped it, costed it, and chose not to build it in this window: the scoring rewards depth and a believable route to production, and a shallow payment demo bolted onto two finished halves would make the submission weaker. The contract, flows and risks are documented in `docs/concordium-integration-assessment.md`.

## Why Concordium, and why not a migration

The brief says bring the agent you already run, and that is what we did. Polymarket execution stays on Polygon; Concordium is the identity and audit anchor — the "one agent, native to another chain" topology the registry documents, anchored by a CIS-8 dual-key proof.

What Concordium gives that the EVM does not: identity is enforced at account creation, so an account is backed by a verified identity by construction rather than by an optional attestation contract. That is the difference between a badge that means "this wallet signed something" and one that means "an identifiable human stands behind this".

## Evidence

| Claim | Where to check |
| --- | --- |
| Badge is valid, today | `GET /v1/check-badge/JyP9XfKVsCUMaaEsDtyoS` → 15/15, no issues |
| Agent on chain | [CCDScan registry contract (token 1224)](https://testnet.ccdscan.io/?dcount=1&dentity=contract&dcontractAddressIndex=12802&dcontractAddressSubIndex=0) |
| Owner account | [CCDScan account](https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=43WTW9mXTvFheLNjmsso5hDEJyYTdn8cssFXYDUHruUjqSSpMu) |
| Anchored root | metadata key `decisionRoot:20261123T152416.424Z` on token 1224, tx `50e859b8…` |
| Self-serve registration | tx `d9918a38…`, token `1454` |
| Code | `infra/services/concordium-agent/`, `infra/services/concordium-anchor/`, `infra/services/shared/concordium/` |
| Tests | `npm test` in `infra` (969), `npx tsx scripts/concordium/e2e.ts` (28 checks against the deployed stack) |
| Contract addresses | CIS-8004 `12802,0` · CIS-8 `12801,0` on testnet |

## Programme requirements

| Requirement | Where it is |
| --- | --- |
| Description | This document |
| Public code repository | https://github.com/balojey/tradewizard-concordium |
| Demo video (≤ 3 min) | `docs/demo-script.md` — recorded from the running product |
| CCDScan link | [registry contract, token 1224](https://testnet.ccdscan.io/?dcount=1&dentity=contract&dcontractAddressIndex=12802&dcontractAddressSubIndex=0) |
| Plan for going live | Route to production, above |
| Runs on testnet, uses Concordium meaningfully | CIS-8004 registry, CIS-8 key binding, badge, on-chain audit anchor |

## Route to production

1. Wire the browser wallet connector so registration is click-through rather than API-plus-signature.
2. Anchor on trade activity rather than wall-clock, so a subscriber's proof exists the moment they see the trade.
3. Ship the badge in the product: a counterparty check before copying a strategy, driven by the public verification GET.
4. x402 for the premium signal feed, with sponsored fees.
5. Mainnet registration, with the audit anchor as a paid feature rather than a demo.

## What we deliberately did not do

- **No migration to Concordium.** The agent keeps executing where its liquidity is.
- **No custody of user keys.** Every write is signed by the owner, which is why some steps are operator-assisted.
- **No unverified claims.** Anything in this document that is not executed on chain is labelled as such.

## Built with

TypeScript · AWS CDK · Lambda · RDS PostgreSQL · DynamoDB · Next.js 16 · Strands Agents SDK · Amazon Bedrock / Nebius Token Factory · Concordium CIS-8004 + CIS-8 · A2A Agent Cards · MCP

MIT licensed. The upstream production repository is private and not covered by that licence.
