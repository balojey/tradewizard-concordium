#!/usr/bin/env -S npx tsx
/**
 * End-to-end test of the Concordium agent API against a deployed environment.
 *
 * Creates (or reuses) a Cognito test user in the namespaced pool, gets a real
 * ID token through ADMIN_USER_PASSWORD_AUTH, then walks every route:
 *
 *   POST /concordium/agents              create
 *   POST /concordium/agents/{id}/card    publish the card (hash checked)
 *   GET  /concordium/agents/{id}/card    public fetch, byte-exact
 *   POST /concordium/agents/{id}/mint    record the on-chain token
 *   POST /concordium/agents/{id}/verify  live badge check
 *   GET  /concordium/agents              list
 *
 * Usage:
 *   npx tsx scripts/concordium/e2e.ts                    # API flow
 *   npx tsx scripts/concordium/e2e.ts --keep             # do not delete the agent
 *
 * Env (defaults read from cdk-outputs-dev.json):
 *   API_BASE_URL, USER_POOL_ID, CLIENT_ID, CLIENT_SECRET, AWS_REGION
 */

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { submitPayload } from './submit';
import { createAgentRegistryClient } from '../../services/shared/concordium/mcp';
import { join } from 'node:path';

const CARD_PATH = join(__dirname, '../../../docs/agents/tradewizard-agent-card.json');
const CARD_URL =
  'https://raw.githubusercontent.com/balojey/tradewizard-concordium/main/docs/agents/tradewizard-agent-card.json';
const CARD_HASH = '6f9fe84acdb3ebc969040721b4b148e6628c60c12b34f630014cfabc90f1f9b9';
const TOKEN_ID = '1224';
const TOKEN_ADDRESS = 'JyP9XfKVsCUMaaEsDtyoS';
const ACCOUNT = '43WTW9mXTvFheLNjmsso5hDEJyYTdn8cssFXYDUHruUjqSSpMu';

const TEST_EMAIL = process.env.E2E_EMAIL ?? 'concordium-e2e@tradewizard.local';
const TEST_PASSWORD = process.env.E2E_PASSWORD ?? 'Tradewizard-E2e-2026!';

interface Config {
  api: string;
  userPoolId: string;
  clientId: string;
  clientSecret?: string;
  region: string;
}

function loadConfig(): Config {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const fromEnv = process.env.API_BASE_URL && process.env.USER_POOL_ID && process.env.CLIENT_ID;
  if (fromEnv) {
    return {
      api: String(process.env.API_BASE_URL).replace(/\/+$/, ''),
      userPoolId: String(process.env.USER_POOL_ID),
      clientId: String(process.env.CLIENT_ID),
      clientSecret: process.env.CLIENT_SECRET,
      region,
    };
  }

  // Fall back to the stack outputs so the script needs no arguments after a deploy.
  const outputs = JSON.parse(readFileSync(join(__dirname, '../../cdk-outputs-dev.json'), 'utf8'));
  const auth = outputs['TradeWizard-Concordium-Dev-Auth'];
  const compute = outputs['TradeWizard-Concordium-Dev-Compute'];
  return {
    api: String(compute.ApiUrl).replace(/\/+$/, ''),
    userPoolId: auth.UserPoolId,
    clientId: auth.BackendClientId,
    clientSecret: process.env.CLIENT_SECRET,
    region,
  };
}

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
    return;
  }
  console.error(`  FAIL ${label}`);
  if (detail !== undefined) console.error('       ', typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600));
  throw new Error(`assertion failed: ${label}`);
}

