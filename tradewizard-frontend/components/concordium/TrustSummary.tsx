'use client';

import Link from 'next/link';
import { ArrowRight, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { useConcordiumAgents, useConcordiumAnchors, type BadgeTrust } from '@/hooks/useConcordium';

/**
 * One-line accountability status for the portfolio page.
 *
 * The full record — registration steps, anchored epochs, proofs — belongs with
 * the Portfolio Manager, because the decisions being anchored are its own. This
 * is the pointer, so the state is still visible where users look at results.
 */
export function TrustSummary() {
  const { data, isLoading } = useConcordiumAgents();
  const agent = data?.agents?.[0];
  const anchors = useConcordiumAnchors(agent?.id);

  if (isLoading) return null;

  const trust: BadgeTrust = agent?.badgeTrust ?? 'unknown';
  const epochCount = anchors.data?.anchors.length ?? 0;

  const icon =
    trust === 'verified' ? (
      <ShieldCheck className="h-4 w-4 text-yes" aria-hidden="true" />
    ) : trust === 'registered' ? (
      <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
    ) : (
      <ShieldQuestion className="h-4 w-4 text-muted" aria-hidden="true" />
    );

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-xs font-medium text-fg">Agent accountability</span>
        {agent ? (
          <>
            <Badge tone={trust === 'verified' ? 'yes' : trust === 'registered' ? 'warning' : 'muted'} size="sm">
              {trust === 'verified' ? 'Verified by Concordium' : trust === 'registered' ? 'Registered, not verified' : 'Unverified'}
            </Badge>
            <span className="truncate text-[0.68rem] text-muted">
              token #{agent.tokenId ?? '—'} · {epochCount} anchored epoch{epochCount === 1 ? '' : 's'}
            </span>
          </>
        ) : (
          <span className="text-[0.68rem] text-muted">no agent registered yet</span>
        )}
      </div>

      <Link
        href="/portfolio-manager"
        className="inline-flex shrink-0 items-center gap-1 text-[0.68rem] font-medium text-accent hover:underline"
      >
        {agent ? 'View agent record' : 'Set it up'}
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </Card>
  );
}

export default TrustSummary;
