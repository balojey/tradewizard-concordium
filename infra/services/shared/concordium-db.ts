/**
 * Persistence for Concordium agent registrations and audit anchors.
 *
 * Kept behind an interface so the API handler can be exercised without a
 * database: the on-chain side cannot be faked, but the state machine around it
 * can, and that is where the interesting mistakes live.
 *
 * Two invariants the schema enforces and this module preserves:
 *
 *  - `card_json` and `metadata_hash_hex` are stored and served **verbatim**. The
 *    on-chain badge is a hash of the bytes at `agent_uri`, so any reformatting in
 *    the serving path silently invalidates it.
 *  - `badge_trust` is a cache of the last registry check, never a source of
 *    truth. Anything that reads it must tolerate it being stale.
 */

import { getDbCredentials } from './db';

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type AgentStatus = 'pending' | 'minted' | 'active' | 'revoked' | 'failed';
export type BadgeTrust = 'verified' | 'registered' | 'unknown';

export interface ConcordiumAgentRow {
  id: string;
  user_id: string;
  network: string;
  concordium_account: string;
  external_key_namespace: string | null;
  external_key_hex: string | null;
  token_id: string | null;
  token_address: string | null;
  agent_uri: string | null;
  metadata_hash_hex: string | null;
  card_json: string | null;
  status: AgentStatus;
  badge_trust: BadgeTrust;
  badge_checked_at: string | null;
  last_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePendingAgentInput {
  userId: string;
  network: string;
  concordiumAccount: string;
  externalKeyNamespace?: string | null;
  externalKeyHex?: string | null;
}

export interface ConcordiumAgentRepository {
  createPending(input: CreatePendingAgentInput): Promise<ConcordiumAgentRow>;
  listForUser(userId: string): Promise<ConcordiumAgentRow[]>;
  getForUser(userId: string, id: string): Promise<ConcordiumAgentRow | null>;
  /** Card hosting is public, so lookup is by id only. */
  getById(id: string): Promise<ConcordiumAgentRow | null>;
  saveCard(id: string, input: { agentUri: string; metadataHashHex: string; cardJson: string }): Promise<ConcordiumAgentRow>;
  recordMint(id: string, input: { tokenId: string; tokenAddress: string; txHash: string }): Promise<ConcordiumAgentRow>;
  recordBadgeCheck(id: string, trust: BadgeTrust): Promise<void>;
}

const COLUMNS = `
  id, user_id, network, concordium_account,
  external_key_namespace, external_key_hex,
  token_id, token_address, agent_uri, metadata_hash_hex, card_json,
  status, badge_trust, badge_checked_at, last_tx_hash, created_at, updated_at
`;

/**
 * One short-lived connection per invocation, matching the other handlers.
 * The client is always closed, including on error, so a failed request cannot
 * leak a connection into the next warm invocation.
 */
async function withClient<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
  const creds = await getDbCredentials();
  const connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${creds.host}:${creds.port}/${creds.dbname}?sslmode=no-verify`;
  const pg = await import('pg');
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    return await fn(client as unknown as SqlClient);
  } finally {
    await client.end();
  }
}

export function createPgRepository(): ConcordiumAgentRepository {
  return {
    async createPending(input) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `INSERT INTO concordium_agents (
             user_id, network, concordium_account, external_key_namespace, external_key_hex
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING ${COLUMNS}`,
          [
            input.userId,
            input.network,
            input.concordiumAccount,
            input.externalKeyNamespace ?? null,
            input.externalKeyHex ?? null,
          ],
        );
        return rows[0];
      });
    },

    async listForUser(userId) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `SELECT ${COLUMNS} FROM concordium_agents WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        );
        return rows;
      });
    },

    async getForUser(userId, id) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `SELECT ${COLUMNS} FROM concordium_agents WHERE user_id = $1 AND id = $2 LIMIT 1`,
          [userId, id],
        );
        return rows[0] ?? null;
      });
    },

    async getById(id) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `SELECT ${COLUMNS} FROM concordium_agents WHERE id = $1 LIMIT 1`,
          [id],
        );
        return rows[0] ?? null;
      });
    },

    async saveCard(id, input) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `UPDATE concordium_agents
              SET agent_uri = $2, metadata_hash_hex = $3, card_json = $4
            WHERE id = $1
            RETURNING ${COLUMNS}`,
          [id, input.agentUri, input.metadataHashHex.toLowerCase(), input.cardJson],
        );
        return rows[0];
      });
    },

    async recordMint(id, input) {
      return withClient(async (client) => {
        const { rows } = await client.query<ConcordiumAgentRow>(
          `UPDATE concordium_agents
              SET token_id = $2, token_address = $3, last_tx_hash = $4, status = 'active'
            WHERE id = $1
            RETURNING ${COLUMNS}`,
          [id, input.tokenId, input.tokenAddress, input.txHash],
        );
        return rows[0];
      });
    },

    async recordBadgeCheck(id, trust) {
      await withClient(async (client) => {
        await client.query(
          `UPDATE concordium_agents SET badge_trust = $2, badge_checked_at = now() WHERE id = $1`,
          [id, trust],
        );
      });
    },
  };
}

