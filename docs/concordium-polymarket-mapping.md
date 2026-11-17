# Concordium ↔ Polymarket: which key is the agent?

The identity claim is only as good as the key it points at. Polymarket has four wallet shapes and the one that *signs* is not the one that *holds funds* — so binding the wrong address produces a badge that verifies but proves nothing about who trades.

This document records what the Polymarket docs say, how TradeWizard is built today, and what we bind and why.

## Polymarket's wallet model

From `docs.polymarket.com/trading/wallets-auth` and `/getting-started/api` (read 17 Nov 2026):

| Wallet type | `signature_type` | When it applies |
| --- | --- | --- |
| **Deposit Wallet** | `3` POLY_1271 | Default for all Polymarket account wallets deployed **on or after 4 May 2026** |
| **Proxy Wallet** | `1` Proxy | Legacy, created via Magic Link or Google auth on polymarket.com |
| **Safe Wallet** | `2` Safe | Legacy, created with an external signer (MetaMask, Rabby) |
| **EOA** | `0` EOA | Not supported by the RFQ gateways |

And the addresses that matter per wallet type:

| Wallet type | `POLY_ADDRESS` | `signer_address` | `maker_address` |
| --- | --- | --- | --- |
| Deposit Wallet | Account or **session signer** with CLOB credentials | Deposit Wallet address | Deposit Wallet address |
| Proxy Wallet | Account signer | **Account signer** (EOA) | Proxy Wallet |
| Safe Wallet | Account signer | **Account signer** (EOA) | Safe Wallet |

Authentication is two layers: **L1** — the wallet signs EIP-712 `ClobAuth` to establish control and derive credentials; **L2** — requests are signed with API credentials over HMAC-SHA256. Order placement uses L2 to authenticate the request and a wallet signature to authorise the order itself.

So on every wallet type, **an EOA signs**; the smart wallet is the maker that holds the funds.

## How TradeWizard is built today

- Auth is **Magic** (email → embedded EOA): `getMagic()` → `magic.rpcProvider` → ethers signer, exposed as `eoaAddress` / `ethersSigner`.
- The Polymarket wallet is a **Safe**, derived deterministically from that EOA (`deriveSafe(eoaAddress, SafeFactory)`) and deployed through the relay client.
- CLOB orders use `signatureType = 2` (Safe): the Magic EOA signs, the Safe is the maker. See `tradewizard-frontend/hooks/useClobClient.ts`.
- Subscriptions also settle from the Safe via `relayClient.execute()`.

## What we bind, and why

**We bind the signer EOA, not the Safe.** A Safe is a contract: it cannot produce a secp256k1 signature, so a CIS-8 proof from it is impossible, and binding its address would create a badge that verifies on-chain while saying nothing about who authorises trades. The EOA is the key that actually signs orders, so that is the key that carries the identity.

The full chain, verifying from the agent outward:

```
agent NFT (token 1224, CIS-8004)
  └── owner: Concordium account        ← identity-backed (IDP-verified human)
        └── CIS-8 external_reference: eip155:137 secp256k1 key   ← the Polymarket signer EOA
              └── maker (Safe / Proxy / Deposit Wallet)          ← holds the funds, cannot sign
```

Recorded in the CIS-8 registration metadata so a reader does not have to guess the shape:

| metadata key | value |
| --- | --- |
| `venue` | `polymarket` |
| `wallet` | the maker address (Safe today, Deposit Wallet after migration) |
| `signature_type` | `2` for Safe, `1` Proxy, `3` Deposit Wallet |

Resolve it either direction:

```bash
# agent → signer key
GET /v1/… / agent_by_external_reference   (MCP tool)
# signer key → owner account
owner_of_key { external_key: { namespace: "eip155:137", key_type: "secp256k1-compressed", public_key_hex } }
```

## Gotchas that cost us time

- **The registry stores secp256k1 keys compressed.** We registered a 65-byte uncompressed key with `ethereum-personal-sign`; `owner_of_key` returned `key_type: secp256k1-compressed` and a 33-byte key. Attach the *canonical* form from `owner_of_key` to the agent, or the external reference points at a key shape that never resolves.
- **`personal_sign` wraps the bytes.** The canonical bytes from `build_cis8_canonical_bytes` (247 bytes, prefixed `CIS-8/v1/canonical`, containing the genesis hash for replay protection) are scheme-agnostic. The `ethereum-personal-sign` scheme means EIP-191: viem's `signMessage({ message: { raw } })` applies the `\x19Ethereum Signed Message:\n<len>` prefix — signing the raw hash instead produces a proof that is silently invalid.
- **`Cis10` (platform handles) is broken on the live deployment.** That rules out binding a Polymarket *username*; the wallet key is the only usable anchor.
- **Magic can sign without us seeing the key.** The production flow is the browser producing the `personal_sign` and the CLI receiving `--signature`; `--private-key` exists for session keys and the demo only.

## Deposit Wallets and session keys — the better model

Polymarket's newest accounts are Deposit Wallets, where the owner can authorise a scoped, **180-day session key**: an EOA that can trade but **cannot withdraw**.

That is the shape an accountable agent should have: a verified human owns the wallet, a scoped session key trades, and the agent NFT carries the identity of the former while pointing at the latter. Our design already accommodates it — the bound key is whatever signer actually signs, and `signature_type` records which wallet shape it serves.

Migration is not automatic: `Session Keys work only with Deposit Wallets. A dedicated migration flow from Safe Wallets and Proxy Wallets is planned.` Our Safe-based accounts (signature type 2) keep working for now, but the binding should move to a session key as soon as accounts are migrated — at which point the agent's key is purpose-built for it, time-limited and withdrawal-incapable.

## Evidence from the live run (17 Nov 2026)

| | |
| --- | --- |
| Agent | token `1224` · `JyP9XfKVsCUMaaEsDtyoS` · Active |
| CIS-8 key | `eip155:137` · `secp256k1-compressed` · `025bdbae4d0a5061bbf2bd9515986129212156553d3d606b5998e87cdcf3b2c134` |
| Registered by | `eda41177…1469` (block ~50925xxx) |
| Attached to agent | `b395b4e2…714f` |
| Metadata | `venue=polymarket`, `signature_type=2`, `wallet=0xA76D…2Da2d` |
| Resolution | `agent_by_external_reference` → token 1224; `owner_of_key` → our account |

The signer key in this run is a throwaway EOA, because the operator's Magic key lives in a browser and must sign from there. The mechanism — canonical bytes, EIP-191 proof, registration, attachment, resolution — is what was proven; the key itself is the last thing to swap in.
