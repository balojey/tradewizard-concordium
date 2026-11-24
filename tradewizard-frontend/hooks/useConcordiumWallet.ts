'use client';

import { useCallback, useRef, useState } from 'react';
import type { BrowserWalletConnector } from '@concordium/wallet-connectors';

/**
 * Concordium Browser Wallet connection, used only to sign the registration
 * transactions. The user's key never leaves their wallet: we hand the wallet a
 * contract update built from the payload our API returned.
 *
 * Feature-detected: if the extension is not installed, `connect` reports that
 * plainly instead of throwing something the UI cannot explain.
 */

export interface SignableContractUpdate {
  contractAddress: { index: number; subindex: number };
  receiveName: string;
  parameterHex: string;
  energy: number;
}

const NOT_INSTALLED =
  'The Concordium Wallet for Web extension is not available in this browser. Install it to sign on-chain steps, or run the registration steps with the CLI.';

export function useConcordiumWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectorRef = useRef<BrowserWalletConnector | null>(null);

  const connect = useCallback(async (): Promise<string | null> => {
    setError(null);
    setIsConnecting(true);
    try {
      if (typeof window === 'undefined' || !('concordium' in window)) {
        throw new Error(NOT_INSTALLED);
      }

      // Imported lazily: the wallet connector package touches browser globals at
      // module scope, which breaks prerendering of the page it is used on.
      const { BrowserWalletConnector } = await import('@concordium/wallet-connectors');
      const connector =
        connectorRef.current ??
        (await BrowserWalletConnector.create({
          // The connection is short-lived and driven by explicit clicks, so the
          // delegate only mirrors what the wallet reports into our own state.
          onChainChanged: () => undefined,
          onAccountChanged: (_connection, nextAccount) => setAccount(nextAccount ?? null),
          onConnected: (_connection, nextAccount) => setAccount(nextAccount ?? null),
          onDisconnected: () => {
            setAccount(null);
            connectorRef.current = null;
          },
        }));

      connectorRef.current = connector;
      await connector.connect();
      const connected = (await connector.getConnectedAccount()) ?? null;
      setAccount(connected);
      return connected;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message.includes('concordium') ? NOT_INSTALLED : message);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  /** Ask the wallet to sign and submit one contract update; resolves to the tx hash. */
  const signContractUpdate = useCallback(
    async (update: SignableContractUpdate): Promise<string> => {
      const connector = connectorRef.current;
      if (!connector || !account) throw new Error('Connect the Concordium wallet first.');

      const { AccountTransactionType, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName } = await import(
        '@concordium/web-sdk'
      );

      const payload = {
        amount: CcdAmount.zero(),
        address: ContractAddress.create(update.contractAddress.index, update.contractAddress.subindex),
        receiveName: ReceiveName.fromString(update.receiveName),
        message: Parameter.fromHexString(update.parameterHex),
        maxContractExecutionEnergy: Energy.create(update.energy),
      };

      // The wallet signs, submits, and resolves with the transaction hash.
      return connector.signAndSendTransaction(account, AccountTransactionType.Update, payload);
    },
    [account],
  );

  return { account, isConnecting, error, connect, signContractUpdate, hasWallet: () => typeof window !== 'undefined' && 'concordium' in window };
}
