#!/usr/bin/env node
/**
 * Remove exactly the data `scripts/seed-warden-demo.ts` created.
 *
 * Cleanup is preview-only by default. Pass `--yes` to delete.
 *
 * How it finds its rows:
 * - users, newsletter rows, tickets: the `warden-demo` marker in email / sub
 * - analyses: deterministic ids (`demoAnalysisId(i)`)
 * - sessions, deliveries, credits, payments, requests: by demo user id (cascade)
 * - market pool rows: deterministic ids built from the markets the demo uses
 * - campaigns / invite links: `created_by = 'warden-demo-operator'`
 * - audit rows: the demo audit actor, or any row targeting a demo record
 *
 * It refuses to run against anything that looks like production.
 *
 * The audit log is append-only, so removing rows means:
 * 1. disabling the immutability trigger inside the transaction,
 * 2. deleting the demo rows,
 * 3. re-sealing the remaining chain when a later, non-demo row exists
 *    (otherwise verification would name the seam as broken).
 * The run verifies the chain from a fresh read before it commits.
 *
 * It also clears the per-user kill-switch state in DynamoDB, so a re-run demo
 * does not start with the previous halt still in place.
 *
 * Usage:
 *   npx tsx scripts/cleanup-warden-demo.ts            # preview
 *   npx tsx scripts/cleanup-warden-demo.ts --yes      # delete
 *   npx tsx scripts/cleanup-warden-demo.ts --yes --keep-payloads
 *   npx tsx scripts/cleanup-warden-demo.ts --yes --keep-audit
 *
 * See docs/admin-portal-runbook.md.
 */

import {
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DeleteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Client } from 'pg';
import {
  AUDIT_HASH_VERSION,
  planChainSeal,
  type SealableAuditRow,
} from '../services/shared/audit-chain';
import { verifyAuditChain, type VerificationRow } from '../services/admin-api/lib/audit-chain';
import {
  DEMO_ANALYSIS_COUNT,
  DEMO_AUDIT_ACTOR,
  DEMO_MARKER,
  connectToDevDatabase,
  demoAnalysisId,
  demoUuid,
  parseCommonArgs,
  readManifest,
  resolveAnalysisBucket,
  section,
} from './lib/warden-demo';

type Counts = Record<string, number>;

async function deleteWhere(
  client: Client,
  counts: Counts,
  table: string,
  where: string,
  params: unknown[] = []
): Promise<number> {
  const result = await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
  const deleted = result.rowCount ?? 0;
  if (deleted > 0) counts[table] = (counts[table] ?? 0) + deleted;
  return deleted;
}

// ─── Audit chain ─────────────────────────────────────────────────────────────

interface StoredAuditRow {
  id: string;
  actorSub: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  before: unknown;
  after: unknown;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  prevHash: string | null;
  rowHash: string | null;
  completionHash: string | null;
  hashVersion: number;
}

const AUDIT_COLUMNS = `
  id,
  actor_sub       AS "actorSub",
  actor_email     AS "actorEmail",
  actor_role      AS "actorRole",
  action,
  target_type     AS "targetType",
  target_id       AS "targetId",
  reason,
  status,
  before,
  after,
  error,
  created_at      AS "createdAt",
  completed_at    AS "completedAt",
  prev_hash       AS "prevHash",
  row_hash        AS "rowHash",
  completion_hash AS "completionHash",
  hash_version    AS "hashVersion"
`;

