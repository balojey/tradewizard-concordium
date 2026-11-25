/**
 * Concordium registry routes.
 *
 * The product answers "is my agent accountable?" from the user's own session.
 * This file answers the operator's version of the question: across all agents,
 * and — the part only an operator can do at scale — *does each anchored epoch
 * still reproduce its on-chain root?*
 *
 * Reads are open to analysts; re-verifying an agent is an admin action and is
 * audited, because it changes the cached trust state a support agent may rely on.
 *
 * The integrity check reuses the product's own modules (`decision-root`,
 * `decision-row`, `concordium-db`) rather than re-deriving the Merkle root here:
 * if the two disagreed, the operator's answer would be worthless.
 */

import { z } from 'zod';
import { withAudit } from '../lib/audit';
import { withClient } from '../lib/db';
import { HttpError, json } from '../lib/responses';
import { parseBody } from '../lib/validation';
import type { AdminRoute, RouteContext } from '../lib/router';
import { createAgentRegistryClient } from '../../shared/concordium/mcp';
import { assessBadge } from '../../shared/concordium/badge';
import { computeDecisionRoot } from '../../shared/concordium/decision-root';
import { toAnchorableDecision } from '../../shared/concordium/decision-row';
import { createPgAnchorRepository } from '../../shared/concordium-db';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const verifySchema = z.object({
  reason: z.string().trim().min(8, 'Reason must be at least 8 characters').max(500),
});

function uuidParam(params: Record<string, string>, name = 'id'): string {
  const value = params[name];
  if (!value || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, 'BAD_REQUEST', `Invalid ${name}`);
  }
  return value;
}

function pageSize(raw: string | undefined, fallback = 25, max = 100): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), max) : fallback;
}

const registry = () => createAgentRegistryClient();

interface AgentRow {
  id: string;
  network: string;
  concordium_account: string;
  token_id: string | null;
  token_address: string | null;
  status: string;
  badge_trust: string;
  badge_checked_at: string | null;
  created_at: string;
  user_id: string;
  email: string;
  epoch_count: string;
  last_anchored_at: string | null;
}

