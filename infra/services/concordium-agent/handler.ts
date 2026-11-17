/**
 * Concordium agent registry API - Lambda handler.
 *
 * Routes (API Gateway REST, `/concordium/agents*`):
 *
 *   POST /concordium/agents                → create a pending agent record
 *   GET  /concordium/agents                → list the caller's agents
 *   GET  /concordium/agents/{id}           → one agent + cached badge trust
 *   POST /concordium/agents/{id}/card      → store the Agent Card and its pinned hash
 *   GET  /concordium/agents/{id}/card      → serve the card verbatim (public, unauthenticated)
 *   POST /concordium/agents/{id}/mint      → record the minted token after the on-chain write
 *   POST /concordium/agents/{id}/verify    → re-check the badge against the registry
 *   GET  /concordium/agents/{id}/anchors   → anchored epochs for the agent
 *   GET  /concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}
 *                                          → inclusion proof for one decision
 *
 * Why the split: the registry holds no keys, so minting is an operator action
 * driven by `infra/scripts/concordium/agent.mjs`. This API owns the state around
 * that action and hosts the Agent Card, which must be reachable by the registry
 * and by counterparties.
 *
 * The card route is public **and must stay byte-exact**. The on-chain
 * `metadata_hash` is the SHA-256 of the bytes served at `agent_uri`; a handler
 * that re-serialises the stored JSON breaks the badge without touching the
 * chain. Hence `card_json` goes out as a raw string, and is never returned in
 * the authenticated JSON payloads (it is large and not useful there).
 *
 * Triggered by: API Gateway REST
 */

import type { APIGatewayProxyEvent, APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { getUserIdByCognitoSub } from '../shared/db';
import {
  createPgAnchorRepository,
  createPgRepository,
  type AnchorRow,
  type ConcordiumAgentRepository,
  type ConcordiumAgentRow,
  type ConcordiumAnchorRepository,
} from '../shared/concordium-db';
import { createAgentRegistryClient, type AgentRegistryClient } from '../shared/concordium/mcp';
import { assessBadge } from '../shared/concordium/badge';
import { assertCardHash, isPubliclyHostableUri } from '../shared/concordium/agent-card';
import {
  buildInclusionProof,
  computeDecisionRoot,
  DECISION_LEAF_VERSION,
  verifyInclusionProof,
} from '../shared/concordium/decision-root';
import { toAnchorableDecision } from '../shared/concordium/decision-row';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

/** Concordium account addresses are 50 base58 characters. */
const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
/**
 * CIS-2 token addresses are Base58Check of (contract, subindex, token_id), so
 * they are much shorter than a 50-character account address. Canonical validity
 * is decided by the registry during badge verification; this is a shape gate.
 */
const TOKEN_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{10,60}$/;
/**
 * Path ids are UUIDs. Without this check a junk id reaches Postgres as an
 * invalid uuid literal and the error surfaces as a 500 instead of a 404.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-fA-F]+$/;
const NETWORKS = new Set(['devnet', 'testnet', 'mainnet']);
/** secp256k1 public keys: 33-byte compressed or 65-byte uncompressed. */
const EXTERNAL_KEY_LENGTHS = new Set([66, 130]);

export interface ConcordiumAgentDeps {
  repo: ConcordiumAgentRepository;
  anchors: ConcordiumAnchorRepository;
  registry: AgentRegistryClient;
  resolveUserId: (cognitoSub: string) => Promise<string | null>;
  /** Base URL the public card route resolves to, used to tell the operator what to pin. */
  publicBaseUrl?: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Public card response: raw bytes, no re-serialisation, no transformation. */
function respondRawCard(cardJson: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      // Verification re-fetches this URL and compares the hash; a stale cache
      // would produce a spurious mismatch, so nothing may cache it.
      'Cache-Control': 'no-store',
    },
    body: cardJson,
    isBase64Encoded: false,
  };
}

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> {
  if (!event.body) throw new HttpError(400, 'Request body is required', 'missing_body');
  try {
    const parsed = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'invalid_json');
  }
}

