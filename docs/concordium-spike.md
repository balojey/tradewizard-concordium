# Spike results — Concordium write path (16 Nov 2026)

Goal: prove `register agent → badge → check_badge clean` on testnet, and decide whether x402 is viable, before committing the build window (19 Nov – 9 Dec).

**Outcome: the whole pipeline is proven except the last hop — submission. Every on-chain write needs an identity-backed, funded account, and that account can only be created through an interactive wallet flow. That is a human step, not a code step.**

## What was proven

Run end to end against the live testnet, today:

| Step | Result |
| --- | --- |
| MCP service reachable, stateless JSON-RPC | ✅ `initialize` + 41 tools |
| `contract_info` / `network_status` | ✅ CIS-8004 `12802,0`, CIS-8 `12801,0`, block height ~50.89M |
| Indexer REST (`/agents`, `/events/recent`, `/status`) | ✅ 1,210 testnet / 5,140 mainnet agents, `lag_blocks: 0` |
| `build_agent_card` → canonical A2A card + sha256 | ✅ wrote a valid card with the badge extension |
| `build_register` → contract receive payload | ✅ `CIS-8004.register`, energy 30000 |
| Payload → signed V0 transaction → block item | ✅ 275 bytes, signed against real chain nonce 194 |
| `check_badge` over public REST | ✅ full verdict with 15 granular checks |
| Actual submission | ❌ blocked on account |

The signing pipeline is now code, not theory: `infra/scripts/concordium/agent.mjs` does build → sign → submit, and `--dry-run` exercises everything except the network call.

## The blocker: identity issuance is interactive

Creating a Concordium account requires a credential, which requires an identity issued by an Identity Provider. On testnet the chain advertises five IDPs:

| id | name | usable headlessly? |
| --- | --- | --- |
| 0 | Concordium testnet IP | no public endpoint — the documented host does not resolve |
| 1 | Notabene (Staging) | commercial, document upload + review |
| 3 | Digital Trust Solutions TestNet | commercial, document upload + review |
| 4 | Global FinReg Testnet | commercial |
| 5 | Dataspike | commercial |

All money-moving and registry-writing operations need an existing account, and the faucet (`Request CCD`) also only funds an existing account. So there is no code-only path to a first account. One human session in the Concordium Wallet for Web is unavoidable.

This is not a design problem — it is the feature. The verified-human anchor has to be established by the human, and every operator of a TradeWizard agent will need to do it once. The product implication is that "link your Concordium identity" is an onboarding step like "connect your Polymarket wallet", not a background job.

### To unblock (≈10 minutes, once)

1. Install **Concordium Wallet for Web**, create a wallet, choose **Testnet**.
2. Create an identity using **Concordium testnet IP** (self-service, no document review).
3. Create an account on that identity, then **Activity → Request CCD** (2,000 test CCD; once per account, and only before it receives a transfer).
4. Export the wallet file (or seed phrase) and give it to the build; `@concordium/web-sdk` derives the account address and signing key from it.

After that, `agent.mjs register --uri … --hash …` submits for real.

## What a clean badge actually requires

I sampled 31 testnet agents through `check_badge`. **Only 5 came back valid** — all from recent registrations; of 9 older ones, zero. Failure modes, in order of frequency:

- `embedding` — card uses the **legacy top-level `concordium` block**. The badge must live in `capabilities.extensions` with `uri: https://docs.concordium.com/a2a-extensions/concordium-badge/v1`. Only `build_agent_badge` produces this correctly; hand-written cards fail.
- `card_fetch` — `agent_uri` returns 404 (dead host, `localhost:8080`, private IPs). Localhost cards are common in submissions and can never verify.
- `metadata_hash` — served bytes do not match the on-chain SHA-256.

A passing verdict requires all of: card served HTTP 200 at `agent_uri`, byte-exact `metadata_hash`, extension-form badge, matching token address / owner / contract refs / verify URL, and `status: Active`.

**Consequence for us: a `badge_valid: true` result is a real differentiator, because most submissions will not achieve one.** It also means card hosting is load-bearing infrastructure — a stable public URL, immutable bytes, re-pin the hash on any edit. `https://tradewizard.example/.well-known/agent-card.json` in the spike is a placeholder for a route we must actually ship.

## x402 status

`@x402/concordium@2.31.0` installs and exposes the client / server / facilitator scheme classes. Settlement could not be exercised because the facilitator sponsor is also an account (same blocker), so treat x402 as **unproven** rather than proven: one more reason to time-box it.

Incidental: installing `@x402/next` exceeded a 5-minute timeout. The package family is large and young; budget for that friction.

## web-sdk sharp edges (cost ~1h, now recorded)

`@concordium/web-sdk@12.0.2` does not match the tutorial snippets:

- `Transaction.sign()` is **async** and must be called on `tx.addMetadata(...).build()`, not on the builder.
- `nonce` is a `SequenceNumber` and **must be ≥ 1** (0 is account creation).
- `expiry` is `TransactionExpiry.fromUnwrappedJSON(bigint)`, not a number.
- `message` must be a `Parameter` (use `fromHexString`), `receiveName` a `ReceiveName`.
- `serializeBlockItem()` returns a `Uint8Array`, not a hex string.
- Node entrypoint is `@concordium/web-sdk/nodejs` (`ConcordiumGRPCNodeClient`); the web client throws in Node.
- `getIdentityProviders()` on the v2 gRPC API returns an async iterator and **omits `ipInfo` metadata**, so IDP metadata must come from the IDP itself.

## Files

- `infra/scripts/concordium/mcp.mjs` — MCP tool caller + REST `checkBadge()` (no SDK needed to verify).
- `infra/scripts/concordium/agent.mjs` — `info | card | register | set-uri | badge | check | call`, `--dry-run` supported.
- `@concordium/web-sdk` added to `infra/` devDependencies.

## Foundation landed (account-independent)

Everything below is real code with tests, and needs no Chain account to run or verify:

| Module | Purpose |
| --- | --- |
| `services/shared/concordium/mcp.ts` | typed client: MCP `tools/call` for reads/writes, REST `checkBadge` for verification, injected `fetch`, per-call timeouts (Lambda-safe) |
| `services/shared/concordium/badge.ts` | verdict → three-state policy (`verified` / `registered` / `unknown`), fails closed, encodes "accountable, not endorsed" |
| `services/shared/concordium/agent-card.ts` | byte-exact card hashing, served-card verification, public-URI guard |
| `services/shared/concordium/decision-root.ts` | Merkle root + inclusion proofs over `portfolio_manager_decisions` for on-chain anchoring |
| `sql/001-schema.sql` | `concordium_agents` (identity, CIS-8 binding, card + hash, cached badge trust) and `concordium_audit_anchors` (epoch roots) |

60 unit tests. Two of them caught design bugs worth recording:

- **Sorted-pair Merkle hashing hides ordering.** The first cut hashed each pair in sorted order, which made sibling order uncommitted — swapping two adjacent trades left the root identical, defeating the point of anchoring a *sequence* of decisions. Now ordered (`H(left ‖ right)`) with carry-up of an unpaired node and a verified leaf count.
- **Carrier-grade NAT was accepted as public.** `isPubliclyHostableUri` initially allowed `100.64.0.0/10`, which is exactly where tunnelled dev boxes live — and several live testnet agents point at `100.120.x.x`, which can never verify.

## Verdict


Identity + audit are cheap and, judged on depth of Concordium integration, disproportionately valuable: `register → card → badge → check` is a few hundred lines and we already have the signing path working. Payments remain the expensive, unproven third — worth a time-boxed attempt after the identity slice lands, not before.
