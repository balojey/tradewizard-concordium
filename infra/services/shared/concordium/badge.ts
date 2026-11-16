/**
 * What a "Verified by Concordium" badge actually lets us claim.
 *
 * The registry's own wording matters here and is easy to overstate in product
 * copy: the badge means **accountable**, not **endorsed**. It proves a verified
 * human or business stands behind an agent and can be identified through a
 * court process; it does not mean Concordium reviewed the agent's code, audited
 * its behaviour, or approved its use case.
 *
 * So this module deliberately distinguishes three states rather than a boolean:
 *
 *  - `verified`   — every check passed; the agent's card, hash and on-chain
 *                   record agree and the owner is identity-backed.
 *  - `registered` — the agent exists and is active, but the badge does not
 *                   verify (dead card URL, stale hash, legacy embedding).
 *                   Common in practice: across 31 sampled testnet agents only 5
 *                   were valid, mostly failing on card hosting.
 *  - `unknown`    — no usable answer; treat as untrusted and say so.
 *
 * Never render `registered` as a trust signal. See docs/concordium-spike.md.
 */

import type { BadgeIssue, BadgeVerdict } from './mcp';

export type BadgeTrust = 'verified' | 'registered' | 'unknown';

export interface BadgeAssessment {
  trust: BadgeTrust;
  /** Short, user-facing sentence. Safe to put in a UI. */
  label: string;
  /** What the badge does and does not assert. Safe to put in a UI. */
  caveat: string;
  ownerAccount?: string;
  tokenAddress?: string;
  agentUri?: string;
  /** Error-severity issues only, in the order the service reported them. */
  problems: BadgeIssue[];
}

const CAVEAT =
  'Concordium verifies that a real, identity-verified person stands behind this agent. ' +
  'It does not review the agent’s code, behaviour or results.';

function errorsOf(verdict: BadgeVerdict | undefined): BadgeIssue[] {
  const issues = verdict?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue) => issue?.severity === 'error');
}

/**
 * Reduce a raw verdict to the one thing callers should branch on.
 *
 * Fails closed: anything other than an explicit `badge_valid: true` with no
 * error-severity issue is not `verified`. A partially-rendered verdict from a
 * changed service must never read as trust.
 */
export function assessBadge(verdict: BadgeVerdict | undefined | null): BadgeAssessment {
  const problems = errorsOf(verdict ?? undefined);
  const base = {
    ownerAccount: verdict?.on_chain?.owner_account,
    tokenAddress: verdict?.token_address,
    agentUri: verdict?.agent_uri ?? verdict?.on_chain?.agent_uri,
    caveat: CAVEAT,
    problems,
  };

  if (!verdict || verdict.badge_valid === undefined) {
    return { ...base, trust: 'unknown', label: 'No verification available' };
  }

  if (verdict.badge_valid === true && problems.length === 0) {
    return { ...base, trust: 'verified', label: 'Verified by Concordium' };
  }

  const active = verdict.on_chain?.status === 'Active';
  if (active) {
    return {
      ...base,
      trust: 'registered',
      label: 'Registered, not verified',
    };
  }

  return { ...base, trust: 'unknown', label: 'No verification available' };
}

/**
 * Whether we should treat this agent as accountable enough to trade against.
 *
 * Kept separate from {@link assessBadge} so the policy can tighten without
 * changing what we display — and so the call site reads as a decision.
 */
export function isTrustedCounterparty(verdict: BadgeVerdict | undefined | null): boolean {
  return assessBadge(verdict).trust === 'verified';
}
