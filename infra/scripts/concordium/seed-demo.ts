#!/usr/bin/env -S npx tsx
/**
 * Seed the deployed environment with the Concordium demo agent.
 *
 * Creates one user, one agent row (pointing at the real testnet token 1224 and
 * the card published in this repo) and, optionally, a portfolio session with the
 * example decisions so the anchoring job has work to do.
 *
 * Idempotent: re-running updates the same rows rather than duplicating them.
 *
 * Env: DB_SECRET_ARN (required), DB_HOST (optional, taken from the secret)
 * Usage:
 *   DB_SECRET_ARN=... npx tsx scripts/concordium/seed-demo.ts [--decisions]
 *   DB_SECRET_ARN=... npx tsx scripts/concordium/seed-demo.ts --attach-email you@example.com
 *
 * `--attach-email` points the existing agent and its decisions at a real account
 * instead of the demo user - use it after signing in once, so the panel in the
 * product shows the live agent rather than its empty state.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARD_PATH = join(__dirname, '../../../docs/agents/tradewizard-agent-card.json');
const DECISIONS_PATH = join(__dirname, '../../../docs/agents/example-decisions.json');

const DEMO = {
  cognitoSub: 'concordium-demo-operator',
  email: 'concordium-demo@tradewizard.local',
  displayName: 'Concordium Demo Operator',
  network: 'testnet',
  concordiumAccount: '43WTW9mXTvFheLNjmsso5hDEJyYTdn8cssFXYDUHruUjqSSpMu',
  tokenId: 1224,
  tokenAddress: 'JyP9XfKVsCUMaaEsDtyoS',
  agentUri:
    'https://raw.githubusercontent.com/balojey/tradewizard-concordium/main/docs/agents/tradewizard-agent-card.json',
  metadataHashHex: '6f9fe84acdb3ebc969040721b4b148e6628c60c12b34f630014cfabc90f1f9b9',
  externalKeyHex:
    '025bdbae4d0a5061bbf2bd9515986129212156553d3d606b5998e87cdcf3b2c134',
};

async function main(): Promise<void> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new Error('DB_SECRET_ARN is required');

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  const creds = JSON.parse(secret.SecretString ?? '{}');
  const host = creds.host || process.env.DB_HOST;
  if (!host) throw new Error('no database host in the secret or DB_HOST');

  const connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${host}:${creds.port ?? 5432}/${creds.dbname ?? 'tradewizard'}?sslmode=no-verify`;
  const pg = await import('pg');
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  // The card must be stored exactly as served: the on-chain hash covers these bytes.
  const cardJson = readFileSync(CARD_PATH, 'utf8');

  const attachIndex = process.argv.indexOf('--attach-email');
  const attachEmail = attachIndex > -1 ? process.argv[attachIndex + 1] : undefined;

  await client.connect();
  try {
    let userId: string;

    if (attachEmail) {
      // Attach to a real account that has already signed in (the Cognito
      // post-confirmation trigger creates the row on first login).
      const existing = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [attachEmail]);
      if (existing.rows.length === 0) {
        throw new Error(
          `no user with email ${attachEmail} - sign in to the product once so the account exists, then retry`,
        );
      }
      userId = existing.rows[0].id;
      console.log(`attaching the demo agent to existing user ${attachEmail}`);
    } else {
      const user = await client.query(
        `INSERT INTO users (cognito_sub, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (cognito_sub) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
         RETURNING id`,
        [DEMO.cognitoSub, DEMO.email, DEMO.displayName],
      );
      userId = user.rows[0].id as string;
    }

    const agent = await client.query(
      `INSERT INTO concordium_agents (
         user_id, network, concordium_account, external_key_namespace, external_key_hex,
         token_id, token_address, agent_uri, metadata_hash_hex, card_json, status, badge_trust
       ) VALUES ($1,$2,$3,'eip155:137',$4,$5,$6,$7,$8,$9,'active','verified')
       ON CONFLICT (network, token_address) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             concordium_account = EXCLUDED.concordium_account,
             external_key_hex = EXCLUDED.external_key_hex,
             agent_uri = EXCLUDED.agent_uri,
             metadata_hash_hex = EXCLUDED.metadata_hash_hex,
             card_json = EXCLUDED.card_json,
             updated_at = now()
       RETURNING id`,
      [
        userId,
        DEMO.network,
        DEMO.concordiumAccount,
        DEMO.externalKeyHex,
        DEMO.tokenId,
        DEMO.tokenAddress,
        DEMO.agentUri,
        DEMO.metadataHashHex,
        cardJson,
      ],
    );
    console.log(`user:  ${userId}`);
    console.log(`agent: ${agent.rows[0].id}`);
    console.log(`card:  ${cardJson.length} bytes, hash ${DEMO.metadataHashHex}`);

    if (process.argv.includes('--decisions')) {
      const decisions = JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')) as Array<Record<string, unknown>>;
      const sessionIds = [...new Set(decisions.map((d) => d.session_id as string))];

      for (const [index, sessionId] of sessionIds.entries()) {
        // One active session per (user, market): give each its own market.
        await client.query(
          `INSERT INTO portfolio_manager_sessions (
             id, user_id, market_id, recurring_analysis_id, persona_id, persona_config,
             investment_amount, status, amount_available
           ) VALUES ($1,$2,$3,$1,'scalper','{}'::jsonb,50,'active',50)
           ON CONFLICT (id) DO NOTHING`,
          [sessionId, userId, `demo-market-${index + 1}`],
        );
      }

      // Sessions inserted by an earlier run belong to the previous owner; move
      // them so the anchoring job (which joins through sessions) sees them.
      if (attachEmail) {
        await client.query(`UPDATE portfolio_manager_sessions SET user_id = $1 WHERE id = ANY($2::uuid[])`, [
          userId,
          sessionIds,
        ]);
      }

      for (const d of decisions) {
        await client.query(
          `INSERT INTO portfolio_manager_decisions (
             id, session_id, analysis_result_id, action, edge_met, alignment_met,
             conviction_score, position_direction, reasoning, skip_reason, created_at
           ) VALUES ($1,$2,NULL::uuid,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [
            d.id,
            d.session_id,
            // The example rows reference analysis results that do not exist in a
            // fresh database; the column is nullable and the FK is enforced.
            d.action,
            d.edge_met,
            d.alignment_met,
            d.conviction_score,
            d.position_direction,
            d.reasoning,
            d.skip_reason,
            d.created_at,
          ],
        );
      }
      console.log(`seeded ${decisions.length} decisions across ${sessionIds.length} sessions`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