async function getToken(cfg: Config): Promise<string> {
  const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminInitiateAuthCommand, DescribeUserPoolClientCommand } =
    await import('@aws-sdk/client-cognito-identity-provider');
  const client = new CognitoIdentityProviderClient({ region: cfg.region });

  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: cfg.userPoolId,
        Username: TEST_EMAIL,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: TEST_EMAIL },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
    console.log(`  created cognito user ${TEST_EMAIL}`);
  } catch (error) {
    if ((error as { name?: string }).name !== 'UsernameExistsException') throw error;
    console.log(`  reusing cognito user ${TEST_EMAIL}`);
  }

  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: cfg.userPoolId,
      Username: TEST_EMAIL,
      Password: TEST_PASSWORD,
      Permanent: true,
    }),
  );

  // Clients with a secret require SECRET_HASH on every auth call.
  const clientSecret =
    cfg.clientSecret ??
    (
      await client.send(
        new DescribeUserPoolClientCommand({ UserPoolId: cfg.userPoolId, ClientId: cfg.clientId }),
      )
    ).UserPoolClient?.ClientSecret;

  const authParameters: Record<string, string> = { USERNAME: TEST_EMAIL, PASSWORD: TEST_PASSWORD };
  if (clientSecret) {
    authParameters.SECRET_HASH = createHmac('sha256', clientSecret)
      .update(TEST_EMAIL + cfg.clientId)
      .digest('base64');
  }

  const auth = await client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: cfg.userPoolId,
      ClientId: cfg.clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: authParameters,
    }),
  );

  const token = auth.AuthenticationResult?.IdToken;
  if (!token) throw new Error(`no IdToken returned (challenge: ${auth.ChallengeName ?? 'none'})`);
  return token;
}

/**
 * Provision the `users` row the API resolves the token to.
 *
 * In production the Cognito post-confirmation trigger does this. It does not
 * fire for an admin-created user confirmed with AdminSetUserPassword, so the
 * test inserts the same row the trigger would (cognito_sub + email + status).
 */
