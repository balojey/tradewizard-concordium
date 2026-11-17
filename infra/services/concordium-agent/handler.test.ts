import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHandler, type ConcordiumAgentDeps } from './handler';
import { computeDecisionRoot } from '../shared/concordium/decision-root';
import { toAnchorableDecision } from '../shared/concordium/decision-row';
import type { AgentRegistryClient, BadgeVerdict } from '../shared/concordium/mcp';
import type {
  AnchorRow,
  BadgeTrust,
  ConcordiumAgentRepository,
  ConcordiumAgentRow,
  ConcordiumAnchorRepository,
  CreatePendingAgentInput,
  DecisionRowSource,
  StageAnchorInput,
} from '../shared/concordium-db';

const ACCOUNT = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
const OTHER_ACCOUNT = '4FoWbP7qANwED5SkWgiEt7UEYgGuBTomNBePZ25YQ2oJTqXpTY';
const CARD = '{\n  "name": "TradeWizard Trade Agent",\n  "version": "1.0.0"\n}';
const CARD_HASH = '5f1cd2c5b5e2b8a3ba3f2ef0f0e5e65f34c7fbfe6ea8d46e57b3f0b7a4a5c9d1';

/** In-memory stand-in for the pg repository. */
function memoryRepo(): ConcordiumAgentRepository & { rows: Map<string, ConcordiumAgentRow> } {
  const rows = new Map<string, ConcordiumAgentRow>();
  let seq = 0;

  const put = (row: ConcordiumAgentRow) => {
    rows.set(row.id, row);
    return { ...row };
  };

  return {
    rows,
    async createPending(input: CreatePendingAgentInput) {
      seq += 1;
      return put({
        id: randomUUID(),
        user_id: input.userId,
        network: input.network,
        concordium_account: input.concordiumAccount,
        external_key_namespace: input.externalKeyNamespace ?? null,
        external_key_hex: input.externalKeyHex ?? null,
        token_id: null,
        token_address: null,
        agent_uri: null,
        metadata_hash_hex: null,
        card_json: null,
        status: 'pending',
        badge_trust: 'unknown',
        badge_checked_at: null,
        last_tx_hash: null,
        created_at: '2026-11-16T09:00:00.000Z',
        updated_at: '2026-11-16T09:00:00.000Z',
      });
    },
    async listForUser(userId) {
      return [...rows.values()].filter((row) => row.user_id === userId).map((row) => ({ ...row }));
    },
    async getForUser(userId, id) {
      const row = rows.get(id);
      return row && row.user_id === userId ? { ...row } : null;
    },
    async getById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async saveCard(id, input) {
      const row = rows.get(id)!;
      return put({ ...row, agent_uri: input.agentUri, metadata_hash_hex: input.metadataHashHex, card_json: input.cardJson });
    },
    async recordMint(id, input) {
      const row = rows.get(id)!;
      return put({
        ...row,
        token_id: input.tokenId,
        token_address: input.tokenAddress,
        last_tx_hash: input.txHash,
        status: 'active',
      });
    },
    async recordBadgeCheck(id, trust: BadgeTrust) {
      const row = rows.get(id)!;
      put({ ...row, badge_trust: trust, badge_checked_at: '2026-11-16T10:00:00.000Z' });
    },
  };
}

/** In-memory anchor store, backed by whatever the test seeds. */
function memoryAnchors(seed: { anchors?: AnchorRow[]; decisions?: DecisionRowSource[] } = {}) {
  const anchors = seed.anchors ?? [];
  const decisions = seed.decisions ?? [];
  const repo: ConcordiumAnchorRepository = {
    async listAnchorableAgents() {
      return [];
    },
    async listDecisionsSince() {
      return [];
    },
    async stageAnchor(_input: StageAnchorInput) {
      return null;
    },
    async recordAnchorTx() {},
    async listAnchorsForAgent(_userId, agentId) {
      return anchors.filter((anchor) => anchor.agent_id === agentId);
    },
    async getAnchorById(anchorId) {
      return anchors.find((anchor) => anchor.id === anchorId) ?? null;
    },
    async getAnchorForAgent(_userId, agentId, anchorId) {
      return anchors.find((anchor) => anchor.id === anchorId && anchor.agent_id === agentId) ?? null;
    },
    async listDecisionsInEpoch(_userId, _start, _end, limit) {
      return decisions.slice(0, limit);
    },
  };
  return { repo, anchors, decisions };
}

