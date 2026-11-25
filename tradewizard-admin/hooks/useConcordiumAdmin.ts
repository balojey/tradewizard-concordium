"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/lib/admin-api";
import { useAdminAuth } from "@/providers/AdminAuthProvider";

/**
 * Concordium registry data for the portal.
 *
 * Reads are analyst-level; re-verification is admin-level and audited server-side
 * (it changes the cached trust state support may quote to a customer).
 */

export type BadgeTrust = "verified" | "registered" | "unknown";

export interface ConcordiumAgentRow {
  id: string;
  network: string;
  concordiumAccount: string;
  tokenId: string | null;
  tokenAddress: string | null;
  status: string;
  badgeTrust: BadgeTrust;
  badgeCheckedAt: string | null;
  createdAt: string;
  owner: { userId: string; email: string };
  epochCount: number;
  lastAnchoredAt: string | null;
}

export interface ConcordiumEpochRow {
  id: string;
  agentId: string;
  tokenId: string | null;
  ownerEmail: string;
  epochStart: string;
  epochEnd: string;
  decisionCount: number;
  rootHash: string;
  txHash: string | null;
  anchoredAt: string | null;
  metadataKey: string | null;
  awaitingSignature: boolean;
}

export interface EpochIntegrity {
  anchorId: string;
  agentId: string;
  tokenId: string | null;
  epochStart: string;
  epochEnd: string;
  decisionCount: number;
  decisionsFound: number;
  anchoredRoot: string;
  rebuiltRoot: string | null;
  reproducible: boolean;
  onChain: { valueText: string | null; matches: boolean } | null;
  failure: string | null;
}

export function useConcordiumAgents(query: string) {
  const { idToken } = useAdminAuth();
  const params = new URLSearchParams({ limit: "50" });
  if (query.trim()) params.set("q", query.trim());

  return useQuery<ConcordiumAgentRow[]>({
    queryKey: ["admin", "concordium", "agents", query.trim()],
    queryFn: () => adminFetch(`admin/concordium/agents?${params}`, { token: idToken }),
    enabled: Boolean(idToken),
    retry: false,
    staleTime: 30_000,
  });
}

export function useConcordiumEpochs() {
  const { idToken } = useAdminAuth();

  return useQuery<ConcordiumEpochRow[]>({
    queryKey: ["admin", "concordium", "epochs"],
    queryFn: () => adminFetch("admin/concordium/epochs?limit=50", { token: idToken }),
    enabled: Boolean(idToken),
    retry: false,
    staleTime: 30_000,
  });
}

export function useVerifyConcordiumAgent() {
  const { idToken } = useAdminAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { agentId: string; reason: string }) =>
      adminFetch(`admin/concordium/agents/${input.agentId}/verify`, {
        method: "POST",
        token: idToken,
        body: { reason: input.reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "concordium"] });
    },
  });
}

/** Recompute one epoch and compare with what was anchored. Read-only. */
export function useEpochIntegrity(anchorId: string | null) {
  const { idToken } = useAdminAuth();

  return useQuery<EpochIntegrity>({
    queryKey: ["admin", "concordium", "integrity", anchorId],
    queryFn: () => adminFetch(`admin/concordium/epochs/${anchorId}/integrity`, { token: idToken }),
    enabled: Boolean(idToken && anchorId),
    retry: false,
    staleTime: 0,
  });
}
