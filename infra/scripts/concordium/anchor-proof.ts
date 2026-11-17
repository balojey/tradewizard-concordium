#!/usr/bin/env -S npx tsx
/**
 * Anchor a decision set on-chain and prove membership in it.
 *
 * This is the audit half of the submission, driven from a file instead of the
 * database so it can be demonstrated without deploying Aurora. It uses the same
 * shared modules the Lambdas use — the root, the leaf mapping and the proof
 * verification are not reimplemented here.
 *
 *   anchor   compute a Merkle root and pin it as registry metadata on the agent
 *   prove    emit an inclusion proof for one decision and self-verify it
 *   tamper   edit a decision and show that the epoch no longer rebuilds
 *   read     read the root actually committed on-chain and compare
 *
 * Env: CONCORDIUM_NETWORK (default testnet), CONCORDIUM_ACCOUNT, CONCORDIUM_KEY_HEX
 * Usage: see docs/concordium-attestation.md
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAgentRegistryClient, type AgentRegistryClient } from '../../services/shared/concordium/mcp';
import type { DecisionRowSource } from '../../services/shared/concordium-db';
import { toAnchorableDecision } from '../../services/shared/concordium/decision-row';
import {
  buildInclusionProof,
  computeDecisionRoot,
  DECISION_LEAF_VERSION,
  verifyInclusionProof,
} from '../../services/shared/concordium/decision-root';
import { anchorMetadataKey } from '../../services/shared/concordium/anchor-metadata';
import { submitPayload } from './submit';

const NETWORK = (process.env.CONCORDIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet' | 'devnet';
const registry: AgentRegistryClient = createAgentRegistryClient({ network: NETWORK });

function arg(name: string, fallback?: string): string | true | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
}

/** Load a decision export (array of DB-shaped rows) and validate the shape. */
function loadDecisions(file: string): DecisionRowSource[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const rows: DecisionRowSource[] = Array.isArray(parsed) ? parsed : parsed.decisions;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no decisions in file');
  for (const row of rows) {
    for (const field of ['id', 'session_id', 'action', 'reasoning', 'created_at'] as const) {
      if (typeof row[field] !== 'string') throw new Error(`decision is missing \`${field}\`: ${JSON.stringify(row).slice(0, 80)}`);
    }
  }
  // Anchoring order is part of the commitment: created_at, then id.
  return [...rows].sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
  );
}

function summary(decisions: DecisionRowSource[]) {
  const anchorable = decisions.map(toAnchorableDecision);
  return {
    anchorable,
    root: computeDecisionRoot(anchorable),
    epochStart: anchorable[0].createdAt,
    epochEnd: anchorable[anchorable.length - 1].createdAt,
  };
}

