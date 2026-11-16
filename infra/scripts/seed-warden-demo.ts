#!/usr/bin/env node
/**
 * Seed the dev database with Warden demo data.
 *
 * The goal is a demo that can show every Warden surface without touching real
 * customers, real money or the Polymarket CLOB:
 *
 *   overview       30 days of `admin_metrics_daily`
 *   users          12 users across plans, statuses and subscription states
 *   analyses       32 executions with payloads in S3, deliveries, agent memory
 *   portfolio      8 sessions (one is a safe kill-switch target), trades, decisions
 *   billing        subscriptions, credit ledger, on-chain payment ledger
 *   agents         agent memory feeds the quality view; cost rollup comes from analyses
 *   markets        market pool rows, including one deliberately stuck execution
 *   support        6 tickets with threads, one overdue
 *   newsletter     5 subscribers, 1 suppression, 3 campaigns with deliveries
 *   members        2 invite links (one revoked) and their redemptions
 *   audit          40 hash-chained rows written through the real writer
 *
 * The kill-switch target is a dedicated user (`warden-demo+ks@...`) with one
 * active session that holds no position and no pending orders. `executeKillSwitch`
 * only calls the CLOB when a session has pending orders with a `clob_order_id`
 * or a position with `amount_in_positions > 0`, so halting this session is a
 * real halt with nothing at risk.
 *
 * Idempotent: every row has a deterministic id (`warden-demo:*`), so a second
 * run is a no-op. To start completely fresh:
 *
 *   npx tsx scripts/cleanup-warden-demo.ts --yes
 *   npx tsx scripts/seed-warden-demo.ts
 *
 * Connection: `DATABASE_URL`, the libpq `PG*` variables, or (by default) the
 * `tw-dev-db-credentials` secret. The script refuses any target that looks like
 * production.
 *
 * Usage:
 *   npx tsx scripts/seed-warden-demo.ts --dry-run
 *   npx tsx scripts/seed-warden-demo.ts
 *   npx tsx scripts/seed-warden-demo.ts --no-s3
 *
 * See docs/admin-portal-runbook.md.
 */

import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Client } from 'pg';
import { PERSONA_REGISTRY } from '../services/shared/persona-registry';
import { insertChainedAuditRow, type ChainedAuditInsert } from '../services/shared/audit-chain';
import {
  DEMO_ANALYSIS_COUNT,
  demoCognitoSub,
  demoEmail,
  demoHash,
  demoSupportRef,
  demoUuid,
  connectToDevDatabase,
  insertRow,
  isoDaysAgo,
  isoDaysFromNow,
  isoHoursAgo,
  json,
  parseCommonArgs,
  readManifest,
  resolveAnalysisBucket,
  section,
  utcDay,
  writeManifest,
  type DemoManifest,
  type MetricsSnapshot,
} from './lib/warden-demo';

// ─── Fixtures: users ─────────────────────────────────────────────────────────

type Plan = 'free' | 'starter' | 'pro' | 'elite';
type UserStatus = 'active' | 'suspended' | 'banned';

interface UserFixture {
  slug: string;
  name: string;
  plan: Plan;
  status: UserStatus;
  credits: number;
  monthlyLimit: number;
  persona: string;
  createdDaysAgo: number;
  isTrial?: boolean;
  trialEndsInDays?: number;
  grace?: boolean;
  cancelled?: boolean;
  newsletter: 'subscribed' | 'unsubscribed' | 'none';
  newsletterPrompted?: boolean;
  usedPaidPlan?: boolean;
}

const USERS: UserFixture[] = [
  {
    slug: 'ks',
    name: 'Kill Switch Demo',
    plan: 'pro',
    status: 'active',
    credits: 42,
    monthlyLimit: 100,
    persona: 'scalper',
    createdDaysAgo: 21,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'ada',
    name: 'Ada Okafor',
    plan: 'elite',
    status: 'active',
    credits: 168,
    monthlyLimit: 300,
    persona: 'sniper',
    createdDaysAgo: 64,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'marcus',
    name: 'Marcus Lin',
    plan: 'pro',
    status: 'active',
    credits: 37,
    monthlyLimit: 100,
    persona: 'contrarian',
    createdDaysAgo: 41,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'priya',
    name: 'Priya Raman',
    plan: 'starter',
    status: 'active',
    credits: 9,
    monthlyLimit: 30,
    persona: 'catalyst-hunter',
    createdDaysAgo: 33,
    newsletter: 'unsubscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'jun',
    name: 'Jun Park',
    plan: 'free',
    status: 'active',
    credits: 3,
    monthlyLimit: 20,
    persona: 'scalper',
    createdDaysAgo: 9,
    isTrial: true,
    trialEndsInDays: 5,
    newsletter: 'subscribed',
    newsletterPrompted: true,
  },
  {
    slug: 'sofia',
    name: 'Sofia Alvarez',
    plan: 'elite',
    status: 'suspended',
    credits: 240,
    monthlyLimit: 300,
    persona: 'momentum-rider',
    createdDaysAgo: 128,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'tomas',
    name: 'Tomas Novak',
    plan: 'free',
    status: 'banned',
    credits: 0,
    monthlyLimit: 20,
    persona: 'scalper',
    createdDaysAgo: 156,
    cancelled: true,
    newsletter: 'none',
  },
  {
    slug: 'anya',
    name: 'Anya Petrova',
    plan: 'starter',
    status: 'active',
    credits: 22,
    monthlyLimit: 30,
    persona: 'hedge-architect',
    createdDaysAgo: 17,
    newsletter: 'subscribed',
    newsletterPrompted: true,
    usedPaidPlan: true,
  },
  {
    slug: 'diego',
    name: 'Diego Ferreira',
    plan: 'pro',
    status: 'active',
    credits: 0,
    monthlyLimit: 100,
    persona: 'scalper',
    createdDaysAgo: 88,
    grace: true,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'leah',
    name: 'Leah Cohen',
    plan: 'free',
    status: 'active',
    credits: 14,
    monthlyLimit: 20,
    persona: 'cautious',
    createdDaysAgo: 4,
    isTrial: true,
    trialEndsInDays: 10,
    newsletter: 'none',
  },
  {
    slug: 'omar',
    name: 'Omar Haddad',
    plan: 'elite',
    status: 'active',
    credits: 96,
    monthlyLimit: 300,
    persona: 'catalyst-hunter',
    createdDaysAgo: 211,
    newsletter: 'subscribed',
    usedPaidPlan: true,
  },
  {
    slug: 'nina',
    name: 'Nina Rossi',
    plan: 'free',
    status: 'active',
    credits: 18,
    monthlyLimit: 20,
    persona: 'scalper',
    createdDaysAgo: 2,
    newsletter: 'unsubscribed',
    newsletterPrompted: true,
  },
];

// ─── Fixtures: analyses ──────────────────────────────────────────────────────

type Recommendation = 'LONG_YES' | 'LONG_NO' | 'NO_TRADE';
type Outcome = 'pending' | 'success' | 'failure' | 'expired' | 'no_trade';
type NoTradeReason =
  | 'consensus_failed'
  | 'divergence_cap'
  | 'edge_below_threshold'
  | 'thesis_veto';

interface AnalysisTemplate {
  hoursAgo: number;
  recommendation: Recommendation;
  marketP: number;
  consensusP: number;
  confidence: number;
  outcome: Outcome;
  noTradeReason?: NoTradeReason;
}

/**
 * One execution per row, spread over the last 30 days so every reporting window
 * has data. Values are hand-picked rather than random: a demo re-run produces
 * the same screen, and nothing here depends on Math.random().
 */
const ANALYSES: AnalysisTemplate[] = [
  { hoursAgo: 2, recommendation: 'LONG_YES', marketP: 0.64, consensusP: 0.713, confidence: 0.82, outcome: 'pending' },
  { hoursAgo: 3, recommendation: 'NO_TRADE', marketP: 0.52, consensusP: 0.549, confidence: 0.44, outcome: 'no_trade', noTradeReason: 'edge_below_threshold' },
  { hoursAgo: 5, recommendation: 'LONG_NO', marketP: 0.38, consensusP: 0.291, confidence: 0.77, outcome: 'success' },
  { hoursAgo: 7, recommendation: 'LONG_YES', marketP: 0.47, consensusP: 0.565, confidence: 0.74, outcome: 'success' },
  { hoursAgo: 9, recommendation: 'LONG_NO', marketP: 0.61, consensusP: 0.492, confidence: 0.69, outcome: 'failure' },
  { hoursAgo: 11, recommendation: 'NO_TRADE', marketP: 0.28, consensusP: 0.312, confidence: 0.51, outcome: 'no_trade', noTradeReason: 'consensus_failed' },
  { hoursAgo: 14, recommendation: 'LONG_YES', marketP: 0.55, consensusP: 0.643, confidence: 0.86, outcome: 'success' },
  { hoursAgo: 18, recommendation: 'LONG_YES', marketP: 0.42, consensusP: 0.478, confidence: 0.58, outcome: 'expired' },
  { hoursAgo: 21, recommendation: 'LONG_NO', marketP: 0.33, consensusP: 0.241, confidence: 0.72, outcome: 'success' },
  { hoursAgo: 26, recommendation: 'NO_TRADE', marketP: 0.74, consensusP: 0.781, confidence: 0.47, outcome: 'no_trade', noTradeReason: 'thesis_veto' },
  { hoursAgo: 30, recommendation: 'LONG_YES', marketP: 0.58, consensusP: 0.664, confidence: 0.79, outcome: 'failure' },
  { hoursAgo: 34, recommendation: 'NO_TRADE', marketP: 0.45, consensusP: 0.483, confidence: 0.42, outcome: 'no_trade', noTradeReason: 'divergence_cap' },
  { hoursAgo: 38, recommendation: 'LONG_NO', marketP: 0.51, consensusP: 0.442, confidence: 0.71, outcome: 'success' },
  { hoursAgo: 44, recommendation: 'LONG_YES', marketP: 0.36, consensusP: 0.431, confidence: 0.66, outcome: 'success' },
  { hoursAgo: 50, recommendation: 'LONG_NO', marketP: 0.69, consensusP: 0.612, confidence: 0.63, outcome: 'expired' },
  { hoursAgo: 56, recommendation: 'NO_TRADE', marketP: 0.23, consensusP: 0.259, confidence: 0.39, outcome: 'no_trade', noTradeReason: 'edge_below_threshold' },
  { hoursAgo: 62, recommendation: 'LONG_YES', marketP: 0.49, consensusP: 0.573, confidence: 0.75, outcome: 'failure' },
  { hoursAgo: 70, recommendation: 'LONG_NO', marketP: 0.66, consensusP: 0.581, confidence: 0.68, outcome: 'success' },
  { hoursAgo: 76, recommendation: 'LONG_YES', marketP: 0.41, consensusP: 0.492, confidence: 0.71, outcome: 'success' },
  { hoursAgo: 84, recommendation: 'NO_TRADE', marketP: 0.57, consensusP: 0.601, confidence: 0.45, outcome: 'no_trade', noTradeReason: 'consensus_failed' },
  { hoursAgo: 92, recommendation: 'LONG_NO', marketP: 0.44, consensusP: 0.361, confidence: 0.64, outcome: 'expired' },
  { hoursAgo: 100, recommendation: 'LONG_YES', marketP: 0.52, consensusP: 0.611, confidence: 0.8, outcome: 'success' },
  { hoursAgo: 108, recommendation: 'LONG_YES', marketP: 0.67, consensusP: 0.733, confidence: 0.62, outcome: 'pending' },
  { hoursAgo: 116, recommendation: 'NO_TRADE', marketP: 0.31, consensusP: 0.341, confidence: 0.41, outcome: 'no_trade', noTradeReason: 'thesis_veto' },
  { hoursAgo: 124, recommendation: 'LONG_NO', marketP: 0.72, consensusP: 0.661, confidence: 0.59, outcome: 'success' },
  { hoursAgo: 132, recommendation: 'LONG_YES', marketP: 0.39, consensusP: 0.462, confidence: 0.73, outcome: 'failure' },
  { hoursAgo: 140, recommendation: 'LONG_NO', marketP: 0.55, consensusP: 0.482, confidence: 0.67, outcome: 'success' },
  { hoursAgo: 150, recommendation: 'NO_TRADE', marketP: 0.62, consensusP: 0.651, confidence: 0.49, outcome: 'no_trade', noTradeReason: 'edge_below_threshold' },
  { hoursAgo: 160, recommendation: 'LONG_YES', marketP: 0.48, consensusP: 0.553, confidence: 0.7, outcome: 'success' },
  { hoursAgo: 320, recommendation: 'LONG_NO', marketP: 0.63, consensusP: 0.551, confidence: 0.61, outcome: 'expired' },
  { hoursAgo: 500, recommendation: 'LONG_YES', marketP: 0.34, consensusP: 0.403, confidence: 0.76, outcome: 'success' },
  { hoursAgo: 650, recommendation: 'LONG_NO', marketP: 0.58, consensusP: 0.511, confidence: 0.65, outcome: 'success' },
];

