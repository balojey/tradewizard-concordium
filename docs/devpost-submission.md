# TradeWizard — accountable autonomous trading

**Bring the agent you already run: we made a live prediction-market trading agent answerable to a verified human, and gave it an audit trail anyone can check.**

Concordium Trusted Agents Hackathon · 2026

---

## Status first, because it matters

This is an honest submission in the middle of its build window, and the distinction between "implemented", "verified against the live service", and "executed on chain" is one we care about — the whole submission is about not letting people overclaim.

| | |
| --- | --- |
| **Verified today** | Registry MCP (41 tools) and REST verification read/written against live testnet; agent card generation and hashing; the payload → signed-transaction pipeline against a real chain nonce; 950 passing tests across the backend |
| **Executed on chain** | Agent token `1224` (`JyP9XfKVsCUMaaEsDtyoS`) registered on Concordium testnet by an identity-backed account, card hash pinned, `badge_valid: true` on all 15 checks, and a `eip155:137` Polymarket signer key bound via CIS-8 and attached to the token |
| **Executed on chain** | A 5-decision epoch anchored on token `1224` (`529d7245…1504`); the root reads back byte-identical and an inclusion proof recomputes to it; editing a decision breaks the rebuild |
| **Implemented, not yet deployed** | The Aurora-backed proof endpoint and the 6-hourly anchoring job — built and tested, awaiting `deploy.sh up dev` |
| **Not built** | x402 payments. Designed, costed, deliberately deferred behind the two halves that make up the actual claim |
| **Why the gap** | Minting and anchoring are owner-authorised on CIS-8004. Our service holds no keys by design, so the last hop is the operator's wallet, not our Lambda. We consider that a feature and explain it below |

Everything in the middle row works against a mock-free code path: the same handler, the same registry client, the same hashing. The only thing missing is a testnet account with an identity behind it.

---

## The problem

TradeWizard runs an autonomous agent that places real Polymarket positions with real money. It decides, on its own, to enter, hold or exit, under risk limits it cannot talk itself out of.

That is exactly the kind of agent this hackathon is about — and it has an obvious hole. A counterparty, a subscriber, or a regulator looking at a Polymarket strategy has no way to tell whether a named, accountable human stands behind it or whether it is a rented farm with a nice UI. The trades are on-chain; the *accountability* is not.

Two things follow from that:

1. **Attribution.** Someone verifiable must stand behind the agent, provably, without publishing who they are.
2. **Audit.** The agent's decisions must be checkable by someone who does not trust our database — otherwise "we log everything" is a claim, not evidence.

## What was already running

This is not a weekend prototype wearing a Concordium badge. The platform behind it is live and deployed:

- 14 specialised intelligence agents run on every market in parallel — news, order flow, base rates, adversarial cross-examination — fund into a deterministic consensus stage
- An autonomous Portfolio Manager places and exits positions under stop-loss, take-profit, position-size and cumulative-loss limits, refusing to trade when edge or alignment thresholds are not met
- Real-time delivery over WebSocket, email, push and webhook; on-chain USDC.e subscriptions on Polygon

Crucially, the agent already records **why** it acted: every decision row stores its action, whether edge and alignment thresholds were met, a conviction score, a written reasoning string, and — when it declined — a skip reason. That log is the raw material for the audit half of this submission.

## What we added

### 1. A verified human behind the agent

The operator verifies once with a Concordium identity provider — a real identity check, not an email address. Their agent is then registered in the CIS-8004 agent registry as an NFT owned by that identity-backed account, with:

- an **A2A Agent Card** at a public URL, whose SHA-256 is pinned on-chain (`metadata_hash`), so the card cannot be swapped after the fact;
- a **CIS-8 binding** between the Concordium account and the agent's `secp256k1` Polymarket **signer** key, so identity on Concordium resolves to the key that actually authorises orders on Polygon — not the Safe that merely holds the funds;
- the **Verified by Concordium badge** embedded as an A2A capability extension.

Anyone can check it with a plain HTTP GET — no SDK, no API key:

```
GET https://agent-registry-mcp.concordium.com/v1/check-badge/{token_address}
```

The badge means **accountable, not endorsed**. It says a verified human can be identified if something goes wrong. It does not say Concordium reviewed our code or our results, and our UI says so in those words.

### 2. An audit trail that survives not trusting us

The agent's decisions live in Aurora. Aurora is authoritative, but it is ours: a subscriber has to trust us not to edit it. So each epoch of decisions is hashed into a Merkle tree, and only the root is written on-chain, as registry metadata on the agent NFT (`decisionRoot:<epoch>`).