async function ensureUserRow(sub: string, email: string): Promise<void> {
  const secretArn = process.env.DB_SECRET_ARN;
  const host = process.env.DB_HOST;
  if (!secretArn || !host) {
    throw new Error(
      'DB_SECRET_ARN and DB_HOST are required so the test user has a users row ' +
        '(the post-confirmation trigger does not run for admin-created users).',
    );
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  const creds = JSON.parse(secret.SecretString ?? '{}');
  const pg = await import('pg');
  const client = new pg.Client({
    connectionString: `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${host}:${creds.port ?? 5432}/${creds.dbname ?? 'tradewizard'}?sslmode=no-verify`,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(
      `INSERT INTO users (cognito_sub, email, status) VALUES ($1, $2, 'active')
       ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()`,
      [sub, email],
    );
  } finally {
    await client.end();
  }
}

/** Open a pg client using the deployment's secret. */
async function withDb<T>(fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
  const secretArn = process.env.DB_SECRET_ARN;
  const host = process.env.DB_HOST;
  if (!secretArn || !host) throw new Error('DB_SECRET_ARN and DB_HOST are required for fixture steps');
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  const creds = JSON.parse(secret.SecretString ?? '{}');
  const pg = await import('pg');
  const client = new pg.Client({
    connectionString: `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${host}:${creds.port ?? 5432}/${creds.dbname ?? 'tradewizard'}?sslmode=no-verify`,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Move the seeded fixture agent and its sessions to the test user. */
async function linkFixtures(sub: string): Promise<{ fixtureAgentId: string; fixtureAnchor?: string; fixtureDecision?: string }> {
  return withDb(async (client) => {
    const user = await client.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [sub]);
    const userId = user.rows[0].id;

    const agent = await client.query<{ id: string }>(
      `UPDATE concordium_agents SET user_id = $1
        WHERE network = 'testnet' AND token_address = $2
        RETURNING id`,
      [userId, TOKEN_ADDRESS],
    );
    if (agent.rows.length === 0) throw new Error('fixture agent not found - run seed-demo.ts first');
    const fixtureAgentId = agent.rows[0].id;

    await client.query(
      `UPDATE portfolio_manager_sessions SET user_id = $1
        WHERE id IN (SELECT session_id FROM portfolio_manager_decisions)`,
      [userId],
    );

    const anchor = await client.query<{ id: string }>(
      `SELECT id FROM concordium_audit_anchors WHERE agent_id = $1 ORDER BY epoch_end DESC LIMIT 1`,
      [fixtureAgentId],
    );
    const decision = await client.query<{ id: string }>(
      `SELECT id FROM portfolio_manager_decisions ORDER BY created_at ASC LIMIT 1`,
    );

    return {
      fixtureAgentId,
      fixtureAnchor: anchor.rows[0]?.id,
      fixtureDecision: decision.rows[0]?.id,
    };
  });
}

/** Edit one decision, then return a function that restores it. */
async function tamperDecision(decisionId: string): Promise<() => Promise<void>> {
  return withDb(async (client) => {
    const original = await client.query<{ reasoning: string }>(
      `SELECT reasoning FROM portfolio_manager_decisions WHERE id = $1`,
      [decisionId],
    );
    const before = original.rows[0].reasoning;
    await client.query(`UPDATE portfolio_manager_decisions SET reasoning = $2 WHERE id = $1`, [
      decisionId,
      'rewritten during the e2e run',
    ]);
    return async () => {
      await withDb(async (restore) => {
        await restore.query(`UPDATE portfolio_manager_decisions SET reasoning = $2 WHERE id = $1`, [decisionId, before]);
      });
    };
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`\nConcordium agent API e2e\n  api : ${cfg.api}\n  pool: ${cfg.userPoolId}\n  client: ${cfg.clientId}\n`);

  const token = await getToken(cfg);

  // The API resolves users.id from the token's sub; make sure that row exists.
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub as string;
  await ensureUserRow(sub, TEST_EMAIL);
  console.log(`  users row ready for sub ${sub.slice(0, 8)}…`);
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const cardJson = readFileSync(CARD_PATH, 'utf8');
  const runId = randomUUID().slice(0, 8);

  console.log('\nAuthentication');
  check('got an ID token', token.length > 100);
  const unauthenticated = await fetch(`${cfg.api}/concordium/agents`);
  check('unauthenticated list is rejected', unauthenticated.status === 401, unauthenticated.status);

  console.log('\nCreate agent');
  const created = await fetch(`${cfg.api}/concordium/agents`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ concordiumAccount: ACCOUNT, externalKeyHex: `02${'ab'.repeat(32)}`, externalKeyNamespace: 'eip155:137' }),
  });
  const createdBody = await created.json();
  check('201 created', created.status === 201, createdBody);
  const agentId = createdBody.agent?.id as string;
  check('agent is pending', createdBody.agent?.status === 'pending', createdBody.agent);
  check('card url is public https', String(createdBody.expectedCardUrl).startsWith('https://'), createdBody.expectedCardUrl);

  console.log('\nPublish the card');
  const badCard = await fetch(`${cfg.api}/concordium/agents/${agentId}/card`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ cardJson, metadataHashHex: '00'.repeat(32), agentUri: CARD_URL }),
  });
  check('hash mismatch rejected', badCard.status === 400, await badCard.text());

  const putCard = await fetch(`${cfg.api}/concordium/agents/${agentId}/card`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ cardJson, metadataHashHex: CARD_HASH, agentUri: CARD_URL }),
  });
  check('card stored', putCard.status === 200, await putCard.clone().text());

  console.log('\nPublic card hosting');
  const served = await fetch(`${cfg.api}/concordium/agents/${agentId}/card`);
  const servedBytes = await served.text();
  check('public fetch is 200', served.status === 200, served.status);
  const { createHash } = await import('node:crypto');
  const servedHash = createHash('sha256').update(servedBytes).digest('hex');
  check('served bytes equal the pinned hash', servedHash === CARD_HASH, { servedHash, CARD_HASH });
  check('cache-control is no-store', served.headers.get('cache-control') === 'no-store', served.headers.get('cache-control'));

  // Self-serve registration: the API builds the payload, any signer submits it.
  // This is the path a wallet-connector UI would take, minus the UI.
  if (process.argv.includes('--self-serve')) {
    console.log('\nSelf-serve registration (API payload + local signature)');
    const payloadResponse = await fetch(`${cfg.api}/concordium/agents/${agentId}/payload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ step: 'register' }),
    });
    const signable = await payloadResponse.json();
    check('register payload returned', payloadResponse.status === 200, signable);
    check('payload names the CIS-8004 contract', signable.contractAddress?.index === 12802, signable.contractAddress);
    check('payload carries a parameter', typeof signable.parameterHex === 'string' && signable.parameterHex.length > 0);

    const submitted = await submitPayload({
      contract_address: signable.contractAddress,
      receive_name: signable.receiveName,
      parameter_hex: signable.parameterHex,
      suggested_energy: signable.energy,
    });
    check('payload signed and submitted', typeof submitted.hash === 'string', submitted);
    const txHash = String(submitted.hash);

    // Find the token the mint just created (newest agent carrying our card).
    const registry = createAgentRegistryClient({ network: 'testnet' });
    const owned: any = await registry.callTool('agents_by_owner', {
      owner_account: process.env.CONCORDIUM_ACCOUNT,
    });
    const minted = (owned.agents ?? [])
      .filter((a: any) => a.metadata_hash_hex === CARD_HASH && a.status !== 'Revoked')
      .sort((a: any, b: any) => Number(b.token_id) - Number(a.token_id))[0];
    check('minted agent is visible in the registry', Boolean(minted), owned.agents?.length);

    const tokenAddressResp: any = await registry.callTool('token_address', {
      token_id: minted.token_id,
      contract_index: 12802,
      contract_subindex: 0,
    });
    check('token address resolved', typeof tokenAddressResp?.token_address === 'string', tokenAddressResp);
    const confirm = await fetch(`${cfg.api}/concordium/agents/${agentId}/confirm`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        step: 'register',
        txHash,
        tokenId: String(minted.token_id),
        tokenAddress: tokenAddressResp.token_address,
      }),
    });
    const confirmBody = await confirm.json();
    check('confirm recorded the registration', confirm.status === 200, confirmBody);
    check('agent is active after confirm', confirmBody.agent?.status === 'active', confirmBody.agent);

    const verifyOwn = await fetch(`${cfg.api}/concordium/agents/${agentId}/verify`, {
      method: 'POST',
      headers: authHeaders,
    });
    const verifyOwnBody = await verifyOwn.json();
    check('verify runs against the freshly minted token', verifyOwn.status === 200, verifyOwnBody);
    // The card we registered still carries token 1224's badge, so the registry
    // reports registered-not-verified. That is the check doing its job.
    check('a mismatched badge is not reported as verified', verifyOwnBody.trust !== 'verified', verifyOwnBody);
    console.log(`  self-serve agent token ${minted.token_id} (${tokenAddressResp.token_address}), tx ${txHash.slice(0, 16)}…`);
  }

  console.log('\nRecord the mint');
  const mint = await fetch(`${cfg.api}/concordium/agents/${agentId}/mint`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tokenId: TOKEN_ID, tokenAddress: TOKEN_ADDRESS, txHash: `e2e-${runId}` }),
  });
  if (mint.status === 409) {
    // The seeded fixture agent already holds this on-chain token.
    check('a claimed token is refused with 409', true);
  } else {
    const mintBody = await mint.json();
    check('mint recorded', mint.status === 200, mintBody);
    check('agent is active', mintBody.agent?.status === 'active', mintBody.agent);
  }

  // Point the seeded fixture agent (real token, real anchored epoch, real
  // decisions) at this test user, so the authenticated read paths run against
  // genuine data instead of an empty agent.
  if (process.argv.includes('--link-fixtures')) {
    console.log('\nLink fixture data to this user');
    const { fixtureAgentId, fixtureAnchor, fixtureDecision } = await linkFixtures(sub);
    check('fixture agent reachable through the API', fixtureAgentId.length > 0);
    console.log(`  fixture agent ${fixtureAgentId}, anchor ${fixtureAnchor ?? 'none'}, decision ${fixtureDecision ?? 'none'}`);

    console.log('\nVerify the badge (live registry call)');
    const verify = await fetch(`${cfg.api}/concordium/agents/${fixtureAgentId}/verify`, { method: 'POST', headers: authHeaders });
    const verifyBody = await verify.json();
    check('verify returned 200', verify.status === 200, verifyBody);
    check('badge trust is verified', verifyBody.trust === 'verified', verifyBody);
    check('no error-severity issues', Array.isArray(verifyBody.problems) && verifyBody.problems.length === 0, verifyBody.problems);

    console.log('\nAnchors');
    const anchors = await fetch(`${cfg.api}/concordium/agents/${fixtureAgentId}/anchors`, { headers: authHeaders });
    const anchorsBody = await anchors.json();
    check('anchors listed', anchors.status === 200 && (anchorsBody.anchors ?? []).length > 0, anchorsBody);

    if (fixtureAnchor) {
      console.log('\nEpoch decisions (what the UI lists)');
      const epoch = await fetch(
        `${cfg.api}/concordium/agents/${fixtureAgentId}/anchors/${fixtureAnchor}/decisions`,
        { headers: authHeaders },
      );
      const epochBody = await epoch.json();
      check('decisions listed', epoch.status === 200 && (epochBody.decisions ?? []).length > 0, epochBody);
      check('each decision carries a leaf', /^[0-9a-f]{64}$/.test(epochBody.decisions?.[0]?.leaf ?? ''), epochBody.decisions?.[0]);
      check('reasoning is not exposed by the list', epochBody.decisions?.[0]?.reasoning === undefined);
    }

    if (fixtureAnchor && fixtureDecision) {
      console.log('\nInclusion proof');
      const proof = await fetch(
        `${cfg.api}/concordium/agents/${fixtureAgentId}/anchors/${fixtureAnchor}/proof/${fixtureDecision}`,
        { headers: authHeaders },
      );
      const proofBody = await proof.json();
      check('proof returned 200', proof.status === 200, proofBody);
      check('proof recomputes to the anchored root', proofBody.verified === true, proofBody);
      check('on-chain value matches the anchored root', proofBody.onChain?.matches === true, proofBody.onChain);

      console.log('\nTamper detection');
      const tamp = await tamperDecision(fixtureDecision);
      const afterTamper = await fetch(
        `${cfg.api}/concordium/agents/${fixtureAgentId}/anchors/${fixtureAnchor}/proof/${fixtureDecision}`,
        { headers: authHeaders },
      );
      check('proof is refused once the log no longer rebuilds', afterTamper.status === 409, afterTamper.status);
      check('refusal names the cause', (await afterTamper.json()).code === 'epoch_not_reproducible');
      await tamp();
    }
  }

  console.log('\nList and fetch');
  const list = await fetch(`${cfg.api}/concordium/agents`, { headers: authHeaders });
  const listBody = await list.json();
  check('agent appears in the list', (listBody.agents ?? []).some((a: { id: string }) => a.id === agentId), listBody);
  const one = await fetch(`${cfg.api}/concordium/agents/${agentId}`, { headers: authHeaders });
  check('single fetch is 200', one.status === 200, one.status);
  const missing = await fetch(`${cfg.api}/concordium/agents/${randomUUID()}`, { headers: authHeaders });
  check('unknown agent 404s', missing.status === 404, missing.status);
  const junk = await fetch(`${cfg.api}/concordium/agents/not-a-uuid/card`);
  check('non-uuid card id 404s', junk.status === 404, junk.status);

  if (!process.argv.includes('--keep')) {
    // The run creates an agent to exercise the write path; unless asked to keep
    // it, remove the ones this test user accumulated so the table stays honest.
    const removed = await withDb(async (client) => {
      const result = await client.query(
        `DELETE FROM concordium_agents
          WHERE token_id IS NULL
            AND user_id = (SELECT id FROM users WHERE cognito_sub = $1)
          RETURNING id`,
        [sub],
      );
      return result.rowCount ?? 0;
    });
    console.log(`cleaned up ${removed} test agent row(s)`);
  }

  console.log(`\n${passed} checks passed. agent ${agentId} (token ${TOKEN_ID})\n`);
}

main().catch((error: unknown) => {
  console.error(`\nE2E FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