const AGENT_NAMES = [
  'breaking_news',
  'catalyst_identification',
  'event_impact',
  'historical_patterns',
  'market_microstructure',
  'mean_reversion',
  'media_sentiment',
  'momentum',
  'narrative_velocity',
  'polling_intelligence',
  'probability_baseline',
  'risk_assessment',
  'social_sentiment',
  'tail_risk',
];

// ─── Fixtures: portfolio sessions ────────────────────────────────────────────

interface TradeFixture {
  direction: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  orderType: 'limit' | 'market';
  sizeUsdc: number;
  price: number;
  fillPrice: number | null;
  status: 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'failed';
  purpose: 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'partial_exit' | 'emergency_exit';
  reasoning: string;
  conviction: number;
  createdHoursAgo: number;
  filledHoursAgo?: number;
  realizedPnl?: number;
  holdMinutes?: number;
  exitReason?: string;
}

interface SessionFixture {
  slug: string;
  userSlug: string;
  marketIndex: number;
  persona: string;
  investment: number;
  status: 'active' | 'paused' | 'exiting' | 'terminated';
  createdHoursAgo: number;
  position?: {
    direction: 'YES' | 'NO';
    entryPrice: number;
    amountInPositions: number;
    entryHoursAgo: number;
  };
  totalTrades: number;
  winningTrades: number;
  realizedPnl: number;
  unrealizedPnl: number;
  cumulativeLossPct?: number;
  profitTargetPct?: number;
  terminationReason?: string;
  terminatedHoursAgo?: number;
  trades: TradeFixture[];
}

const SESSIONS: SessionFixture[] = [
  {
    slug: 'ks-pristine',
    userSlug: 'ks',
    marketIndex: 2,
    persona: 'scalper',
    investment: 10,
    status: 'active',
    createdHoursAgo: 26,
    totalTrades: 0,
    winningTrades: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    profitTargetPct: 25,
    trades: [],
  },
  {
    slug: 'ada-live',
    userSlug: 'ada',
    marketIndex: 0,
    persona: 'sniper',
    investment: 250,
    status: 'active',
    createdHoursAgo: 52,
    position: { direction: 'YES', entryPrice: 0.642, amountInPositions: 187.5, entryHoursAgo: 30 },
    totalTrades: 4,
    winningTrades: 3,
    realizedPnl: 18.42,
    unrealizedPnl: 6.31,
    profitTargetPct: 30,
    trades: [
      {
        direction: 'YES',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 187.5,
        price: 0.642,
        fillPrice: 0.642,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Edge 7.3 points over market with 0.82 confidence from the fusion stage.',
        conviction: 0.82,
        createdHoursAgo: 31,
        filledHoursAgo: 30,
      },
      {
        direction: 'YES',
        side: 'SELL',
        orderType: 'limit',
        sizeUsdc: 62.5,
        price: 0.704,
        fillPrice: 0.704,
        status: 'filled',
        purpose: 'partial_exit',
        reasoning: 'Trimmed a third of the position after the market moved through the first target.',
        conviction: 0.74,
        createdHoursAgo: 18,
        filledHoursAgo: 17,
        realizedPnl: 5.83,
        holdMinutes: 780,
        exitReason: 'partial target',
      },
      {
        direction: 'YES',
        side: 'SELL',
        orderType: 'limit',
        sizeUsdc: 125,
        price: 0.731,
        fillPrice: null,
        status: 'pending',
        purpose: 'take_profit',
        reasoning: 'Take-profit orders rest above the entry; no CLOB id in demo data.',
        conviction: 0.7,
        createdHoursAgo: 6,
      },
    ],
  },
  {
    slug: 'ada-closed',
    userSlug: 'ada',
    marketIndex: 5,
    persona: 'sniper',
    investment: 100,
    status: 'terminated',
    createdHoursAgo: 150,
    totalTrades: 3,
    winningTrades: 3,
    realizedPnl: 12.41,
    unrealizedPnl: 0,
    terminationReason: 'take_profit',
    terminatedHoursAgo: 48,
    trades: [
      {
        direction: 'NO',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 100,
        price: 0.58,
        fillPrice: 0.58,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Consensus probability 0.49 against a 0.58 market price.',
        conviction: 0.72,
        createdHoursAgo: 148,
        filledHoursAgo: 147,
      },
      {
        direction: 'NO',
        side: 'SELL',
        orderType: 'limit',
        sizeUsdc: 100,
        price: 0.652,
        fillPrice: 0.652,
        status: 'filled',
        purpose: 'take_profit',
        reasoning: 'Profit target reached; the position closed in full.',
        conviction: 0.8,
        createdHoursAgo: 50,
        filledHoursAgo: 48,
        realizedPnl: 12.41,
        holdMinutes: 5940,
        exitReason: 'take_profit',
      },
    ],
  },
  {
    slug: 'priya-paused',
    userSlug: 'priya',
    marketIndex: 6,
    persona: 'catalyst-hunter',
    investment: 50,
    status: 'paused',
    createdHoursAgo: 96,
    position: { direction: 'NO', entryPrice: 0.418, amountInPositions: 32, entryHoursAgo: 70 },
    totalTrades: 2,
    winningTrades: 1,
    realizedPnl: -1.82,
    unrealizedPnl: 0.94,
    cumulativeLossPct: 0.0364,
    trades: [
      {
        direction: 'NO',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 32,
        price: 0.418,
        fillPrice: 0.418,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Catalyst calendar favoured the downside; entry below the market mid.',
        conviction: 0.64,
        createdHoursAgo: 72,
        filledHoursAgo: 70,
      },
      {
        direction: 'NO',
        side: 'SELL',
        orderType: 'market',
        sizeUsdc: 8,
        price: 0.392,
        fillPrice: 0.392,
        status: 'filled',
        purpose: 'partial_exit',
        reasoning: 'Reduced exposure after a loss exit reset the session risk budget.',
        conviction: 0.51,
        createdHoursAgo: 40,
        filledHoursAgo: 40,
        realizedPnl: -1.82,
        holdMinutes: 1800,
        exitReason: 'risk reduction',
      },
    ],
  },
  {
    slug: 'marcus-loss',
    userSlug: 'marcus',
    marketIndex: 7,
    persona: 'contrarian',
    investment: 75,
    status: 'terminated',
    createdHoursAgo: 220,
    totalTrades: 5,
    winningTrades: 1,
    realizedPnl: -6.35,
    unrealizedPnl: 0,
    terminationReason: 'stop_loss',
    terminatedHoursAgo: 120,
    trades: [
      {
        direction: 'YES',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 75,
        price: 0.61,
        fillPrice: 0.61,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Contrarian read on a crowded NO position.',
        conviction: 0.58,
        createdHoursAgo: 218,
        filledHoursAgo: 216,
      },
      {
        direction: 'YES',
        side: 'SELL',
        orderType: 'market',
        sizeUsdc: 75,
        price: 0.558,
        fillPrice: 0.558,
        status: 'filled',
        purpose: 'stop_loss',
        reasoning: 'Stop level hit; the session exited at market.',
        conviction: 0.42,
        createdHoursAgo: 121,
        filledHoursAgo: 120,
        realizedPnl: -6.35,
        holdMinutes: 5760,
        exitReason: 'stop_loss',
      },
    ],
  },
  {
    slug: 'anya-watch',
    userSlug: 'anya',
    marketIndex: 1,
    persona: 'hedge-architect',
    investment: 20,
    status: 'active',
    createdHoursAgo: 12,
    totalTrades: 0,
    winningTrades: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    profitTargetPct: 20,
    trades: [],
  },
  {
    slug: 'omar-exiting',
    userSlug: 'omar',
    marketIndex: 3,
    persona: 'catalyst-hunter',
    investment: 500,
    status: 'exiting',
    createdHoursAgo: 130,
    position: { direction: 'YES', entryPrice: 0.55, amountInPositions: 300, entryHoursAgo: 96 },
    totalTrades: 6,
    winningTrades: 4,
    realizedPnl: 22.14,
    unrealizedPnl: -4.26,
    trades: [
      {
        direction: 'YES',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 300,
        price: 0.55,
        fillPrice: 0.55,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Catalyst window opened with a clear edge and deep liquidity.',
        conviction: 0.78,
        createdHoursAgo: 98,
        filledHoursAgo: 96,
      },
      {
        direction: 'YES',
        side: 'SELL',
        orderType: 'market',
        sizeUsdc: 150,
        price: 0.536,
        fillPrice: null,
        status: 'pending',
        purpose: 'exit',
        reasoning: 'Operator requested an exit; the order is unfilled in demo data.',
        conviction: 0.55,
        createdHoursAgo: 2,
      },
    ],
  },
  {
    slug: 'diego-killed',
    userSlug: 'diego',
    marketIndex: 4,
    persona: 'scalper',
    investment: 60,
    status: 'terminated',
    createdHoursAgo: 400,
    totalTrades: 2,
    winningTrades: 1,
    realizedPnl: 3.31,
    unrealizedPnl: 0,
    terminationReason: 'kill_switch',
    terminatedHoursAgo: 72,
    trades: [
      {
        direction: 'NO',
        side: 'BUY',
        orderType: 'limit',
        sizeUsdc: 60,
        price: 0.47,
        fillPrice: 0.47,
        status: 'filled',
        purpose: 'entry',
        reasoning: 'Small edge, fast persona, tight spread.',
        conviction: 0.61,
        createdHoursAgo: 398,
        filledHoursAgo: 396,
      },
      {
        direction: 'NO',
        side: 'SELL',
        orderType: 'market',
        sizeUsdc: 60,
        price: 0.496,
        fillPrice: 0.496,
        status: 'filled',
        purpose: 'emergency_exit',
        reasoning: 'Kill switch failed over to the exit path; the position closed at market.',
        conviction: 0.5,
        createdHoursAgo: 73,
        filledHoursAgo: 72,
        realizedPnl: 3.31,
        holdMinutes: 19440,
        exitReason: 'kill_switch',
      },
    ],
  },
];

interface DecisionFixture {
  sessionSlug: string;
  action: 'enter' | 'hold' | 'exit' | 'no_action' | 'skip';
  hoursAgo: number;
  edgeMet: boolean;
  alignmentMet: boolean;
  conviction: number;
  reasoning: string;
  skipReason?: string;
  hadPosition?: boolean;
  positionDirection?: 'YES' | 'NO';
  positionUnrealizedPnl?: number;
}