const VALID_VERDICT: BadgeVerdict = {
  token_address: 'JyP9X',
  on_chain: { owner_account: OTHER_ACCOUNT, status: 'Active' },
  badge_valid: true,
  issues: [],
  checks: { hash_matches_on_chain: true },
};

function makeDeps(
  overrides: Partial<Omit<ConcordiumAgentDeps, 'anchors'>> = {},
  anchorSeed: { anchors?: AnchorRow[]; decisions?: DecisionRowSource[] } = {},
) {
  const repo = memoryRepo();
  const anchorStore = memoryAnchors(anchorSeed);
  const checks: string[] = [];
  const deps: ConcordiumAgentDeps = {
    repo,
    anchors: anchorStore.repo,
    publicBaseUrl: 'https://api.test/',
    resolveUserId: async (sub: string) => (sub === 'sub-known' ? 'user-1' : null),
    registry: {
      network: 'testnet',
      callTool: (async () => ({})) as unknown as AgentRegistryClient['callTool'],
      listTools: async () => [],
      checkBadge: async (id: string) => {
        checks.push(id);
        return VALID_VERDICT;
      },
    },
    ...overrides,
  };
  return { deps, repo, checks, anchors: anchorStore };
}

/** Invoke the handler with the deps under test and guarantee a result. */
function run(deps: ConcordiumAgentDeps) {
  const handler = createHandler(deps);
  return async (ev: APIGatewayProxyEvent, _context?: unknown, _callback?: unknown): Promise<APIGatewayProxyResult> => {
    const result = await handler(ev, {} as never, () => {});
    if (!result) throw new Error('handler returned nothing');
    return result;
  };
}

function event(overrides: Partial<APIGatewayProxyEvent> & { sub?: string | null } = {}): APIGatewayProxyEvent {
  const { sub = 'sub-known', ...rest } = overrides;
  return {
    httpMethod: 'GET',
    resource: '/concordium/agents',
    path: '/concordium/agents',
    pathParameters: null,
    headers: {},
    body: null,
    isBase64Encoded: false,
    requestContext: sub
      ? ({ authorizer: { claims: { sub } } } as unknown as APIGatewayProxyEvent['requestContext'])
      : ({} as APIGatewayProxyEvent['requestContext']),
    ...rest,
  } as APIGatewayProxyEvent;
}

const body = (value: unknown) => JSON.stringify(value);
const parse = (result: APIGatewayProxyResult | void) => {
  if (!result) throw new Error('handler returned nothing');
  return JSON.parse(result.body);
};

