import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHandler, type ConcordiumAgentDeps } from './handler';
import type { AgentRegistryClient, BadgeVerdict } from '../shared/concordium/mcp';
import type {
  BadgeTrust,
  ConcordiumAgentRepository,
  ConcordiumAgentRow,
  CreatePendingAgentInput,
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
        id: `agent-${seq}`,
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

const VALID_VERDICT: BadgeVerdict = {
  token_address: 'JyP9X',
  on_chain: { owner_account: OTHER_ACCOUNT, status: 'Active' },
  badge_valid: true,
  issues: [],
  checks: { hash_matches_on_chain: true },
};

function makeDeps(overrides: Partial<ConcordiumAgentDeps> = {}) {
  const repo = memoryRepo();
  const checks: string[] = [];
  const deps: ConcordiumAgentDeps = {
    repo,
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
  return { deps, repo, checks };
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
