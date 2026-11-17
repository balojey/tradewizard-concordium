#!/usr/bin/env node
/**
 * Concordium Agent Registry — spike CLI.
 *
 * Proves the write path the MCP service forces on every caller:
 *   build_* payload  ->  we sign  ->  we submit  ->  verify over public REST
 *
 * The MCP service holds no keys. All mutating tools return a CIS-8004 / CIS-8
 * contract receive parameter plus a suggested energy; this script turns that
 * into a signed account transaction.
 *
 * Usage (see docs/concordium-spike.md):
 *   node scripts/concordium/agent.mjs info
 *   node scripts/concordium/agent.mjs card --name "..." --description "..." --uri https://.../agent-card.json
 *   node scripts/concordium/agent.mjs register --uri https://.../agent-card.json --hash <sha256hex> [--dry-run]
 *   node scripts/concordium/agent.mjs badge --card-file ./agent-card.json --token-id 12
 *   node scripts/concordium/agent.mjs check --token <token_address>
 *
 * Env for anything that writes:
 *   CONCORDIUM_NETWORK   testnet | mainnet | devnet   (default testnet)
 *   CONCORDIUM_ACCOUNT   base58 account address
 *   CONCORDIUM_KEY_HEX   64-hex ed25519 account key (seed)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  buildBasicAccountSigner,
} from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@concordium/web-sdk/nodejs';
import { callTool, checkBadge } from './mcp.mjs';

const NETWORK = process.env.CONCORDIUM_NETWORK ?? 'testnet';
const GRPC = process.env.CONCORDIUM_GRPC ?? 'grpc.testnet.concordium.com:20000';
const ACCOUNT = process.env.CONCORDIUM_ACCOUNT;
const KEY_HEX = process.env.CONCORDIUM_KEY_HEX;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function requireAccount() {
  if (!ACCOUNT || !KEY_HEX) {
    throw new Error(
      'CONCORDIUM_ACCOUNT and CONCORDIUM_KEY_HEX are required for on-chain writes.\n' +
        'Create a testnet identity + account in the Concordium Wallet for Web, then export the account key.',
    );
  }
}

function client() {
  return new ConcordiumGRPCNodeClient(
    GRPC.split(':')[0],
    Number(GRPC.split(':')[1] ?? 20000),
    credentials.createSsl(),
  );
}

/**
 * Turn an MCP `build_*` payload into a submitted transaction.
 * `dryRun` proves the whole signing path without touching the chain.
 */
async function submit(payload, { dryRun = false } = {}) {
  requireAccount();
  const sender = AccountAddress.fromBase58(ACCOUNT);

  const grpc = client();
  const { nonce } = await grpc.getNextAccountNonce(sender);

  const configured = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(payload.contract_address.index, payload.contract_address.subindex),
      receiveName: ReceiveName.fromString(payload.receive_name),
      message: Parameter.fromHexString(payload.parameter_hex),
    },
    Energy.create(payload.suggested_energy),
  ).addMetadata({
    sender,
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromUnwrappedJSON(BigInt(Math.floor(Date.now() / 1000) + 1800)),
  });

  const built = configured.build();
  const signed = await Transaction.sign(built, buildBasicAccountSigner(KEY_HEX));
  const finalized = Transaction.finalize(signed);
  const hex = Buffer.from(Transaction.serializeBlockItem(finalized)).toString('hex');

  if (dryRun) {
    console.log(`[dry-run] receive ${payload.receive_name} on ${payload.contract_address.index},${payload.contract_address.subindex}`);
    console.log(`[dry-run] nonce ${nonce}  energy ${payload.suggested_energy}  block item ${hex.length / 2} bytes`);
    return { dryRun: true, nonce: String(nonce), bytes: hex.length / 2 };
  }

  const hash = await grpc.sendTransaction(finalized);
  // TransactionHash is a branded object; String() yields its hex form. Calling
  // Buffer.from() on it throws *after* the transaction is already submitted,
  // which is how a "failed" run can still have minted something.
  const hashHex = String(hash).replace(/^0x/i, '');
  await grpc.waitForTransactionFinalization(hash);
  console.log(`submitted: ${hashHex}`);
  console.log(`explorer:  https://testnet.ccdscan.io/?dtab=account&a=${ACCOUNT}`);
  return { hash: hashHex };
}

