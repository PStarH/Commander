/**
 * Worker claim-secret helpers (P1-A).
 *
 * Plaintext lives only in process memory after register(); DB stores sha256 hash.
 * Never log plaintext.
 */
import { createHash, randomBytes } from 'node:crypto';

/** High-entropy claim secret returned once from register. */
export function generateWorkerClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 digest of UTF-8 plaintext — matches PG `sha256(convert_to(..., 'UTF8'))`. */
export function hashWorkerClaimSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function verifyWorkerClaimSecret(secret: string | undefined, expectedHash: Buffer | undefined): boolean {
  if (!secret || secret.length === 0 || !expectedHash || expectedHash.length !== 32) {
    return false;
  }
  const actual = hashWorkerClaimSecret(secret);
  if (actual.length !== expectedHash.length) return false;
  // Constant-time compare
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) {
    mismatch |= actual[i]! ^ expectedHash[i]!;
  }
  return mismatch === 0;
}