function requireString(body: Record<string, unknown>, key: string, code: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `\`${key}\` is required`, code);
  }
  return value.trim();
}

/** External shape. Deliberately omits `card_json`. */
function toApiAgent(row: ConcordiumAgentRow) {
  return {
    id: row.id,
    network: row.network,
    concordiumAccount: row.concordium_account,
    externalKeyNamespace: row.external_key_namespace,
    externalKeyHex: row.external_key_hex,
    tokenId: row.token_id,
    tokenAddress: row.token_address,
    agentUri: row.agent_uri,
    metadataHashHex: row.metadata_hash_hex,
    status: row.status,
    badgeTrust: row.badge_trust,
    badgeCheckedAt: row.badge_checked_at,
    lastTxHash: row.last_tx_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cardUrlFor(deps: ConcordiumAgentDeps, agentId: string): string | undefined {
  if (!deps.publicBaseUrl) return undefined;
  return `${deps.publicBaseUrl.replace(/\/+$/, '')}/concordium/agents/${agentId}/card`;
}


/** External shape of an anchor. `payload_hex` stays internal: it is a signed payload, not data. */
function toApiAnchor(row: AnchorRow) {
  return {
    id: row.id,
    epochStart: row.epoch_start,
    epochEnd: row.epoch_end,
    decisionCount: row.decision_count,
    rootHash: row.root_hash,
    leafVersion: row.leaf_version,
    metadataKey: row.metadata_key,
    txHash: row.tx_hash,
    anchoredAt: row.anchored_at,
    createdAt: row.created_at,
    /** Staged but not yet submitted by the operator. */
    pendingSignature: row.payload_hex !== null && row.tx_hash === null,
  };
}

/**
 * Read the anchored root out of a `get_metadata` response.
 *
 * The registry stores metadata values as UTF-8 text, and the tool returns the
 * bytes (`value_hex`, 128 hex characters for a 64-character root) alongside the
 * decoded `value_text`. Older anchors written before the text rule hold the raw
 * 32-byte digest instead, so both forms are accepted — anything else is
 * "unreadable" and must never be reported as a match.
 */
function readMetadataRoot(payload: unknown): { root: string | null; bytes: string | null } {
  if (!payload || typeof payload !== 'object') return { root: null, bytes: null };
  const record = payload as Record<string, unknown>;

  const text = typeof record.value_text === 'string' ? record.value_text.trim().toLowerCase() : null;
  if (text && /^[0-9a-f]{64}$/.test(text)) return { root: text, bytes: null };

  for (const key of ['value_hex', 'valueHex', 'hex', 'value']) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const hex = raw.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) continue;

    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length === 32) return { root: bytes.toString('hex'), bytes: hex };
    const decoded = bytes.toString('utf8');
    if (/^[0-9a-f]{64}$/.test(decoded)) return { root: decoded, bytes: hex };
  }

  return { root: null, bytes: null };
}