// ─── Audit anchoring ─────────────────────────────────────────────────────────
//
// The anchoring job can compute a root and stage the on-chain write, but it
// cannot sign: the registry holds no keys and CIS-8004 metadata is
// owner-authorised. So an anchor row is created with `tx_hash` null and the
// sign-ready payload attached; the operator submits it and we record the hash.

export interface AnchorableAgent {
  agentId: string;
  userId: string;
  concordiumAccount: string;
  /** decimal string — BIGINT comes back from pg as text */
  tokenId: string;
  /** last anchored epoch end, or null when the agent has never been anchored */
  lastAnchoredAt: string | null;
}

export interface DecisionRowSource {
  id: string;
  session_id: string;
  analysis_result_id: string | null;
  action: string;
  edge_met: boolean | null;
  alignment_met: boolean | null;
  conviction_score: number | string | null;
  position_direction: string | null;
  reasoning: string;
  skip_reason: string | null;
  /** ISO-8601 with millisecond precision, produced by the query itself. */
  created_at: string;
}

export interface StageAnchorInput {
  agentId: string;
  epochStart: string;
  epochEnd: string;
  decisionCount: number;
  rootHash: string;
  leafVersion: number;
  metadataKey: string;
  payloadHex: string;
}

export interface ConcordiumAnchorRepository {
  /** Active agents that have a token and a published card, i.e. anchorable. */
  listAnchorableAgents(): Promise<AnchorableAgent[]>;
  /** Decisions for one owner since the given timestamp, oldest first. */
  listDecisionsSince(userId: string, since: string | null, limit: number): Promise<DecisionRowSource[]>;
  /** Returns the new anchor id, or null when this epoch is already staged. */
  stageAnchor(input: StageAnchorInput): Promise<string | null>;
  recordAnchorTx(anchorId: string, txHash: string): Promise<void>;
}

/**
 * Decisions are read with the timestamp formatting that leaf hashing expects, so
 * an Aurora round-trip cannot change a leaf. Verification reads the same way.
 */
const DECISION_SELECT = `
  d.id,
  d.session_id,
  d.analysis_result_id,
  d.action,
  d.edge_met,
  d.alignment_met,
  d.conviction_score::float8 AS conviction_score,
  d.position_direction,
  d.reasoning,
  d.skip_reason,
  to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
`;

export function createPgAnchorRepository(): ConcordiumAnchorRepository {
  return {
    async listAnchorableAgents() {
      return withClient(async (client) => {
        const { rows } = await client.query<AnchorableAgent>(
          `SELECT
             a.id AS "agentId",
             a.user_id AS "userId",
             a.concordium_account AS "concordiumAccount",
             a.token_id::text AS "tokenId",
             (
               SELECT max(an.epoch_end)::text
                 FROM concordium_audit_anchors an
                WHERE an.agent_id = a.id
             ) AS "lastAnchoredAt"
           FROM concordium_agents a
          WHERE a.status = 'active'
            AND a.token_id IS NOT NULL
            AND a.card_json IS NOT NULL`,
        );
        return rows;
      });
    },

    async listDecisionsSince(userId, since, limit) {
      return withClient(async (client) => {
        const { rows } = await client.query<DecisionRowSource>(
          `SELECT ${DECISION_SELECT}
             FROM portfolio_manager_decisions d
             JOIN portfolio_manager_sessions s ON s.id = d.session_id
            WHERE s.user_id = $1
              AND ($2::timestamptz IS NULL OR d.created_at > $2::timestamptz)
            ORDER BY d.created_at ASC
            LIMIT $3`,
          [userId, since, limit],
        );
        return rows;
      });
    },

    async stageAnchor(input) {
      return withClient(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO concordium_audit_anchors (
             agent_id, epoch_start, epoch_end, decision_count, root_hash,
             leaf_version, metadata_key, payload_hex
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (agent_id, epoch_start, epoch_end) DO NOTHING
           RETURNING id`,
          [
            input.agentId,
            input.epochStart,
            input.epochEnd,
            input.decisionCount,
            input.rootHash,
            input.leafVersion,
            input.metadataKey,
            input.payloadHex,
          ],
        );
        return rows[0]?.id ?? null;
      });
    },

    async recordAnchorTx(anchorId, txHash) {
      await withClient(async (client) => {
        await client.query(
          `UPDATE concordium_audit_anchors SET tx_hash = $2, anchored_at = now() WHERE id = $1`,
          [anchorId, txHash],
        );
      });
    },
  };
}
