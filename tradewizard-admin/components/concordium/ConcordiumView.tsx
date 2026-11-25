"use client";

import { useState } from "react";
import { ExternalLink, Loader2, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { DataTable, type Column } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Page, PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/Stat";
import { formatDateTime } from "@/lib/format";
import {
  useConcordiumAgents,
  useConcordiumEpochs,
  useEpochIntegrity,
  useVerifyConcordiumAgent,
  type BadgeTrust,
  type ConcordiumAgentRow,
  type ConcordiumEpochRow,
} from "@/hooks/useConcordiumAdmin";

const EXPLORER = "https://testnet.ccdscan.io";

/** CCDScan deep links are query routes; path forms 404. */
const explorerAccount = (address: string) => `${EXPLORER}/?dcount=1&dentity=account&daddress=${address}`;
const explorerTransaction = (hash: string) => `${EXPLORER}/?dcount=1&dentity=transaction&dhash=${hash}`;

function short(value: string | null | undefined, head = 8, tail = 6): string {
  if (!value) return "—";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function TrustBadge({ trust }: { trust: BadgeTrust }) {
  if (trust === "verified") return <Badge tone="yes">Verified</Badge>;
  if (trust === "registered") return <Badge tone="warning">Registered</Badge>;
  return <Badge tone="neutral">Unverified</Badge>;
}

function TrustIcon({ trust }: { trust: BadgeTrust }) {
  if (trust === "verified") return <ShieldCheck size={12} className="text-yes" aria-hidden />;
  if (trust === "registered") return <ShieldAlert size={12} className="text-warning" aria-hidden />;
  return <ShieldQuestion size={12} className="text-muted" aria-hidden />;
}

export function ConcordiumView() {
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState<ConcordiumAgentRow | null>(null);
  const [reason, setReason] = useState("");
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);

  const agents = useConcordiumAgents(query);
  const epochs = useConcordiumEpochs();
  const verify = useVerifyConcordiumAgent();
  const integrity = useEpochIntegrity(selectedAnchor);

  const agentRows = agents.data ?? [];
  const epochRows = epochs.data ?? [];
  const verified = agentRows.filter((row) => row.badgeTrust === "verified").length;

  const agentColumns: Column<ConcordiumAgentRow>[] = [
    {
      key: "owner",
      header: "Owner",
      render: (row) => <span className="text-[12px] text-fg">{row.owner.email}</span>,
    },
    {
      key: "token",
      header: "Token",
      render: (row) => (
        <span className="mono text-[11px] text-muted">
          {row.tokenId ? `#${row.tokenId}` : "not minted"}
          {row.tokenAddress ? ` · ${row.tokenAddress}` : ""}
        </span>
      ),
    },
    {
      key: "account",
      header: "Account",
      render: (row) => (
        <a
          href={explorerAccount(row.concordiumAccount)}
          target="_blank"
          rel="noreferrer"
          className="mono inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent"
        >
          {short(row.concordiumAccount)}
          <ExternalLink size={9} aria-hidden />
        </a>
      ),
    },
    {
      key: "trust",
      header: "Badge",
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <TrustIcon trust={row.badgeTrust} />
          <TrustBadge trust={row.badgeTrust} />
        </span>
      ),
    },
    {
      key: "epochs",
      header: "Epochs",
      align: "right",
      render: (row) => <span className="num text-[12px]">{row.epochCount}</span>,
    },
    {
      key: "checked",
      header: "Last checked",
      render: (row) => (
        <span className="text-[11px] text-muted">
          {row.badgeCheckedAt ? formatDateTime(row.badgeCheckedAt) : "never"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setVerifying(row);
            setReason("");
          }}
          disabled={!row.tokenAddress}
        >
          Re-verify
        </Button>
      ),
    },
  ];

  const epochColumns: Column<ConcordiumEpochRow>[] = [
    {
      key: "epoch",
      header: "Epoch",
      render: (row) => (
        <span className="text-[12px] text-fg">{formatDateTime(row.epochEnd)}</span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (row) => <span className="text-[11px] text-muted">{row.ownerEmail}</span>,
    },
    {
      key: "token",
      header: "Token",
      render: (row) => <span className="mono text-[11px] text-muted">#{row.tokenId ?? "—"}</span>,
    },
    {
      key: "decisions",
      header: "Decisions",
      align: "right",
      render: (row) => <span className="num text-[12px]">{row.decisionCount}</span>,
    },
    {
      key: "root",
      header: "Root",
      render: (row) => <span className="mono text-[11px] text-muted">{short(row.rootHash)}</span>,
    },
    {
      key: "tx",
      header: "Anchor",
      render: (row) =>
        row.txHash ? (
          <a
            href={explorerTransaction(row.txHash)}
            target="_blank"
            rel="noreferrer"
            className="mono inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent"
          >
            {short(row.txHash, 6, 4)}
            <ExternalLink size={9} aria-hidden />
          </a>
        ) : (
          <Badge tone="warning">awaiting signature</Badge>
        ),
    },
    {
      key: "integrity",
      header: "",
      align: "right",
      render: (row) => (
        <Button size="sm" variant="secondary" onClick={() => setSelectedAnchor(row.id)}>
          Check integrity
        </Button>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Agent accountability"
        description="On-chain identity for every agent, and whether each anchored epoch still reproduces its root."
      />

      <StatGrid>
        <StatCard label="Agents" value={String(agentRows.length)} hint="registered on Concordium" />
        <StatCard label="Verified" value={String(verified)} hint="badge intact" tone="yes" />
        <StatCard label="Anchored epochs" value={String(epochRows.length)} hint="roots pinned on chain" />
        <StatCard
          label="Awaiting signature"
          value={String(epochRows.filter((row) => row.awaitingSignature).length)}
          hint="staged, not submitted"
        />
      </StatGrid>

      <Panel className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[13px] font-medium text-fg">Registered agents</h2>
            <p className="text-[10.5px] text-muted">Every user agent, with its cached badge state.</p>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email, token or account"
            className="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <DataTable
          columns={agentColumns}
          rows={agentRows}
          getRowId={(row) => row.id}
          loading={agents.isLoading}
          emptyMessage="No agents registered yet."
        />
      </Panel>

      <Panel className="mt-4">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[13px] font-medium text-fg">Anchored epochs</h2>
            <p className="text-[10.5px] text-muted">
              Newest first. Integrity re-derives the Merkle root from the decision log.
            </p>
          </div>
        </div>
        <DataTable
          columns={epochColumns}
          rows={epochRows}
          getRowId={(row) => row.id}
          loading={epochs.isLoading}
          emptyMessage="No epochs anchored yet."
        />
      </Panel>

      {selectedAnchor && (
        <Panel className="mt-4">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium text-fg">Epoch integrity</h2>
            <Button size="sm" variant="ghost" onClick={() => setSelectedAnchor(null)}>
              Close
            </Button>
          </div>

          <div className="px-4 py-3">
            {integrity.isLoading && (
              <p className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                <Loader2 size={12} className="animate-spin" aria-hidden /> Recomputing…
              </p>
            )}

            {integrity.error && (
              <p className="text-[12px] text-no">{(integrity.error as Error).message}</p>
            )}

            {integrity.data && (
              <div className="flex flex-col gap-2">
                <div
                  className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] ${
                    integrity.data.reproducible
                      ? "border-yes/30 bg-yes/10 text-yes"
                      : "border-no/30 bg-no/10 text-no"
                  }`}
                >
                  {integrity.data.reproducible ? (
                    <>
                      <ShieldCheck size={13} aria-hidden /> Reproduces the anchored root
                    </>
                  ) : (
                    <>
                      <ShieldAlert size={13} aria-hidden /> Does NOT reproduce — the log changed after anchoring
                    </>
                  )}
                </div>

                <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11.5px] sm:grid-cols-2">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Anchor</dt>
                    <dd className="mono">{short(integrity.data.anchorId, 10, 6)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Decisions found</dt>
                    <dd className="num">
                      {integrity.data.decisionsFound} of {integrity.data.decisionCount}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Anchored root</dt>
                    <dd className="mono">{short(integrity.data.anchoredRoot)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Rebuilt root</dt>
                    <dd className="mono">{short(integrity.data.rebuiltRoot)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">On chain</dt>
                    <dd
                      className={
                        integrity.data.onChain
                          ? integrity.data.onChain.matches
                            ? "text-yes"
                            : "text-no"
                          : "text-muted"
                      }
                    >
                      {integrity.data.onChain
                        ? integrity.data.onChain.matches
                          ? "matches"
                          : "does not match"
                        : "not committed"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Epoch</dt>
                    <dd>{formatDateTime(integrity.data.epochEnd)}</dd>
                  </div>
                </dl>

                {integrity.data.failure && (
                  <p className="text-[11.5px] text-no">{integrity.data.failure}</p>
                )}
              </div>
            )}
          </div>
        </Panel>
      )}

      {verifying && (
        <Panel className="mt-4">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium text-fg">
              Re-verify {verifying.owner.email}
              {verifying.tokenId ? ` · token #${verifying.tokenId}` : ""}
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setVerifying(null)}>
              Cancel
            </Button>
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            <p className="text-[11.5px] text-muted">
              Calls the registry live and updates the cached badge state. Recorded in the audit log, so a reason is
              required.
            </p>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="Reason (min 8 characters)"
              className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  verify.mutate(
                    { agentId: verifying.id, reason },
                    {
                      onSuccess: () => {
                        setVerifying(null);
                        setReason("");
                      },
                    }
                  );
                }}
                loading={verify.isPending}
                disabled={reason.trim().length < 8}
              >
                Re-verify now
              </Button>
              {verify.error && <span className="text-[11.5px] text-no">{(verify.error as Error).message}</span>}
            </div>
          </div>
        </Panel>
      )}
    </Page>
  );
}