export const concordiumRoutes: AdminRoute[] = [
  {
    method: 'GET',
    path: '/admin/concordium/agents',
    minimumRole: 'analyst',
    handler: async ({ event }: RouteContext) => {
      const limit = pageSize(event.queryStringParameters?.limit);
      const q = event.queryStringParameters?.q?.trim() || null;
      // ILIKE with a wildcard pattern; NULL disables the filter.
      const pattern = q ? `%${q}%` : null;

      return withClient(async (client) => {
        const { rows } = await client.query<AgentRow>(
          `SELECT a.id, a.network, a.concordium_account, a.token_id::text AS token_id,
                  a.token_address, a.status, a.badge_trust, a.badge_checked_at, a.created_at,
                  u.id AS user_id, u.email,
                  (SELECT count(*) FROM concordium_audit_anchors an WHERE an.agent_id = a.id)::text AS epoch_count,
                  (SELECT max(an.anchored_at) FROM concordium_audit_anchors an WHERE an.agent_id = a.id) AS last_anchored_at
             FROM concordium_agents a
             JOIN users u ON u.id = a.user_id
            WHERE ($1::text IS NULL
                   OR a.token_address ILIKE $1
                   OR u.email ILIKE $1
                   OR a.concordium_account = $2)
            ORDER BY a.created_at DESC
            LIMIT $3`,
          [pattern, q, limit],
        );

        const counts = await client.query<{ total: string }>(
          `SELECT count(*)::text AS total
             FROM concordium_agents a JOIN users u ON u.id = a.user_id
            WHERE ($1::text IS NULL
                   OR a.token_address ILIKE $1
                   OR u.email ILIKE $1
                   OR a.concordium_account = $2)`,
          [pattern, q],
        );

        return json(
          event,
          200,
          rows.map((row) => ({
            id: row.id,
            network: row.network,
            concordiumAccount: row.concordium_account,
            tokenId: row.token_id,
            tokenAddress: row.token_address,
            status: row.status,
            badgeTrust: row.badge_trust,
            badgeCheckedAt: row.badge_checked_at,
            createdAt: row.created_at,
            owner: { userId: row.user_id, email: row.email },
            epochCount: Number(row.epoch_count),
            lastAnchoredAt: row.last_anchored_at,
          })),
          { nextCursor: null, totalCount: Number(counts.rows[0]?.total ?? 0) },
        );
      });
    },
  },

  {
    method: 'POST',
    path: '/admin/concordium/agents/{id}/verify',
    minimumRole: 'admin',
    handler: async ({ event, identity, params }: RouteContext) => {
      const agentId = uuidParam(params);
      const input = parseBody(verifySchema, event.body);

      const agent = await withClient(async (client) => {
        const { rows } = await client.query<{ token_address: string | null; user_id: string }>(
          `SELECT token_address, user_id FROM concordium_agents WHERE id = $1`,
          [agentId],
        );
        return rows[0];
      });
      if (!agent) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
      if (!agent.token_address) {
        throw new HttpError(409, 'BAD_REQUEST', 'Agent is not minted, so it has no badge to verify');
      }

      // Registry call outside any transaction, so a slow network hop cannot hold
      // a database connection.
      const verdict = await registry().checkBadge(agent.token_address);
      const assessment = assessBadge(verdict);

      const updated = await withClient((client) =>
        withAudit(
          client,
          {
            actor: identity,
            action: 'concordium.agent.verify',
            targetType: 'concordium_agent',
            targetId: agentId,
            reason: input.reason,
            ip: event.requestContext?.identity?.sourceIp ?? null,
            userAgent: event.headers?.['user-agent'] ?? event.headers?.['User-Agent'] ?? null,
            requestId: event.requestContext?.requestId ?? null,
          },
          async () => {
            await client.query(
              `UPDATE concordium_agents SET badge_trust = $2, badge_checked_at = now() WHERE id = $1`,
              [agentId, assessment.trust],
            );
            return { result: assessment, after: { badgeTrust: assessment.trust } };
          },
        ),
      );

      return json(event, 200, {
        trust: updated.trust,
        label: updated.label,
        problems: updated.problems,
        checks: verdict.checks ?? {},
        verdict,
      });
    },
  },

  {
    method: 'GET',
    path: '/admin/concordium/epochs',
    minimumRole: 'analyst',
    handler: async ({ event }: RouteContext) => {
      const limit = pageSize(event.queryStringParameters?.limit);

      return withClient(async (client) => {
        const { rows } = await client.query<{
          id: string;
          agent_id: string;
          epoch_start: string;
          epoch_end: string;
          decision_count: number;
          root_hash: string;
          tx_hash: string | null;
          anchored_at: string | null;
          metadata_key: string | null;
          token_id: string | null;
          email: string;
        }>(
          `SELECT an.id, an.agent_id, an.epoch_start, an.epoch_end, an.decision_count,
                  an.root_hash, an.tx_hash, an.anchored_at, an.metadata_key,
                  a.token_id::text AS token_id, u.email
             FROM concordium_audit_anchors an
             JOIN concordium_agents a ON a.id = an.agent_id
             JOIN users u ON u.id = a.user_id
            ORDER BY an.epoch_end DESC
            LIMIT $1`,
          [limit],
        );

        return json(
          event,
          200,
          rows.map((row) => ({
            id: row.id,
            agentId: row.agent_id,
            tokenId: row.token_id,
            ownerEmail: row.email,
            epochStart: row.epoch_start,
            epochEnd: row.epoch_end,
            decisionCount: row.decision_count,
            rootHash: row.root_hash,
            txHash: row.tx_hash,
            anchoredAt: row.anchored_at,
            metadataKey: row.metadata_key,
            awaitingSignature: row.tx_hash === null,
          })),
          { nextCursor: null },
        );
      });
    },
  },

  {
    /**
     * Recompute an epoch from the decision log and compare it with what was
     * anchored. A mismatch is the tamper signal the product surfaces as 409 —
     * here it is a queue item for an operator.
     */
    method: 'GET',
    path: '/admin/concordium/epochs/{anchorId}/integrity',
    minimumRole: 'analyst',
    handler: async ({ event, params }: RouteContext) => {
      const anchorId = uuidParam(params, 'anchorId');
      const repo = createPgAnchorRepository();

      const anchor = await repo.getAnchorById(anchorId);
      if (!anchor) throw new HttpError(404, 'NOT_FOUND', 'Anchor not found');

      const owner = await withClient(async (client) => {
        const { rows } = await client.query<{ user_id: string; token_id: string | null }>(
          `SELECT user_id, token_id::text AS token_id FROM concordium_agents WHERE id = $1`,
          [anchor.agent_id],
        );
        return rows[0];
      });
      if (!owner) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');

      // Same query, ordering and timestamp formatting as the anchoring job.
      const rows = await repo.listDecisionsInEpoch(
        owner.user_id,
        anchor.epoch_start,
        anchor.epoch_end,
        anchor.decision_count,
      );

      const decisions = rows.map(toAnchorableDecision);
      let rebuiltRoot: string | null = null;
      let failure: string | null = null;
      try {
        rebuiltRoot = decisions.length > 0 ? computeDecisionRoot(decisions) : null;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      const reproducible = rebuiltRoot !== null && rebuiltRoot === anchor.root_hash;

      // What the chain actually holds, when the anchor was signed.
      let onChain: { valueText: string | null; matches: boolean } | null = null;
      if (anchor.metadata_key && anchor.tx_hash && owner.token_id) {
        const metadata = await registry()
          .callTool<{ value_text?: string; value_hex?: string }>('get_metadata', {
            token_id: owner.token_id,
            key: anchor.metadata_key,
          })
          .catch(() => null);
        const text =
          metadata?.value_text?.trim().toLowerCase() ??
          (metadata?.value_hex ? Buffer.from(metadata.value_hex, 'hex').toString('utf8').trim().toLowerCase() : null);
        onChain = { valueText: text ?? null, matches: text === anchor.root_hash.toLowerCase() };
      }

      return json(event, 200, {
        anchorId: anchor.id,
        agentId: anchor.agent_id,
        tokenId: owner.token_id,
        epochStart: anchor.epoch_start,
        epochEnd: anchor.epoch_end,
        decisionCount: anchor.decision_count,
        decisionsFound: decisions.length,
        anchoredRoot: anchor.root_hash,
        rebuiltRoot,
        reproducible,
        onChain,
        failure,
      });
    },
  },
];
