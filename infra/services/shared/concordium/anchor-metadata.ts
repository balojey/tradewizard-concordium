/**
 * The registry metadata key an epoch root is pinned under.
 *
 * Shared by the anchoring job and the proof CLI so both derive the same key. It
 * lives outside the job's module on purpose: importing a Lambda handler pulls in
 * pg and the AWS SDK, which a script has no business loading.
 */

export const ANCHOR_METADATA_KEY_PREFIX = 'decisionRoot:';

/**
 * `2026-11-17T10:12:19.740Z` → `decisionRoot:20261117T101219.740Z`.
 *
 * Milliseconds are kept deliberately: two epochs can end inside the same second,
 * and a key collision would silently overwrite the previous root on-chain.
 */
export function anchorMetadataKey(epochEnd: string): string {
  return `${ANCHOR_METADATA_KEY_PREFIX}${epochEnd.replace(/[-:]/g, '')}`.slice(0, 64);
}
