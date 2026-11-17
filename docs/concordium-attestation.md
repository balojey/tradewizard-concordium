# Attestation: anchoring decisions and proving them

The audit claim has two halves: a root committed on-chain, and a proof a subscriber can check without trusting our database. Both are executable today from the command line.

```bash
cd infra
export CONCORDIUM_ACCOUNT=<account>
export CONCORDIUM_KEY_HEX=<account key>

npx tsx scripts/concordium/anchor-proof.ts anchor --file ../docs/agents/example-decisions.json --token-id 1224
npx tsx scripts/concordium/anchor-proof.ts read   --file ../docs/agents/example-decisions.json --token-id 1224
npx tsx scripts/concordium/anchor-proof.ts prove  --file ../docs/agents/example-decisions.json --decision <id>
npx tsx scripts/concordium/anchor-proof.ts tamper --file ../docs/agents/example-decisions.json --decision <id> --reasoning "rewritten"
```

The commands share the modules the Lambdas use — `decision-root.ts` for the Merkle tree, `decision-row.ts` for the leaf preimage, `anchor-metadata.ts` for the key format — so the CLI cannot drift from the service.

| Command | Does | Writes |
| --- | --- | --- |
| `anchor` | hash the decisions into a root, pin it as agent metadata | chain |
| `read` | fetch the metadata back and compare with the file | no |
| `prove` | emit an inclusion proof for one decision, self-verified | no |
| `tamper` | edit one decision and show the epoch no longer rebuilds | no |

The `--file` input is an array of `portfolio_manager_decisions` rows, exactly as the database returns them (`portfolio_manager_decisions` column names, ISO timestamps with milliseconds). Rows are sorted by `created_at, id` on load — the same order the anchoring job uses — because ordering is part of the commitment.

## Executed on testnet (17 Nov 2026)

| | |
| --- | --- |
| Agent | token `1224` · `JyP9XfKVsCUMaaEsDtyoS` |
| Decisions | 5, epoch `2026-11-17T08:05:12.311Z` → `2026-11-17T10:12:19.740Z` |
| Root | `d046cfcd71f13636cff849eb1147ca0cff1dae95753c9d5ee6cc4dc601799cb4` |
| Metadata key | `decisionRoot:20261117T101219.740Z` |
| Anchored | `529d724531150d84454604e2c3dd2a312dd2dfaf428fc77be2a2d3692e331504` |
| Read-back | on-chain text == computed root (`matches: true`) |
| Proof | index 2 of 5, path of 3, recomputes to the root |
| Tamper check | edited reasoning → rebuilt root `83a80ab6…`, no longer matches |

## What the chain taught us

Three findings, none of which are in the public documentation.

**`setMetadata` rejects non-UTF-8 values (-7208).** The contract stores text, not arbitrary bytes. The MCP tool's `value_hex` is hex-decoded into raw bytes, so passing a Merkle root as 32 raw bytes is rejected; you must hex-encode the root's *ASCII* form (`Buffer.from(root, 'utf8').toString('hex')`) and decode UTF-8 when reading back. Measured against the live contract:

| Call | Result |
| --- | --- |
| `key=a`, empty value | success |
| `key=description`, `"hello"` | success |
| `key=a`, value `00` (one byte) | reject `-7208` |
| `key=agentWallet` | reject `-7211` (reserved key) |
| root as UTF-8 text | success |
| root as 32 raw bytes | reject `-7208` |

The tool also omits nothing structurally — inserting a vector length before the key/value pair makes the parameter fail deserialization (`-2147483648`, the contract's own "deserialization failed"), which confirmed the tool's encoding is correct and the rejection is a value-validity rule.

**Finality is not success.** `waitForTransactionFinalization` resolves for a transaction the contract *rejected*; the summary carries `transactionType: 'failed'` and a `rejectReason`. Our submit path printed `submitted:` and returned a hash for a write that never happened — the anchor looked pinned for two runs before we read it back. Both CLIs now inspect the summary and throw on a rejected receive. The lesson generalises: any claim about on-chain state must be read back, not inferred from a hash.

**Metadata keys are capped by the interface, not the contract.** Keys up to 64 characters worked; milliseconds are kept in the epoch stamp because two epochs can end within the same second and a collision would overwrite the previous root.

## Why this shape

The root is committed as agent metadata rather than in a separate registry, so it travels with the agent: `agent_of` returns the record, `get_metadata` returns the root, and the CIS-8 binding ties both to the Polymarket signer key. A counterparty needs two HTTP calls and no trust in TradeWizard.

Nothing per-trade is published — only the root. A subscriber proves their own trade with an inclusion path, and the proof endpoint (Aurora-backed, deployed separately) refuses to answer when the rebuild no longer matches, returning `409 epoch_not_reproducible`.

## Still to do

- The endpoint that serves proofs from the database is built and tested; it needs the stack deployed (`./deploy.sh up dev`) to run against real rows.
- The anchoring job stages a root every 6 hours and leaves the signature to the operator; until the frontend signs, this CLI is that operator step.