A subscriber then asks for an inclusion proof for their own trade and recomputes the root themselves, against the value committed on-chain. Nothing per-trade is published — the leaf commits to the decision, and only the root goes to chain.

The part we are proudest of: **the proof endpoint refuses to answer if the epoch no longer rebuilds to its anchored root**. Delete or edit a decision after the fact and proofs stop being served, rather than quietly verifying against a rewritten history. Pruning a row stops being a silent edit and becomes a detectable event.

```
GET /concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}
→ 200 { proof, rootHash, verified: true, onChain: { matches: true } }
→ 409 epoch_not_reproducible     ← someone changed the log
```

### 3. Payments (designed, deferred)

x402 lets an agent pay per call for data or compute over plain HTTP, with Concordium settlement in the official x402 Foundation package and fees sponsored so a user never holds CCD.

We scoped it, costed it, and chose not to build it in this window. The reason is judgment, not difficulty: the scoring is on depth of integration and a believable route to production, and a shallow payment demo bolted onto two genuinely finished halves makes the submission weaker, not stronger. Contract, flows and risks are documented in `docs/concordium-integration-assessment.md` §2.

## How it is built

```
                     ┌──────────────────────────────┐
   operator ────────▶│ Concordium testnet           │
   (verified human)  │  CIS-8004 agent NFT (12802)  │
                     │  CIS-8 key registry  (12801) │
                     │  metadata: decisionRoot:<epoch>
                     └───────────────┬──────────────┘
                                     │  Agent Card (public, hash-pinned)
                     ┌───────────────▼──────────────┐
                     │ TradeWizard backend          │
                     │  concordium-agent  (API)     │
                     │  concordium-anchor (6-hourly)│
                     │  shared/concordium (client,  │
                     │   badge policy, Merkle)      │
                     └───────────────┬──────────────┘
                                     │  inclusion proofs
                              subscribers verify
```

Two design decisions worth calling out:

**No keys in our infrastructure.** The registry service holds no keys — every mutation is a `build_*` call that returns a sign-ready payload. Our Lambdas compute, verify and stage; the account owner signs. An anchor row therefore carries `tx_hash = null` and its pending payload until the operator submits. This costs us a manual step and buys us the ability to say we never custody a user's signing key.

**Refusals over accommodations.** A card whose bytes do not match its pinned hash is rejected instead of stored. An `agent_uri` on loopback, plain HTTP or a private range is rejected, because the registry could never fetch it. Both are the most common ways real agents end up with a badge that can never verify: of 31 live testnet agents we sampled, only 5 passed `check_badge`.

## Why Concordium, and why not a migration

The brief says bring the agent you already run, and that is what we did. Polymarket execution stays on Polygon; Concordium is the identity and audit anchor. The registry documents this as "one agent, native to another chain", anchored by a CIS-8 dual-key proof — our case exactly.

What Concordium gives that the EVM does not: identity is enforced at account creation, so an account is backed by a verified identity by construction rather than by an optional attestation contract. That is the difference between a badge that means "this wallet signed something" and one that means "a real, identifiable human stands behind this".

## Evidence in the repository

- `infra/services/shared/concordium/` — registry client, badge policy, card hashing, Merkle root and inclusion proofs
- `infra/services/concordium-agent/` — API and public Agent Card hosting (32 tests)
- `infra/services/concordium-anchor/` — epoch anchoring job (14 tests)
- `infra/services/concordium-agent/handler.test.ts` — including the tamper case: edit a decision, proof stops
- `docs/concordium-integration-assessment.md` — what the registry, badge and x402 actually provide
- `docs/concordium-spike.md` — what was proven against live testnet, with the observations that shaped the design
- `infra/scripts/concordium/agent.mjs` — the CLI that drives the real on-chain writes

## Route to production

1. Finish the operator flow end to end on testnet: mint, badge, one anchored epoch, one verified proof (blocked on a testnet identity, minutes of work).
2. Anchor on a schedule tied to trade activity rather than wall-clock, so a subscriber's proof exists at the moment they see the trade.
3. Ship the badge in the product: a "verified + auditable" panel on the portfolio page driven by the public verification GET, and a counterparty check before copying a strategy.
4. x402 for the premium signal feed: the agent pays per call for external data, with sponsored fees.
5. Mainnet registration for the platform's own agents, with the audit anchor as a paid feature rather than a demo.

---

## Built with

TypeScript · AWS CDK · Lambda · Aurora PostgreSQL (Serverless v2) · DynamoDB · Next.js 16 · Strands Agents SDK · Amazon Bedrock / Nebius Token Factory · Concordium CIS-8004 + CIS-8 · A2A Agent Cards · MCP
