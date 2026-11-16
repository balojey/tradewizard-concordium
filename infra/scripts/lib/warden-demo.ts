/**
 * Shared fixtures and connection helpers for the Warden demo data pair:
 *
 *   scripts/seed-warden-demo.ts      - fill a dev database with demo records
 *   scripts/cleanup-warden-demo.ts   - remove exactly those records
 *
 * Every row the seed writes is either:
 *   - keyed by a deterministic UUID derived from a `warden-demo:*` name, or
 *   - a row whose email / external id starts with `warden-demo`.
 *
 * That is what makes cleanup exact: it never guesses, and it never touches a
 * real dev record. The one exception is `admin_metrics_daily`, whose primary
 * key is the day; the seed records the previous values in a manifest so the
 * cleanup can put them back.
 *
 * Safety:
 * - Refuses to run against a host that looks like production.
 * - `cleanup` previews by default; it only writes with `--yes`.
 * - Audit rows go through the hash-chain writer, and cleanup re-seals the chain
 *   when it removes rows from the middle of it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';

/** Every demo email, cognito sub, market id and target id contains this. */
export const DEMO_MARKER = 'warden-demo';

export const DEMO_EMAIL_DOMAIN = 'tradewizard.live';

/** Audit rows written by the seed carry this actor, so cleanup can find them. */
export const DEMO_AUDIT_ACTOR = `${DEMO_MARKER}-operator`;
export const DEMO_AUDIT_EMAIL = `${DEMO_MARKER}@${DEMO_EMAIL_DOMAIN}`;
export const DEMO_AUDIT_ROLE = 'owner';

export const MANIFEST_PATH = join(__dirname, '..', '..', '.warden-demo-state.json');

export function demoEmail(slug: string): string {
  return `${DEMO_MARKER}+${slug}@${DEMO_EMAIL_DOMAIN}`;
}

export function demoCognitoSub(slug: string): string {
  return `${DEMO_MARKER}-${slug}`;
}

/**
 * Deterministic UUID (version 5 layout) from a name.
 *
 * Deterministic ids are the whole idempotency story: a second seed run writes
 * the same primary keys, so `ON CONFLICT DO NOTHING` is a no-op, and cleanup
 * can compute the same ids without reading a manifest first.
 */
