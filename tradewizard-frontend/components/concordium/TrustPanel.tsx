'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCheck2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/utils/classNames';
import {
  useCardIntegrity,
  useConcordiumAgents,
  useConcordiumAnchors,
  useDecisionProof,
  useEpochDecisions,
  useVerifyConcordiumAgent,
  type BadgeTrust,
  type ConcordiumAgent,
  type ConcordiumAnchor,
} from '@/hooks/useConcordium';

/**
 * CCDScan routes are query-param based: path forms such as `/account/<addr>`
 * return a JSON 404. Deep links must use ?dtab=…&<param>=… .
 */
const EXPLORER = 'https://testnet.ccdscan.io';
const explorerAccount = (address: string) => `${EXPLORER}/?dtab=account&a=${address}`;
const explorerTransaction = (hash: string) => `${EXPLORER}/?dtab=transaction&tx=${hash}`;
const explorerToken = (tokenAddress: string) => `${EXPLORER}/?dtab=token&t=${tokenAddress}`;

function short(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return '—';
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function trustTone(trust: BadgeTrust): 'yes' | 'warning' | 'muted' {
  if (trust === 'verified') return 'yes';
  if (trust === 'registered') return 'warning';
  return 'muted';
}

function TrustIcon({ trust }: { trust: BadgeTrust }) {
  if (trust === 'verified') return <ShieldCheck className="h-4 w-4 text-yes" aria-hidden="true" />;
  if (trust === 'registered') return <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />;
  return <ShieldQuestion className="h-4 w-4 text-muted" aria-hidden="true" />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="shrink-0 text-[0.68rem] uppercase tracking-wide text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-fg">{children}</span>
    </div>
  );
}

