/**
 * Anchoring `portfolio_manager_decisions` on-chain.
 *
 * The platform already records what each agent decided and why: `action`,
 * `edge_met`, `conviction_score`, `position_direction`, `reasoning`,
 * `skip_reason`, one row per analysis. That log lives in Aurora, where it is
 * authoritative but not *provable* — a subscriber has to trust us not to edit it.
 *
 * This module makes it provable without storing anything per trade on-chain:
 * each epoch's decisions are hashed into a Merkle root, and only the root is
 * written to the agent's registry metadata. A single subscriber can then be
 * shown an inclusion proof for their own trades, and recompute the root against
 * the value committed on-chain.
 *
 * Design notes that are not obvious:
 *
 *  - Leaves are hashed over {@link AnchorableDecision} with the repo's canonical
 *    JSON form (`shared/audit-chain.ts`), so an Aurora round-trip cannot change a
 *    hash by reordering keys.
 *  - Pairs are hashed **in order** (`H(left ‖ right)`), never sorted. Sorting the
 *    pair would make sibling order uncommitted, so swapping two adjacent
 *    decisions would leave the root unchanged — which defeats the point of
 *    anchoring a sequence of trades.
 *  - An unpaired trailing node is carried up unchanged rather than duplicated,
 *    which avoids the duplicate-last-node ambiguity that afflicts naive trees.
 *    The verifier also checks the claimed leaf count, so a proof cannot be
 *    replayed against a differently shaped tree.
 *  - The root is over decisions in `created_at` order. Order is part of the
 *    commitment: re-ordering is a different root, and that is intended.
 */

import { createHash } from 'crypto';
import { canonicalJson } from '../audit-chain';

/** The decision fields covered by the epoch root. Adding a field is a version bump. */
export interface AnchorableDecision {
  id: string;
  sessionId: string;
  analysisResultId: string | null;
  action: string;
  edgeMet: boolean | null;
  alignmentMet: boolean | null;
  convictionScore: number | null;
  positionDirection: string | null;
  reasoning: string;
  skipReason: string | null;
  /** ISO-8601 with millisecond precision — exactly as stored. */
  createdAt: string;
}

/** Bumped when {@link AnchorableDecision} changes; verification refuses other versions. */
export const DECISION_LEAF_VERSION = 1;

export interface InclusionProof {
  leaf: string;
  index: number;
  /** Leaf count of the tree the proof was built against. */
  size: number;
  path: string[];
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Ordered-pair hashing: `hashPair(left, right)` commits to which side is which. */
function hashPair(left: string, right: string): string {
  return sha256Hex(left + right);
}

/** Leaf for one decision. */
export function decisionLeaf(decision: AnchorableDecision): string {
  return sha256Hex(
    canonicalJson({
      v: DECISION_LEAF_VERSION,
      id: decision.id,
      sessionId: decision.sessionId,
      analysisResultId: decision.analysisResultId,
      action: decision.action,
      edgeMet: decision.edgeMet,
      alignmentMet: decision.alignmentMet,
      convictionScore: decision.convictionScore,
      positionDirection: decision.positionDirection,
      reasoning: decision.reasoning,
      skipReason: decision.skipReason,
      createdAt: decision.createdAt,
    }),
  );
}

/**
 * Merkle root over one epoch's decisions.
 *
 * Throws on an empty set rather than returning a value: an epoch with nothing to
 * commit must not produce a root that looks like an anchored epoch.
 */
export function computeDecisionRoot(decisions: readonly AnchorableDecision[]): string {
  if (decisions.length === 0) throw new Error('cannot anchor an empty decision set');
  let level = decisions.map(decisionLeaf);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      // A trailing unpaired node is carried up unchanged, never duplicated.
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** Proof that one decision is a member of an epoch root. */
export function buildInclusionProof(decisions: readonly AnchorableDecision[], index: number): InclusionProof {
  if (decisions.length === 0) throw new Error('cannot prove membership of an empty decision set');
  if (index < 0 || index >= decisions.length) {
    throw new RangeError(`decision index ${index} out of range for ${decisions.length} leaves`);
  }

  let level = decisions.map(decisionLeaf);
  let cursor = index;
  const path: string[] = [];

  while (level.length > 1) {
    const sibling = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    if (sibling < level.length) path.push(level[sibling]);

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
    cursor = Math.floor(cursor / 2);
  }

  return { leaf: decisionLeaf(decisions[index]), index, size: decisions.length, path };
}

/**
 * Recompute the root from a proof. This is the function a subscriber runs
 * client-side, and the one our own verification endpoint runs server-side
 * before publishing anything.
 */
export function verifyInclusionProof(proof: InclusionProof, root: string): boolean {
  if (!proof || typeof proof.leaf !== 'string' || !Array.isArray(proof.path)) return false;
  if (!Number.isInteger(proof.index) || !Number.isInteger(proof.size) || proof.size < 1) return false;

  let hash = proof.leaf;
  let cursor = proof.index;
  let width = proof.size;
  let step = 0;

  while (width > 1) {
    const hasSibling = cursor % 2 === 0 ? cursor + 1 < width : true;
    if (hasSibling) {
      const sibling = proof.path[step];
      if (typeof sibling !== 'string') return false;
      // Even cursor: our node is the left child; odd: we are the right child.
      hash = cursor % 2 === 0 ? hashPair(hash, sibling) : hashPair(sibling, hash);
      step += 1;
    }
    cursor = Math.floor(cursor / 2);
    width = Math.ceil(width / 2);
  }

  return step === proof.path.length && hash === root;
}
