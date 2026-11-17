import { useMemo } from "react";
import { useWallet } from "@/providers/WalletContext";
import { ClobClient } from "@polymarket/clob-client";
import useSafeDeployment from "@/hooks/useSafeDeployment";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";

import { TradingSession } from "@/utils/session";
import {
  CLOB_API_URL,
  POLYGON_CHAIN_ID,
  REMOTE_SIGNING_URL,
} from "@/constants/polymarket";

// This hook creates the authenticated clobClient with the User API Credentials
// and the builder config credentials, but only after a trading session is initialized

export default function useClobClient(
  tradingSession: TradingSession | null,
  isTradingSessionComplete: boolean | undefined
) {
  const { eoaAddress, ethersSigner } = useWallet();
  const { derivedSafeAddressFromEoa } = useSafeDeployment(eoaAddress);

  /**
   * Polymarket wallet that holds the funds and authors the order:
   *  - legacy Safe accounts        -> signature type 2 (POLY_GNOSIS_SAFE)
   *  - modern Deposit Wallet       -> signature type 3 (POLY_1271)
   *
   * The installed clob-client enum stops at 2, so type 3 is passed numerically.
   * The value goes into the EIP-712 order struct; the exchange validates the
   * signature against the wallet type. Funder and type must describe the SAME
   * wallet, which is why both come from the session rather than a fresh
   * derivation: a derived legacy Safe address does not exist for a Deposit
   * Wallet account, and orders funded by it are rejected.
   */
  const funderAddress = tradingSession?.safeAddress ?? derivedSafeAddressFromEoa;
  // The enum is not exported from the client and stops at 2 in the installed
  // version, so take the parameter type from the constructor and cast.
  type ClobSignatureType = ConstructorParameters<typeof ClobClient>[4];
  const signatureType = (
    tradingSession?.walletType === "DEPOSIT_WALLET" ? 3 : 2
  ) as unknown as ClobSignatureType;

  const clobClient = useMemo(() => {
    if (
      !ethersSigner ||
      !eoaAddress ||
      !funderAddress ||
      !isTradingSessionComplete ||
      !tradingSession?.apiCredentials
    ) {
      return null;
    }

    const builderConfig = new BuilderConfig({
      remoteBuilderConfig: {
        url: REMOTE_SIGNING_URL(),
      },
    });

    // This is the persisted clobClient instance for creating and posting
    // orders for the user, with proper builder order attribution
    return new ClobClient(
      CLOB_API_URL,
      POLYGON_CHAIN_ID,
      ethersSigner,
      tradingSession.apiCredentials,
      signatureType,
      funderAddress,
      undefined, // mandatory placeholder
      false,
      builderConfig // Builder order attribution
    );
  }, [
    eoaAddress,
    ethersSigner,
    funderAddress,
    signatureType,
    isTradingSessionComplete,
    tradingSession?.apiCredentials,
  ]);

  return { clobClient };
}
