'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useConcordiumWallet } from '@/hooks/useConcordiumWallet';
import {
  useConfirmStep,
  useCreateConcordiumAgent,
  useGenerateCard,
  useRegistrationPayload,
  type ConcordiumAgent,
} from '@/hooks/useConcordium';

/**
 * In-app registration: everything a normal signed-in user needs to put their
 * agent on Concordium, without a terminal.
 *
 * The service holds no keys, so the on-chain steps are signed by the user's
 * Concordium wallet. When no wallet extension is present the UI says so and
 * leaves the account form usable rather than failing at the last click.
 */

const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 py-2">
      <span
        className={
          done
            ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yes/15 text-[0.6rem] font-semibold text-yes'
            : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[0.6rem] font-semibold text-muted'
        }
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg">{title}</p>
        <div className="mt-1 text-[0.7rem] text-muted">{children}</div>
      </div>
    </li>
  );
}

export function RegistrationPanel({ agent }: { agent?: ConcordiumAgent }) {
  const wallet = useConcordiumWallet();
  const createAgent = useCreateConcordiumAgent();
  const generateCard = useGenerateCard();
  const registrationPayload = useRegistrationPayload();
  const confirmStep = useConfirmStep();

  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const concordiumAccount = agent?.concordiumAccount ?? account;
  const hasToken = Boolean(agent?.tokenId);
  const hasCard = Boolean(agent?.metadataHashHex);

  const clear = () => {
    setError(null);
    setBusy(null);
  };

  async function connect() {
    clear();
    setBusy('connect');
    const connected = await wallet.connect();
    if (connected) setAccount(connected);
    setBusy(null);
    if (!connected && wallet.error) setError(wallet.error);
  }

  async function create() {
    clear();
    if (!ACCOUNT_RE.test(account.trim())) {
      setError('That is not a Concordium account address (50 base58 characters).');
      return;
    }
    setBusy('create');
    try {
      await createAgent.mutateAsync({ concordiumAccount: account.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the agent record.');
    } finally {
      setBusy(null);
    }
  }

  async function publishCard(agentId: string) {
    clear();
    setBusy('card');
    try {
      await generateCard.mutateAsync(agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not publish the Agent Card.');
    } finally {
      setBusy(null);
    }
  }

  /** Sign one contract update and record it, retrying while the index catches up. */
  async function signAndConfirm(agentId: string, step: 'register' | 'set-uri', extra: Record<string, unknown> = {}) {
    clear();
    setBusy(step);
    try {
      const payload = await registrationPayload.mutateAsync({ agentId, body: { step, ...extra } });
      const txHash = await wallet.signContractUpdate(payload);

      let lastError: unknown;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await confirmStep.mutateAsync({ agentId, body: { step, txHash, ...payload.metadata, ...extra } });
          return;
        } catch (cause) {
          lastError = cause;
          // The registry index lags finality; wait and retry before surfacing it.
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
      }
      throw lastError;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The on-chain step did not complete.');
    } finally {
      setBusy(null);
    }
  }

  // ── No agent yet: create the record ────────────────────────────────────────
  if (!agent) {
    return (
      <Card className="px-4 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-fg">Register this agent on Concordium</h3>
        </div>
        <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          Registration creates an on-chain identity for the agent: your Concordium account owns it, the badge proves a
          verified human stands behind it, and its decisions are anchored so they can be checked later.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="Your Concordium account (3… or 4…)"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <Button variant="secondary" size="sm" onClick={connect} loading={busy === 'connect'}>
            {busy !== 'connect' && <Wallet className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
            Use wallet
          </Button>
          <Button size="sm" onClick={create} loading={busy === 'create'} disabled={!account.trim()}>
            Create record
          </Button>
        </div>

        {wallet.error && <p className="mt-2 text-[0.7rem] text-warning">{wallet.error}</p>}
        {error && <p className="mt-2 text-[0.7rem] text-no">{error}</p>}

        <p className="mt-2 text-[0.65rem] leading-relaxed text-muted">
          The account must be backed by a verified identity (Concordium Wallet → Testnet → identity). Signing happens in
          the wallet; we never hold your key.
        </p>
      </Card>
    );
  }

  // ── Agent exists: card, then the on-chain steps ────────────────────────────
  return (
    <Card className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-fg">Finish registering this agent</h3>
        </div>
        <Badge tone={hasToken ? 'yes' : 'warning'} size="sm">
          {hasToken ? `token #${agent.tokenId}` : 'not minted yet'}
        </Badge>
      </div>

      <ol className="mt-2 divide-y divide-border/60">
        <Step n={1} title="Create the agent record" done>
          Owned by <span className="font-mono">{agent.concordiumAccount.slice(0, 10)}…</span>
        </Step>

        <Step n={2} title="Publish the Agent Card" done={hasCard}>
          {hasCard ? (
            <>Hosted at our own URL, hash pinned below.</>
          ) : (
            <>
              Generated and hosted by the app — you do not need to host a file.
              <Button
                variant="secondary"
                size="sm"
                className="ml-2"
                onClick={() => publishCard(agent.id)}
                loading={busy === 'card'}
              >
                Publish card
              </Button>
            </>
          )}
        </Step>

        <Step n={3} title="Sign the registration transaction" done={hasToken}>
          {hasToken ? (
            <>Minted as token #{agent.tokenId}.</>
          ) : (
            <>
              Signed by your Concordium wallet — this is the step that puts the agent on chain.
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {!wallet.account ? (
                  <Button variant="secondary" size="sm" onClick={connect} loading={busy === 'connect'}>
                    Connect wallet
                  </Button>
                ) : (
                  <span className="font-mono text-[0.65rem]">wallet {wallet.account.slice(0, 10)}…</span>
                )}
                <Button
                  size="sm"
                  onClick={() => signAndConfirm(agent.id, 'register')}
                  loading={busy === 'register'}
                  disabled={!hasCard || !wallet.account}
                >
                  Register on chain
                </Button>
              </div>
              {!hasCard && <span className="ml-1">Publish the card first.</span>}
            </>
          )}
        </Step>
      </ol>

      {busy === 'register' && (
        <p className="mt-1 inline-flex items-center gap-1.5 text-[0.7rem] text-muted">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Waiting for the registry to index the mint…
        </p>
      )}
      {wallet.error && <p className="mt-2 text-[0.7rem] text-warning">{wallet.error}</p>}
      {error && <p className="mt-2 text-[0.7rem] text-no">{error}</p>}
    </Card>
  );
}

export default RegistrationPanel;
