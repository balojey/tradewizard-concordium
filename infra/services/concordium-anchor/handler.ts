/**
 * Epoch anchoring job.
 *
 * Closes the loop on the audit claim: each run takes the decisions an agent has
 * made since its last anchor, hashes them into a Merkle root, and stages the
 * on-chain write that pins that root as registry metadata on the agent NFT.
 *
 * What this job deliberately does **not** do is sign. The registry holds no
 * keys, and CIS-8004 metadata writes are owner-authorised, so the sponsor of
 * the agent is the only party who can pin. The job therefore stages an anchor
 * row with the sign-ready payload attached; the operator submits it and we
 * record the transaction hash. That is the same split as minting, and it keeps
 * a user's key out of our infrastructure entirely.
 *
 * A run is per-agent and failure-isolated: one agent's bad state must not stop
 * the others from being anchored.
 *
 * Triggered by: EventBridge schedule
 */

import type { Handler } from 'aws-lambda';
import {
  createPgAnchorRepository,
  type AnchorableAgent,
  type ConcordiumAnchorRepository,
} from '../shared/concordium-db';
import { createAgentRegistryClient, type AgentRegistryClient } from '../shared/concordium/mcp';
import { computeDecisionRoot, DECISION_LEAF_VERSION } from '../shared/concordium/decision-root';
import { toAnchorableDecision } from '../shared/concordium/decision-row';

import { anchorMetadataKey } from '../shared/concordium/anchor-metadata';

// Re-exported for the job's tests; the implementation is shared with the CLI.
export { anchorMetadataKey };

export interface AnchorJobDeps {
  anchors: ConcordiumAnchorRepository;
  registry: AgentRegistryClient;
  now?: () => Date;
  /** Below this, an epoch is not worth a transaction. */
  minDecisions?: number;
  /** Upper bound on decisions per epoch; the rest anchor on the next run. */
  maxDecisionsPerEpoch?: number;
}

export interface AgentAnchorOutcome {
  agentId: string;
  status: 'staged' | 'skipped' | 'duplicate' | 'failed';
  decisionCount?: number;
  rootHash?: string;
  anchorId?: string | null;
  error?: string;
}

export interface AnchorJobResult {
  ranAt: string;
  staged: number;
  skipped: number;
  duplicates: number;
  failed: number;
  agents: AgentAnchorOutcome[];
}

async function anchorAgent(
  agent: AnchorableAgent,
  deps: Required<Pick<AnchorJobDeps, 'anchors' | 'registry'>> & { minDecisions: number; maxDecisionsPerEpoch: number },
): Promise<AgentAnchorOutcome> {
  try {
    const rows = await deps.anchors.listDecisionsSince(agent.userId, agent.lastAnchoredAt, deps.maxDecisionsPerEpoch);
    if (rows.length < deps.minDecisions) {
      return { agentId: agent.agentId, status: 'skipped', decisionCount: rows.length };
    }

    const decisions = rows.map(toAnchorableDecision);
    const rootHash = computeDecisionRoot(decisions);
    const epochStart = decisions[0].createdAt;
    const epochEnd = decisions[decisions.length - 1].createdAt;
    const metadataKey = anchorMetadataKey(epochEnd);

    // The service returns a sign-ready payload; nobody here can sign it.
    //
    // `value_hex` is hex-decoded into raw bytes by the tool, and CIS-8004
    // rejects non-UTF-8 metadata values (-7208). The root therefore goes in as
    // the hex-encoded ASCII form of the digest, which is what readers decode.
    const payload = await deps.registry.callTool<{ parameter_hex?: string }>('build_set_metadata', {
      sender: agent.concordiumAccount,
      token_id: agent.tokenId,
      key: metadataKey,
      value_hex: Buffer.from(rootHash, 'utf8').toString('hex'),
    });

    if (!payload?.parameter_hex) {
      throw new Error('registry returned no parameter_hex for build_set_metadata');
    }

    const anchorId = await deps.anchors.stageAnchor({
      agentId: agent.agentId,
      epochStart,
      epochEnd,
      decisionCount: decisions.length,
      rootHash,
      leafVersion: DECISION_LEAF_VERSION,
      metadataKey,
      payloadHex: payload.parameter_hex,
    });

    if (anchorId === null) {
      // Same epoch staged by a concurrent or previous run: not an error.
      return { agentId: agent.agentId, status: 'duplicate', decisionCount: decisions.length, rootHash };
    }

    return { agentId: agent.agentId, status: 'staged', decisionCount: decisions.length, rootHash, anchorId };
  } catch (error) {
    console.error(`Anchoring failed for agent ${agent.agentId}:`, error);
    return {
      agentId: agent.agentId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAnchorJob(deps: AnchorJobDeps): Promise<AnchorJobResult> {
  const now = deps.now ?? (() => new Date());
  const minDecisions = deps.minDecisions ?? 1;
  const maxDecisionsPerEpoch = deps.maxDecisionsPerEpoch ?? 500;

  const agents = await deps.anchors.listAnchorableAgents();
  const outcomes: AgentAnchorOutcome[] = [];

  for (const agent of agents) {
    outcomes.push(await anchorAgent(agent, { anchors: deps.anchors, registry: deps.registry, minDecisions, maxDecisionsPerEpoch }));
  }

  const count = (status: AgentAnchorOutcome['status']) => outcomes.filter((o) => o.status === status).length;

  return {
    ranAt: now().toISOString(),
    staged: count('staged'),
    skipped: count('skipped'),
    duplicates: count('duplicate'),
    failed: count('failed'),
    agents: outcomes,
  };
}

export const handler: Handler = async () => {
  const result = await runAnchorJob({
    anchors: createPgAnchorRepository(),
    registry: createAgentRegistryClient(),
    minDecisions: Number(process.env.CONCORDIUM_ANCHOR_MIN_DECISIONS ?? 1),
    maxDecisionsPerEpoch: Number(process.env.CONCORDIUM_ANCHOR_MAX_DECISIONS ?? 500),
  });

  console.log(
    `Anchor job: ${result.staged} staged, ${result.skipped} skipped, ${result.duplicates} duplicate, ${result.failed} failed`,
  );
  if (result.failed > 0) console.error('Anchor failures:', result.agents.filter((a) => a.status === 'failed'));

  return result;
};