export function createHandler(deps: ConcordiumAgentDeps): APIGatewayProxyHandler {
  const network = deps.registry.network;

  async function authenticatedUserId(event: APIGatewayProxyEvent): Promise<string> {
    const sub = event.requestContext?.authorizer?.claims?.sub;
    if (!sub) throw new HttpError(401, 'Unauthorized', 'missing_auth');
    const userId = await deps.resolveUserId(sub);
    if (!userId) throw new HttpError(401, 'Unauthorized', 'unknown_user');
    return userId;
  }

  async function ownedAgent(userId: string, agentId: string): Promise<ConcordiumAgentRow> {
    if (!UUID_RE.test(agentId)) throw new HttpError(404, 'Agent not found', 'not_found');
    const agent = await deps.repo.getForUser(userId, agentId);
    if (!agent) throw new HttpError(404, 'Agent not found', 'not_found');
    return agent;
  }

  async function createAgent(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const body = parseBody(event);

    const concordiumAccount = requireString(body, 'concordiumAccount', 'missing_account');
    if (!ACCOUNT_RE.test(concordiumAccount)) {
      throw new HttpError(400, '`concordiumAccount` is not a valid Concordium account address', 'invalid_account');
    }

    const requestedNetwork = typeof body.network === 'string' ? body.network : network;
    if (!NETWORKS.has(requestedNetwork)) {
      throw new HttpError(400, '`network` must be devnet, testnet or mainnet', 'invalid_network');
    }

    let externalKeyHex: string | null = null;
    let externalKeyNamespace: string | null = null;
    if (body.externalKeyHex !== undefined && body.externalKeyHex !== null) {
      const candidate = requireString(body, 'externalKeyHex', 'invalid_external_key');
      if (!HEX_RE.test(candidate) || !EXTERNAL_KEY_LENGTHS.has(candidate.length)) {
        throw new HttpError(
          400,
          '`externalKeyHex` must be a secp256k1 public key (33 or 65 bytes, hex)',
          'invalid_external_key',
        );
      }
      externalKeyHex = candidate.toLowerCase();
      externalKeyNamespace = typeof body.externalKeyNamespace === 'string' ? body.externalKeyNamespace.trim() : 'eip155';
    }

    const agent = await deps.repo.createPending({
      userId,
      network: requestedNetwork,
      concordiumAccount,
      externalKeyNamespace,
      externalKeyHex,
    });

    return respond(201, {
      agent: toApiAgent(agent),
      next: [
        'Host the Agent Card and POST it to /concordium/agents/{id}/card',
        'Mint on-chain with infra/scripts/concordium/agent.mjs register',
        'Record the mint with POST /concordium/agents/{id}/mint',
      ],
      expectedCardUrl: cardUrlFor(deps, agent.id),
    });
  }

  async function listAgents(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agents = await deps.repo.listForUser(userId);
    return respond(200, {
      agents: agents.map((agent) => ({ ...toApiAgent(agent), cardUrl: cardUrlFor(deps, agent.id) })),
    });
  }

  async function getAgent(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');
    return respond(200, { agent: { ...toApiAgent(agent), cardUrl: cardUrlFor(deps, agent.id) } });
  }

  async function putCard(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');
    const body = parseBody(event);

    const cardJson = requireString(body, 'cardJson', 'missing_card');
    const metadataHashHex = requireString(body, 'metadataHashHex', 'missing_hash');
    const agentUri = requireString(body, 'agentUri', 'missing_agent_uri');

    if (metadataHashHex.length !== 64 || !HEX_RE.test(metadataHashHex)) {
      throw new HttpError(400, '`metadataHashHex` must be a 32-byte hex SHA-256', 'invalid_hash');
    }
    if (!isPubliclyHostableUri(agentUri)) {
      // Loopback, plain-HTTP and private-range URIs can never be fetched by the
      // registry, so reject them here rather than minting an unverifiable agent.
      throw new HttpError(400, '`agentUri` must be a public https URL', 'invalid_agent_uri');
    }
    try {
      JSON.parse(cardJson);
    } catch {
      throw new HttpError(400, '`cardJson` must be valid JSON', 'invalid_card_json');
    }
    try {
      assertCardHash(cardJson, metadataHashHex);
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : 'card hash mismatch',
        'card_hash_mismatch',
      );
    }

    const saved = await deps.repo.saveCard(agent.id, { agentUri, metadataHashHex, cardJson });
    return respond(200, {
      agent: toApiAgent(saved),
      note: 'Card stored. The registry will fetch this URL and compare the hash on every check.',
    });
  }

  /**
   * Public route. Deliberately unauthenticated: the registry and counterparty
   * agents fetch it without credentials. It exposes only what the Agent Card
   * already discloses by design.
   */
  async function getCard(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const agentId = event.pathParameters?.id ?? '';
    if (!UUID_RE.test(agentId)) throw new HttpError(404, 'Agent card not published', 'card_not_found');
    const agent = await deps.repo.getById(agentId);
    if (!agent?.card_json) throw new HttpError(404, 'Agent card not published', 'card_not_found');
    return respondRawCard(agent.card_json);
  }

  async function recordMint(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');
    const body = parseBody(event);

    const tokenId = requireString(body, 'tokenId', 'missing_token_id');
    const tokenAddress = requireString(body, 'tokenAddress', 'missing_token_address');
    const txHash = requireString(body, 'txHash', 'missing_tx_hash');

    if (!/^\d+$/.test(tokenId)) {
      throw new HttpError(400, '`tokenId` must be a decimal integer', 'invalid_token_id');
    }
    if (!TOKEN_ADDRESS_RE.test(tokenAddress)) {
      throw new HttpError(400, '`tokenAddress` must be a CIS-2 token address', 'invalid_token_address');
    }
    if (agent.token_address && agent.token_address !== tokenAddress) {
      throw new HttpError(409, 'Agent is already recorded with a different token address', 'already_minted');
    }
    if (!agent.card_json) {
      throw new HttpError(409, 'Publish the Agent Card before recording a mint', 'card_missing');
    }

    let saved: ConcordiumAgentRow;
    try {
      saved = await deps.repo.recordMint(agent.id, { tokenId, tokenAddress, txHash });
    } catch (error) {
      // One on-chain agent can only be claimed once. Postgres reports the unique
      // index violation as 23505; without this it surfaced as a bare 500.
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'That token address is already recorded for another agent', 'token_already_claimed');
      }
      throw error;
    }
    return respond(200, { agent: toApiAgent(saved) });
  }

  async function verifyAgent(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');

    if (!agent.token_address) {
      throw new HttpError(409, 'Agent is not minted yet, so it has no badge to verify', 'not_minted');
    }

    const verdict = await deps.registry.checkBadge(agent.token_address).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `Registry unavailable: ${message}`, 'registry_unavailable');
    });

    const assessment = assessBadge(verdict);
    await deps.repo.recordBadgeCheck(agent.id, assessment.trust);

    return respond(200, {
      trust: assessment.trust,
      label: assessment.label,
      caveat: assessment.caveat,
      problems: assessment.problems,
      checks: verdict.checks ?? {},
      verdict,
    });
  }


  async function listAnchors(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');
    const anchors = await deps.anchors.listAnchorsForAgent(userId, agent.id);
    return respond(200, { anchors: anchors.map(toApiAnchor) });
  }

  /**
   * Inclusion proof for one decision in one anchored epoch.
   *
   * The epoch is rebuilt from the same rows the anchor was computed over, in the
   * same order, and the rebuild **must** reproduce the anchored root. If it does
   * not, the log changed after it was anchored — which is precisely the event
   * this whole design exists to expose — and we refuse to hand out a proof that
   * would silently verify against something else.
   */
  async function decisionProof(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
    const userId = await authenticatedUserId(event);
    const agent = await ownedAgent(userId, event.pathParameters?.id ?? '');
    const anchorId = event.pathParameters?.anchorId;
    const decisionId = event.pathParameters?.decisionId;
    if (!anchorId || !decisionId) {
      throw new HttpError(400, '`anchorId` and `decisionId` are required', 'missing_params');
    }

    if (!UUID_RE.test(anchorId)) throw new HttpError(404, 'Anchor not found', 'anchor_not_found');
    const anchor = await deps.anchors.getAnchorForAgent(userId, agent.id, anchorId);
    if (!anchor) throw new HttpError(404, 'Anchor not found', 'anchor_not_found');

    const rows = await deps.anchors.listDecisionsInEpoch(
      userId,
      anchor.epoch_start,
      anchor.epoch_end,
      anchor.decision_count,
    );
    const decisions = rows.map(toAnchorableDecision);

    const index = decisions.findIndex((decision) => decision.id === decisionId);
    if (index < 0) {
      throw new HttpError(404, 'Decision is not part of this epoch', 'decision_not_in_epoch');
    }

    let rebuiltRoot: string;
    try {
      rebuiltRoot = computeDecisionRoot(decisions);
    } catch {
      throw new HttpError(409, 'Epoch cannot be rebuilt from the stored decisions', 'epoch_not_reproducible');
    }
    if (rebuiltRoot !== anchor.root_hash) {
      console.error(
        `Anchor ${anchor.id} no longer reproduces: rebuilt ${rebuiltRoot}, anchored ${anchor.root_hash}`,
      );
      throw new HttpError(409, 'Epoch no longer reproduces its anchored root', 'epoch_not_reproducible');
    }

    const proof = buildInclusionProof(decisions, index);
    const verified = verifyInclusionProof(proof, anchor.root_hash);

    // What is actually committed on-chain, once the operator has submitted the
    // staged payload. Absent before that, and absence is not corruption.
    let onChain: { key: string; valueHex: string | null; valueText: string | null; matches: boolean } | null = null;
    if (anchor.metadata_key && anchor.tx_hash && agent.token_id) {
      const raw = await deps.registry
        .callTool('get_metadata', { token_id: agent.token_id, key: anchor.metadata_key })
        .catch((error: unknown) => {
          console.error(`On-chain metadata read failed for anchor ${anchor.id}:`, error);
          return null;
        });
      const { root, bytes } = readMetadataRoot(raw);
      onChain = {
        key: anchor.metadata_key,
        valueHex: bytes,
        valueText: root,
        matches: root === anchor.root_hash,
      };
    }

    return respond(200, {
      anchor: toApiAnchor(anchor),
      decision: decisions[index],
      leafVersion: DECISION_LEAF_VERSION,
      proof,
      rootHash: anchor.root_hash,
      /** The proof recomputes to the anchored root. */
      verified,
      onChain,
      howToVerify: [
        'Rebuild the leaf from `decision` and `leafVersion` with the documented canonical JSON form.',
        'Recompute the root by hashing each pair of `proof.path` in order, using `proof.index` to decide the side.',
        'Compare the result with `proof` → `rootHash`, and with the on-chain value at `anchor.metadataKey`.',
      ],
    });
  }

  return async (event) => {
    if (event.httpMethod === 'OPTIONS') return respond(200, {});

    // `event.resource` is the API Gateway resource template, not the concrete
    // path, so dispatch stays stable regardless of the id in the URL.
    const route = `${event.resource ?? event.path}`;
    const method = event.httpMethod;

    try {
      if (route === '/concordium/agents' && method === 'POST') return await createAgent(event);
      if (route === '/concordium/agents' && method === 'GET') return await listAgents(event);
      if (route === '/concordium/agents/{id}' && method === 'GET') return await getAgent(event);
      if (route === '/concordium/agents/{id}/card' && method === 'GET') return await getCard(event);
      if (route === '/concordium/agents/{id}/card' && method === 'POST') return await putCard(event);
      if (route === '/concordium/agents/{id}/mint' && method === 'POST') return await recordMint(event);
      if (route === '/concordium/agents/{id}/verify' && method === 'POST') return await verifyAgent(event);
      if (route === '/concordium/agents/{id}/anchors' && method === 'GET') return await listAnchors(event);
      if (route === '/concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}' && method === 'GET') {
        return await decisionProof(event);
      }
      return respond(404, { error: 'Not found', route, method });
    } catch (error) {
      if (error instanceof HttpError) {
        return respond(error.statusCode, { error: error.message, code: error.code });
      }
      console.error('Concordium agent handler error:', error);
      return respond(500, { error: 'Internal server error' });
    }
  };
}

export const handler: APIGatewayProxyHandler = createHandler({
  repo: createPgRepository(),
  anchors: createPgAnchorRepository(),
  registry: createAgentRegistryClient(),
  resolveUserId: getUserIdByCognitoSub,
  publicBaseUrl: process.env.CONCORDIUM_CARD_BASE_URL,
});
