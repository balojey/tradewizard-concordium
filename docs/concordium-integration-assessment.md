# Concordium Trusted Agents — integration assessment

Technical findings from probing the live Concordium agent infrastructure (16 Nov 2026) against TradeWizard's existing surfaces. Purpose: estimate real integration cost before committing to the hackathon build window (19 Nov – 9 Dec 2026).

All endpoints below were called directly; contract indices and tool lists are observed, not quoted from marketing pages.

## 1. What is actually live

**Agent Registry = two smart contracts (CIS-8004 + CIS-8), not an SDK you install.**

| Network | CIS-8004 (agent NFT) | CIS-8 (external keys) | Explorer |
| --- | --- | --- | --- |
| testnet | `12802,0` | `12801,0` | `testnet.ccdscan.io` |
| mainnet | `10082,0` | `10081,0` | `ccdscan.io` |

Agents are CIS-2 NFTs. Each holds an `agent_uri` (off-chain Agent Card JSON) plus an on-chain SHA-256 `metadata_hash` anchor, a `agent_wallet` (payment routing), extensible metadata key/values, and an optional `external_reference` pointing at a CIS-8 key registration.

**CIS-8 is the piece that matters for us.** It records a cryptographically proven binding between a Concordium account and an external public key — `secp256k1` (uncompressed/compressed) and `ed25519` are supported. That is exactly the "agent lives on Polygon/Polymarket, identity anchored on Concordium" topology the brief calls *One Agent, Native to Another Chain*.

### MCP service — `https://agent-registry-mcp.concordium.com`

Live, no auth, rate-limited per IP. JSON-RPC over `POST /mcp` (initialize works; stateless, no session header needed). **41 tools.**

- Read: `agent_of`, `agent_by_token_address`, `agent_by_external_reference`, `is_active`, `get_metadata`, `get_agent_wallet`, `owner_of_key`, `verify_agent_card`, `check_badge`, `check_account_badges`, `get_badge_json`, `contract_info`, `network_status`
- Enumerate (indexer-backed): `list_agents`, `agents_by_owner`, `search_agents`, `agent_history`, `recent_registrations`, `recent_transfers`
- Write: **every mutating tool is `build_*` and returns a sign-ready payload (wire-hex + schema JSON). The server holds no keys.** `build_register`, `build_agent_card`, `build_agent_badge`, `build_set_agent_uri`, `build_set_metadata`, `build_set_agent_wallet`, `build_set_external_reference`, `build_cis8_register`, `build_transfer`, `build_revoke`

Signing is our problem — `@concordium/web-sdk` (currently `12.0.2`) plus an account key. Workable headlessly; no browser wallet required for a demo.

### REST twin — same host, no auth, CORS open

`GET /v1/check-badge/{id}` (accepts a badge token address *or* an account), `/v1/get-badge-JSON/{token_address}`, `/v1/verify-agent-card/{token_address}`, `/v1/build-set-agent-uri/{token_address}`, `/healthz`, plus `/openapi.json`.

This is the important one for us: **badge verification is a plain HTTP GET**, so it drops into a Lambda or a Next.js route handler with zero Concordium SDK dependency. The SDK is only needed to *write*.

### Indexer — `https://agent-registry-indexer.concordium.com`

Separate host, resource-style REST: `/status`, `/agents`, `/agents/:id`, `/agents/:id/history`, `/events/recent`, `/cis8/keys`. Live and synced to head as of writing — testnet 1,210 agents, mainnet 5,140, devnet 51.

## 2. x402 on Concordium

`@x402/concordium` `2.31.0` — an official x402 Foundation package (Apache-2.0, in the Foundation repo), but note it was **merged in June 2026**, so it is new and thin. Deps: `@x402/core` + `@concordium/web-sdk`.

Scheme is `exact` over **V1 sponsored transactions**: the client builds a transfer naming the facilitator as sponsor, signs only as sender, and the facilitator adds its sponsor signature and submits — so the paying agent never holds CCD for gas.

- Testnet CAIP-2: `ccd:4221332d34e1694168c2a0c0b3fd0f27`
- gRPC: `grpc.testnet.concordium.com:20000`
- Assets: `"CCD"` (6 decimals) or a PLT symbol (`"EURR"`, `"USDR"`)
- Three roles we must assemble ourselves: client, server middleware, **facilitator** (needs a funded Concordium account + its own gRPC connection)

Assets on testnet are the real constraint:

- **Test CCD** — faucet via Concordium Wallet for Web (Activity → Request CCD). One request per account, only before it has incoming transactions.
- **Test PLT (USDR/EURR)** — no public faucet. Requires submitting an issuance request to Concordium and manual distribution. Realistically days, not hours.

So a convincing payment demo on testnet should settle in **CCD**, with USDR as an upgrade if Concordium hands out test tokens at a workshop.

## 3. Mapping to TradeWizard

### Pillar 1 — "a verified human stands behind the agent"

Polymarket agents trade real money. Today a counterparty cannot distinguish a named human's strategy from a farm. The chain we would build:

1. Operator (existing Cognito user) creates/uses a Concordium testnet account bound to a testnet identity — the verified-human anchor.
2. `build_agent_card` → Agent Card JSON hosted at a public URL (`agent_uri`); `build_register` mints the agent NFT.
3. `build_cis8_register` binds the operator's **Polygon/Polymarket wallet public key** to that Concordium account, via a signature over `build_cis8_canonical_bytes` signed by that wallet.
4. `build_set_external_reference` attaches the CIS-8 binding to the agent NFT → the agent on Polymarket is resolvable from Concordium.
5. `build_agent_badge` merges the badge into the Agent Card, `build_set_agent_uri` pins the new hash.