const commands = {
  async info() {
    console.log(JSON.stringify(await callTool('contract_info', { network: NETWORK }), null, 2));
    console.log(JSON.stringify(await callTool('network_status', { network: NETWORK }), null, 2));
  },

  async card() {
    const out = await callTool('build_agent_card', {
      network: NETWORK,
      name: arg('name'),
      description: arg('description'),
      agent_uri: arg('uri'),
      owner_account: ACCOUNT,
      token_id: arg('token-id', null),
    });
    const file = arg('out', 'agent-card.json');
    writeFileSync(file, out.agent_card_json);
    console.log(`wrote ${file}`);
    console.log(`sha256 ${out.metadata_hash_hex}`);
    console.log(`host the file verbatim at ${arg('uri')} — the hash must match byte for byte.`);
  },

  async register() {
    // Minting is not idempotent: a crash after submission leaves an agent on
    // chain, so a retry mints a second one. Refuse unless explicitly allowed.
    if (!arg('allow-duplicate', false)) {
      const existing = await callTool('agents_by_owner', { network: NETWORK, owner_account: ACCOUNT });
      const duplicate = (existing.agents ?? []).find(
        (agent) => agent.metadata_hash_hex === arg('hash') && agent.status !== 'Revoked',
      );
      if (duplicate) {
        console.error(
          `Already registered: token ${duplicate.token_id} (${duplicate.token_address ?? 'address unknown'}) on ${NETWORK}.\n` +
            'Pass --allow-duplicate to mint another agent with the same card.',
        );
        process.exit(1);
      }
    }

    const payload = await callTool('build_register', {
      network: NETWORK,
      sender: ACCOUNT,
      agent_uri: arg('uri'),
      metadata_hash_hex: arg('hash'),
    });
    console.log(JSON.stringify(await submit(payload, { dryRun: !!arg('dry-run', false) }), null, 2));
  },

  async 'set-uri'() {
    const payload = await callTool('build_set_agent_uri', {
      network: NETWORK,
      sender: ACCOUNT,
      token_id: arg('token-id'),
      agent_uri: arg('uri'),
      metadata_hash_hex: arg('hash'),
    });
    console.log(JSON.stringify(await submit(payload, { dryRun: !!arg('dry-run', false) }), null, 2));
  },

  async revoke() {
    // Revoking marks the NFT Revoked (it is not burned) and clears the external
    // reference and payment wallet. Use it for duplicates and for agents that
    // should stop being treated as accountable.
    const payload = await callTool('build_revoke', {
      network: NETWORK,
      sender: ACCOUNT,
      token_id: arg('token-id'),
    });
    console.log(JSON.stringify(await submit(payload, { dryRun: !!arg('dry-run', false) }), null, 2));
  },

  /**
   * Bind a Polymarket signer key to this Concordium account (CIS-8).
   *
   * Which key matters: Polymarket authorises orders with the *signer* key — the
   * EOA behind a Safe/Proxy/Deposit Wallet — while the smart wallet is only the
   * maker. A contract cannot produce a secp256k1 proof, so binding the wallet
   * address would be unverifiable. We bind the signer and record the wallet in
   * the card, which is the mapping a counterparty needs.
   *
   * In production the browser signs (Magic `personal_sign`) and the CLI receives
   * `--signature`. `--private-key` exists for the demo and for session keys.
   */
  async 'bind-key'() {
    const rawKey = arg('private-key') === true ? generatePrivateKey() : String(arg('private-key'));
    // viem wants 0x-prefixed hex; accept either form so a key copied from a
    // secrets manager does not need editing.
    const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
    const account = privateKeyToAccount(privateKey);
    const namespace = String(arg('namespace', 'eip155:137'));
    const keyType = String(arg('key-type', 'secp256k1-uncompressed'));
    const publicKeyHex = account.publicKey.slice(2);

    console.log(`signer: ${account.address}  (${namespace}, ${keyType})`);

    const canonical = await callTool('build_cis8_canonical_bytes', {
      network: NETWORK,
      concordium_account: ACCOUNT,
      external_namespace: namespace,
      external_key_namespace: namespace,
      external_key_type: keyType,
      external_public_key_hex: publicKeyHex,
      proof_scheme: 'ethereum-personal-sign',
    });

    console.log(`canonical bytes: ${canonical.byte_length} bytes (prefix "${canonical.prefix_utf8}")`);

    // EIP-191 personal_sign over the exact bytes: viem wraps with the
    // `\x19Ethereum Signed Message:\n<len>` prefix, which is what the scheme means.
    const signature = await account.signMessage({ message: { raw: `0x${canonical.bytes_hex}` } });

    const payload = await callTool('build_cis8_register', {
      network: NETWORK,
      sender: ACCOUNT,
      external_key: { namespace, key_type: keyType, public_key_hex: publicKeyHex },
      proof: { scheme: 'ethereum-personal-sign', signature_hex: signature.slice(2) },
      metadata: [
        { key: 'wallet', value: String(arg('wallet-address', account.address)) },
        { key: 'signature_type', value: String(arg('signature-type', '2')) },
        { key: 'venue', value: 'polymarket' },
      ],
    });

    const result = await submit(payload, { dryRun: !!arg('dry-run', false) });
    console.log(JSON.stringify({ signer: account.address, ...result }, null, 2));

    if (arg('attach', false) && typeof arg('token-id', null) === 'string') {
      const reference = await callTool('build_set_external_reference', {
        network: NETWORK,
        sender: ACCOUNT,
        token_id: arg('token-id'),
        external_reference: {
          contract_address: { index: 12801, subindex: 0 },
          kind: 'Cis8',
          key: { namespace, key_type: keyType, public_key_hex: publicKeyHex },
        },
      });
      console.log(JSON.stringify(await submit(reference), null, 2));
    }
  },

  /**
   * Attach an already-registered CIS-8 key to an agent NFT.
   *
   * Use the canonical key form reported by `owner_of_key` (the registry stores
   * secp256k1 keys compressed), otherwise the reference points at a key shape
   * that never resolves.
   */
  async 'attach-key'() {
    const payload = await callTool('build_set_external_reference', {
      network: NETWORK,
      sender: ACCOUNT,
      token_id: arg('token-id'),
      external_reference: {
        contract_address: { index: 12801, subindex: 0 },
        kind: 'Cis8',
        key: {
          namespace: String(arg('namespace', 'eip155:137')),
          key_type: String(arg('key-type', 'secp256k1-compressed')),
          public_key_hex: String(arg('public-key-hex')).replace(/^0x/i, '').toLowerCase(),
        },
      },
    });
    console.log(JSON.stringify(await submit(payload, { dryRun: !!arg('dry-run', false) }), null, 2));
  },

  async badge() {
    const cardFile = arg('card-file');
    const out = await callTool('build_agent_badge', {
      network: NETWORK,
      card_url: arg('card-url'),
      ...(cardFile ? { card_json: readFileSync(cardFile, 'utf8') } : {}),
      owner_account: ACCOUNT,
      token_id: arg('token-id'),
    });
    const file = arg('out', 'agent-card.badged.json');
    writeFileSync(file, typeof out.agent_card_json === 'string' ? out.agent_card_json : JSON.stringify(out.agent_card_json, null, 2));
    console.log(`wrote ${file}`);
    console.log(`sha256 ${out.metadata_hash_hex}  <- pin this with \`set-uri\``);
  },

  async check() {
    const id = arg('token') ?? arg('account');
    console.log(JSON.stringify(await checkBadge(id, NETWORK), null, 2));
  },

  async call() {
    const [tool, json] = process.argv.slice(3);
    console.log(JSON.stringify(await callTool(tool, json ? JSON.parse(json) : {}), null, 2));
  },
};

const cmd = process.argv[2];
if (!commands[cmd]) {
  console.error(`usage: agent.mjs <${Object.keys(commands).join('|')}> [--flags]`);
  process.exit(1);
}
await commands[cmd]();