const DECISIONS: DecisionFixture[] = [
  { sessionSlug: 'ada-live', action: 'enter', hoursAgo: 31, edgeMet: true, alignmentMet: true, conviction: 0.82, reasoning: 'Edge and alignment both cleared the sniper thresholds.' },
  { sessionSlug: 'ada-live', action: 'hold', hoursAgo: 20, edgeMet: true, alignmentMet: true, conviction: 0.76, reasoning: 'Thesis intact; implied probability still trails the fused estimate.', hadPosition: true, positionDirection: 'YES', positionUnrealizedPnl: 4.12 },
  { sessionSlug: 'ada-live', action: 'hold', hoursAgo: 8, edgeMet: false, alignmentMet: true, conviction: 0.61, reasoning: 'Edge narrowed but the position is inside its target band.', hadPosition: true, positionDirection: 'YES', positionUnrealizedPnl: 6.31 },
  { sessionSlug: 'priya-paused', action: 'enter', hoursAgo: 72, edgeMet: true, alignmentMet: true, conviction: 0.64, reasoning: 'Catalyst window and edge aligned.' },
  { sessionSlug: 'priya-paused', action: 'exit', hoursAgo: 40, edgeMet: false, alignmentMet: false, conviction: 0.51, reasoning: 'Cumulative loss crossed the persona limit.', hadPosition: true, positionDirection: 'NO', positionUnrealizedPnl: -1.9 },
  { sessionSlug: 'marcus-loss', action: 'enter', hoursAgo: 218, edgeMet: true, alignmentMet: true, conviction: 0.58, reasoning: 'Contrarian signal against a crowded side.' },
  { sessionSlug: 'marcus-loss', action: 'exit', hoursAgo: 121, edgeMet: false, alignmentMet: false, conviction: 0.42, reasoning: 'Stop-loss level reached.', hadPosition: true, positionDirection: 'YES', positionUnrealizedPnl: -6.35 },
  { sessionSlug: 'omar-exiting', action: 'enter', hoursAgo: 98, edgeMet: true, alignmentMet: true, conviction: 0.78, reasoning: 'Deep liquidity and a clean catalyst.' },
  { sessionSlug: 'omar-exiting', action: 'exit', hoursAgo: 2, edgeMet: false, alignmentMet: true, conviction: 0.55, reasoning: 'Operator requested exit; the position is being unwound.', hadPosition: true, positionDirection: 'YES', positionUnrealizedPnl: -4.26 },
  { sessionSlug: 'anya-watch', action: 'skip', hoursAgo: 10, edgeMet: false, alignmentMet: false, conviction: 0.34, reasoning: 'No edge above the persona floor.', skipReason: 'edge_below_threshold' },
  { sessionSlug: 'anya-watch', action: 'skip', hoursAgo: 6, edgeMet: false, alignmentMet: true, conviction: 0.41, reasoning: 'Signals disagree on direction.', skipReason: 'consensus_failed' },
  { sessionSlug: 'diego-killed', action: 'enter', hoursAgo: 398, edgeMet: true, alignmentMet: true, conviction: 0.61, reasoning: 'Fast persona, tight spread.' },
  { sessionSlug: 'diego-killed', action: 'exit', hoursAgo: 73, edgeMet: false, alignmentMet: false, conviction: 0.5, reasoning: 'Kill switch halted the account and exited the position.', hadPosition: true, positionDirection: 'NO', positionUnrealizedPnl: 3.31 },
];

// ─── Fixtures: support ───────────────────────────────────────────────────────

interface MessageFixture {
  authorType: 'customer' | 'admin' | 'system';
  authorSlug?: string;
  body: string;
  isInternal?: boolean;
  hoursAgo: number;
}

interface TicketFixture {
  slug: string;
  requesterSlug?: string;
  requesterEmail?: string;
  topic: 'analysis' | 'portfolio' | 'billing' | 'login' | 'data' | 'other';
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  subject: string;
  body: string;
  createdHoursAgo: number;
  firstResponseHoursAgo?: number;
  resolvedHoursAgo?: number;
  assigned?: boolean;
  context: Record<string, string>;
  messages: MessageFixture[];
}

const TICKETS: TicketFixture[] = [
  {
    slug: 'analysis-edge',
    requesterSlug: 'marcus',
    topic: 'analysis',
    status: 'open',
    priority: 'high',
    subject: 'Recommendation went against the market and lost',
    body: 'The last analysis on the Netanyahu market recommended NO at 0.61 and it moved the other way within a day. I want to understand what the agents saw.',
    createdHoursAgo: 31,
    assigned: false,
    context: { marketId: 'market-7', plan: 'pro', appVersion: '2.14.0' },
    messages: [
      {
        authorType: 'customer',
        authorSlug: 'marcus',
        body: 'The last analysis recommended NO at 0.61 and it moved the other way within a day. Can someone explain which agents disagreed?',
        hoursAgo: 31,
      },
      {
        authorType: 'system',
        body: 'Ticket created from the public support form. Context snapshot attached.',
        hoursAgo: 31,
      },
    ],
  },
  {
    slug: 'portfolio-halt',
    requesterSlug: 'omar',
    topic: 'portfolio',
    status: 'pending',
    priority: 'urgent',
    subject: 'Session stopped trading after an exit order',
    body: 'My session on the Palantir market has been in exiting for two hours. The order is still pending and I cannot pause it.',
    createdHoursAgo: 5,
    firstResponseHoursAgo: 4,
    assigned: true,
    context: { marketId: 'market-3', plan: 'elite', appVersion: '2.14.0' },
    messages: [
      {
        authorType: 'customer',
        authorSlug: 'omar',
        body: 'Session has been exiting for two hours and the order is still pending.',
        hoursAgo: 5,
      },
      {
        authorType: 'admin',
        body: 'Thanks for the detail. I can see the exit order on our side and I have asked the risk engine to re-check the session. Nothing else is at risk while the halt is in place.',
        hoursAgo: 4,
      },
      {
        authorType: 'admin',
        body: 'Internal: the pending order has no CLOB id, so the exit retry is a no-op. Flagging the executor.',
        isInternal: true,
        hoursAgo: 4,
      },
    ],
  },
  {
    slug: 'billing-double',
    requesterSlug: 'sofia',
    topic: 'billing',
    status: 'resolved',
    priority: 'normal',
    subject: 'Charged twice for the same renewal',
    body: 'Two USDC transfers left my wallet for the same billing cycle. Only one credit pack landed.',
    createdHoursAgo: 72,
    firstResponseHoursAgo: 70,
    resolvedHoursAgo: 48,
    assigned: true,
    context: { plan: 'elite', appVersion: '2.13.2' },
    messages: [
      {
        authorType: 'customer',
        authorSlug: 'sofia',
        body: 'Two transfers for one renewal. Only one pack landed.',
        hoursAgo: 72,
      },
      {
        authorType: 'admin',
        body: 'Confirmed: one transaction was a retry that landed on chain twice. I have granted the missing credits and attached the tx hashes to your account notes.',
        hoursAgo: 70,
      },
      {
        authorType: 'customer',
        authorSlug: 'sofia',
        body: 'Credits are there now, thank you.',
        hoursAgo: 50,
      },
      {
        authorType: 'admin',
        body: 'Resolved. Refund recorded against the duplicate tx hash.',
        hoursAgo: 48,
      },
    ],
  },
  {
    slug: 'login-totp',
    requesterEmail: 'warden-demo+reader1@example.com',
    topic: 'login',
    status: 'open',
    priority: 'high',
    subject: 'TOTP code rejected after changing phones',
    body: 'I moved to a new phone and my authenticator codes are rejected. I still have the recovery codes.',
    createdHoursAgo: 14,
    assigned: false,
    context: { appVersion: '2.14.0' },
    messages: [
      {
        authorType: 'customer',
        body: 'New phone, codes rejected, recovery codes still available.',
        hoursAgo: 14,
      },
    ],
  },
  {
    slug: 'data-delete',
    requesterSlug: 'priya',
    topic: 'data',
    status: 'pending',
    priority: 'normal',
    subject: 'Delete my analysis history',
    body: 'I want my delivered analyses removed. I understand the account itself can stay.',
    createdHoursAgo: 40,
    firstResponseHoursAgo: 36,
    assigned: true,
    context: { plan: 'starter', appVersion: '2.13.2' },
    messages: [
      {
        authorType: 'customer',
        authorSlug: 'priya',
        body: 'Please delete my delivered analysis history.',
        hoursAgo: 40,
      },
      {
        authorType: 'admin',
        body: 'We can remove delivered analyses while keeping the account. Before I proceed: do you want the portfolio session history removed as well, or only the analyses?',
        hoursAgo: 36,
      },
    ],
  },
  {
    slug: 'other-api',
    requesterEmail: 'warden-demo+reader2@example.com',
    topic: 'other',
    status: 'closed',
    priority: 'low',
    subject: 'Is there a read-only API for my subscription?',
    body: 'I would like to pull my delivered analyses into a spreadsheet. Is there an endpoint for that?',
    createdHoursAgo: 200,
    firstResponseHoursAgo: 190,
    resolvedHoursAgo: 180,
    assigned: true,
    context: { appVersion: '2.12.1' },
    messages: [
      {
        authorType: 'customer',
        body: 'Looking for a read-only endpoint for delivered analyses.',
        hoursAgo: 200,
      },
      {
        authorType: 'admin',
        body: 'There is no public API yet. The newsletter and email delivery are the supported export paths today; I have added your request to the roadmap notes.',
        hoursAgo: 190,
      },
      {
        authorType: 'admin',
        body: 'Closing as answered. Reopen by replying to the thread link.',
        hoursAgo: 180,
      },
    ],
  },
];

// ─── Fixtures: newsletter ────────────────────────────────────────────────────

interface CampaignFixture {
  slug: string;
  subject: string;
  preheader: string;
  template: 'market_brief' | 'product_update';
  status: 'draft' | 'sent';
  sentHoursAgo?: number;
  content: Record<string, unknown>;
  recipients: number;
}

const CAMPAIGNS: CampaignFixture[] = [
  {
    slug: 'issue-14',
    subject: 'The week the Fed repriced everything',
    preheader: 'Three markets where the agents disagree with the crowd.',
    template: 'market_brief',
    status: 'sent',
    sentHoursAgo: 120,
    recipients: 4,
    content: {
      heroTitle: 'The week the Fed repriced everything',
      intro:
        'Rate expectations moved twice this week and the agent panel followed. These are the three markets where the fused estimate still sits furthest from the price.',
      picks: [
        {
          question: 'Will the upper bound of the target federal funds rate be 4.25% at the end of 2026?',
          aiProbability: 61,
          marketProbability: 54,
          read: 'Polling and macro agents moved together; the tail-risk agent is the dissenter.',
          url: 'https://tradewizard.live/markets',
        },
        {
          question: 'Will NVIDIA be the largest company in the world by market cap on October 31, 2026?',
          aiProbability: 47,
          marketProbability: 52,
          read: 'Momentum faded while the narrative agent stayed bullish. Net: no trade.',
          url: 'https://tradewizard.live/markets',
        },
        {
          question: 'Will Bitcoin have the best performance in 2026?',
          aiProbability: 38,
          marketProbability: 33,
          read: 'Historical patterns and mean reversion agree the crowd is early.',
          url: 'https://tradewizard.live/markets',
        },
      ],
      closing: 'Every pick links to the analysis that produced it. Nothing here is advice.',
    },
  },
  {
    slug: 'issue-15',
    subject: 'What changed in the analysis gate',
    preheader: 'A tighter divergence cap and what it did to no-trade reasons.',
    template: 'product_update',
    status: 'sent',
    sentHoursAgo: 20,
    recipients: 4,
    content: {
      heroTitle: 'What changed in the analysis gate',
      intro:
        'We tightened the divergence cap and started recording why a run returned no trade. The result is fewer forced entries and a clearer audit trail.',
      sections: [
        {
          heading: 'A named reason for every no-trade',
          body: 'Every no-trade run now carries a machine-readable reason: consensus failure, divergence cap, edge below threshold, or thesis veto. Warden aggregates them so the gate can be tuned from evidence instead of guesswork.',
        },
        {
          heading: 'Shadow consensus beside the live one',
          body: 'Each analysis now also records the agent-driven consensus beside the live recommendation, with a fixed scoring horizon for both. Nothing changes the live decision until the shadow data justifies it.',
        },
      ],
      closing: 'Read the full changelog in the repository.',
    },
  },
  {
    slug: 'issue-16-draft',
    subject: 'Draft: the markets nobody is watching',
    preheader: 'Low-liquidity markets where the agents found an edge anyway.',
    template: 'market_brief',
    status: 'draft',
    recipients: 0,
    content: {
      heroTitle: 'The markets nobody is watching',
      intro:
        'Thin books are not automatically bad books. This draft looks at four low-liquidity markets where the fused estimate diverged from the price.',
      picks: [
        {
          question: 'Will WTI Crude Oil (WTI) hit (HIGH) $105 in October?',
          aiProbability: 22,
          marketProbability: 16,
          read: 'Catalyst agent is the only one above the market. Draft note: verify the expiry first.',
          url: 'https://tradewizard.live/markets',
        },
      ],
      closing: 'Not scheduled. Review the expiry dates before sending.',
    },
  },
];

