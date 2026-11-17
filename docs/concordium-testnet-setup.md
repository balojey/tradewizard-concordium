# Getting a Concordium testnet identity and account

Everything on the registry side needs one thing we cannot create for you: an
account backed by a verified identity. This is the only manual step in the whole
build, and it takes about ten minutes.

**Why it cannot be automated.** The chain advertises five identity providers; the
testnet one has no publicly reachable endpoint, and the others are commercial
services that require document upload and human review. Whatever the route, a
person has to complete an identity check. That is the feature, not an oversight:
the badge exists to prove a real human stands behind the agent.

---

## 1. Create the wallet

1. Install **Concordium Wallet for Web** (Chrome, Edge, Brave or Opera).
2. Create a new wallet and write down the 24-word seed phrase.
3. When asked which network to connect to, choose **Testnet**. The UI turns green
   for testnet and blue for mainnet.

> Use a fresh seed phrase dedicated to testnet. Identities and accounts are not
> shared between networks, and no seed that has ever touched mainnet should be
> near this build.

## 2. Create the identity

1. Select a third-party identity provider from the list. **Concordium testnet
   IP** is the self-service one; the others ask for photos of an ID document plus
   a selfie and are usually approved within minutes.
2. Submit whatever it asks for. You will then have a *pending* identity; the
   result is collected by the wallet within minutes and can be retrieved for up
   to seven days.
3. The identity is testnet-only. It proves a human, and on testnet that human is
   you behind a test provider — which is exactly what the demo needs.

## 3. Create the account and claim test CCD

1. **Create account**, selecting the identity you just made.
2. Copy the account address (the selector at the top left, or **Receive → Copy
   Address**). It is 50 base58 characters, e.g.
   `3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB`.
3. Open the account, click **Activity**, then **Request CCD**.

Two rules, both of which fail silently if missed:

- **The faucet pays once per account** and credits 20,000 test CCD.
- **It only works before the account has any incoming transaction.** Claim the
  CCD *before* anything sends to that address, or create a fresh account.

## 4. Hand the key to the build

Account signing keys are derived from *(identity provider index, identity index,
credential counter)* — not from an account index — and the wallet never shows
those numbers. Rather than ask you to guess, the repo derives candidates and
verifies them against the public keys already published on-chain for your
account:

```bash
cd infra
export CONCORDIUM_SEED_PHRASE="word word word …"     # 24 words, testnet only
node scripts/concordium/derive-key.mjs --address <your account address> --dry-run
```

`--dry-run` prints the matched indices and account, and masks the key. A match is
proof the derived key really controls that account. If nothing matches, the
script says so and prints nothing — usually the wrong network or the wrong seed.

Drop `--dry-run` to get the two exports:

```bash
export CONCORDIUM_ACCOUNT=<account address>
export CONCORDIUM_KEY_HEX=<account key>
```

## 5. Register the agent

```bash
node scripts/concordium/agent.mjs info                      # contract + network health
node scripts/concordium/agent.mjs card \
  --name "TradeWizard Trade Agent" \
  --description "Autonomous Polymarket execution, accountable to a verified human" \
  --uri https://<your-host>/.well-known/agent-card.json \
  --out agent-card.json                                     # prints the sha256 to pin
node scripts/concordium/agent.mjs register \
  --uri https://<your-host>/.well-known/agent-card.json \
  --hash <sha256 from the previous step>                    # add --dry-run first
```

Then host `agent-card.json` verbatim at that URL — the registry re-fetches it and
compares the SHA-256 on every badge check, so any reformatting invalidates the
badge — and confirm with:

```bash
node scripts/concordium/agent.mjs check --token <token_address>
```

A clean result reports `badge_valid: true` with no error-severity issues. Of 31
live testnet agents sampled on 16 Nov 2026, only 5 passed; the usual causes are a
legacy card embedding, a dead `agent_uri` host, or served bytes that drifted from
the pinned hash.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Address … is not an account on testnet` | The wallet is on mainnet, or the address was mistyped. Switch via **Menu → Network**. |
| `No derived key matches this account` | Wrong seed phrase, or the account was created on the other network. Nothing is printed in this case on purpose. |
| Faucet button absent or refuses | The account already has an incoming transaction, or already claimed. Create another account on the same identity. |
| `badge_valid: false`, `embedding` error | The card has a legacy top-level `concordium` block instead of the A2A extension. Regenerate with `build_agent_badge` rather than editing the JSON. |
| `card_fetch` error | `agent_uri` returned non-200. `localhost`, plain HTTP and private IP ranges are rejected at write time for this reason. |

## What the demo then shows

1. An agent NFT owned by an identity-backed account, carrying a card whose hash is pinned on-chain.
2. `check_badge` returning `badge_valid: true` over a plain HTTP GET, no SDK, no key.
3. An anchored epoch: a Merkle root pinned as registry metadata.
4. An inclusion proof for one decision that recomputes to that root — and a `409`
   if the underlying decision was edited after anchoring.