const commands: Record<string, () => Promise<void>> = {
  async anchor() {
    const file = String(arg('file'));
    const tokenId = String(arg('token-id'));
    const decisions = loadDecisions(file);
    const { root, epochStart, epochEnd } = summary(decisions);

    const metadataKey = anchorMetadataKey(epochEnd);
    console.log(`decisions: ${decisions.length}  epoch: ${epochStart} → ${epochEnd}`);
    console.log(`root:      ${root}`);
    console.log(`metadata:  ${metadataKey}`);

    const payload = await registry.callTool<any>('build_set_metadata', {
      network: NETWORK,
      sender: process.env.CONCORDIUM_ACCOUNT,
      token_id: tokenId,
      key: metadataKey,
      // CIS-8004 rejects non-UTF-8 metadata values (-7208). The registry tool
      // hex-decodes `value_hex` into raw bytes, so store the root as *text* by
      // hex-encoding its ASCII form. Reading back means decoding UTF-8.
      value_hex: Buffer.from(root, 'utf8').toString('hex'),
    });

    const result = await submitPayload(payload, { dryRun: !!arg('dry-run') });
    console.log(JSON.stringify({ metadataKey, root, decisionCount: decisions.length, leafVersion: DECISION_LEAF_VERSION, ...result }, null, 2));
  },

  async prove() {
    const decisions = loadDecisions(String(arg('file')));
    const decisionId = String(arg('decision'));
    const { anchorable, root } = summary(decisions);

    const index = anchorable.findIndex((d) => d.id === decisionId);
    if (index < 0) throw new Error(`decision ${decisionId} is not in this epoch`);

    const proof = buildInclusionProof(anchorable, index);
    const verified = verifyInclusionProof(proof, root);

    const decision = decisions[index];
    const leaf = createHash('sha256')
      .update(
        JSON.stringify({
          v: DECISION_LEAF_VERSION,
          id: decision.id,
          sessionId: decision.session_id,
          analysisResultId: decision.analysis_result_id ?? null,
          action: decision.action,
          edgeMet: decision.edge_met ?? null,
          alignmentMet: decision.alignment_met ?? null,
          convictionScore: decision.conviction_score === null ? null : Number(decision.conviction_score),
          positionDirection: decision.position_direction ?? null,
          reasoning: decision.reasoning,
          skipReason: decision.skip_reason ?? null,
          createdAt: decision.created_at,
        }),
      )
      .digest('hex');

    console.log(
      JSON.stringify(
        {
          decision: anchorable[index],
          leafVersion: DECISION_LEAF_VERSION,
          leaf,
          proof,
          rootHash: root,
          verified,
          note: verified
            ? 'recomputes to the anchored root'
            : 'DOES NOT recompute — the epoch has changed since it was anchored',
        },
        null,
        2,
      ),
    );
    if (!verified) process.exitCode = 1;
  },

  /**
   * The tamper case. Edit one decision after anchoring and the epoch stops
   * hashing to its root; the proof endpoint answers 409 rather than serving a
   * proof that would verify against a different history.
   */
  async tamper() {
    const decisions = loadDecisions(String(arg('file')));
    const decisionId = String(arg('decision'));
    const { root } = summary(decisions);

    const tampered = decisions.map((row) =>
      row.id === decisionId ? { ...row, reasoning: String(arg('reasoning', 'rewritten after the fact')) } : row,
    );
    const tamperedRoot = computeDecisionRoot(tampered.map(toAnchorableDecision));

    console.log(`anchored root:  ${root}`);
    console.log(`rebuilt root:   ${tamperedRoot}`);
    console.log(`match:          ${tamperedRoot === root}`);
    console.log('');
    console.log(
      tamperedRoot === root
        ? 'No change detected (did the id match?).'
        : 'Epoch no longer reproduces its anchored root → the proof endpoint returns\n409 epoch_not_reproducible. This is the tamper signal, not an error.',
    );
    if (tamperedRoot === root) process.exitCode = 1;
  },

  /** Read back what is actually committed on-chain and compare it with the file. */
  async read() {
    const decisions = loadDecisions(String(arg('file')));
    const { root, epochEnd } = summary(decisions);
    const metadataKey = anchorMetadataKey(epochEnd);

    const onChain = await registry.callTool<any>('get_metadata', {
      token_id: String(arg('token-id')),
      key: metadataKey,
    });

    const rawHex = String(onChain?.value_hex ?? onChain?.valueHex ?? '').replace(/^0x/i, '');
    const asText = rawHex ? Buffer.from(rawHex, 'hex').toString('utf8') : '';
    console.log(
      JSON.stringify(
        { metadataKey, onChainBytes: rawHex || null, onChainText: asText || null, computed: root, matches: asText === root },
        null,
        2,
      ),
    );
    if (asText !== root) process.exitCode = 1;
  },
};

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !commands[command]) {
    console.error(
      `usage: anchor-proof.ts <${Object.keys(commands).join('|')}> --file <decisions.json> [--token-id N] [--decision ID]`,
    );
    process.exit(1);
  }
  await commands[command]();
}

// The infra package compiles to CommonJS, where a top-level await is not allowed.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