describe('concordium agent handler — routing', () => {
  it('answers CORS preflight without auth', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(event({ httpMethod: 'OPTIONS' }), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it('404s an unknown route', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(event({ resource: '/nope', path: '/nope' }), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('POST /concordium/agents', () => {
  const post = (payload: unknown, sub: string | null = 'sub-known') =>
    event({ httpMethod: 'POST', resource: '/concordium/agents', body: body(payload), sub });

  it('requires authentication', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(post({ concordiumAccount: ACCOUNT }, null), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('rejects a non-Concordium account address', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(post({ concordiumAccount: '0xdeadbeef' }), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 400 });
    expect(parse(result).code).toBe('invalid_account');
  });

  it('creates a pending agent and tells the operator what to do next', async () => {
    const { deps, repo } = makeDeps();
    const result = await run(deps)(post({ concordiumAccount: ACCOUNT }), {} as never, () => {});

    expect(result.statusCode).toBe(201);
    const payload = parse(result);
    expect(payload.agent).toMatchObject({ status: 'pending', concordiumAccount: ACCOUNT, badgeTrust: 'unknown' });
    expect(payload.expectedCardUrl).toBe(`https://api.test/concordium/agents/${payload.agent.id}/card`);
    expect(payload.next).toHaveLength(3);
    expect(repo.rows.get(payload.agent.id)?.user_id).toBe('user-1');
  });

  it('accepts a compressed secp256k1 Polymarket key as the CIS-8 binding', async () => {
    const { deps } = makeDeps();
    const key = '02' + 'ab'.repeat(32);
    const result = await run(deps)(
      post({ concordiumAccount: ACCOUNT, externalKeyHex: key }),
      {} as never,
      () => {},
    );

    expect(result.statusCode).toBe(201);
    expect(parse(result).agent).toMatchObject({ externalKeyHex: key, externalKeyNamespace: 'eip155' });
  });

  it('rejects a 32-byte value that is not a public key', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(
      post({ concordiumAccount: ACCOUNT, externalKeyHex: 'ab'.repeat(32) }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(parse(result).code).toBe('invalid_external_key');
  });

  it('rejects an unknown network', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(
      post({ concordiumAccount: ACCOUNT, network: 'goerli' }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a malformed body', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: '{not json' }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(parse(result).code).toBe('invalid_json');
  });
});

describe('GET /concordium/agents/{id}', () => {
  async function seed() {
    const { deps, repo } = makeDeps();
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    return { deps, repo, id: parse(created).agent.id as string };
  }

  it('returns the caller’s agent', async () => {
    const { deps, id } = await seed();
    const result = await run(deps)(
      event({ resource: '/concordium/agents/{id}', path: `/concordium/agents/${id}`, pathParameters: { id } }),
      {} as never,
      () => {},
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result).agent.id).toBe(id);
  });

  it('hides another user’s agent behind a 404', async () => {
    const { deps, id } = await seed();
    const result = await run(deps)(
      event({
        resource: '/concordium/agents/{id}',
        pathParameters: { id },
        sub: 'sub-other',
      }),
      {} as never,
      () => {},
    );
    expect(result.statusCode).toBe(401);
  });
});

describe('Agent card storage and hosting', () => {
  async function seededAgent() {
    const { deps, repo, checks } = makeDeps();
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    return { deps, repo, checks, id: parse(created).agent.id as string };
  }

  const putCard = (id: string, payload: unknown, sub = 'sub-known') =>
    event({
      httpMethod: 'POST',
      resource: '/concordium/agents/{id}/card',
      path: `/concordium/agents/${id}/card`,
      pathParameters: { id },
      body: body(payload),
      sub,
    });

  it('rejects a card whose bytes do not match the pinned hash', async () => {
    const { deps, id } = await seededAgent();
    const result = await run(deps)(
      putCard(id, { cardJson: CARD, metadataHashHex: CARD_HASH, agentUri: 'https://tradewizard.app/agents/1/card.json' }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(parse(result).code).toBe('card_hash_mismatch');
  });

  it('rejects a card URL the registry could never fetch', async () => {
    const { deps, id } = await seededAgent();
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(CARD).digest('hex');
    const result = await run(deps)(
      putCard(id, { cardJson: CARD, metadataHashHex: hash, agentUri: 'http://localhost:8080/card.json' }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(parse(result).code).toBe('invalid_agent_uri');
  });

  it('stores a matching card and keeps the JSON out of the agent payload', async () => {
    const { deps, id } = await seededAgent();
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(CARD).digest('hex');
    const result = await run(deps)(
      putCard(id, { cardJson: CARD, metadataHashHex: hash, agentUri: 'https://tradewizard.app/agents/1/card.json' }),
      {} as never,
      () => {},
    );

    expect(result.statusCode).toBe(200);
    expect(parse(result).agent).toMatchObject({ metadataHashHex: hash, agentUri: 'https://tradewizard.app/agents/1/card.json' });
    expect(parse(result).agent.cardJson).toBeUndefined();
  });

  it('serves the stored card verbatim, without authentication', async () => {
    const { deps, id } = await seededAgent();
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(CARD).digest('hex');
    await run(deps)(
      putCard(id, { cardJson: CARD, metadataHashHex: hash, agentUri: 'https://tradewizard.app/agents/1/card.json' }),
      {} as never,
      () => {},
    );

    const result = await run(deps)(
      event({ resource: '/concordium/agents/{id}/card', pathParameters: { id }, sub: null }),
      {} as never,
      () => {},
    );

    // Byte-exact: the registry hashes exactly this body.
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(CARD);
    expect(createHash('sha256').update(String(result.body)).digest('hex')).toBe(hash);
    expect(result.headers?.['Cache-Control']).toBe('no-store');
  });

  it('404s a card that has not been published', async () => {
    const { deps, id } = await seededAgent();
    const result = await run(deps)(
      event({ resource: '/concordium/agents/{id}/card', pathParameters: { id }, sub: null }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('POST /concordium/agents/{id}/mint', () => {
  const mint = (id: string, payload: unknown) =>
    event({
      httpMethod: 'POST',
      resource: '/concordium/agents/{id}/mint',
      pathParameters: { id },
      body: body(payload),
    });

  async function agentWithCard() {
    const { deps, repo } = makeDeps();
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    const id = parse(created).agent.id as string;
    const { createHash } = await import('crypto');
    await run(deps)(
      event({
        httpMethod: 'POST',
        resource: '/concordium/agents/{id}/card',
        pathParameters: { id },
        body: body({
          cardJson: CARD,
          metadataHashHex: createHash('sha256').update(CARD).digest('hex'),
          agentUri: 'https://tradewizard.app/agents/1/card.json',
        }),
      }),
      {} as never,
      () => {},
    );
    return { deps, repo, id };
  }

  it('refuses to record a mint before the card is published', async () => {
    const { deps } = makeDeps();
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    const id = parse(created).agent.id as string;
    const result = await run(deps)(
      mint(id, { tokenId: '1209', tokenAddress: OTHER_ACCOUNT, txHash: 'ab'.repeat(32) }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 409 });
    expect(parse(result).code).toBe('card_missing');
  });

  it('records the minted token and marks the agent active', async () => {
    const { deps, id } = await agentWithCard();
    const result = await run(deps)(
      mint(id, { tokenId: '1209', tokenAddress: OTHER_ACCOUNT, txHash: 'ab'.repeat(32) }),
      {} as never,
      () => {},
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result).agent).toMatchObject({
      status: 'active',
      tokenId: '1209',
      tokenAddress: OTHER_ACCOUNT,
    });
  });

  it('rejects a non-decimal token id', async () => {
    const { deps, id } = await agentWithCard();
    const result = await run(deps)(
      mint(id, { tokenId: '1209a', tokenAddress: OTHER_ACCOUNT, txHash: 'ab'.repeat(32) }),
      {} as never,
      () => {},
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('POST /concordium/agents/{id}/verify', () => {
  const verify = (id: string) =>
    event({ httpMethod: 'POST', resource: '/concordium/agents/{id}/verify', pathParameters: { id } });

  async function mintedAgent(checkBadge?: ConcordiumAgentDeps['registry']['checkBadge']) {
    const { deps, repo, checks } = makeDeps(checkBadge ? { registry: {
        network: 'testnet',
        callTool: (async () => ({})) as unknown as AgentRegistryClient['callTool'],
        listTools: async () => [],
        checkBadge,
      } } : {});
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    const id = parse(created).agent.id as string;
    const { createHash } = await import('crypto');
    await run(deps)(
      event({
        httpMethod: 'POST',
        resource: '/concordium/agents/{id}/card',
        pathParameters: { id },
        body: body({
          cardJson: CARD,
          metadataHashHex: createHash('sha256').update(CARD).digest('hex'),
          agentUri: 'https://tradewizard.app/agents/1/card.json',
        }),
      }),
      {} as never,
      () => {},
    );
    await run(deps)(
      event({
        httpMethod: 'POST',
        resource: '/concordium/agents/{id}/mint',
        pathParameters: { id },
        body: body({ tokenId: '1209', tokenAddress: OTHER_ACCOUNT, txHash: 'ab'.repeat(32) }),
      }),
      {} as never,
      () => {},
    );
    return { deps, repo, checks, id };
  }

  it('refuses to verify an agent that has not been minted', async () => {
    const { deps } = makeDeps();
    const created = await run(deps)(
      event({ httpMethod: 'POST', resource: '/concordium/agents', body: body({ concordiumAccount: ACCOUNT }) }),
      {} as never,
      () => {},
    );
    const result = await run(deps)(verify(parse(created).agent.id), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 409 });
  });

  it('reports verified trust and caches it', async () => {
    const { deps, repo, id, checks } = await mintedAgent();
    const result = await run(deps)(verify(id), {} as never, () => {});

    expect(result.statusCode).toBe(200);
    expect(parse(result)).toMatchObject({ trust: 'verified', label: 'Verified by Concordium' });
    expect(checks).toEqual([OTHER_ACCOUNT]);
    expect(repo.rows.get(id)?.badge_trust).toBe('verified');
  });

  it('downgrades to registered when the badge does not validate', async () => {
    const { deps, repo, id } = await mintedAgent(async () => ({
      token_address: OTHER_ACCOUNT,
      on_chain: { status: 'Active' },
      badge_valid: false,
      issues: [{ severity: 'error', field: 'card_fetch', message: 'card URL did not return HTTP 200' }],
    }));

    const result = await run(deps)(verify(id), {} as never, () => {});
    expect(parse(result).trust).toBe('registered');
    expect(parse(result).problems).toHaveLength(1);
    expect(repo.rows.get(id)?.badge_trust).toBe('registered');
  });

  it('returns 502 when the registry is unreachable', async () => {
    const { deps, id } = await mintedAgent(async () => {
      throw new Error('fetch failed');
    });

    const result = await run(deps)(verify(id), {} as never, () => {});
    expect(result).toMatchObject({ statusCode: 502 });
    expect(parse(result).code).toBe('registry_unavailable');
  });
});

describe('anchors and inclusion proofs', () => {
  const DECISIONS: DecisionRowSource[] = [
    {
      id: 'decision-1',
      session_id: 'session-1',
      analysis_result_id: 'analysis-1',
      action: 'enter',
      edge_met: true,
      alignment_met: true,
      conviction_score: 0.71,
      position_direction: 'YES',
      reasoning: 'edge above threshold',
      skip_reason: null,
      created_at: '2026-11-16T09:00:00.000Z',
    },
    {
      id: 'decision-2',
      session_id: 'session-1',
      analysis_result_id: 'analysis-2',
      action: 'skip',
      edge_met: false,
      alignment_met: false,
      conviction_score: 0.22,
      position_direction: null,
      reasoning: 'alignment failed',
      skip_reason: 'alignment below threshold',
      created_at: '2026-11-16T10:00:00.000Z',
    },
    {
      id: 'decision-3',
      session_id: 'session-2',
      analysis_result_id: 'analysis-3',
      action: 'exit',
      edge_met: true,
      alignment_met: true,
      conviction_score: 0.64,
      position_direction: 'YES',
      reasoning: 'take profit hit',
      skip_reason: null,
      created_at: '2026-11-16T11:00:00.000Z',
    },
  ];

  function anchorFor(agentId: string, overrides: Partial<AnchorRow> = {}): AnchorRow {
    return {
      id: randomUUID(),
      agent_id: agentId,
      epoch_start: '2026-11-16T09:00:00.000Z',
      epoch_end: '2026-11-16T11:00:00.000Z',
      decision_count: DECISIONS.length,
      root_hash: computeDecisionRoot(DECISIONS.map(toAnchorableDecision)),
      leaf_version: 1,
      metadata_key: 'decisionRoot:20261116T110000.000Z',
      payload_hex: 'abcd',
      tx_hash: null,
      anchored_at: null,
      created_at: '2026-11-16T12:00:00.000Z',
      ...overrides,
    };
  }

  /** Minted agent in a store the caller keeps, so anchors can point at its real id. */
  async function setup(overrides: Partial<Omit<ConcordiumAgentDeps, 'anchors'>> = {}) {
    const store = makeDeps(overrides);
    const created = await run(store.deps)(
      event({
        httpMethod: 'POST',
        resource: '/concordium/agents',
        body: body({ concordiumAccount: ACCOUNT }),
      }),
    );
    const id = parse(created).agent.id as string;
    const row = store.repo.rows.get(id)!;
    row.token_id = '1209';
    row.token_address = OTHER_ACCOUNT;
    return { ...store, id };
  }

  function proofEvent(id: string, anchorId = 'anchor-1', decisionId = 'decision-1', sub: string | null = 'sub-known') {
    return event({
      resource: '/concordium/agents/{id}/anchors/{anchorId}/proof/{decisionId}',
      pathParameters: { id, anchorId, decisionId },
      sub,
    });
  }

  it('requires authentication', async () => {
    const s = await setup();
    s.anchors.anchors.push(anchorFor(s.id));
    s.anchors.decisions.push(...DECISIONS);

    const result = await run(s.deps)(proofEvent(s.id, 'anchor-1', 'decision-1', null));
    expect(result.statusCode).toBe(401);
  });

  it('404s an anchor that does not belong to the caller', async () => {
    const s = await setup();
    const result = await run(s.deps)(proofEvent(s.id, 'anchor-missing'));
    expect(result.statusCode).toBe(404);
    expect(parse(result).code).toBe('anchor_not_found');
  });

  it('returns a proof that recomputes to the anchored root', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id);
    s.anchors.anchors.push(anchor);
    s.anchors.decisions.push(...DECISIONS);

    const result = await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-2'));
    expect(result.statusCode).toBe(200);

    const payload = parse(result);
    expect(payload.verified).toBe(true);
    expect(payload.rootHash).toBe(anchor.root_hash);
    expect(payload.proof.index).toBe(1);
    expect(payload.proof.size).toBe(3);
    expect(payload.proof.path.length).toBeGreaterThan(0);
    expect(payload.decision.id).toBe('decision-2');
    expect(payload.leafVersion).toBe(1);
    // Nothing anchored on-chain yet, so there is nothing to compare against.
    expect(payload.onChain).toBeNull();
    expect(payload.howToVerify).toHaveLength(3);
  });

  it('refuses to serve a proof when the epoch no longer reproduces its root', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id);
    s.anchors.anchors.push(anchor);
    // Someone edited a decision's reasoning after it was anchored.
    s.anchors.decisions.push(
      ...DECISIONS.map((row) => (row.id === 'decision-3' ? { ...row, reasoning: 'rewritten after the fact' } : row)),
    );

    const result = await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-1'));
    expect(result.statusCode).toBe(409);
    expect(parse(result).code).toBe('epoch_not_reproducible');
  });

  it('404s a decision from a different epoch', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id);
    s.anchors.anchors.push(anchor);
    s.anchors.decisions.push(...DECISIONS);

    const result = await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-from-elsewhere'));
    expect(result.statusCode).toBe(404);
    expect(parse(result).code).toBe('decision_not_in_epoch');
  });

  it('compares the anchored root with the value committed on-chain', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id, { tx_hash: 'ab'.repeat(32) });
    s.anchors.anchors.push(anchor);
    s.anchors.decisions.push(...DECISIONS);

    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    s.deps.registry = {
      network: 'testnet',
      callTool: (async (name: string, args: Record<string, unknown>) => {
        seen.push({ name, args });
        return { value_hex: anchor.root_hash };
      }) as unknown as AgentRegistryClient['callTool'],
      listTools: async () => [],
      checkBadge: async () => VALID_VERDICT,
    };

    const result = await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-1'));
    expect(result.statusCode).toBe(200);
    expect(parse(result).onChain).toEqual({ key: anchor.metadata_key, valueHex: anchor.root_hash, matches: true });
    expect(seen[0]).toMatchObject({ name: 'get_metadata', args: { token_id: '1209', key: anchor.metadata_key } });
  });

  it('reports a mismatch when the on-chain value differs', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id, { tx_hash: 'ab'.repeat(32) });
    s.anchors.anchors.push(anchor);
    s.anchors.decisions.push(...DECISIONS);

    s.deps.registry = {
      network: 'testnet',
      callTool: (async () => ({ value_hex: 'ff'.repeat(32) })) as unknown as AgentRegistryClient['callTool'],
      listTools: async () => [],
      checkBadge: async () => VALID_VERDICT,
    };

    const result = await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-1'));
    expect(parse(result).onChain.matches).toBe(false);
    // The proof itself is still internally consistent.
    expect(parse(result).verified).toBe(true);
  });

  it('does not call the registry for an anchor that is still awaiting signature', async () => {
    const s = await setup();
    const anchor = anchorFor(s.id);
    s.anchors.anchors.push(anchor);
    s.anchors.decisions.push(...DECISIONS);

    const seen: string[] = [];
    s.deps.registry = {
      network: 'testnet',
      callTool: (async (name: string) => {
        seen.push(name);
        return {};
      }) as unknown as AgentRegistryClient['callTool'],
      listTools: async () => [],
      checkBadge: async () => VALID_VERDICT,
    };

    await run(s.deps)(proofEvent(s.id, anchor.id, 'decision-1'));
    expect(seen).toEqual([]);
  });

  it('lists anchors and flags the ones still awaiting a signature', async () => {
    const s = await setup();
    const staged = anchorFor(s.id);
    const submitted = anchorFor(s.id, {
      id: randomUUID(),
      tx_hash: 'cd'.repeat(32),
      payload_hex: null,
      anchored_at: '2026-11-16T13:00:00.000Z',
    });
    s.anchors.anchors.push(staged, submitted);

    const result = await run(s.deps)(event({ resource: '/concordium/agents/{id}/anchors', pathParameters: { id: s.id } }));

    expect(result.statusCode).toBe(200);
    const payload = parse(result);
    expect(payload.anchors).toHaveLength(2);
    expect(payload.anchors[0]).toMatchObject({ id: staged.id, pendingSignature: true });
    expect(payload.anchors[1]).toMatchObject({ id: submitted.id, pendingSignature: false, txHash: 'cd'.repeat(32) });
    // The sign-ready payload itself never leaves the server.
    expect(payload.anchors[0].payloadHex).toBeUndefined();
  });
});

describe('malformed ids', () => {
  it('404s a non-UUID id on the public card route instead of reaching the database', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(
      event({ resource: '/concordium/agents/{id}/card', pathParameters: { id: 'does-not-exist' }, sub: null }),
    );
    expect(result.statusCode).toBe(404);
    expect(parse(result).code).toBe('card_not_found');
  });

  it('404s a non-UUID id on the authenticated routes', async () => {
    const { deps } = makeDeps();
    const result = await run(deps)(
      event({ resource: '/concordium/agents/{id}', pathParameters: { id: 'not-a-uuid' } }),
    );
    expect(result.statusCode).toBe(404);
    expect(parse(result).code).toBe('not_found');
  });
});
