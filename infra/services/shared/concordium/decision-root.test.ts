import { describe, expect, it } from 'vitest';
import {
  buildInclusionProof,
  computeDecisionRoot,
  decisionLeaf,
  verifyInclusionProof,
  type AnchorableDecision,
} from './decision-root';

function decision(overrides: Partial<AnchorableDecision> = {}): AnchorableDecision {
  return {
    id: '7c1b2f7e-0000-4000-8000-000000000000',
    sessionId: '9b1deb4d-0000-4000-8000-000000000000',
    analysisResultId: '3f2a1c88-0000-4000-8000-000000000000',
    action: 'enter',
    edgeMet: true,
    alignmentMet: true,
    convictionScore: 0.72,
    positionDirection: 'yes',
    reasoning: 'Edge above threshold with aligned momentum.',
    skipReason: null,
    createdAt: '2026-11-16T09:15:00.000Z',
    ...overrides,
  };
}

/** Deterministic set of n decisions, each distinct. */
function decisions(n: number): AnchorableDecision[] {
  return Array.from({ length: n }, (_, i) =>
    decision({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      createdAt: `2026-11-16T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
      action: i % 2 === 0 ? 'enter' : 'skip',
      skipReason: i % 2 === 0 ? null : 'conviction below threshold',
    }),
  );
}

describe('decisionLeaf', () => {
  it('is stable for identical decisions', () => {
    expect(decisionLeaf(decision())).toBe(decisionLeaf(decision()));
  });

  it('changes when a committed field changes', () => {
    expect(decisionLeaf(decision({ convictionScore: 0.73 }))).not.toBe(decisionLeaf(decision()));
    expect(decisionLeaf(decision({ reasoning: 'other' }))).not.toBe(decisionLeaf(decision()));
  });

  it('distinguishes null from a value in an optional field', () => {
    expect(decisionLeaf(decision({ skipReason: null }))).not.toBe(decisionLeaf(decision({ skipReason: 'none' })));
  });
});

describe('computeDecisionRoot', () => {
  it('is deterministic', () => {
    expect(computeDecisionRoot(decisions(5))).toBe(computeDecisionRoot(decisions(5)));
  });

  it('returns a 64-character hex digest', () => {
    expect(computeDecisionRoot(decisions(1))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-sensitive, so re-ordering is a different commitment', () => {
    const set = decisions(4);
    const reordered = [set[1], set[0], set[2], set[3]];
    expect(computeDecisionRoot(reordered)).not.toBe(computeDecisionRoot(set));
  });

  it('changes when any decision is added', () => {
    expect(computeDecisionRoot(decisions(4))).not.toBe(computeDecisionRoot(decisions(5)));
  });

  it('refuses an empty set rather than anchoring nothing', () => {
    expect(() => computeDecisionRoot([])).toThrow(/empty decision set/);
  });
});

describe('inclusion proofs', () => {
  it.each([1, 2, 3, 4, 5, 7, 8, 9, 16, 17])('verifies every leaf of a %i-leaf tree', (n) => {
    const set = decisions(n);
    const root = computeDecisionRoot(set);
    for (let i = 0; i < n; i += 1) {
      const proof = buildInclusionProof(set, i);
      expect(verifyInclusionProof(proof, root)).toBe(true);
    }
  });

  it('rejects a proof against the wrong root', () => {
    const set = decisions(5);
    const proof = buildInclusionProof(set, 2);
    const otherRoot = computeDecisionRoot(decisions(6));
    expect(verifyInclusionProof(proof, otherRoot)).toBe(false);
  });

  it('rejects a tampered leaf', () => {
    const set = decisions(5);
    const root = computeDecisionRoot(set);
    const proof = buildInclusionProof(set, 2);
    const tampered = { ...proof, leaf: decisionLeaf(decision({ reasoning: 'rewritten after the fact' })) };
    expect(verifyInclusionProof(tampered, root)).toBe(false);
  });

  it('rejects a tampered path', () => {
    const set = decisions(6);
    const root = computeDecisionRoot(set);
    const proof = buildInclusionProof(set, 3);
    expect(proof.path.length).toBeGreaterThan(0);
    const tampered = { ...proof, path: [proof.path[0].replace(/^./, '0'), ...proof.path.slice(1)] };
    expect(verifyInclusionProof(tampered, root)).toBe(false);
  });

  it('rejects a truncated path', () => {
    const set = decisions(8);
    const root = computeDecisionRoot(set);
    const proof = buildInclusionProof(set, 5);
    expect(verifyInclusionProof({ ...proof, path: proof.path.slice(0, -1) }, root)).toBe(false);
  });

  it('rejects an out-of-range index', () => {
    expect(() => buildInclusionProof(decisions(3), 3)).toThrow(RangeError);
  });

  it('produces a proof for a single-leaf tree with no path', () => {
    const set = decisions(1);
    const proof = buildInclusionProof(set, 0);
    expect(proof.path).toEqual([]);
    expect(verifyInclusionProof(proof, computeDecisionRoot(set))).toBe(true);
  });

  it('reports a leaf count that the verifier relies on', () => {
    const set = decisions(5);
    const proof = buildInclusionProof(set, 4);
    expect(proof.size).toBe(5);
    // Same path, wrong claimed size: the carry-up shape no longer matches.
    expect(verifyInclusionProof({ ...proof, size: 8 }, computeDecisionRoot(set))).toBe(false);
  });
});
