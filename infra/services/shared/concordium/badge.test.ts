import { describe, expect, it } from 'vitest';
import { assessBadge, isTrustedCounterparty } from './badge';
import type { BadgeVerdict } from './mcp';

/** Trimmed from a real valid testnet verdict (token 1209, 16 Nov 2026). */
const VALID: BadgeVerdict = {
  token_id: 1209,
  token_address: 'JyP9XNuGtozS8hg7pS7j5',
  agent_uri: 'https://kls.kinganlogic.com/.well-known/agent-card-kls-testnet-1209-v1.json',
  on_chain: {
    owner_account: '4FoWbP7qANwED5SkWgiEt7UEYgGuBTomNBePZ25YQ2oJTqXpTY',
    status: 'Active',
    agent_uri: 'https://kls.kinganlogic.com/.well-known/agent-card-kls-testnet-1209-v1.json',
    metadata_hash_hex: 'b9bef9093e574934710aa990f47d17ade6e3fbe2999c69b9ad10bcf2fe365a4e',
  },
  checks: { on_chain_agent_found: true, card_fetched: true, hash_matches_on_chain: true, badge_well_formed: true },
  badge_valid: true,
  issues: [],
};

describe('assessBadge', () => {
  it('reports a fully valid verdict as verified', () => {
    const assessment = assessBadge(VALID);
    expect(assessment.trust).toBe('verified');
    expect(assessment.label).toBe('Verified by Concordium');
    expect(assessment.ownerAccount).toBe('4FoWbP7qANwED5SkWgiEt7UEYgGuBTomNBePZ25YQ2oJTqXpTY');
    expect(assessment.problems).toEqual([]);
  });

  it('never claims endorsement', () => {
    expect(assessBadge(VALID).caveat).toMatch(/does not review the agent/i);
  });

  it('treats an active agent with a failing badge as registered only', () => {
    const legacy: BadgeVerdict = {
      ...VALID,
      badge_valid: false,
      checks: { ...VALID.checks, badge_well_formed: false },
      issues: [
        {
          severity: 'error',
          field: 'embedding',
          message: 'badge uses the legacy top-level `concordium` block',
        },
      ],
    };

    const assessment = assessBadge(legacy);
    expect(assessment.trust).toBe('registered');
    expect(assessment.label).toBe('Registered, not verified');
    expect(assessment.problems).toHaveLength(1);
    expect(isTrustedCounterparty(legacy)).toBe(false);
  });

  it('reports a dead card URL as registered, not verified', () => {
    const deadCard: BadgeVerdict = {
      ...VALID,
      badge_valid: false,
      issues: [{ severity: 'error', field: 'card_fetch', message: 'card URL did not return HTTP 200' }],
    };

    expect(assessBadge(deadCard).trust).toBe('registered');
  });

  it('fails closed when the verdict is missing or does not say', () => {
    expect(assessBadge(undefined).trust).toBe('unknown');
    expect(assessBadge(null).trust).toBe('unknown');
    expect(assessBadge({}).trust).toBe('unknown');
    expect(isTrustedCounterparty(undefined)).toBe(false);
  });

  it('refuses to call a verdict verified when an error issue accompanies it', () => {
    // Defensive: the service has been inconsistent about badge_valid vs issues.
    const contradictory: BadgeVerdict = {
      ...VALID,
      badge_valid: true,
      issues: [{ severity: 'error', field: 'metadata_hash', message: 'hash mismatch' }],
    };

    expect(assessBadge(contradictory).trust).not.toBe('verified');
  });

  it('ignores warnings when deciding trust', () => {
    const withWarning: BadgeVerdict = {
      ...VALID,
      issues: [{ severity: 'warning', field: 'agent_uri', message: 'non-canonical path' }],
    };

    expect(assessBadge(withWarning).trust).toBe('verified');
  });

  it('does not treat a revoked agent as registered', () => {
    const revoked: BadgeVerdict = {
      ...VALID,
      badge_valid: false,
      on_chain: { ...VALID.on_chain, status: 'Revoked' },
      issues: [{ severity: 'error', field: 'status', message: 'agent is Revoked' }],
    };

    expect(assessBadge(revoked).trust).toBe('unknown');
  });
});
