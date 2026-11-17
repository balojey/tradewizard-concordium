#!/usr/bin/env node
/**
 * Derive the signing key for an existing Concordium account from a seed phrase.
 *
 * Why this exists: the Concordium Wallet for Web shows account addresses but has
 * no per-account private-key export, and the registry service holds no keys, so
 * the CLI needs the key locally to sign registration and anchoring payloads.
 *
 * Account keys are derived from (identity provider index, identity index,
 * credential counter) — not from an account index — and the browser wallet never
 * shows those numbers. So instead of asking for them, this script derives
 * candidates and **verifies each public key against the keys already published
 * on-chain for the account**. A match is proof the derived key really controls
 * that account; if nothing matches, nothing is printed and nothing is guessed.
 *
 * Usage:
 *   CONCORDIUM_SEED_PHRASE="word word …" node scripts/concordium/derive-key.mjs --address <base58>
 *   node scripts/concordium/derive-key.mjs --address <base58>        # prompts for the phrase
 *
 * Use a testnet-only seed phrase. A seed that was ever used on mainnet does not
 * belong near this script: the derived key is printed to your terminal.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import { AccountAddress, ConcordiumHdWallet } from '@concordium/web-sdk';

const DEFAULT_GRPC = 'grpc.testnet.concordium.com:20000';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}

const address = arg('address');
if (typeof address !== 'string') {
  console.error('usage: derive-key.mjs --address <base58 account> [--network testnet|mainnet] [--grpc host:port]');
  process.exit(1);
}

const network = String(arg('network', 'testnet'));
const grpc = String(arg('grpc', DEFAULT_GRPC));
const maxIdentity = Number(arg('max-identity', 4));
const maxCredential = Number(arg('max-credential', 4));
const dryRun = !!arg('dry-run', false);

async function readSeedPhrase() {
  const fromEnv = process.env.CONCORDIUM_SEED_PHRASE;
  if (fromEnv && fromEnv.trim().split(/\s+/).length >= 24) return fromEnv.trim();

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Seed phrase (24 words, testnet only): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Normalise a hex key for comparison: strip 0x, lowercase. */
const norm = (value) => String(value).replace(/^0x/i, '').toLowerCase();

/**
 * Every ed25519 public key the account has published on-chain, across all
 * credentials. Accepts both credential shapes the SDK can return.
 */
function onChainKeys(accountInfo) {
  const keys = new Set();
  const credentialsMap = accountInfo?.accountCredentials ?? {};

  for (const credential of Object.values(credentialsMap)) {
    const contents = credential?.value?.contents ?? credential?.contents;
    const keyList = contents?.credentialPublicKeys?.keys;
    if (!keyList) continue;
    for (const entry of Object.values(keyList)) {
      // The gRPC client returns { schemeId, verifyKey } per key; tolerate a bare
      // hex string too, in case the shape changes.
      if (typeof entry === 'string') keys.add(norm(entry));
      else if (entry && typeof entry === 'object' && typeof entry.verifyKey === 'string') {
        keys.add(norm(entry.verifyKey));
      }
    }
  }
  return keys;
}

const seedPhrase = await readSeedPhrase();
if (seedPhrase.split(/\s+/).length < 24) {
  console.error('That does not look like a 24-word seed phrase.');
  process.exit(1);
}

const client = new ConcordiumGRPCNodeClient(
  grpc.split(':')[0],
  Number(grpc.split(':')[1] ?? 20000),
  credentials.createSsl(),
);

const accountAddress = AccountAddress.fromBase58(String(address));
const info = await client.getAccountInfo(accountAddress);
// `simple` is a normal account with a single credential; `unknown` means the
// address has never been deployed.
if (!info || info.type === 'unknown') {
  console.error(`Address ${address} is not an account on ${network}.`);
  process.exit(1);
}

const expected = onChainKeys(info);
if (expected.size === 0) {
  console.error('Could not read any public keys for that account from the chain.');
  process.exit(1);
}

const wallet = ConcordiumHdWallet.fromSeedPhrase(seedPhrase, network === 'mainnet' ? 'Mainnet' : 'Testnet');

let found = null;
for (let idp = 0; idp <= 2 && !found; idp += 1) {
  for (let identity = 0; identity <= maxIdentity && !found; identity += 1) {
    for (let credential = 0; credential <= maxCredential && !found; credential += 1) {
      const publicKey = norm(Buffer.from(wallet.getAccountPublicKey(idp, identity, credential)).toString('hex'));
      if (expected.has(publicKey)) found = { idp, identity, credential, publicKey };
    }
  }
}

if (!found) {
  console.error(
    'No derived key matches this account.\n' +
      `Tried identity provider 0–2, identity 0–${maxIdentity}, credential 0–${maxCredential}.\n` +
      'Most likely the account was not created from this seed phrase, or from a different network.',
  );
  process.exit(1);
}

const signingKey = Buffer.from(wallet.getAccountSigningKey(found.idp, found.identity, found.credential)).toString('hex');
const masked = signingKey.slice(0, 6) + '…' + signingKey.slice(-6);

console.log(`matched: identity provider ${found.idp}, identity ${found.identity}, credential ${found.credential}`);
console.log(`account: ${String(address)}`);
console.log(`public key: ${found.publicKey}`);

if (dryRun) {
  console.log(`signing key: ${masked} (not printed)`);
  process.exit(0);
}

console.log('');
console.log('Export these for the CLI (testnet only):');
console.log(`export CONCORDIUM_ACCOUNT=${String(address)}`);
console.log(`export CONCORDIUM_KEY_HEX=${signingKey}`);
