import { describe, expect, it } from 'vitest';
import { anchorMetadataKey, runAnchorJob } from './handler';
import { toAnchorableDecision } from '../shared/concordium/decision-row';
import { computeDecisionRoot } from '../shared/concordium/decision-root';
import type {
  AnchorableAgent,
  ConcordiumAnchorRepository,
  DecisionRowSource,
  StageAnchorInput,
} from '../shared/concordium-db';
import type { AgentRegistryClient } from '../shared/concordium/mcp';

const AGENT: AnchorableAgent = {
  agentId: 'agent-1',
  userId: 'user-1',
  concordiumAccount: '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB',
  tokenId: '1209',
  lastAnchoredAt: null,
};

function decisionRow(index: number, overrides: Partial<DecisionRowSource> = {}): DecisionRowSource {
  return {
    id: `decision-${index}`,
    session_id: 'session-1',
    analysis_result_id: `analysis-${index}`,
    action: index % 2 === 0 ? 'enter' : 'skip',
    edge_met: index % 2 === 0,
    alignment_met: true,
    conviction_score: 0.6 + index / 100,
    position_direction: index % 2 === 0 ? 'YES' : null,
    reasoning: `reason ${index}`,
    skip_reason: index % 2 === 0 ? null : 'conviction below threshold',
    created_at: `2026-11-16T09:${String(index).padStart(2, '0')}:00.000Z`,
    ...overrides,
  };
}

function memoryAnchors(options: {
  agents?: AnchorableAgent[];
  decisions?: DecisionRowSource[];
  stageResult?: string | null;
}) {
  const staged: StageAnchorInput[] = [];
  const calls: Array<{ userId: string; since: string | null; limit: number }> = [];
  const tx: Array<{ anchorId: string; txHash: string }> = [];

  const repo: ConcordiumAnchorRepository = {
    async listAnchorableAgents() {
      return options.agents ?? [AGENT];
    },
    async listDecisionsSince(userId, since, limit) {
      calls.push({ userId, since, limit });
      return (options.decisions ?? []).slice(0, limit);
    },
    async stageAnchor(input) {
      staged.push(input);
      return options.stageResult === undefined ? 'anchor-1' : options.stageResult;
    },
    async recordAnchorTx(anchorId, txHash) {
      tx.push({ anchorId, txHash });
    },
    // Not exercised by the job; the proof routes live in concordium-agent.
    async listAnchorsForAgent() {
      return [];
    },
    async getAnchorById() {
      return null;
    },
    async getAnchorForAgent() {
      return null;
    },
    async listDecisionsInEpoch() {
      return [];
    },
  };

  return { repo, staged, calls, tx };
}

function registryStub(payload: unknown = { parameter_hex: 'abcd' }) {
  const tools: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registry: AgentRegistryClient = {
    network: 'testnet',
    async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      tools.push({ name, args });
      if (payload instanceof Error) throw payload;
      return payload as T;
    },
    async listTools() {
      return [];
    },
    async checkBadge() {
      return {};
    },
  };
  return { registry, tools };
}

describe('anchorMetadataKey', () => {
  it('compacts an ISO timestamp into a fixed-width key', () => {
    expect(anchorMetadataKey('2026-11-16T12:00:00.000Z')).toBe('decisionRoot:20261116T120000.000Z');
  });

  it('keeps milliseconds, so two epochs in the same second cannot collide', () => {
    expect(anchorMetadataKey('2026-11-16T12:00:00.001Z')).not.toBe(anchorMetadataKey('2026-11-16T12:00:00.002Z'));
  });

  it('stays within the 64-character registry limit', () => {
    expect(anchorMetadataKey('2026-11-16T12:00:00.000Z').length).toBeLessThanOrEqual(64);
  });
});

describe('toAnchorableDecision', () => {
  it('maps snake_case rows and coerces a NUMERIC conviction score to a number', () => {
    const mapped = toAnchorableDecision(decisionRow(1, { conviction_score: '0.72' }));
    expect(mapped).toMatchObject({
      id: 'decision-1',
      sessionId: 'session-1',
      analysisResultId: 'analysis-1',
      action: 'skip',
      convictionScore: 0.72,
      createdAt: '2026-11-16T09:01:00.000Z',
    });
    expect(typeof mapped.convictionScore).toBe('number');
  });

  it('keeps a null score null rather than coercing it to zero', () => {
    expect(toAnchorableDecision(decisionRow(2, { conviction_score: null })).convictionScore).toBeNull();
  });
});