export function demoUuid(name: string): string {
  const hex = createHash('sha256').update(`${DEMO_MARKER}:${name}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Deterministic 64-char hex, used for fake on-chain tx hashes and tokens. */
export function demoHash(name: string): string {
  return createHash('sha256').update(`${DEMO_MARKER}:${name}`).digest('hex');
}

/**
 * Number of analysis executions the seed writes.
 *
 * `analysis_results` has no marker column, so cleanup identifies those rows by
 * their deterministic id. Keep this in sync with the `ANALYSES` fixture; the
 * seed asserts the two match at start-up so a mismatch fails loudly rather than
 * leaving rows behind.
 */
export const DEMO_ANALYSIS_COUNT = 32;

export function demoAnalysisId(index: number): string {
  return demoUuid(`analysis:${index}`);
}

/** Human handle such as `TW-4F2K9Q` from the support API. */
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function demoSupportRef(name: string): string {
  const hex = demoHash(`support-ref:${name}`);
  let ref = '';
  for (let index = 0; index < 6; index += 1) {
    ref += REF_ALPHABET[parseInt(hex.slice(index * 2, index * 2 + 2), 16) % REF_ALPHABET.length];
  }
  return `TW-${ref}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export interface CommonArgs {
  dryRun: boolean;
  yes: boolean;
  quiet: boolean;
  keepPayloads: boolean;
  keepAudit: boolean;
}

export function parseCommonArgs(argv: string[], command: 'seed' | 'cleanup'): CommonArgs {
  const args: CommonArgs = {
    dryRun: command === 'cleanup',
    yes: false,
    quiet: false,
    keepPayloads: false,
    keepAudit: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--yes':
        args.yes = true;
        args.dryRun = false;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--keep-payloads':
        args.keepPayloads = true;
        break;
      case '--keep-audit':
        args.keepAudit = true;
        break;
      case '--help':
      case '-h':
        args.quiet = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return args;
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── Database connection ─────────────────────────────────────────────────────

export interface DbTarget {
  host: string;
  database: string;
  user: string;
  source: 'DATABASE_URL' | 'PG* environment' | 'Secrets Manager';
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Refuse anything that looks like production.
 *
 * The demo script creates users, payments and audit rows. There is no version of
 * that which is safe to point at production, so the check is a hard failure and
 * not a warning.
 */
export function assertDevelopmentTarget(host: string, database: string): void {
  const haystack = `${host} ${database}`.toLowerCase();
  if (haystack.includes('prod')) {
    throw new Error(
      `Refusing to run: target looks like production (host=${host}, database=${database}). ` +
        'Set DATABASE_URL or the PG* variables to the dev database.'
    );
  }
}

export async function connectToDevDatabase(): Promise<{ client: Client; target: DbTarget }> {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString) {
    const parsed = new URL(connectionString);
    const host = parsed.hostname;
    const database = parsed.pathname.replace(/^\//, '') || 'tradewizard';
    assertDevelopmentTarget(host, database);

    return {
      client: new Client({
        connectionString,
        ssl: isLocalHost(host) ? undefined : { rejectUnauthorized: false },
      }),
      target: {
        host,
        database,
        user: parsed.username || '(url)',
        source: 'DATABASE_URL',
      },
    };
  }

  if (process.env.PGHOST && process.env.PGUSER) {
    const host = process.env.PGHOST;
    const database = process.env.PGDATABASE ?? 'tradewizard';
    assertDevelopmentTarget(host, database);

    return {
      client: new Client({
        ssl: isLocalHost(host) ? undefined : { rejectUnauthorized: false },
      }),
      target: {
        host,
        database,
        user: process.env.PGUSER,
        source: 'PG* environment',
      },
    };
  }

  // Same convention as deploy.sh: the credentials live in `tw-{env}-db-credentials`.
  const envName = process.env.WARDEN_DEMO_ENV ?? 'dev';
  if (envName !== 'dev') {
    throw new Error('WARDEN_DEMO_ENV must be "dev"; the demo scripts never target another environment.');
  }

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const secretId = process.env.DB_SECRET_ARN || `tw-${envName}-db-credentials`;
  const secrets = new SecretsManagerClient({ region });
  const secretValue = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!secretValue.SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }

  const credentials = JSON.parse(secretValue.SecretString) as {
    host: string;
    port?: number;
    dbname?: string;
    username: string;
    password: string;
  };

  const host = credentials.host;
  const database = credentials.dbname ?? 'tradewizard';
  assertDevelopmentTarget(host, database);

  return {
    client: new Client({
      host,
      port: credentials.port ?? 5432,
      database,
      user: credentials.username,
      password: credentials.password,
      ssl: isLocalHost(host) ? undefined : { rejectUnauthorized: false },
    }),
    target: { host, database, user: credentials.username, source: 'Secrets Manager' },
  };
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  day: string;
  /** `false` means the seed created the row; cleanup deletes it. */
  existed: boolean;
  /** Previous values when the seed overwrote a row. */
  previous: Record<string, number> | null;
}

export interface DemoManifest {
  version: 1;
  seededAt: string;
  host: string;
  database: string;
  metrics: MetricsSnapshot[];
  counts: Record<string, number>;
}

export function readManifest(): DemoManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DemoManifest;
  } catch {
    return null;
  }
}

export function writeManifest(manifest: DemoManifest): void {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// ─── Small SQL helpers ───────────────────────────────────────────────────────

export async function insertRow(
  client: Client,
  table: string,
  row: Record<string, unknown>,
  onConflict?: string
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const sql =
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) ` +
    `VALUES (${placeholders.join(', ')})` +
    (onConflict ? ` ${onConflict}` : '');

  await client.query(sql, columns.map((column) => row[column]));
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The analysis bucket, from `ANALYSIS_BUCKET` or by listing buckets for the
 * `tw-dev-analysis-results-*` naming convention. Returns null when neither
 * works, so callers can warn instead of failing the whole run.
 */
export async function resolveAnalysisBucket(): Promise<string | null> {
  const configured = process.env.ANALYSIS_BUCKET;
  if (configured) return configured;

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const client = new S3Client({ region });

  try {
    const response = await client.send(new ListBucketsCommand({}));
    const match = (response.Buckets ?? [])
      .map((bucket) => bucket.Name ?? '')
      .filter((name) => /^tw-dev-analysis-results-/.test(name))
      .sort()
      .pop();

    return match ?? null;
  } catch (error) {
    console.warn(
      `  ! could not list S3 buckets: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function isoDaysAgo(days: number, hours = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(date.getUTCHours() - hours);
  return date.toISOString();
}

export function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function utcDay(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
