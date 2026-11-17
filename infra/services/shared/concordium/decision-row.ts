/**
 * Row → leaf preimage mapping.
 *
 * Shared by the anchoring job and the proof endpoint on purpose: if the two
 * disagreed about which fields are committed or how a value is coerced, a proof
 * would rebuild against a different root than the one that was anchored. One
 * function, one canonical form.
 */

import type { AnchorableDecision } from './decision-root';
import type { DecisionRowSource } from '../concordium-db';

/** Map a decision row onto the fields covered by the epoch root. */
export function toAnchorableDecision(row: DecisionRowSource): AnchorableDecision {
  return {
    id: row.id,
    sessionId: row.session_id,
    analysisResultId: row.analysis_result_id,
    action: row.action,
    edgeMet: row.edge_met,
    alignmentMet: row.alignment_met,
    // NUMERIC arrives as text unless the query casts it; accept both, and keep
    // null as null — coercing to 0 would change the hash.
    convictionScore: row.conviction_score === null ? null : Number(row.conviction_score),
    positionDirection: row.position_direction,
    reasoning: row.reasoning,
    skipReason: row.skip_reason,
    createdAt: row.created_at,
  };
}