Existing surfaces reused: `users` identity, `getUserIdByCognitoSub()`, the wallet connection we already have in the frontend. New: a Concordium account per operator, an `agent_card` hosting route, a registration job, and a signer.

Cost: **medium** — it is a well-defined CRUD flow over MCP plus one wallet-signature proof. No contract work. The interactive part is provisioning a testnet identity for the demo operator, which is a one-off manual step in the wallet app.

### Pillar 2 — "a record of what it did"

`portfolio_manager_decisions` already stores `action`, `edge_met`, `conviction_score`, `reasoning`, `skip_reason` per decision, one row per analysis, keyed to `portfolio_manager_sessions` and `portfolio_manager_trades`. That is already a compliance-shaped decision log.

Two ways to make it *verifiable* rather than merely stored, in increasing cost:

- **Cheap and real:** `build_set_metadata` writes arbitrary key/values onto the agent NFT (only `agentWallet` is reserved). Anchor a rolling Merkle root of decision rows — e.g. `decision_root:epoch=12:hash=…`, once per epoch. Anyone can then prove a given decision was in the log without trusting our Aurora.
- **Subscribers can verify:** `verify_agent_card` + `/v1/check-badge/{account}` are public GETs, so the frontend can show a live "verified + auditable" state with no SDK and no secrets.

Cost: **low** for the anchoring job (one Lambda on a schedule, reusing decision rows), **medium** for the UI proof viewer.

### Pillar 3 — "pay and get paid"

`credit_transactions` + `subscriptions` is today a private ledger. x402 would let a TradeWizard agent pay per-call for external market data / a premium signal feed, with fees sponsored.

Cost: **high** relative to the other two. It means running a facilitator, a funded sponsor account, a resource server, and a client inside the agents. Time-box it: a single paid endpoint (one premium market-data or signal route) proving an agent paid and got access is enough to satisfy the brief, and is the demo money-shot.

### Angle nobody else will have

The interesting claim is not "our agent has a badge". It is: **every autonomous trade is attributable to a verified human and independently auditable, and counterparties can check that before dealing with us.** That is a product story for a trading platform, not a hackathon costume — and it is the one track (`build agents that check each other's badge before dealing`) where identity and payments reinforce each other.

## 4. Risks and gotchas (observed, not speculated)

- **`Cis10` (platform-handle) external references are broken on the live deployment** — writes reject, lookups return null. Use `Cis8` crypto-key bindings only. This rules out binding a Polymarket *username*; we bind the wallet key.
- **Enumeration tools depend on the indexer**, which the MCP service reaches at `127.0.0.1:4400` — internal. Direct chain reads work regardless. Prefer the public indexer host for listing, and don't build anything critical on `list_agents`.
- **Transfer and revoke clear `external_reference` and reset `agent_wallet`.** Any ownership change requires re-running `build_set_external_reference` + `build_set_agent_wallet`.
- **`build_set_agent_wallet` needs two authorisations** — the new wallet signs 122 canonical bytes (with a deadline), then the owner signs the transaction.
- **No keys are held server-side.** Every write is build → sign → submit. Any design that assumes the MCP server can register on our behalf is wrong.
- **Testnet identity is still an identity.** The badge's whole value is the IDP link; on testnet that is a test IDP, but it is an interactive flow and must be done before the demo. Do it early.
- **Badge means accountable, not endorsed** — Concordium explicitly does not review code or behaviour. Don't overclaim in the UI or the pitch.
- **Sponsored fees are not free fees.** Someone funds the sponsor account; on testnet the facilitator account needs CCD.
- **`@x402/concordium` is ~5 months old.** Budget for sharp edges; treat the facilitator as the riskiest component and prove it against testnet before building anything on top.

## 5. Suggested scope for the build window

Depth is judged, and transaction count explicitly is not. One vertical slice, end to end:

| # | Slice | Deliverable | Est. |
| --- | --- | --- | --- |
| 1 | Identity anchor | Operator's Concordium testnet account + identity; agent NFT minted; CIS-8 binding to Polymarket wallet; badge live and `check_badge`-clean | 3–4 d |
| 2 | Agent Card hosting | Public `agent_uri` route serving the card, hash pinned on-chain | 1 d |
| 3 | Audit anchoring | Epoch job anchoring `portfolio_manager_decisions` Merkle root into NFT metadata; public proof endpoint | 2 d |
| 4 | Payments | One x402-priced resource, CCD on testnet, facilitator running, agent pays and is granted | 3–4 d |
| 5 | Counterparty check | "Verify before you deal" — TradeWizard checks the other agent's badge via REST before acting | 1 d |
| 6 | Proof surface | Frontend badge/audit panel wired to the public REST GETs | 2 d |
| 7 | Submission | README, 3-min demo video, CCDScan links, mainnet plan | 2 d |

Deliberately excluded: migrating anything to Concordium, issuing our own PLT, contracts, multi-chain key rotation, admin portal work.

## 6. Submission requirements (from the brief)

Description, **public repo** (done), demo video ≤ 3 min, **CCDExplorer/CCDScan link**, short plan for going live. Deadline **9 Dec 2026, 23:59 UTC**; platform locks at deadline. Runs on Concordium **testnet** and must make meaningful use of at least one Concordium component.

## 7. References

- Registry docs: `https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/`
- MCP service: `https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/mcp-service.html`
- x402 integration: `https://docs.concordium.com/en/mainnet/how-to/integrations/x402-integration.html`
- x402 Concordium scheme: `github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_concordium.md`
- Agent registry skill file (tool semantics): `concordium-agent-registry` SKILL.md published by Concordium
