# Spike results — Concordium write path (16 Nov 2026)

Goal: prove `register agent → badge → check_badge clean` on testnet, and decide whether x402 is viable, before committing the build window (19 Nov – 9 Dec).

**Outcome: the whole pipeline is proven except the last hop — submission. Every on-chain write needs an identity-backed, funded account, and that account can only be created through an interactive wallet flow. That is a human step, not a code step.**

## Live run: first verified agent (17 Nov 2026)

The whole write path was executed against testnet, end to end, with a real identity-backed account.

| | |
| --- | --- |
| Account | `43WTW9mXTvFheLNjmsso5hDEJyYTdn8cssFXYDUHruUjqSSpMu` (identity provider 0, identity 0, credential 0) |
| Agent | token **1224** · `JyP9XfKVsCUMaaEsDtyoS` · status `Active` |
| Card | `docs/agents/tradewizard-agent-card.json`, hash `6f9fe84a…f9b9`, served publicly |
| Mint | `6104b7b5bdbecd46771e963ffd0effeff4dc16e16c2cb03b627413a4cbff1d14` (block 50924450) |
| URI + hash pinned | `be8e0f6fc936773c0b7efd6eb437b54c521c5787745749ab67422402beaad243` (block 50924597) |
| Verification | `badge_valid: true`, **15/15 checks**, zero issues |

That result is the claim in the submission, and it is reproducible with the commands in `docs/concordium-testnet-setup.md`.

### Three things the live run taught us

**A crash after submission mints twice.** `TransactionHash` is a branded object, not a Buffer, so `Buffer.from(hash)` threw *after* `sendTransaction` had already succeeded. The run looked failed; the chain had accepted it; the retry minted a second agent (1224 and 1227, 28 seconds apart). Two fixes: format via `String(hash)`, and refuse to register when an active agent already carries the same `metadata_hash` unless `--allow-duplicate` is passed. The duplicate was revoked (`5627148a…`), which also exercised the revoke path — revoking marks the NFT `Revoked` and clears the payment wallet, so a superseded agent cannot keep receiving.

**Pinning a hash to a CDN URL is a race.** The badged card was committed, but `raw.githubusercontent.com` served the previous bytes for ~200 seconds from its edge cache. Had we pinned immediately, `check_badge` would have failed with a hash mismatch that looks exactly like a corrupted card. We polled until the served hash matched before calling `set_uri`. The durable fix is content-addressed hosting — a URL containing the card hash — so a version can never be served stale under a pinned hash.

**Verification is unforgiving in a useful way.** The 15 checks caught nothing only because every one was satisfied: on-chain record, active status, card fetch, hash match, extension form, token/owner/contract refs and verify URL. Hand-written or stale cards fail several at once, which is why most live agents do not pass.

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

## Registry API (landed)

`services/concordium-agent` — the state machine around the on-chain action, plus public card hosting.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /concordium/agents` | Cognito | create a pending agent: Concordium account + optional CIS-8 Polymarket key |
| `GET /concordium/agents` | Cognito | list the caller's agents with cached badge trust |
| `GET /concordium/agents/{id}` | Cognito | one agent + card URL |
| `POST /concordium/agents/{id}/card` | Cognito | store the Agent Card, validating hash and public-URI shape |
| `GET /concordium/agents/{id}/card` | **none** | serve the stored card byte-for-byte |
| `POST /concordium/agents/{id}/mint` | Cognito | record token id/address/tx hash after the CLI write |
| `POST /concordium/agents/{id}/verify` | Cognito | live `check_badge`, cache the result, return the verdict |
| `GET /concordium/agents/{id}/anchors` | Cognito | anchored epochs, flagging those still awaiting a signature |
| `GET /concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}` | Cognito | inclusion proof for one decision |

Verified in the synthesized template: the card `GET` is the only unauthenticated route, every mutation is `COGNITO_USER_POOLS`, and the card base URL is derived from the REST API id so the Lambda never depends on the stage deployment.

Two deliberate refusals in the write path, both learned from the sample of live agents:

- a card whose bytes do not match the supplied hash is rejected (400) instead of stored;
- an `agent_uri` on loopback, plain HTTP or a private range is rejected (400), because the registry can never fetch it and the agent would mint unverifiable.

The card route sets `Cache-Control: no-store`: verification re-fetches that URL and compares hashes, so a cached copy would produce a false mismatch after any edit.

Minting stays an operator action (`scripts/concordium/agent.mjs`) because the registry holds no keys; the API records the result rather than performing it.

## Proof endpoint (landed)

`GET /concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}` — the part where a subscriber stops trusting us.

It rebuilds the anchored epoch from the same rows, in the same order, and **refuses to answer if the rebuild does not reproduce the anchored root** (`409 epoch_not_reproducible`). That refusal is the point of the whole design: if anyone edits or deletes a decision after it was anchored, proofs stop being served rather than quietly verifying against something else. Pruning a row is no longer a silent edit; it is a detectable event.

Ordering is deterministic on purpose — `ORDER BY created_at, id` in both the staging query and the rebuild — because Postgres does not guarantee a stable order for equal timestamps, and two decisions can share a millisecond.

The response carries the leaf preimage, the proof path with its index and leaf count, the anchored root, and an `onChain` block comparing that root with what the registry actually returned via `get_metadata`. Three states, deliberately distinct:

- `onChain: null` — the anchor is staged and awaiting the operator's signature; nothing is committed yet, and that is not corruption.
- `matches: true` — the value committed on-chain equals the anchor we rebuilt.
- `matches: false` or `valueHex: null` — a real discrepancy, surfaced rather than smoothed over.

The staged `payload_hex` is never returned; the list endpoint exposes only `pendingSignature`.

## Anchoring job (landed)

`services/concordium-anchor` — EventBridge every 6 hours, `CONCORDIUM_ANCHOR_MIN_DECISIONS` threshold (3 by default), 500-decision cap per epoch.

Per active agent with a published card:

1. read decisions since the last anchor, oldest first, with the timestamp formatting leaf hashing expects;
2. hash them into a Merkle root (`shared/concordium/decision-root.ts`);
3. ask the registry for a sign-ready `build_set_metadata` payload under key `decisionRoot:<epochEnd>`;
4. insert the anchor row with `tx_hash` null and the payload attached.

It does not sign, and it cannot: CIS-8004 metadata is owner-authorised, so the agent's sponsor is the only party who can pin. Staging the payload keeps the user's key out of our infrastructure and makes the operator action a one-liner.

Failure is per-agent: one bad agent is recorded as `failed` and the rest still anchor. An epoch already staged is a `duplicate`, not an error. A registry response without `parameter_hex` fails the agent rather than staging an unsubmittable row.

Metadata keys keep milliseconds (`decisionRoot:20261116T120000.000Z`) — two epochs can end in the same second, and a key collision would silently overwrite the previous root on-chain.

## Verdict


Identity + audit are cheap and, judged on depth of Concordium integration, disproportionately valuable: `register → card → badge → check` is a few hundred lines and we already have the signing path working. Payments remain the expensive, unproven third — worth a time-boxed attempt after the identity slice lands, not before.
