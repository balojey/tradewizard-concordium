'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api-client';

/**
 * Concordium accountability data.
 *
 * Everything here comes from the agent API, which in turn reads the registry:
 * badge state is a live `check_badge`, the anchored epochs are rows the
 * anchoring job staged, and a proof is recomputed from the decision log before
 * it is served. The one thing computed locally is the card hash, so the browser
 * can verify the served bytes without trusting the API's own claim.
 */

export type BadgeTrust = 'verified' | 'registered' | 'unknown';

export interface ConcordiumAgent {
  id: string;
  network: string;
  concordiumAccount: string;
  externalKeyNamespace: string | null;
  externalKeyHex: string | null;
  tokenId: string | null;
  tokenAddress: string | null;
  agentUri: string | null;
  metadataHashHex: string | null;
  status: 'pending' | 'minted' | 'active' | 'revoked' | 'failed';
  badgeTrust: BadgeTrust;
  badgeCheckedAt: string | null;
  lastTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  cardUrl?: string;
}

export interface BadgeProblem {
  severity: string;
  field: string;
  message: string;
}

export interface BadgeVerification {
  trust: BadgeTrust;
  label: string;
  caveat: string;
  problems: BadgeProblem[];
  checks: Record<string, boolean | string>;
}

export interface ConcordiumAnchor {
  id: string;
  epochStart: string;
  epochEnd: string;
  decisionCount: number;
  rootHash: string;
  leafVersion: number;
  metadataKey: string | null;
  txHash: string | null;
  anchoredAt: string | null;
  createdAt: string;
  pendingSignature: boolean;
}

export interface EpochDecision {
  id: string;
  action: string;
  positionDirection: string | null;
  createdAt: string;
  /** Which market the decision was about, and what the analysis concluded. */
  marketId: string | null;
  analysis: {
    recommendation: string | null;
    consensusProbability: number | null;
    marketProbability: number | null;
    edge: number | null;
  };
  leaf: string;
}

export interface DecisionProof {
  anchor: ConcordiumAnchor;
  decision: { id: string; action: string; reasoning: string; createdAt: string };
  context?: { marketId: string | null };
  leafVersion: number;
  proof: { leaf: string; index: number; size: number; path: string[] };
  rootHash: string;
  verified: boolean;
  onChain: { key: string; valueHex: string | null; valueText: string | null; matches: boolean } | null;
  howToVerify: string[];
}

export function useConcordiumAgents() {
  return useQuery({
    queryKey: ['concordium', 'agents'],
    queryFn: () => get<{ agents: ConcordiumAgent[] }>('/concordium/agents'),
    staleTime: 30_000,
  });
}

export function useVerifyConcordiumAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => post<BadgeVerification>(`/concordium/agents/${agentId}/verify`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['concordium', 'agents'] });
    },
  });
}

export function useConcordiumAnchors(agentId: string | undefined) {
  return useQuery({
    queryKey: ['concordium', 'anchors', agentId],
    queryFn: () => get<{ anchors: ConcordiumAnchor[] }>(`/concordium/agents/${agentId}/anchors`),
    enabled: Boolean(agentId),
  });
}

export function useEpochDecisions(agentId: string | undefined, anchorId: string | undefined) {
  return useQuery({
    queryKey: ['concordium', 'decisions', agentId, anchorId],
    queryFn: () =>
      get<{ decisions: EpochDecision[] }>(`/concordium/agents/${agentId}/anchors/${anchorId}/decisions`),
    enabled: Boolean(agentId && anchorId),
  });
}

export function useDecisionProof(
  agentId: string | undefined,
  anchorId: string | undefined,
  decisionId: string | undefined,
) {
  return useQuery({
    queryKey: ['concordium', 'proof', agentId, anchorId, decisionId],
    queryFn: () =>
      get<DecisionProof>(`/concordium/agents/${agentId}/anchors/${anchorId}/proof/${decisionId}`),
    enabled: Boolean(agentId && anchorId && decisionId),
    // A 409 means the epoch no longer reproduces its root; retrying will not help.
    retry: false,
  });
}

/**
 * Verify the card ourselves: fetch the public URL and compare the SHA-256 with
 * the hash pinned on-chain. This is the same check the registry performs, run
 * in the browser, so the panel is not simply repeating what the API says.
 */
export function useCardIntegrity(cardUrl: string | undefined, expectedHash: string | null | undefined) {
  return useQuery({
    queryKey: ['concordium', 'card-integrity', cardUrl, expectedHash],
    queryFn: async () => {
      const response = await fetch(String(cardUrl), { cache: 'no-store' });
      if (!response.ok) throw new Error(`card fetch failed: HTTP ${response.status}`);
      const bytes = await response.text();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
      const served = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return {
        servedHash: served,
        expectedHash: String(expectedHash ?? '').toLowerCase(),
        matches: served === String(expectedHash ?? '').toLowerCase(),
        bytes: bytes.length,
      };
    },
    enabled: Boolean(cardUrl && expectedHash),
    retry: false,
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface SignablePayload {
  step: string;
  contractAddress: { index: number; subindex: number };
  receiveName: string;
  parameterHex: string;
  energy: number;
  metadata: Record<string, unknown>;
}

export function useCreateConcordiumAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { concordiumAccount: string; externalKeyHex?: string }) =>
      post<{ agent: ConcordiumAgent }>('/concordium/agents', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['concordium', 'agents'] });
    },
  });
}

/** Ask the API to build and publish this agent's card at our own public URL. */
export function useGenerateCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      post<{ agent: ConcordiumAgent; cardUrl: string; metadataHashHex: string }>(
        `/concordium/agents/${agentId}/card/generate`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['concordium', 'agents'] });
    },
  });
}

/** Get a sign-ready contract update for one registration step. */
export function useRegistrationPayload() {
  return useMutation({
    mutationFn: (input: { agentId: string; body: Record<string, unknown> }) =>
      post<SignablePayload>(`/concordium/agents/${input.agentId}/payload`, input.body),
  });
}

/** Record a step the user signed and submitted. */
export function useConfirmStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; body: Record<string, unknown> }) =>
      post<{ agent: ConcordiumAgent }>(`/concordium/agents/${input.agentId}/confirm`, input.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['concordium', 'agents'] });
    },
  });
}
