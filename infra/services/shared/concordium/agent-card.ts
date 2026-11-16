/**
 * Agent Card hosting and hash pinning.
 *
 * An agent's identity on-chain is only a pointer: the NFT stores `agent_uri`
 * plus a SHA-256 of the bytes served there. Verification therefore compares the
 * *served bytes* against the on-chain hash — so the card must be byte-stable.
 * Any re-serialisation that reorders keys, changes whitespace or drops a null
 * changes the hash and invalidates the badge without touching the chain.
 *
 * That is the single most common failure we observed in the wild: cards that
 * 404, cards behind `localhost`, and cards whose served bytes drifted from the
 * pinned hash. Hence:
 *
 *  1. The canonical form is produced once, stored verbatim, and served verbatim.
 *  2. Nothing in the serving path re-stringifies the JSON.
 *  3. `verifyServedCard` is what we run against our own URL before claiming a badge.
 */

import { createHash } from 'crypto';

/** A2A extension URI the badge must live under (the legacy top-level block fails). */
export const AGENT_CARD_EXTENSION_URI = 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1';

/** How long a card fetch may take before we treat the card as unavailable. */
const CARD_FETCH_TIMEOUT_MS = 8000;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface CardVerification {
  ok: boolean;
  status?: number;
  /** SHA-256 of what the URL actually served, when it served anything. */
  servedHash?: string;
  onChainHash: string;
  reason?: string;
}

/**
 * Fetch the card we tell the chain to expect and compare it byte for byte.
 *
 * Run this before pinning a hash and periodically after: it is the only check
 * that catches a hosting regression, and it is cheap enough to do on demand.
 */
export async function verifyServedCard(
  url: string,
  onChainHash: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CardVerification> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const expected = onChainHash.trim().toLowerCase();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? CARD_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      onChainHash: expected,
      reason: `card URL unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, onChainHash: expected, reason: `card URL returned HTTP ${response.status}` };
  }

  const servedHash = sha256Hex(await response.text());
  if (servedHash !== expected) {
    return {
      ok: false,
      status: response.status,
      servedHash,
      onChainHash: expected,
      reason: 'served bytes do not match the on-chain metadata hash',
    };
  }

  return { ok: true, status: response.status, servedHash, onChainHash: expected };
}

/**
 * Guard for anything that writes a card to storage.
 *
 * The hash we pin must be the hash of the exact string we will serve, so the
 * caller passes the string — not a re-serialised object.
 */
export function assertCardHash(cardJson: string, expectedHash: string): void {
  const actual = sha256Hex(cardJson);
  if (actual !== expectedHash.trim().toLowerCase()) {
    throw new Error(`agent card hash mismatch: served ${actual} but expected ${expectedHash}`);
  }
}

/**
 * The card must be reachable by the registry and by counterparties. A relative
 * or loopback URI can never verify, so reject it before it reaches the chain.
 */
export function isPubliclyHostableUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  // Carrier-grade NAT (100.64.0.0/10) is where tunnelled dev boxes live; it is
  // not routable from the registry, so a card there can never verify.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  return true;
}