function AnchorRow({ agentId, anchor }: { agentId: string; anchor: ConcordiumAnchor }) {
  const [open, setOpen] = useState(false);
  const [decisionId, setDecisionId] = useState<string | undefined>();
  const decisions = useEpochDecisions(open ? agentId : undefined, open ? anchor.id : undefined);
  const proof = useDecisionProof(agentId, open ? anchor.id : undefined, decisionId);

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-2.5 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg">
            {new Date(anchor.epochEnd).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            <span className="text-muted"> · {anchor.decisionCount} decision{anchor.decisionCount === 1 ? '' : 's'}</span>
          </span>
          <span className="block truncate font-mono text-[0.65rem] text-muted">{anchor.rootHash}</span>
        </span>
        {anchor.pendingSignature ? (
          <Badge tone="warning" size="sm">awaiting signature</Badge>
        ) : (
          <Badge tone="yes" size="sm">anchored</Badge>
        )}
      </button>

      {open && (
        <div className="pb-3 pl-5">
          {anchor.txHash && (
            <a
              href={explorerTransaction(anchor.txHash)}
              target="_blank"
              rel="noreferrer"
              className="mb-2 inline-flex items-center gap-1 text-[0.68rem] text-accent hover:underline"
            >
              view transaction <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}

          {decisions.isLoading && <p className="text-[0.7rem] text-muted">Loading decisions…</p>}

          {(decisions.data?.decisions ?? []).length > 0 && (
            <ul className="flex flex-col gap-1">
              {decisions.data!.decisions.map((decision) => (
                <li key={decision.id}>
                  <button
                    type="button"
                    onClick={() => setDecisionId(decision.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[0.7rem] transition-colors',
                      decisionId === decision.id ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="uppercase tracking-wide text-fg">
                        {decision.action.replace('_', ' ')}
                        {decision.analysis?.recommendation && (
                          <span className="ml-1.5 normal-case text-muted">· {decision.analysis.recommendation}</span>
                        )}
                      </span>
                      <span className="truncate font-mono text-[0.62rem] text-muted">
                        {short(decision.marketId, 10, 6)}
                        {decision.analysis?.edge !== null && decision.analysis?.edge !== undefined && (
                          <> · edge {decision.analysis.edge > 0 ? '+' : ''}{(decision.analysis.edge * 100).toFixed(1)}pt</>
                        )}
                        {decision.analysis?.consensusProbability !== null &&
                          decision.analysis?.marketProbability !== null &&
                          decision.analysis?.consensusProbability !== undefined &&
                          decision.analysis?.marketProbability !== undefined && (
                            <>
                              {' '}· {(decision.analysis.consensusProbability * 100).toFixed(1)}% vs{' '}
                              {(decision.analysis.marketProbability * 100).toFixed(1)}%
                            </>
                          )}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.62rem]">{short(decision.id, 6, 4)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {proof.error && (
            <p className="mt-2 rounded-md border border-no/30 bg-no/10 p-2 text-[0.7rem] text-no">
              {(proof.error as { status?: number }).status === 409
                ? 'Proof refused: this epoch no longer rebuilds to the anchored root, so the decision log was changed after anchoring.'
                : (proof.error as Error).message}
            </p>
          )}

          {proof.data && (
            <div className="mt-2 rounded-md border border-border bg-surface-2/60 p-2.5 text-[0.7rem]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-1 text-yes">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  proof recomputes to the root
                </span>
                <span className={proof.data.onChain ? (proof.data.onChain.matches ? 'text-yes' : 'text-no') : 'text-muted'}>
                  {proof.data.onChain
                    ? proof.data.onChain.matches
                      ? 'matches the value on chain'
                      : 'does not match the value on chain'
                    : 'not yet committed on chain'}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[0.65rem] leading-relaxed text-muted">
                market {short(proof.data.context?.marketId, 10, 6)} · leaf {short(proof.data.proof.leaf, 10, 6)} · index{' '}
                {proof.data.proof.index} of {proof.data.proof.size} · path of {proof.data.proof.path.length}
              </p>
              <p className="mt-1 text-[0.65rem] text-muted">{proof.data.decision.reasoning}</p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AgentCard({ agent }: { agent: ConcordiumAgent }) {
  const verify = useVerifyConcordiumAgent();
  const integrity = useCardIntegrity(agent.cardUrl, agent.metadataHashHex);
  const anchors = useConcordiumAnchors(agent.id);
  const trust: BadgeTrust = verify.data?.trust ?? agent.badgeTrust;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <TrustIcon trust={trust} />
          <h3 className="text-sm font-semibold text-fg">Accountability</h3>
          <Badge tone={trustTone(trust)} size="sm">
            {verify.data?.label ?? (trust === 'verified' ? 'Verified by Concordium' : trust === 'registered' ? 'Registered, not verified' : 'Unverified')}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => verify.mutate(agent.id)}
            loading={verify.isPending}
            disabled={!agent.tokenAddress}
          >
            {!verify.isPending && <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden="true" />}
            Re-verify
          </Button>
        </div>
      </div>

      <div className="px-4 py-2">
        <Row label="Concordium account">
          <a
            href={explorerAccount(agent.concordiumAccount)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-accent hover:underline"
          >
            {short(agent.concordiumAccount, 8, 6)}
          </a>
        </Row>
        <Row label="Agent token">
          {agent.tokenAddress ? (
            <a
              href={explorerToken(agent.tokenAddress)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-accent hover:underline"
            >
              #{agent.tokenId} · {agent.tokenAddress}
            </a>
          ) : (
            'not minted'
          )}
        </Row>
        <Row label="Polymarket signer">
          <span title={agent.externalKeyHex ?? undefined}>{short(agent.externalKeyHex, 10, 8)}</span>
        </Row>
        <Row label="Card hash">
          <span title={agent.metadataHashHex ?? undefined}>{short(agent.metadataHashHex, 10, 8)}</span>
        </Row>
        <Row label="Card bytes">
          {integrity.isLoading ? (
            <span className="inline-flex items-center gap-1 text-muted">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> checking
            </span>
          ) : integrity.data ? (
            <span className={integrity.data.matches ? 'text-yes' : 'text-no'}>
              {integrity.data.matches ? 'match the pinned hash' : 'do not match'}
            </span>
          ) : (
            <span className="text-muted">unavailable</span>
          )}
        </Row>
      </div>

      <p className="px-4 pb-3 text-[0.66rem] leading-relaxed text-muted">
        Concordium verifies that a real, identity-checked person stands behind this agent. It does not review the
        agent&apos;s code, behaviour or results.
      </p>

      {verify.data?.problems && verify.data.problems.length > 0 && (
        <ul className="mx-4 mb-3 flex flex-col gap-1 rounded-md border border-warning/30 bg-warning/10 p-2 text-[0.68rem] text-warning">
          {verify.data.problems.map((problem) => (
            <li key={`${problem.field}-${problem.message}`}>
              <span className="font-medium">{problem.field}:</span> {problem.message}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border px-4 py-2">
        <div className="flex items-center justify-between py-1">
          <h4 className="text-[0.68rem] uppercase tracking-wide text-muted">Anchored decision epochs</h4>
          <span className="text-[0.65rem] text-muted">Merkle roots pinned on chain</span>
        </div>
        {anchors.isLoading && <p className="py-2 text-[0.7rem] text-muted">Loading epochs…</p>}
        {anchors.data && anchors.data.anchors.length === 0 && (
          <p className="py-2 text-[0.7rem] text-muted">
            No epoch anchored yet. The job runs every six hours and stages a root once there are enough decisions.
          </p>
        )}
        {anchors.data && anchors.data.anchors.length > 0 && (
          <ul className="mt-1">
            {anchors.data.anchors.map((anchor) => (
              <AnchorRow key={anchor.id} agentId={agent.id} anchor={anchor} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function TrustPanel() {
  const { data, isLoading } = useConcordiumAgents();
  const agent = data?.agents?.[0];

  if (isLoading) {
    return (
      <Card className="flex items-center gap-2 px-4 py-6 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading accountability data…
      </Card>
    );
  }

  if (!agent) {
    return (
      <Card className="px-4 py-6">
        <div className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4 text-muted" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-fg">Accountability</h3>
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          This account has no agent registered on Concordium yet. Once one is registered, this panel shows the verified
          identity behind it, the decision epochs anchored on chain, and a proof you can recompute yourself.
        </p>
      </Card>
    );
  }

  return <AgentCard agent={agent} />;
}

export default TrustPanel;