describe('runAnchorJob', () => {
  it('stages one anchor per agent with the expected root and metadata key', async () => {
    const decisions = [decisionRow(0), decisionRow(1), decisionRow(2)];
    const { repo, staged } = memoryAnchors({ decisions });
    const { registry, tools } = registryStub({ parameter_hex: 'deadbeef' });

    const result = await runAnchorJob({ anchors: repo, registry });

    expect(result).toMatchObject({ staged: 1, skipped: 0, failed: 0 });
    expect(staged).toHaveLength(1);

    const expectedRoot = computeDecisionRoot(decisions.map(toAnchorableDecision));
    expect(staged[0]).toMatchObject({
      agentId: 'agent-1',
      decisionCount: 3,
      rootHash: expectedRoot,
      leafVersion: 1,
      epochStart: '2026-11-16T09:00:00.000Z',
      epochEnd: '2026-11-16T09:02:00.000Z',
      metadataKey: 'decisionRoot:20261116T090200.000Z',
      payloadHex: 'deadbeef',
    });

    // The registry is asked to build a payload, never to sign.
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('build_set_metadata');
    expect(tools[0].args).toMatchObject({
      sender: AGENT.concordiumAccount,
      token_id: '1209',
      key: 'decisionRoot:20261116T090200.000Z',
      // ASCII root, hex-encoded: the contract rejects raw digest bytes (-7208).
      value_hex: Buffer.from(expectedRoot, 'utf8').toString('hex'),
    });
    expect(tools[0].args.value_hex).not.toBe(expectedRoot);
  });

  it('asks only for decisions since the last anchor', async () => {
    const { repo, calls } = memoryAnchors({
      agents: [{ ...AGENT, lastAnchoredAt: '2026-11-15T00:00:00.000Z' }],
      decisions: [decisionRow(0)],
    });
    const { registry } = registryStub();

    await runAnchorJob({ anchors: repo, registry });

    expect(calls[0]).toEqual({ userId: 'user-1', since: '2026-11-15T00:00:00.000Z', limit: 500 });
  });

  it('skips an agent below the minimum decision count without calling the registry', async () => {
    const { repo, staged } = memoryAnchors({ decisions: [decisionRow(0)] });
    const { registry, tools } = registryStub();

    const result = await runAnchorJob({ anchors: repo, registry, minDecisions: 3 });

    expect(result).toMatchObject({ staged: 0, skipped: 1 });
    expect(staged).toHaveLength(0);
    expect(tools).toHaveLength(0);
  });

  it('treats an already-staged epoch as a duplicate, not a failure', async () => {
    const { repo } = memoryAnchors({ decisions: [decisionRow(0)], stageResult: null });
    const { registry } = registryStub();

    const result = await runAnchorJob({ anchors: repo, registry });

    expect(result).toMatchObject({ staged: 0, duplicates: 1, failed: 0 });
    expect(result.agents[0].status).toBe('duplicate');
  });

  it('isolates a failing agent so the rest still anchor', async () => {
    const agents: AnchorableAgent[] = [AGENT, { ...AGENT, agentId: 'agent-2', userId: 'user-2' }];
    const { repo, staged } = memoryAnchors({ agents, decisions: [decisionRow(0)] });

    let call = 0;
    const registry: AgentRegistryClient = {
      network: 'testnet',
      async callTool<T>(): Promise<T> {
        call += 1;
        if (call === 1) throw new Error('registry exploded');
        return { parameter_hex: 'cafe' } as T;
      },
      async listTools() {
        return [];
      },
      async checkBadge() {
        return {};
      },
    };

    const result = await runAnchorJob({ anchors: repo, registry });

    expect(result).toMatchObject({ staged: 1, failed: 1 });
    expect(result.agents.map((a) => a.status)).toEqual(['failed', 'staged']);
    expect(result.agents[0].error).toMatch(/exploded/);
    expect(staged).toHaveLength(1);
  });

  it('fails the agent when the registry returns no payload instead of staging a null', async () => {
    const { repo, staged } = memoryAnchors({ decisions: [decisionRow(0)] });
    const { registry } = registryStub({});

    const result = await runAnchorJob({ anchors: repo, registry });

    expect(result).toMatchObject({ staged: 0, failed: 1 });
    expect(staged).toHaveLength(0);
    expect(result.agents[0].error).toMatch(/parameter_hex/);
  });

  it('bounds the number of decisions per epoch', async () => {
    const decisions = Array.from({ length: 10 }, (_, i) => decisionRow(i));
    const { repo, calls, staged } = memoryAnchors({ decisions });
    const { registry } = registryStub();

    const result = await runAnchorJob({ anchors: repo, registry, maxDecisionsPerEpoch: 4 });

    expect(calls[0].limit).toBe(4);
    expect(staged[0].decisionCount).toBe(4);
  });

  it('does nothing when there are no active agents', async () => {
    const { repo } = memoryAnchors({ agents: [], decisions: [decisionRow(0)] });
    const { registry, tools } = registryStub();

    const result = await runAnchorJob({ anchors: repo, registry });

    expect(result).toMatchObject({ staged: 0, skipped: 0, failed: 0 });
    expect(tools).toHaveLength(0);
  });

  it('reports the run time', async () => {
    const { repo } = memoryAnchors({ agents: [] });
    const { registry } = registryStub();
    const result = await runAnchorJob({ anchors: repo, registry, now: () => new Date('2026-11-16T12:00:00.000Z') });
    expect(result.ranAt).toBe('2026-11-16T12:00:00.000Z');
  });
});
