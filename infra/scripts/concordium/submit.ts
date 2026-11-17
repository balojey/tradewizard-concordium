/**
 * Sign and submit a registry `build_*` payload.
 *
 * Shared by the TypeScript CLIs so the signing path exists once. Scripts only:
 * Lambda code must never hold a signing key, so this deliberately lives outside
 * `services/shared/`.
 */

import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  buildBasicAccountSigner,
} from '@concordium/web-sdk';
// The Node gRPC client only exists behind a package subpath export, which this
// package's CommonJS/node10 module resolution cannot see. tsx resolves it at
// runtime; the type import below keeps `grpcClient()` typed.
// @ts-expect-error TS2307 subpath export
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

export interface ContractPayload {
  contract_address: { index: number; subindex: number };
  receive_name: string;
  parameter_hex: string;
  suggested_energy: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/concordium-testnet-setup.md)`);
  return value;
}

export function grpcClient(): ConcordiumGRPCNodeClient {
  const target = process.env.CONCORDIUM_GRPC ?? 'grpc.testnet.concordium.com:20000';
  const [host, port] = target.split(':');
  return new ConcordiumGRPCNodeClient(host, Number(port ?? 20000), credentials.createSsl());
}

/** Build, sign and (unless dryRun) submit one contract update. Returns the tx hash. */
export async function submitPayload(
  payload: ContractPayload,
  options: { dryRun?: boolean } = {},
): Promise<{ hash?: string; dryRun?: boolean; nonce?: string; bytes?: number }> {
  const sender = AccountAddress.fromBase58(requireEnv('CONCORDIUM_ACCOUNT'));
  const keyHex = requireEnv('CONCORDIUM_KEY_HEX');
  const client = grpcClient();
  const { nonce } = await client.getNextAccountNonce(sender);

  const configured = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(payload.contract_address.index, payload.contract_address.subindex),
      receiveName: ReceiveName.fromString(payload.receive_name),
      message: Parameter.fromHexString(payload.parameter_hex),
    },
    Energy.create(payload.suggested_energy),
  ).addMetadata({
    sender,
    nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromUnwrappedJSON(BigInt(Math.floor(Date.now() / 1000) + 1800)),
  });

  const signed = await Transaction.sign(configured.build(), buildBasicAccountSigner(keyHex));
  const finalized = Transaction.finalize(signed);
  const bytes = Buffer.from(Transaction.serializeBlockItem(finalized)).length;

  if (options.dryRun) {
    console.log(`[dry-run] ${payload.receive_name} on ${payload.contract_address.index},${payload.contract_address.subindex}`);
    return { dryRun: true, nonce: String(nonce), bytes };
  }

  const hash = await client.sendTransaction(finalized);
  const hashHex = String(hash).replace(/^0x/i, '');
  const summary: any = await client.waitForTransactionFinalization(hash);

  // A finalized transaction can still have failed in the contract. Reporting
  // "submitted" for a rejected receive is how a broken write looks like success.
  const outcome = summary?.summary ?? summary;
  if (outcome?.transactionType === 'failed' || outcome?.type === 'failed') {
    const reason = outcome?.rejectReason ?? outcome?.details ?? outcome;
    throw new Error(`transaction ${hashHex} FAILED on chain: ${JSON.stringify(reason)}`);
  }

  console.log(`submitted: ${hashHex}`);
  return { hash: hashHex, bytes };
}