function toSealableRow(row: StoredAuditRow): SealableAuditRow {
  return {
    id: row.id,
    actorSub: row.actorSub,
    actorEmail: row.actorEmail,
    actorRole: row.actorRole,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    before: row.before ?? null,
    createdAt: row.createdAt.toISOString(),
    prevHash: row.prevHash,
    rowHash: row.rowHash,
    hashVersion: row.hashVersion ?? AUDIT_HASH_VERSION,
    status: row.status,
    after: row.after ?? null,
    error: row.error,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toVerificationRow(row: StoredAuditRow): VerificationRow {
  return { ...toSealableRow(row), completionHash: row.completionHash };
}

async function readAuditRows(client: Client): Promise<StoredAuditRow[]> {
  const result = await client.query<StoredAuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM admin_audit_log ORDER BY created_at, id`
  );
  return result.rows;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
Remove the Warden demo data.

  --yes             Actually delete (default is a preview that rolls back)
  --keep-payloads   Leave the seeded S3 payloads in place
  --keep-audit      Leave the demo audit rows in place (no chain re-seal)
`);
    return;
  }

  const args = parseCommonArgs(process.argv.slice(2), 'cleanup');
  const log = (message: string) => {
    if (!args.quiet) console.log(message);
  };

  const { client, target } = await connectToDevDatabase();
  await client.connect();

  const counts: Counts = {};
  let payloadKeys: string[] = [];
  let killSwitchUsers: string[] = [];
  let chainStatus: { checked: number; valid: boolean; resealed: number } = {
    checked: 0,
    valid: true,
    resealed: 0,
  };

  try {
    log(`target: ${target.host}/${target.database} (${target.source})`);
    if (!args.yes) log('mode: preview - nothing will be committed (pass --yes to delete)');

    await client.query(`SET lock_timeout = '10s'`);
    await client.query('BEGIN');

    // ── Discover what the seed wrote ────────────────────────────────────────
    const users = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM users
        WHERE email LIKE $1 OR cognito_sub LIKE $1`,
      [`${DEMO_MARKER}%`]
    );
    const userIds = users.rows.map((row) => row.id);
    killSwitchUsers = [...userIds];

    const sessions = await client.query<{ id: string; market_id: string }>(
      `SELECT id, market_id FROM portfolio_manager_sessions WHERE user_id = ANY($1::uuid[])`,
      [userIds]
    );
    const sessionIds = sessions.rows.map((row) => row.id);

    const analysisIds = Array.from({ length: DEMO_ANALYSIS_COUNT }, (_, index) =>
      demoAnalysisId(index)
    );

    const analysisRows = await client.query<{ id: string; market_id: string; key: string }>(
      `SELECT id, market_id, result_payload_s3_key AS key
         FROM analysis_results
        WHERE id = ANY($1::uuid[])`,
      [analysisIds]
    );
    payloadKeys = analysisRows.rows.map((row) => row.key);

    const tickets = await client.query<{ id: string }>(
      `SELECT id FROM support_tickets
        WHERE requester_email LIKE $1 OR user_id = ANY($2::uuid[])`,
      [`${DEMO_MARKER}%`, userIds]
    );
    const ticketIds = tickets.rows.map((row) => row.id);

    const campaigns = await client.query<{ id: string }>(
      `SELECT id FROM newsletter_campaigns WHERE created_by LIKE $1`,
      [`${DEMO_MARKER}%`]
    );
    const campaignIds = campaigns.rows.map((row) => row.id);

    const invites = await client.query<{ id: string }>(
      `SELECT id FROM admin_invite_links WHERE created_by_sub LIKE $1`,
      [`${DEMO_MARKER}%`]
    );
    const inviteIds = invites.rows.map((row) => row.id);

    const demoMarkets = await client.query<{ condition_id: string }>(
      `SELECT condition_id FROM markets WHERE condition_id LIKE $1`,
      [`${DEMO_MARKER}-%`]
    );

    const scheduleMarkets = new Set<string>([
      ...analysisRows.rows.map((row) => row.market_id),
      ...sessions.rows.map((row) => row.market_id),
      ...demoMarkets.rows.map((row) => row.condition_id),
    ]);
    const scheduleIds = [...scheduleMarkets].map((marketId) => demoUuid(`schedule:${marketId}`));

    const auditTargetIds = [
      ...userIds,
      ...sessionIds,
      ...analysisRows.rows.map((row) => row.id),
      ...ticketIds,
      ...campaignIds,
      ...inviteIds,
    ];

    log(
      `found: ${userIds.length} user(s), ${sessionIds.length} session(s), ` +
        `${analysisRows.rows.length} analysis row(s), ${ticketIds.length} ticket(s), ` +
        `${campaignIds.length} campaign(s), ${inviteIds.length} invite link(s)`
    );

    // Rows that disappear because they hang off a demo user or session. They
    // are not deleted explicitly, but the report must not pretend they survive.
    const cascades: Array<{ table: string; where: string; params: unknown[] }> = [
      { table: 'subscriptions', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'credit_transactions', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'payment_transactions', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'analysis_requests', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'market_subscribers', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'notification_preferences', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'device_endpoints', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'portfolio_manager_sessions', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      {
        table: 'portfolio_manager_trades',
        where: 'session_id = ANY($1::uuid[])',
        params: [sessionIds],
      },
      {
        table: 'portfolio_manager_decisions',
        where: 'session_id = ANY($1::uuid[])',
        params: [sessionIds],
      },
      { table: 'admin_user_notes', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      { table: 'admin_plan_overrides', where: 'user_id = ANY($1::uuid[])', params: [userIds] },
      {
        table: 'support_messages',
        where: 'ticket_id = ANY($1::uuid[])',
        params: [ticketIds],
      },
      {
        table: 'support_thread_tokens',
        where: 'ticket_id = ANY($1::uuid[])',
        params: [ticketIds],
      },
    ];

    for (const cascade of cascades) {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${cascade.table} WHERE ${cascade.where}`,
        cascade.params
      );
      const count = Number(result.rows[0]?.count ?? 0);
      if (count > 0) counts[cascade.table] = (counts[cascade.table] ?? 0) + count;
    }

    // ── Delete, children first ──────────────────────────────────────────────
    const demoTargets = { userIds, scheduleIds, ticketIds, campaignIds, inviteIds };

    // portfolio_manager_schedule points at analysis_results, so it goes first.
    await deleteWhere(
      client,
      counts,
      'market_analysis_schedule',
      'id = ANY($1::uuid[])',
      [demoTargets.scheduleIds]
    );

    // Support: messages and tokens cascade from the ticket.
    await deleteWhere(
      client,
      counts,
      'support_tickets',
      'requester_email LIKE $1 OR user_id = ANY($2::uuid[]) OR id = ANY($3::uuid[])',
      [`${DEMO_MARKER}%`, userIds, ticketIds]
    );

    // Newsletter: deliveries cascade from the campaign, but external
    // subscribers are addressed only by email.
    await deleteWhere(
      client,
      counts,
      'newsletter_deliveries',
      'campaign_id = ANY($1::uuid[]) OR email LIKE $2',
      [campaignIds, `${DEMO_MARKER}%`]
    );
    await deleteWhere(client, counts, 'newsletter_campaigns', 'id = ANY($1::uuid[])', [campaignIds]);
    await deleteWhere(
      client,
      counts,
      'newsletter_subscribers',
      'email LIKE $1',
      [`${DEMO_MARKER}%`]
    );
    await deleteWhere(
      client,
      counts,
      'newsletter_suppressions',
      'email LIKE $1',
      [`${DEMO_MARKER}%`]
    );

    // Invite links: redemptions cascade, but the seeded redemptions use a
    // `warden-demo` cognito sub that no user row owns.
    await deleteWhere(
      client,
      counts,
      'admin_invite_redemptions',
      'link_id = ANY($1::uuid[]) OR email LIKE $2 OR cognito_sub LIKE $2',
      [inviteIds, `${DEMO_MARKER}%`]
    );
    await deleteWhere(client, counts, 'admin_invite_links', 'id = ANY($1::uuid[])', [inviteIds]);

    // Analyses: deliveries and agent memory cascade from the result, but trades
    // reference `analysis_results` without a cascade. Deleting the demo users
    // first removes their sessions, trades and decisions.
    await deleteWhere(
      client,
      counts,
      'analysis_deliveries',
      'user_id = ANY($1::uuid[]) OR result_id = ANY($2::uuid[])',
      [userIds, analysisIds]
    );

    // Users: subscriptions, credits, payments, requests, subscribers,
    // preferences, sessions, trades, decisions, notes and overrides cascade.
    await deleteWhere(client, counts, 'users', 'id = ANY($1::uuid[])', [userIds]);

    await deleteWhere(client, counts, 'agent_memory', 'result_id = ANY($1::uuid[])', [analysisIds]);
    await deleteWhere(client, counts, 'analysis_results', 'id = ANY($1::uuid[])', [analysisIds]);

    await deleteWhere(
      client,
      counts,
      'markets',
      'condition_id LIKE $1',
      [`${DEMO_MARKER}-%`]
    );

    // ── Audit rows ──────────────────────────────────────────────────────────
    if (args.keepAudit) {
      log('audit: --keep-audit set, demo audit rows are left in place');
    } else {
      const beforeDelete = await readAuditRows(client);

      const deletedRows = beforeDelete.filter(
        (row) =>
          row.actorSub === DEMO_AUDIT_ACTOR ||
          (row.targetId !== null && auditTargetIds.includes(row.targetId))
      );

      if (deletedRows.length > 0) {
        const earliest = deletedRows.reduce(
          (oldest, row) => (row.createdAt < oldest ? row.createdAt : oldest),
          deletedRows[0].createdAt
        );
        const laterRows = beforeDelete.filter(
          (row) =>
            !deletedRows.some((deleted) => deleted.id === row.id) && row.createdAt > earliest
        );

        // The trigger rejects DELETE outright; lift it only inside this
        // transaction, which also holds the re-seal below.
        await client.query('ALTER TABLE admin_audit_log DISABLE TRIGGER admin_audit_log_immutable');

        const deleteResult = await client.query(
          `DELETE FROM admin_audit_log WHERE id = ANY($1::uuid[])`,
          [deletedRows.map((row) => row.id)]
        );
        counts.admin_audit_log =
          (counts.admin_audit_log ?? 0) + (deleteResult.rowCount ?? 0);

        if (laterRows.length > 0) {
          // Removing rows from the middle of the chain leaves a seam. Re-seal
          // the remaining rows, oldest first, so verification still passes.
          const remainingRows = beforeDelete.filter(
            (row) => !deletedRows.some((deleted) => deleted.id === row.id)
          );
          const storedById = new Map(remainingRows.map((row) => [row.id, row]));
          const updates = planChainSeal(remainingRows.map(toSealableRow), { force: true });

          for (const update of updates) {
            const stored = storedById.get(update.id);
            if (
              stored &&
              stored.rowHash === update.rowHash &&
              stored.prevHash === update.prevHash
            ) {
              continue;
            }

            await client.query(
              `
              UPDATE admin_audit_log
                 SET prev_hash = $2,
                     row_hash = $3,
                     completion_hash = $4,
                     completed_at = $5::timestamptz,
                     hash_version = $6
               WHERE id = $1
              `,
              [
                update.id,
                update.prevHash,
                update.rowHash,
                update.completionHash,
                update.completedAt,
                AUDIT_HASH_VERSION,
              ]
            );
            chainStatus.resealed += 1;
          }
        }

        await client.query('ALTER TABLE admin_audit_log ENABLE TRIGGER admin_audit_log_immutable');
      }

      const afterRows = await readAuditRows(client);
      const verification = verifyAuditChain(afterRows.map(toVerificationRow), {
        coversGenesis: true,
      });
      chainStatus = { ...chainStatus, checked: verification.checked, valid: verification.valid };

      if (!verification.valid) {
        throw new Error(
          `Audit chain did not verify after cleanup (first broken row ${verification.firstBrokenId}: ${verification.firstBrokenReason}). Rolled back.`
        );
      }
    }

    // ── Metrics rollup ──────────────────────────────────────────────────────
    const manifest = readManifest();
    if (!manifest) {
      log(
        'metrics: no manifest found (.warden-demo-state.json) - dashboard rows are left untouched'
      );
    } else {
      for (const entry of manifest.metrics) {
        if (entry.existed && entry.previous) {
          await client.query(
            `
            UPDATE admin_metrics_daily
               SET signups = $2,
                   active_users = $3,
                   analyses_executed = $4,
                   analyses_delivered = $5,
                   credits_consumed = $6,
                   revenue_usdc = $7,
                   pm_active_sessions = $8,
                   pm_realized_pnl = $9,
                   updated_at = now()
             WHERE day = $1::date
            `,
            [
              entry.day,
              entry.previous.signups ?? 0,
              entry.previous.activeUsers ?? 0,
              entry.previous.analysesExecuted ?? 0,
              entry.previous.analysesDelivered ?? 0,
              entry.previous.creditsConsumed ?? 0,
              entry.previous.revenueUsdc ?? 0,
              entry.previous.pmActiveSessions ?? 0,
              entry.previous.pmRealizedPnl ?? 0,
            ]
          );
          counts.admin_metrics_daily = (counts.admin_metrics_daily ?? 0) + 1;
        } else {
          await client.query(`DELETE FROM admin_metrics_daily WHERE day = $1::date`, [entry.day]);
          counts.admin_metrics_daily = (counts.admin_metrics_daily ?? 0) + 1;
        }
      }
    }

    // ── Report ──────────────────────────────────────────────────────────────
    section(args.yes ? 'deleted' : 'would delete');
    for (const [table, count] of Object.entries(counts).sort()) {
      log(`  ${table.padEnd(30)} ${count}`);
    }

    if (!args.keepAudit) {
      log(
        `\naudit: chain ${chainStatus.valid ? 'verified' : 'BROKEN'} over ${chainStatus.checked} row(s)` +
          (chainStatus.resealed > 0 ? `, re-sealed ${chainStatus.resealed}` : '')
      );
    }

    if (!args.keepPayloads && payloadKeys.length > 0) {
      log(`s3: ${payloadKeys.length} payload(s) ${args.yes ? 'deleted' : 'would be deleted'}`);
    }

    if (!args.yes) {
      await client.query('ROLLBACK');
      log('\npreview only: rolled back. NOTHING was deleted.');
      log('to delete for real:');
      log('  npm run cleanup:demo:apply');
      log('  npx tsx scripts/cleanup-warden-demo.ts --yes');
      if (process.env.npm_lifecycle_event) {
        log(
          '\nnote: `npm run cleanup:demo --yes` hands --yes to npm, not to this script.\n' +
            '      use `npm run cleanup:demo -- --yes` or the apply script above.'
        );
      }
      return;
    }

    await client.query('COMMIT');
    log('\ncommitted');

    // ── Post-commit: S3 and DynamoDB ────────────────────────────────────────
    if (!args.keepPayloads && payloadKeys.length > 0) {
      try {
        const bucket = await resolveAnalysisBucket();
        if (!bucket) {
          console.warn('  ! no analysis bucket found; skipping payload deletion (use --keep-payloads to silence)');
        } else {
          const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
          const s3 = new S3Client({ region });

          for (let index = 0; index < payloadKeys.length; index += 1000) {
            const batch = payloadKeys.slice(index, index + 1000);
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
              })
            );
          }
          log(`s3: deleted ${payloadKeys.length} payload(s) from ${bucket}`);
        }
      } catch (error) {
        console.warn(
          `  ! S3 cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
        console.warn('    set ANALYSIS_BUCKET and re-run, or delete the keys manually');
      }
    }

    if (killSwitchUsers.length > 0) {
      try {
        const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
        const table = process.env.RATE_LIMIT_TABLE || 'tw-dev-rate-limits';
        const dynamo = new DynamoDBClient({ region });

        for (const userId of killSwitchUsers) {
          await dynamo.send(
            new DeleteItemCommand({
              TableName: table,
              Key: {
                pk: { S: `kill_switch#${userId}` },
                sk: { S: 'state' },
              },
            })
          );
        }
        log(`dynamo: cleared per-user kill-switch state for ${killSwitchUsers.length} demo user(s)`);
      } catch (error) {
        console.warn(
          `  ! could not clear kill-switch state: ${error instanceof Error ? error.message : String(error)}`
        );
        console.warn('    reset it in Warden, or delete the items from the rate-limit table');
      }
    }

    // ── Final check ─────────────────────────────────────────────────────────
    const remaining = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE email LIKE $1`,
      [`${DEMO_MARKER}%`]
    );
    const remainingAudit = args.keepAudit
      ? { rows: [{ count: '0' }] }
      : await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM admin_audit_log WHERE actor_sub = $1`,
          [DEMO_AUDIT_ACTOR]
        );
    const remainingAnalyses = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analysis_results WHERE id = ANY($1::uuid[])`,
      [Array.from({ length: DEMO_ANALYSIS_COUNT }, (_, index) => demoAnalysisId(index))]
    );

    log(
      `remaining: ${remaining.rows[0]?.count ?? 0} demo user(s), ` +
        `${remainingAnalyses.rows[0]?.count ?? 0} analysis row(s), ` +
        `${remainingAudit.rows[0]?.count ?? 0} demo audit row(s)`
    );

    if (
      Number(remaining.rows[0]?.count ?? 0) > 0 ||
      Number(remainingAnalyses.rows[0]?.count ?? 0) > 0
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('\n✗ Cleanup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
