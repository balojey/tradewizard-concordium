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
  createPgRepository,
  type ConcordiumAgentRepository,
  type ConcordiumAgentRow,
} from '../shared/concordium-db';
import { createAgentRegistryClient, type AgentRegistryClient } from '../shared/concordium/mcp';
import { assessBadge } from '../shared/concordium/badge';
import { assertCardHash, isPubliclyHostableUri } from '../shared/concordium/agent-card';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

/** Concordium account addresses are 50 base58 characters. */
const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const NETWORKS = new Set(['devnet', 'testnet', 'mainnet']);
/** secp256k1 public keys: 33-byte compressed or 65-byte uncompressed. */
const EXTERNAL_KEY_LENGTHS = new Set([66, 130]);

export interface ConcordiumAgentDeps {
  repo: ConcordiumAgentRepository;
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
    const agent = await deps.repo.getById(event.pathParameters?.id ?? '');
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
    if (!ACCOUNT_RE.test(tokenAddress)) {
      throw new HttpError(400, '`tokenAddress` must be a CIS-2 token address', 'invalid_token_address');
    }
    if (agent.token_address && agent.token_address !== tokenAddress) {
      throw new HttpError(409, 'Agent is already recorded with a different token address', 'already_minted');
    }
    if (!agent.card_json) {
      throw new HttpError(409, 'Publish the Agent Card before recording a mint', 'card_missing');
    }

    const saved = await deps.repo.recordMint(agent.id, { tokenId, tokenAddress, txHash });
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
  registry: createAgentRegistryClient(),
  resolveUserId: getUserIdByCognitoSub,
  publicBaseUrl: process.env.CONCORDIUM_CARD_BASE_URL,
});