// ─── Fixtures: audit ─────────────────────────────────────────────────────────

interface AuditFixture {
  action: string;
  targetType: string;
  targetSlug: string;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  role: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  error?: string;
}

const AUDIT: AuditFixture[] = [
  { action: 'portfolio.kill_switch.activate', targetType: 'user', targetSlug: 'diego', role: 'owner', status: 'succeeded', reason: 'Cross-session loss limit reached; halting entries and exiting at market.', before: { halted: false }, after: { halted: true, sessions: 1 } },
  { action: 'portfolio.session.terminate', targetType: 'session', targetSlug: 'diego-killed', role: 'owner', status: 'succeeded', reason: 'Kill switch exit completed for the session.', before: { status: 'exiting' }, after: { status: 'terminated', terminationReason: 'kill_switch' } },
  { action: 'user.credits.grant', targetType: 'user', targetSlug: 'sofia', role: 'support', status: 'succeeded', reason: 'Duplicate renewal payment confirmed on chain; missing credits granted.', before: { creditsRemaining: 200 }, after: { creditsRemaining: 240 } },
  { action: 'user.note.create', targetType: 'user', targetSlug: 'sofia', role: 'support', status: 'succeeded', reason: 'Recorded the duplicate tx hash for the billing ticket.', after: { note: 'Duplicate tx 0x… confirmed; credits granted.' } },
  { action: 'analysis.requeue', targetType: 'analysis', targetSlug: 'analysis-11', role: 'analyst', status: 'succeeded', reason: 'Payload was truncated; re-running the market to replace it.', before: { recommendation: 'LONG_YES' }, after: { requeued: true } },
  { action: 'analysis.refund', targetType: 'analysis', targetSlug: 'analysis-11', role: 'support', status: 'succeeded', reason: 'Credit refund for the failed run reported in ticket TW.', before: { creditsRemaining: 36 }, after: { creditsRemaining: 37 } },
  { action: 'settings.update', targetType: 'setting', targetSlug: 'analysisGateProfile', role: 'owner', status: 'succeeded', reason: 'Tighten the divergence cap after the review of no-trade reasons.', before: { value: 'balanced' }, after: { value: 'strict' } },
  { action: 'settings.update', targetType: 'setting', targetSlug: 'copilotEnabled', role: 'owner', status: 'succeeded', reason: 'Copilot read-only rehearsal before the demo.', before: { value: true }, after: { value: true } },
  { action: 'support.ticket.reply', targetType: 'support_ticket', targetSlug: 'portfolio-halt', role: 'support', status: 'succeeded', reason: 'Replied to the customer about the pending exit order.' },
  { action: 'support.ticket.note', targetType: 'support_ticket', targetSlug: 'portfolio-halt', role: 'support', status: 'succeeded', reason: 'Internal note: pending order has no CLOB id.' },
  { action: 'support.ticket.claim', targetType: 'support_ticket', targetSlug: 'portfolio-halt', role: 'support', status: 'succeeded', reason: 'Claimed the urgent portfolio ticket.' },
  { action: 'support.ticket.update', targetType: 'support_ticket', targetSlug: 'billing-double', role: 'support', status: 'succeeded', reason: 'Duplicate payment confirmed; ticket resolved.', before: { status: 'pending' }, after: { status: 'resolved' } },
  { action: 'admin.invite_link.create', targetType: 'invite_link', targetSlug: 'invite-analyst', role: 'owner', status: 'succeeded', reason: 'Analyst access for the market review rotation.', after: { role: 'analyst', maxUses: 3 } },
  { action: 'admin.invite_link.revoke', targetType: 'invite_link', targetSlug: 'invite-owner-old', role: 'owner', status: 'succeeded', reason: 'Link was for a contractor whose engagement ended.' },
  { action: 'admin.role.change', targetType: 'member', targetSlug: 'member-analyst', role: 'owner', status: 'succeeded', reason: 'Promoted after the review rotation.', before: { role: 'support' }, after: { role: 'admin' } },
  { action: 'newsletter.campaign.send', targetType: 'newsletter_campaign', targetSlug: 'issue-15', role: 'owner', status: 'succeeded', reason: 'Scheduled issue 15 to the confirmed audience.', after: { recipients: 4 } },
  { action: 'newsletter.campaign.create', targetType: 'newsletter_campaign', targetSlug: 'issue-16-draft', role: 'admin', status: 'succeeded', reason: 'Draft for the low-liquidity issue.', after: { status: 'draft' } },
  { action: 'user.status.update', targetType: 'user', targetSlug: 'tomas', role: 'owner', status: 'succeeded', reason: 'Repeated abuse after two warnings.', before: { status: 'active' }, after: { status: 'banned' } },
  { action: 'user.status.update', targetType: 'user', targetSlug: 'sofia', role: 'owner', status: 'succeeded', reason: 'Suspended pending the duplicate payment review.', before: { status: 'active' }, after: { status: 'suspended' } },
  { action: 'user.plan.override', targetType: 'user', targetSlug: 'leah', role: 'owner', status: 'succeeded', reason: 'Community comp for the beta feedback session.', after: { plan: 'starter', expiresInDays: 30 } },
  { action: 'portfolio.session.pause', targetType: 'session', targetSlug: 'priya-paused', role: 'support', status: 'succeeded', reason: 'Customer asked to pause after a losing exit.', before: { status: 'active' }, after: { status: 'paused' } },
  { action: 'analysis.cache.invalidate', targetType: 'market', targetSlug: 'market-2', role: 'analyst', status: 'succeeded', reason: 'Market description changed after the last run.' },
  { action: 'user.credits.refund', targetType: 'user', targetSlug: 'marcus', role: 'support', status: 'succeeded', reason: 'Refund for the recommendation disputed in the support thread.', before: { creditsRemaining: 35 }, after: { creditsRemaining: 37 } },
  { action: 'settings.update', targetType: 'setting', targetSlug: 'analysisMaxCostUsd', role: 'owner', status: 'failed', reason: 'Attempted to lift the per-run cost ceiling during the incident.', error: 'Refused: value exceeds the reviewed ceiling for the environment.', before: { value: 0.35 } },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

type Counts = Record<string, number>;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function clampProbability(value: number): number {
  return Math.min(0.99, Math.max(0.01, round4(value)));
}

async function seedDatabase(
  client: Client,
  options: { dryRun: boolean; noS3: boolean; counts: Counts }
): Promise<{ manifest: DemoManifest; payloads: Array<{ key: string; body: string }> }> {
  const { counts } = options;
  const bump = (table: string, by = 1) => {
    counts[table] = (counts[table] ?? 0) + by;
  };

  // Cleanup finds analysis rows by deterministic id, so the count must match.
  if (ANALYSES.length !== DEMO_ANALYSIS_COUNT) {
    throw new Error(
      `Fixture drift: ANALYSES has ${ANALYSES.length} entries but DEMO_ANALYSIS_COUNT is ${DEMO_ANALYSIS_COUNT}. Update both.`
    );
  }

  // ── Markets ───────────────────────────────────────────────────────────────
  // Two pools on purpose:
  //
  // - `markets` (real, when present) backs the analysis history. Resolution does
  //   not matter there; these rows are historical.
  // - `sessionMarkets` are always demo markets. The portfolio lifecycle Lambda
  //   checks real markets for resolution every five minutes and closes a session
  //   when its market has resolved. Sessions on a demo condition id get a 404
  //   from the CLOB, so they stay open while the demo is being recorded.
  const marketRows = await client.query<{ condition_id: string; question: string }>(
    `SELECT condition_id, question FROM markets WHERE is_active = true ORDER BY created_at ASC LIMIT 9`
  );

  const markets: Array<{ conditionId: string; question: string; probability: number }> =
    marketRows.rows.map((row, index) => ({
      conditionId: row.condition_id,
      question: row.question,
      probability: [0.64, 0.438, 0.512, 0.347, 0.72, 0.58, 0.415, 0.62, 0.29][index % 9],
    }));

  const DEMO_MARKETS: Array<{ slug: string; question: string; probability: number }> = [
    { slug: 'fed-cut', question: 'Will the Fed cut rates at the December 2026 meeting?', probability: 0.58 },
    { slug: 'btc-150k', question: 'Will Bitcoin close above $150,000 before January 2027?', probability: 0.34 },
    { slug: 'openai-ipo', question: 'Will OpenAI file for an IPO before July 2027?', probability: 0.21 },
  ];

  const sessionMarkets: Array<{ conditionId: string; question: string; probability: number }> = [];

  for (const demoMarket of DEMO_MARKETS) {
    const conditionId = `warden-demo-market-${demoMarket.slug}`;
    const market = {
      conditionId,
      question: demoMarket.question,
      probability: demoMarket.probability,
    };
    sessionMarkets.push(market);

    await insertRow(
      client,
      'markets',
      {
        id: demoUuid(`market:${demoMarket.slug}`),
        condition_id: conditionId,
        question: demoMarket.question,
        description: 'Seeded demo market for the Warden walkthrough.',
        event_type: 'demo',
        expiry_at: isoDaysFromNow(120),
        is_active: true,
        current_probability: demoMarket.probability,
        volume_24h: 142000,
        liquidity_score: 0.82,
        last_synced_at: isoHoursAgo(1),
      },
      'ON CONFLICT (condition_id) DO NOTHING'
    );
    bump('markets');
  }

  // On a fresh environment there are no real markets, so the analysis history
  // falls back to the demo pool rather than dividing by zero.
  const analysisMarkets = markets.length > 0 ? markets : sessionMarkets;
  const allMarkets = [...analysisMarkets];
  for (const market of sessionMarkets) {
    if (!allMarkets.some((candidate) => candidate.conditionId === market.conditionId)) {
      allMarkets.push(market);
    }
  }

  const marketAt = (index: number) => analysisMarkets[index % analysisMarkets.length];

  // ── Users + subscriptions ─────────────────────────────────────────────────
  const userIds = new Map<string, string>();

  for (const user of USERS) {
    const userId = demoUuid(`user:${user.slug}`);
    userIds.set(user.slug, userId);

    await insertRow(
      client,
      'users',
      {
        id: userId,
        cognito_sub: demoCognitoSub(user.slug),
        email: demoEmail(user.slug),
        display_name: user.name,
        status: user.status,
        portfolio_persona_id: user.persona,
        portfolio_persona_params: json({ [user.persona]: {} }),
        has_used_paid_plan: user.usedPaidPlan ?? false,
        newsletter_prompted_at: user.newsletterPrompted ? isoDaysAgo(user.createdDaysAgo - 1) : null,
        created_at: isoDaysAgo(user.createdDaysAgo),
        updated_at: isoHoursAgo(6),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('users');

    const cycleStart = isoDaysAgo(12);
    await insertRow(
      client,
      'subscriptions',
      {
        id: demoUuid(`subscription:${user.slug}`),
        user_id: userId,
        plan: user.plan,
        status: user.cancelled ? 'cancelled' : user.grace ? 'grace_period' : 'active',
        credits_remaining: user.credits,
        credits_monthly_limit: user.monthlyLimit,
        billing_cycle_start: cycleStart,
        billing_cycle_end: isoDaysFromNow(18),
        wallet_address:
          user.plan === 'free' ? null : `0x${demoHash(`wallet:${user.slug}`).slice(0, 40)}`,
        grace_period_start: user.grace ? isoDaysAgo(3) : null,
        grace_period_end: user.grace ? isoDaysFromNow(4) : null,
        is_trial: user.isTrial ?? false,
        trial_end: user.trialEndsInDays ? isoDaysFromNow(user.trialEndsInDays) : null,
        cancelled_at: user.cancelled ? isoDaysAgo(9) : null,
        created_at: isoDaysAgo(user.createdDaysAgo),
        updated_at: isoHoursAgo(6),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('subscriptions');

    if (user.newsletter !== 'none') {
      await insertRow(
        client,
        'newsletter_subscribers',
        {
          email: demoEmail(user.slug),
          user_id: userId,
          status: user.newsletter === 'unsubscribed' ? 'unsubscribed' : 'subscribed',
          source: user.newsletterPrompted ? 'signup_prompt' : 'account_toggle',
          consent_version: '2026-09',
          ip_hash: demoHash(`ip:${user.slug}`).slice(0, 32),
          user_agent: 'Mozilla/5.0 (Warden demo seed)',
          confirmed_at: isoDaysAgo(user.createdDaysAgo),
          unsubscribed_at: user.newsletter === 'unsubscribed' ? isoDaysAgo(2) : null,
          created_at: isoDaysAgo(user.createdDaysAgo),
          updated_at: isoDaysAgo(2),
        },
        'ON CONFLICT (email) DO NOTHING'
      );
      bump('newsletter_subscribers');
    }

    await insertRow(
      client,
      'notification_preferences',
      {
        id: demoUuid(`notification-pref:${user.slug}`),
        user_id: userId,
        market_id: null,
        channel_in_app: true,
        channel_email: user.newsletter === 'subscribed',
        channel_push: user.plan === 'elite',
        channel_webhook: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00',
        min_probability_shift: 0.05,
        created_at: isoDaysAgo(user.createdDaysAgo),
        updated_at: isoDaysAgo(3),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('notification_preferences');
  }

  // ── Credits ───────────────────────────────────────────────────────────────
  const CREDIT_ROWS: Array<{
    slug: string;
    amount: number;
    balance: number;
    reason: string;
    source: 'plan' | 'credit_pack' | 'trial' | 'admin_grant' | 'admin_refund';
    daysAgo: number;
  }> = [
    { slug: 'ada', amount: 300, balance: 300, reason: 'Monthly Elite credits', source: 'plan', daysAgo: 12 },
    { slug: 'ada', amount: -132, balance: 168, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 4 },
    { slug: 'omar', amount: 300, balance: 300, reason: 'Monthly Elite credits', source: 'plan', daysAgo: 12 },
    { slug: 'omar', amount: -204, balance: 96, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 3 },
    { slug: 'sofia', amount: 200, balance: 200, reason: 'Monthly Elite credits', source: 'plan', daysAgo: 12 },
    { slug: 'sofia', amount: 40, balance: 240, reason: 'Billing ticket compensation', source: 'admin_grant', daysAgo: 2 },
    { slug: 'ks', amount: 100, balance: 100, reason: 'Monthly Pro credits', source: 'plan', daysAgo: 12 },
    { slug: 'ks', amount: -58, balance: 42, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 1 },
    { slug: 'marcus', amount: 100, balance: 100, reason: 'Monthly Pro credits', source: 'plan', daysAgo: 12 },
    { slug: 'marcus', amount: -63, balance: 37, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 2 },
    { slug: 'marcus', amount: 2, balance: 37, reason: 'Refund for disputed recommendation', source: 'admin_refund', daysAgo: 1 },
    { slug: 'priya', amount: 30, balance: 30, reason: 'Monthly Starter credits', source: 'plan', daysAgo: 12 },
    { slug: 'priya', amount: -21, balance: 9, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 5 },
    { slug: 'anya', amount: 30, balance: 30, reason: 'Monthly Starter credits', source: 'plan', daysAgo: 12 },
    { slug: 'anya', amount: -8, balance: 22, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 2 },
    { slug: 'jun', amount: 20, balance: 20, reason: 'Trial credits', source: 'trial', daysAgo: 9 },
    { slug: 'jun', amount: -17, balance: 3, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 1 },
    { slug: 'leah', amount: 20, balance: 20, reason: 'Trial credits', source: 'trial', daysAgo: 4 },
    { slug: 'leah', amount: -6, balance: 14, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 1 },
    { slug: 'diego', amount: 100, balance: 100, reason: 'Monthly Pro credits', source: 'plan', daysAgo: 12 },
    { slug: 'diego', amount: -100, balance: 0, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 5 },
    { slug: 'nina', amount: 20, balance: 20, reason: 'Trial credits', source: 'trial', daysAgo: 2 },
    { slug: 'nina', amount: -2, balance: 18, reason: 'Analysis deliveries this cycle', source: 'plan', daysAgo: 1 },
    { slug: 'tomas', amount: 20, balance: 20, reason: 'Free plan credits', source: 'plan', daysAgo: 40 },
    { slug: 'tomas', amount: -20, balance: 0, reason: 'Account closed; credits cleared', source: 'admin_refund', daysAgo: 9 },
  ];

  for (const [index, row] of CREDIT_ROWS.entries()) {
    const userId = userIds.get(row.slug);
    if (!userId) continue;
    await insertRow(
      client,
      'credit_transactions',
      {
        id: demoUuid(`credit:${index}:${row.slug}`),
        user_id: userId,
        amount: row.amount,
        balance_after: row.balance,
        reason: row.reason,
        reference_type: row.source === 'plan' ? 'billing_cycle' : 'admin',
        credit_source: row.source,
        created_at: isoDaysAgo(row.daysAgo, index % 12),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('credit_transactions');
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  const PAYMENTS: Array<{
    slug: string;
    type: 'subscription_payment' | 'credit_pack_purchase' | 'renewal_payment' | 'proration_credit';
    amount: number;
    plan: Plan | null;
    pack: string | null;
    credits: number | null;
    daysAgo: number;
  }> = [
    { slug: 'ada', type: 'subscription_payment', amount: 49, plan: 'elite', pack: null, credits: 300, daysAgo: 12 },
    { slug: 'ada', type: 'credit_pack_purchase', amount: 25, plan: null, pack: 'pack_150', credits: 150, daysAgo: 5 },
    { slug: 'omar', type: 'subscription_payment', amount: 49, plan: 'elite', pack: null, credits: 300, daysAgo: 12 },
    { slug: 'omar', type: 'renewal_payment', amount: 49, plan: 'elite', pack: null, credits: 300, daysAgo: 1 },
    { slug: 'sofia', type: 'subscription_payment', amount: 49, plan: 'elite', pack: null, credits: 300, daysAgo: 12 },
    { slug: 'sofia', type: 'renewal_payment', amount: 49, plan: 'elite', pack: null, credits: 300, daysAgo: 3 },
    { slug: 'sofia', type: 'renewal_payment', amount: 49, plan: 'elite', pack: null, credits: 0, daysAgo: 3 },
    { slug: 'ks', type: 'subscription_payment', amount: 19, plan: 'pro', pack: null, credits: 100, daysAgo: 12 },
    { slug: 'marcus', type: 'subscription_payment', amount: 19, plan: 'pro', pack: null, credits: 100, daysAgo: 12 },
    { slug: 'marcus', type: 'proration_credit', amount: -4.5, plan: 'pro', pack: null, credits: 0, daysAgo: 2 },
    { slug: 'priya', type: 'subscription_payment', amount: 9, plan: 'starter', pack: null, credits: 30, daysAgo: 12 },
    { slug: 'anya', type: 'subscription_payment', amount: 9, plan: 'starter', pack: null, credits: 30, daysAgo: 12 },
    { slug: 'diego', type: 'subscription_payment', amount: 19, plan: 'pro', pack: null, credits: 100, daysAgo: 12 },
    { slug: 'tomas', type: 'subscription_payment', amount: 9, plan: 'starter', pack: null, credits: 30, daysAgo: 41 },
    { slug: 'tomas', type: 'proration_credit', amount: -9, plan: 'starter', pack: null, credits: 0, daysAgo: 9 },
  ];

  for (const [index, payment] of PAYMENTS.entries()) {
    const userId = userIds.get(payment.slug);
    if (!userId) continue;
    await insertRow(
      client,
      'payment_transactions',
      {
        id: demoUuid(`payment:${index}:${payment.slug}`),
        user_id: userId,
        transaction_type: payment.type,
        amount_usdc: payment.amount,
        tx_hash: `0x${demoHash(`tx:${index}:${payment.slug}`)}`,
        source_address: `0x${demoHash(`source:${payment.slug}`).slice(0, 40)}`,
        plan: payment.plan,
        credit_pack_id: payment.pack,
        credits_added: payment.credits,
        created_at: isoDaysAgo(payment.daysAgo, index),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('payment_transactions');
  }

  // ── Analysis requests (needed by deliveries and sessions) ─────────────────
  const requestIds = new Map<string, string>();

  const ensureRequest = async (
    userSlug: string,
    market: { conditionId: string }
  ) => {
    const userId = userIds.get(userSlug);
    if (!userId) throw new Error(`Unknown demo user: ${userSlug}`);
    const key = `${userSlug}:${market.conditionId}`;
    const existing = requestIds.get(key);
    if (existing) return existing;

    const requestId = demoUuid(`request:${key}`);
    requestIds.set(key, requestId);

    await insertRow(
      client,
      'analysis_requests',
      {
        id: requestId,
        user_id: userId,
        market_id: market.conditionId,
        request_type: 'recurring',
        interval_seconds: 3600,
        status: 'active',
        created_at: isoDaysAgo(14),
        updated_at: isoDaysAgo(1),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('analysis_requests');

    await insertRow(
      client,
      'market_subscribers',
      {
        id: demoUuid(`subscriber:${key}`),
        market_id: market.conditionId,
        user_id: userId,
        analysis_request_id: requestId,
        subscribed_at: isoDaysAgo(14),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('market_subscribers');

    return requestId;
  };

  // ── Analyses ──────────────────────────────────────────────────────────────
  const payloads: Array<{ key: string; body: string }> = [];
  const analysisIds: string[] = [];

  for (const [index, template] of ANALYSES.entries()) {
    const market = marketAt(index);
    const resultId = demoUuid(`analysis:${index}`);
    await ensureRequest(USERS[index % USERS.length].slug, market);

    const executedAt = isoHoursAgo(template.hoursAgo);
    const edge = round4(template.consensusP - template.marketP);
    const actionable = template.recommendation !== 'NO_TRADE';

    const entryPrice = template.marketP;
    const targetPrice = actionable
      ? clampProbability(
          template.recommendation === 'LONG_YES' ? entryPrice + 0.08 : entryPrice - 0.08
        )
      : null;
    const stopLossPrice = actionable
      ? clampProbability(
          template.recommendation === 'LONG_YES' ? entryPrice - 0.04 : entryPrice + 0.04
        )
      : null;

    const resolved = template.outcome === 'success' || template.outcome === 'failure';
    const outcomeHitPrice = resolved
      ? template.outcome === 'success'
        ? targetPrice
        : stopLossPrice
      : null;

    const shadowAction: Recommendation =
      template.recommendation === 'NO_TRADE' && index % 3 === 0
        ? 'LONG_YES'
        : template.recommendation;

    await insertRow(
      client,
      'analysis_results',
      {
        id: resultId,
        market_id: market.conditionId,
        executed_at: executedAt,
        execution_duration_ms: 48000 + (index % 13) * 6300,
        total_llm_calls: 18 + (index % 7),
        model_costs_usd: round6(0.0412 + (index % 9) * 0.0123),
        result_payload_s3_key: `results/${market.conditionId}/${resultId}.json`,
        consensus_probability: template.consensusP,
        recommendation: template.recommendation,
        confidence_score: template.confidence,
        edge,
        market_probability_at_execution: template.marketP,
        entry_price: actionable ? entryPrice : null,
        target_price: targetPrice,
        stop_loss_price: stopLossPrice,
        outcome_status: template.outcome,
        outcome_hit_price: outcomeHitPrice,
        outcome_resolved_at: resolved
          ? isoHoursAgo(Math.max(1, template.hoursAgo - 20))
          : template.outcome === 'expired'
            ? isoHoursAgo(Math.max(1, template.hoursAgo - 24))
            : null,
        agents_scored: template.outcome === 'success' || template.outcome === 'failure' || template.outcome === 'expired',
        shadow_action: shadowAction,
        shadow_edge: round4(shadowAction === 'NO_TRADE' ? edge * 0.4 : edge + 0.006),
        shadow_vote_score: round4(0.45 + (index % 6) * 0.07),
        shadow_probability: round4(template.consensusP + (index % 2 === 0 ? 0.018 : -0.014)),
        shadow_cost_floor: round4(0.008 + (index % 5) * 0.004),
        shadow_reason:
          shadowAction === 'NO_TRADE'
            ? 'Shadow consensus did not clear the cost floor.'
            : 'Shadow consensus agreed with the direction but sized differently.',
        no_trade_reason: template.noTradeReason ?? null,
        horizon_hours: 24,
        horizon_move: template.outcome === 'expired' ? round4((index % 7) * 0.004 - 0.008) : null,
        live_pnl:
          template.outcome === 'success'
            ? round4(0.08 * (index % 4 + 1))
            : template.outcome === 'failure'
              ? round4(-0.04 * (index % 3 + 1))
              : null,
        shadow_pnl:
          template.outcome === 'success' || template.outcome === 'failure'
            ? round4((template.outcome === 'success' ? 0.05 : -0.02) * (index % 3 + 1))
            : null,
        pnl_scored_at: resolved ? isoHoursAgo(Math.max(1, template.hoursAgo - 20)) : null,
        created_at: executedAt,
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('analysis_results');
    analysisIds.push(resultId);

    // Payload: same shape the analysis lambda writes, plus an honest marker.
    const payload = {
      marketId: market.conditionId,
      action: template.recommendation,
      entryZone: actionable ? [round4(entryPrice - 0.01), round4(entryPrice + 0.01)] : [0, 0],
      targetZone: targetPrice ? [round4(targetPrice - 0.01), round4(targetPrice + 0.01)] : [0, 0],
      stopLoss: stopLossPrice ?? 0,
      expectedValue: actionable ? round4(edge * template.confidence) : 0,
      winProbability: template.consensusP,
      liquidityRisk: edge > 0.06 ? 'medium' : 'low',
      explanation: {
        summary:
          template.recommendation === 'NO_TRADE'
            ? `${market.question} did not clear the analysis gate: ${template.noTradeReason?.replace(/_/g, ' ')}.`
            : `The fused estimate for ${market.question} sits at ${(template.consensusP * 100).toFixed(1)}% against a market price of ${(template.marketP * 100).toFixed(1)}%.`,
        coreThesis: actionable
          ? `Fourteen agents produced a ${(template.confidence * 100).toFixed(0)}% confidence read. Probability baseline, historical patterns and market microstructure carried the direction; the tail-risk agent stayed cautious on size.`
          : 'The consensus engine and the risk layer did not agree on a direction with enough edge to justify a position.',
        keyCatalysts: [
          'A scheduled catalyst inside the 24h horizon',
          'Liquidity deep enough to exit within one tick',
          'Polling or data releases that move the base rate',
        ],
        failureScenarios: [
          'The catalyst resolves earlier than the market implies',
          'A thin book widens the exit spread',
          'A correlated market moves first and drags this one',
        ],
        uncertaintyNote: `Disagreement index ${(0.2 + (index % 5) * 0.05).toFixed(3)}; the panel is ${template.confidence > 0.7 ? 'mostly aligned' : 'split'}.`,
        riskPerspectives:
          'Aggressive sizing would take the full edge; the conservative view caps size at the persona limit and widens the stop.',
      },
      metadata: {
        consensusProbability: template.consensusP,
        marketProbability: template.marketP,
        edge,
        confidenceBand: [
          round4(template.consensusP - 0.06),
          round4(template.consensusP + 0.06),
        ],
        totalLlmCalls: 18 + (index % 7),
        executionDurationMs: 48000 + (index % 13) * 6300,
        agentsUsed: AGENT_NAMES,
        marketQuestion: market.question,
        disagreementIndex: round4(0.2 + (index % 5) * 0.05),
        consensusConfidence: template.confidence,
        signalAlignment: round4(0.45 + (index % 6) * 0.07),
        volatility: round4(0.02 + (index % 4) * 0.01),
        marketEndDate: isoDaysFromNow(45 + (index % 30)),
        divergenceGuardTriggered: template.noTradeReason === 'divergence_cap',
        thesisVetoTriggered: template.noTradeReason === 'thesis_veto',
        noTradeReason: template.noTradeReason ?? null,
        seededDemo: true,
      },
    };

    payloads.push({
      key: `results/${market.conditionId}/${resultId}.json`,
      body: `${JSON.stringify(payload, null, 2)}\n`,
    });

    // Deliver to two users, rotating so user detail pages have history.
    for (let offset = 0; offset < 2; offset += 1) {
      const recipient = USERS[(index + offset * 3) % USERS.length];
      const recipientRequest = await ensureRequest(recipient.slug, market);
      await insertRow(
        client,
        'analysis_deliveries',
        {
          id: demoUuid(`delivery:${index}:${recipient.slug}`),
          result_id: resultId,
          user_id: userIds.get(recipient.slug),
          analysis_request_id: recipientRequest,
          was_cached_delivery: index % 4 === 0,
          delivery_channel: index % 3 === 0 ? 'email' : 'websocket',
          delivered_at: isoHoursAgo(Math.max(0.2, template.hoursAgo - 0.4)),
        },
        'ON CONFLICT (result_id, user_id, analysis_request_id) DO NOTHING'
      );
      bump('analysis_deliveries');
    }

    // Agent memory for the most recent runs only, so the table stays readable.
    if (index < 12) {
      for (let agentOffset = 0; agentOffset < 4; agentOffset += 1) {
        const agentName = AGENT_NAMES[(index + agentOffset * 3) % AGENT_NAMES.length];
        const direction =
          actionable && (index + agentOffset) % 3 !== 0
            ? template.recommendation === 'LONG_YES'
              ? 'YES'
              : 'NO'
            : 'NEUTRAL';
        await insertRow(
          client,
          'agent_memory',
          {
            id: demoUuid(`agent-memory:${index}:${agentName}`),
            market_id: market.conditionId,
            agent_name: agentName,
            result_id: resultId,
            direction,
            confidence: round4(0.42 + ((index + agentOffset) % 5) * 0.09),
            fair_probability: round4(template.consensusP + (agentOffset - 1.5) * 0.02),
            key_drivers: json([
              'Order-book depth improved over the last six hours',
              'Base rate moved with the last polling release',
            ]),
            risk_factors: json([
              'Resolution criteria has an edge case',
              'Thin liquidity on the exit side',
            ]),
            signal_timestamp: executedAt,
            was_correct:
              template.outcome === 'success'
                ? true
                : template.outcome === 'failure'
                  ? false
                  : null,
            accuracy_score:
              template.outcome === 'success'
                ? round4(template.confidence)
                : template.outcome === 'failure'
                  ? round4(1 - template.confidence)
                  : null,
            created_at: executedAt,
          },
          'ON CONFLICT (id) DO NOTHING'
        );
        bump('agent_memory');
      }
    }
  }

  // ── Market pool ───────────────────────────────────────────────────────────
  for (const [index, market] of allMarkets.entries()) {
    const newest = analysisIds[index % analysisIds.length];
    await insertRow(
      client,
      'market_analysis_schedule',
      {
        id: demoUuid(`schedule:${market.conditionId}`),
        market_id: market.conditionId,
        shortest_interval_seconds: [3600, 7200, 21600][index % 3],
        next_scheduled_run: isoHoursAgo(index === 4 ? 0.5 : -index - 1),
        last_completed_at: isoHoursAgo(2 + index),
        last_result_id: newest,
        is_executing: index === 4,
        execution_started_at: index === 4 ? isoHoursAgo(0.75) : null,
        status: index === 8 ? 'inactive' : 'active',
        created_at: isoDaysAgo(20),
        updated_at: isoHoursAgo(1),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('market_analysis_schedule');
  }

  // ── Portfolio sessions ────────────────────────────────────────────────────
  const sessionIds = new Map<string, string>();

  for (const fixture of SESSIONS) {
    const userId = userIds.get(fixture.userSlug);
    if (!userId) continue;

    // Sessions live on demo markets: a real market can resolve under the demo
    // and the lifecycle Lambda would close the session mid-recording.
    const market = sessionMarkets[fixture.marketIndex % sessionMarkets.length];
    const requestId = await ensureRequest(fixture.userSlug, market);
    const sessionId = demoUuid(`session:${fixture.slug}`);
    sessionIds.set(fixture.slug, sessionId);

    const amountInPositions = fixture.position?.amountInPositions ?? 0;
    const positionSize = fixture.position
      ? round6(fixture.position.amountInPositions / fixture.position.entryPrice)
      : null;
    // A closed session holds capital plus what it realized; an open one holds
    // capital minus what is committed to the position.
    const amountAvailable =
      fixture.status === 'terminated' && !fixture.position
        ? round6(fixture.investment + fixture.realizedPnl)
        : round6(fixture.investment - amountInPositions);

    await insertRow(
      client,
      'portfolio_manager_sessions',
      {
        id: sessionId,
        user_id: userId,
        market_id: market.conditionId,
        recurring_analysis_id: requestId,
        persona_id: fixture.persona,
        persona_config: json(PERSONA_REGISTRY[fixture.persona] ?? PERSONA_REGISTRY.scalper),
        investment_amount: fixture.investment,
        status: fixture.status,
        position_direction: fixture.position?.direction ?? null,
        position_size: positionSize,
        position_entry_price: fixture.position?.entryPrice ?? null,
        position_entry_at: fixture.position ? isoHoursAgo(fixture.position.entryHoursAgo) : null,
        position_stop_loss_order_id: null,
        position_take_profit_order_id: null,
        total_trades: fixture.totalTrades,
        winning_trades: fixture.winningTrades,
        realized_pnl: fixture.realizedPnl,
        unrealized_pnl: fixture.unrealizedPnl,
        total_hold_duration_minutes: fixture.position ? 1440 : 0,
        amount_in_positions: amountInPositions,
        amount_in_pending_orders: 0,
        amount_available: amountAvailable,
        position_guard_schedule_arn: null,
        cumulative_loss_pct: fixture.cumulativeLossPct ?? 0,
        last_loss_exit_at: fixture.cumulativeLossPct ? isoHoursAgo(40) : null,
        position_size_reduction_active: false,
        profit_target_pct: fixture.profitTargetPct ?? null,
        termination_reason: fixture.terminationReason ?? null,
        created_at: isoHoursAgo(fixture.createdHoursAgo),
        updated_at: isoHoursAgo(fixture.status === 'terminated' ? (fixture.terminatedHoursAgo ?? 1) : 0.5),
        terminated_at: fixture.terminatedHoursAgo
          ? isoHoursAgo(fixture.terminatedHoursAgo)
          : null,
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('portfolio_manager_sessions');

    for (const [tradeIndex, trade] of fixture.trades.entries()) {
      const shares = round6(trade.sizeUsdc / trade.price);
      await insertRow(
        client,
        'portfolio_manager_trades',
        {
          id: demoUuid(`trade:${fixture.slug}:${tradeIndex}`),
          session_id: sessionId,
          analysis_result_id: analysisIds[(tradeIndex + fixture.marketIndex) % analysisIds.length],
          direction: trade.direction,
          side: trade.side,
          order_type: trade.orderType,
          size_usdc: trade.sizeUsdc,
          price: trade.price,
          fill_price: trade.fillPrice,
          shares: trade.fillPrice ? shares : null,
          status: trade.status,
          clob_order_id: null,
          trade_purpose: trade.purpose,
          reasoning: trade.reasoning,
          conviction_score: trade.conviction,
          patience_expires_at:
            trade.status === 'pending' ? isoHoursAgo(-0.25) : null,
          created_at: isoHoursAgo(trade.createdHoursAgo),
          filled_at: trade.filledHoursAgo ? isoHoursAgo(trade.filledHoursAgo) : null,
          cancelled_at: null,
          realized_pnl: trade.realizedPnl ?? null,
          hold_duration_minutes: trade.holdMinutes ?? null,
          exit_reason: trade.exitReason ?? null,
        },
        'ON CONFLICT (id) DO NOTHING'
      );
      bump('portfolio_manager_trades');
    }

    for (const [decisionIndex, decision] of DECISIONS.filter(
      (candidate) => candidate.sessionSlug === fixture.slug
    ).entries()) {
      await insertRow(
        client,
        'portfolio_manager_decisions',
        {
          id: demoUuid(`decision:${fixture.slug}:${decisionIndex}`),
          session_id: sessionId,
          analysis_result_id: analysisIds[(decisionIndex + fixture.marketIndex) % analysisIds.length],
          action: decision.action,
          edge_met: decision.edgeMet,
          alignment_met: decision.alignmentMet,
          conviction_score: decision.conviction,
          additional_criteria_met: decision.edgeMet && decision.alignmentMet,
          had_position: decision.hadPosition ?? false,
          position_direction: decision.positionDirection ?? null,
          position_unrealized_pnl: decision.positionUnrealizedPnl ?? null,
          reasoning: decision.reasoning,
          skip_reason: decision.skipReason ?? null,
          created_at: isoHoursAgo(decision.hoursAgo),
        },
        'ON CONFLICT (id) DO NOTHING'
      );
      bump('portfolio_manager_decisions');
    }
  }

  // ── Notes and plan overrides ──────────────────────────────────────────────
  const NOTES: Array<{ slug: string; body: string; hoursAgo: number }> = [
    { slug: 'sofia', body: 'Duplicate renewal confirmed on chain. Credits granted; asked the customer to keep the tx hash.', hoursAgo: 70 },
    { slug: 'sofia', body: 'Account suspended while the duplicate payment review finishes. Do not terminate.', hoursAgo: 30 },
    { slug: 'omar', body: 'Exit retry is a no-op because the pending order has no CLOB id. Executor investigation open.', hoursAgo: 4 },
    { slug: 'marcus', body: 'Disputed recommendation refunded one credit as a goodwill gesture. Not a platform fault.', hoursAgo: 26 },
    { slug: 'priya', body: 'Wants delivered analyses deleted. Waiting on whether session history should go too.', hoursAgo: 36 },
    { slug: 'diego', body: 'Kill switch drill completed end to end. Halt was synchronous; exit landed 40s later.', hoursAgo: 71 },
  ];

  for (const [index, note] of NOTES.entries()) {
    const userId = userIds.get(note.slug);
    if (!userId) continue;
    await insertRow(
      client,
      'admin_user_notes',
      {
        id: demoUuid(`note:${note.slug}:${index}`),
        user_id: userId,
        author_sub: 'warden-demo-support',
        author_email: 'support@warden-demo.tradewizard.live',
        body: note.body,
        created_at: isoHoursAgo(note.hoursAgo),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('admin_user_notes');
  }

  for (const slug of ['sofia', 'leah']) {
    const userId = userIds.get(slug);
    if (!userId) continue;
    await insertRow(
      client,
      'admin_plan_overrides',
      {
        user_id: userId,
        plan: slug === 'sofia' ? 'elite' : 'starter',
        expires_at: isoDaysFromNow(slug === 'sofia' ? 45 : 30),
        reason:
          slug === 'sofia'
            ? 'Comp while the duplicate payment is investigated.'
            : 'Community comp for the beta feedback session.',
        granted_by: 'warden-demo-operator',
        revoked_at: null,
        created_at: isoDaysAgo(slug === 'sofia' ? 2 : 5),
      },
      'ON CONFLICT (user_id) DO NOTHING'
    );
    bump('admin_plan_overrides');
  }

  // ── Support ───────────────────────────────────────────────────────────────
  for (const ticket of TICKETS) {
    const ticketId = demoUuid(`ticket:${ticket.slug}`);
    const userId = ticket.requesterSlug ? userIds.get(ticket.requesterSlug) : null;
    const requesterEmail = ticket.requesterSlug
      ? demoEmail(ticket.requesterSlug)
      : ticket.requesterEmail!;

    await insertRow(
      client,
      'support_tickets',
      {
        id: ticketId,
        ref: demoSupportRef(ticket.slug),
        requester_email: requesterEmail,
        user_id: userId ?? null,
        topic: ticket.topic,
        status: ticket.status,
        priority: ticket.priority,
        subject: ticket.subject,
        body: ticket.body,
        context: json(ticket.context),
        context_hash: demoHash(`context:${ticket.slug}`).slice(0, 32),
        app_version: ticket.context.appVersion ?? null,
        request_id: `warden-demo-${ticket.slug}`,
        assigned_admin_sub: ticket.assigned ? 'warden-demo-support' : null,
        assigned_at: ticket.assigned ? isoHoursAgo(ticket.createdHoursAgo - 1) : null,
        confirmation_sent: true,
        last_customer_notified_at: isoHoursAgo(ticket.createdHoursAgo),
        first_response_at: ticket.firstResponseHoursAgo
          ? isoHoursAgo(ticket.firstResponseHoursAgo)
          : null,
        last_message_at: isoHoursAgo(
          Math.min(...ticket.messages.map((message) => message.hoursAgo))
        ),
        resolved_at: ticket.resolvedHoursAgo ? isoHoursAgo(ticket.resolvedHoursAgo) : null,
        closed_at: ticket.status === 'closed' ? isoHoursAgo(ticket.resolvedHoursAgo ?? 1) : null,
        ip_hash: demoHash(`ip:${ticket.slug}`).slice(0, 32),
        created_at: isoHoursAgo(ticket.createdHoursAgo),
        updated_at: isoHoursAgo(Math.min(...ticket.messages.map((message) => message.hoursAgo))),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('support_tickets');

    for (const [index, message] of ticket.messages.entries()) {
      await insertRow(
        client,
        'support_messages',
        {
          id: demoUuid(`ticket-message:${ticket.slug}:${index}`),
          ticket_id: ticketId,
          author_type: message.authorType,
          author_user_id:
            message.authorType === 'customer' && message.authorSlug
              ? userIds.get(message.authorSlug)
              : null,
          author_admin_sub: message.authorType === 'admin' ? 'warden-demo-support' : null,
          author_admin_email:
            message.authorType === 'admin' ? 'support@warden-demo.tradewizard.live' : null,
          body: message.body,
          is_internal: message.isInternal ?? false,
          request_id: `warden-demo-${ticket.slug}-${index}`,
          created_at: isoHoursAgo(message.hoursAgo),
        },
        'ON CONFLICT (id) DO NOTHING'
      );
      bump('support_messages');
    }

    await insertRow(
      client,
      'support_thread_tokens',
      {
        id: demoUuid(`ticket-token:${ticket.slug}`),
        ticket_id: ticketId,
        token_hash: demoHash(`thread-token:${ticket.slug}`),
        expires_at: isoDaysFromNow(30),
        created_at: isoHoursAgo(ticket.createdHoursAgo),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('support_thread_tokens');
  }

  // ── Newsletter campaigns ──────────────────────────────────────────────────
  for (const campaign of CAMPAIGNS) {
    const campaignId = demoUuid(`campaign:${campaign.slug}`);
    const sentAt = campaign.sentHoursAgo ? isoHoursAgo(campaign.sentHoursAgo) : null;

    await insertRow(
      client,
      'newsletter_campaigns',
      {
        id: campaignId,
        subject: campaign.subject,
        preheader: campaign.preheader,
        template: campaign.template,
        content: json(campaign.content),
        audience: json({ type: 'confirmed' }),
        status: campaign.status,
        slug: campaign.status === 'sent' ? campaign.slug : null,
        scheduled_at: null,
        started_at: sentAt,
        sent_at: sentAt,
        cancelled_at: null,
        created_by: 'warden-demo-operator',
        approved_by: campaign.status === 'sent' ? 'warden-demo-owner' : null,
        recipient_count: campaign.recipients,
        sent_count: campaign.status === 'sent' ? campaign.recipients : 0,
        failed_count: 0,
        created_at: isoHoursAgo((campaign.sentHoursAgo ?? 2) + 6),
        updated_at: isoHoursAgo(campaign.sentHoursAgo ?? 2),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('newsletter_campaigns');

    if (campaign.status !== 'sent') continue;

    const recipients = USERS.filter((user) => user.newsletter === 'subscribed').slice(
      0,
      campaign.recipients
    );
    for (const [index, recipient] of recipients.entries()) {
      await insertRow(
        client,
        'newsletter_deliveries',
        {
          id: demoUuid(`delivery:${campaign.slug}:${recipient.slug}`),
          campaign_id: campaignId,
          email: demoEmail(recipient.slug),
          user_id: userIds.get(recipient.slug),
          status: index === 1 ? 'bounced' : 'sent',
          provider_message_id: `warden-demo-${campaign.slug}-${index}`,
          error: index === 1 ? 'Mailbox full (seeded demo bounce).' : null,
          attempts: index === 1 ? 3 : 1,
          sent_at: sentAt,
          created_at: sentAt,
        },
        'ON CONFLICT (campaign_id, email) DO NOTHING'
      );
      bump('newsletter_deliveries');
    }
  }

  for (const [index, email] of [
    'warden-demo+reader1@example.com',
    'warden-demo+reader2@example.com',
  ].entries()) {
    await insertRow(
      client,
      'newsletter_subscribers',
      {
        email,
        user_id: null,
        status: 'subscribed',
        source: 'public_form',
        consent_version: '2026-09',
        ip_hash: demoHash(`ip:reader${index}`).slice(0, 32),
        user_agent: 'Mozilla/5.0 (Warden demo seed)',
        confirmed_at: isoDaysAgo(30 - index * 4),
        created_at: isoDaysAgo(30 - index * 4),
        updated_at: isoDaysAgo(30 - index * 4),
      },
      'ON CONFLICT (email) DO NOTHING'
    );
    bump('newsletter_subscribers');
  }

  await insertRow(
    client,
    'newsletter_suppressions',
    {
      email: 'warden-demo+bounced@example.com',
      reason: 'bounced',
      note: 'Hard bounce on the last two issues.',
      created_at: isoDaysAgo(11),
    },
    'ON CONFLICT (email) DO NOTHING'
  );
  bump('newsletter_suppressions');

  // ── Invite links ──────────────────────────────────────────────────────────
  const inviteLinks: Array<{
    slug: string;
    role: 'analyst' | 'support' | 'admin' | 'owner';
    maxUses: number;
    useCount: number;
    expiresInDays: number;
    revoked?: boolean;
  }> = [
    { slug: 'invite-analyst', role: 'analyst', maxUses: 3, useCount: 1, expiresInDays: 6 },
    { slug: 'invite-owner-old', role: 'owner', maxUses: 1, useCount: 1, expiresInDays: -9, revoked: true },
  ];

  for (const link of inviteLinks) {
    const linkId = demoUuid(`invite:${link.slug}`);
    await insertRow(
      client,
      'admin_invite_links',
      {
        id: linkId,
        token_hash: demoHash(`invite-token:${link.slug}`),
        role: link.role,
        created_by_sub: 'warden-demo-operator',
        created_by_email: 'operator@warden-demo.tradewizard.live',
        reason:
          link.slug === 'invite-analyst'
            ? 'Analyst access for the market review rotation.'
            : 'Contractor access for the audit review (ended).',
        expires_at: isoDaysFromNow(link.expiresInDays),
        max_uses: link.maxUses,
        use_count: link.useCount,
        revoked_at: link.revoked ? isoDaysAgo(8) : null,
        revoked_by: link.revoked ? 'warden-demo-operator' : null,
        last_used_at: link.useCount > 0 ? isoDaysAgo(3) : null,
        created_at: isoDaysAgo(link.revoked ? 30 : 4),
      },
      'ON CONFLICT (id) DO NOTHING'
    );
    bump('admin_invite_links');

    const redemptions = link.revoked
      ? [{ slug: 'contractor', email: 'warden-demo+contractor@tradewizard.live', daysAgo: 28 }]
      : [{ slug: 'analyst-invitee', email: 'warden-demo+analyst@tradewizard.live', daysAgo: 3 }];

    for (const redemption of redemptions) {
      await insertRow(
        client,
        'admin_invite_redemptions',
        {
          id: demoUuid(`invite-redemption:${link.slug}:${redemption.slug}`),
          link_id: linkId,
          cognito_sub: `warden-demo-${redemption.slug}`,
          email: redemption.email,
          created_at: isoDaysAgo(redemption.daysAgo),
        },
        'ON CONFLICT (cognito_sub) DO NOTHING'
      );
      bump('admin_invite_redemptions');
    }
  }

  // ── Metrics rollup ────────────────────────────────────────────────────────
  const metrics: MetricsSnapshot[] = [];
  const existingManifest = readManifest();
  const firstDay = utcDay(-29);

  const existingMetrics = await client.query<Record<string, unknown>>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, signups, active_users, analyses_executed,
            analyses_delivered, credits_consumed, revenue_usdc::float8 AS revenue_usdc,
            pm_active_sessions, pm_realized_pnl::float8 AS pm_realized_pnl
       FROM admin_metrics_daily
      WHERE day >= $1::date`,
    [firstDay]
  );

  const metricsByDay = new Map(
    existingMetrics.rows.map((row) => [String(row.day), row])
  );

  for (let offset = 0; offset < 30; offset += 1) {
    const day = utcDay(offset - 29);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;

    const signups = weekend ? 3 + (offset % 4) : 6 + ((offset * 3) % 9);
    const activeUsers = 48 + offset * 2 + ((weekday * 3) % 11);
    const analysesExecuted = weekend ? 12 + (offset % 7) : 22 + ((offset * 5) % 18);
    const analysesDelivered = analysesExecuted * (2 + (offset % 3));
    const creditsConsumed = Math.round(analysesExecuted * 1.6);
    const revenueUsdc = [0, 29, 0, 0, 99, 0, 49, 0, 19, 199][offset % 10] + (weekend ? 0 : 19);
    const pmActiveSessions = 4 + (offset % 5);
    const pmRealizedPnl = ((offset * 7) % 23) - 8;

    const previous = metricsByDay.get(day) ?? null;
    const manifestEntry = existingManifest?.metrics.find((entry) => entry.day === day);

    metrics.push({
      day,
      existed: previous !== null,
      previous:
        manifestEntry?.previous ??
        (previous
          ? {
              signups: Number(previous.signups ?? 0),
              activeUsers: Number(previous.active_users ?? 0),
              analysesExecuted: Number(previous.analyses_executed ?? 0),
              analysesDelivered: Number(previous.analyses_delivered ?? 0),
              creditsConsumed: Number(previous.credits_consumed ?? 0),
              revenueUsdc: Number(previous.revenue_usdc ?? 0),
              pmActiveSessions: Number(previous.pm_active_sessions ?? 0),
              pmRealizedPnl: Number(previous.pm_realized_pnl ?? 0),
            }
          : null),
    });

    await client.query(
      `
      INSERT INTO admin_metrics_daily (
        day, signups, active_users, analyses_executed, analyses_delivered,
        credits_consumed, revenue_usdc, pm_active_sessions, pm_realized_pnl, updated_at
      ) VALUES (
        $1::date, $2, $3, $4, $5, $6, $7, $8, $9, now()
      )
      ON CONFLICT (day) DO UPDATE SET
        signups = EXCLUDED.signups,
        active_users = EXCLUDED.active_users,
        analyses_executed = EXCLUDED.analyses_executed,
        analyses_delivered = EXCLUDED.analyses_delivered,
        credits_consumed = EXCLUDED.credits_consumed,
        revenue_usdc = EXCLUDED.revenue_usdc,
        pm_active_sessions = EXCLUDED.pm_active_sessions,
        pm_realized_pnl = EXCLUDED.pm_realized_pnl,
        updated_at = now()
      `,
      [
        day,
        signups,
        activeUsers,
        analysesExecuted,
        analysesDelivered,
        creditsConsumed,
        revenueUsdc,
        pmActiveSessions,
        pmRealizedPnl,
      ]
    );
    bump('admin_metrics_daily');
  }

  const countsSnapshot: Counts = {};
  for (const [table, count] of Object.entries(counts)) countsSnapshot[table] = count;

  const manifest: DemoManifest = {
    version: 1,
    seededAt: new Date().toISOString(),
    host: '',
    database: '',
    metrics,
    counts: countsSnapshot,
  };

  return { manifest, payloads };
}

// ─── Audit rows ─────────────────────────────────────────────────────────────

async function seedAuditRows(
  client: Client,
  userIds: Map<string, string>,
  sessionIds: Map<string, string>,
  dryRun: boolean
): Promise<number> {
  const existing = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM admin_audit_log WHERE actor_sub = $1`,
    ['warden-demo-operator']
  );

  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    return 0;
  }

  if (dryRun) return AUDIT.length;

  const targetId = (fixture: AuditFixture): string | null => {
    if (fixture.targetType === 'session') {
      return sessionIds.get(fixture.targetSlug) ?? null;
    }
    if (fixture.targetType === 'user') {
      return userIds.get(fixture.targetSlug) ?? null;
    }
    const tickets: Record<string, string> = {
      'portfolio-halt': demoUuid('ticket:portfolio-halt'),
      'billing-double': demoUuid('ticket:billing-double'),
    };
    if (fixture.targetType === 'support_ticket') {
      return tickets[fixture.targetSlug] ?? demoUuid(`ticket:${fixture.targetSlug}`);
    }
    if (fixture.targetType === 'newsletter_campaign') {
      return demoUuid(`campaign:${fixture.targetSlug}`);
    }
    if (fixture.targetType === 'invite_link') {
      return demoUuid(`invite:${fixture.targetSlug}`);
    }
    if (fixture.targetType === 'analysis') {
      const index = Number(fixture.targetSlug.replace('analysis-', ''));
      return demoUuid(`analysis:${Number.isFinite(index) ? index : 0}`);
    }
    if (fixture.targetType === 'market') {
      return fixture.targetSlug;
    }
    return fixture.targetSlug;
  };

  let written = 0;
  for (const fixture of AUDIT) {
    const input: ChainedAuditInsert = {
      actorSub: 'warden-demo-operator',
      actorEmail: 'operator@warden-demo.tradewizard.live',
      actorRole: fixture.role,
      action: fixture.action,
      targetType: fixture.targetType,
      targetId: targetId(fixture),
      reason: fixture.reason,
      status: fixture.status,
      before: fixture.before ?? null,
      after: fixture.after ?? null,
      error: fixture.error ?? null,
      ip: '203.0.113.7',
      userAgent: 'Warden demo seed',
      requestId: randomUUID(),
      idempotencyKey: null,
    };

    await insertChainedAuditRow(client, input);
    written += 1;
  }

  return written;
}

// ─── S3 payloads ────────────────────────────────────────────────────────────

async function uploadPayloads(
  payloads: Array<{ key: string; body: string }>,
  bucket: string
): Promise<number> {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const s3 = new S3Client({ region });

  let uploaded = 0;
  for (const payload of payloads) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: payload.key,
        Body: payload.body,
        ContentType: 'application/json',
        CacheControl: 'private, max-age=300',
      })
    );
    uploaded += 1;
  }

  return uploaded;
}

// ─── Entry point ────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`
Seed the dev database with Warden demo data.

  --dry-run    Write nothing; roll the transaction back and report counts
  --no-s3      Skip uploading analysis payloads to S3
  --quiet      Only print the summary

The seed is idempotent. To start fresh:
  npx tsx scripts/cleanup-warden-demo.ts --yes
  npx tsx scripts/seed-warden-demo.ts
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseCommonArgs(process.argv.slice(2), 'seed');
  const noS3 = process.argv.includes('--no-s3');
  const log = (message: string) => {
    if (!args.quiet) console.log(message);
  };

  const { client, target } = await connectToDevDatabase();
  await client.connect();

  const counts: Counts = {};

  try {
    log(`target: ${target.host}/${target.database} (${target.source})`);
    if (args.dryRun) log('mode: dry run - everything below is rolled back');

    await client.query('BEGIN');

    const { manifest, payloads } = await seedDatabase(client, {
      dryRun: args.dryRun,
      noS3,
      counts,
    });

    if (args.dryRun) {
      await client.query('ROLLBACK');
      log('\ndry run: transaction rolled back, nothing written');
      section('rows the seed ensures exist');
      for (const [table, count] of Object.entries(counts).sort()) {
        log(`  ${table.padEnd(30)} ${count}`);
      }
      if (!noS3) log(`  ${'s3 payloads'.padEnd(30)} ${payloads.length}`);
      log(`  ${'audit rows'.padEnd(30)} ${AUDIT.length}`);
      log('\ncounts include rows an earlier run already created; nothing is duplicated.');
      return;
    }

    await client.query('COMMIT');

    // Post-commit work is best effort: the records already exist, and cleanup
    // works whether or not the payloads or audit rows landed.
    try {
      // Audit rows go through the hash-chain writer, which owns its own
      // transaction, so they run after the data commit.
      const userIds = new Map<string, string>();
      for (const user of USERS) userIds.set(user.slug, demoUuid(`user:${user.slug}`));
      const sessionIds = new Map<string, string>();
      for (const session of SESSIONS) sessionIds.set(session.slug, demoUuid(`session:${session.slug}`));

      const auditRows = await seedAuditRows(client, userIds, sessionIds, args.dryRun);
      const totalAudit = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM admin_audit_log WHERE actor_sub = $1`,
        ['warden-demo-operator']
      );
      if (auditRows === 0) {
        log(`audit: demo rows already present (${totalAudit.rows[0]?.count ?? 0}), left untouched`);
      } else {
        log(`audit: wrote ${auditRows} hash-chained row(s)`);
      }

      if (!noS3) {
        const bucket = await resolveAnalysisBucket();
        if (!bucket) {
          console.warn('  ! no analysis bucket found; skipping payload upload (use --no-s3 to silence)');
        } else {
          const uploaded = await uploadPayloads(payloads, bucket);
          log(`s3: uploaded ${uploaded} payload(s) to ${bucket}`);
        }
      }
    } catch (error) {
      console.warn(
        `  ! post-commit step failed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.warn('    the database records are in place; rerun the seed to fill the gap');
    }

    manifest.host = target.host;
    manifest.database = target.database;
    writeManifest(manifest);

    section('rows ensured');
    for (const [table, count] of Object.entries(counts).sort()) {
      log(`  ${table.padEnd(30)} ${count}`);
    }
    log('\ncounts include rows an earlier run already created; nothing was duplicated.');

    section('demo identities');
    log(`  kill-switch user   ${demoEmail('ks')}  (${demoUuid('user:ks')})`);
    log(`  kill-switch session ${demoUuid('session:ks-pristine')}`);
    log(`  that session holds no position and no pending orders - halting it never reaches the CLOB`);
    log(`  invite links        2 seeded for the Members page; mint a real one there to test /join`);
    log(`\ncleanup: npx tsx scripts/cleanup-warden-demo.ts --yes`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('\n✗ Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
