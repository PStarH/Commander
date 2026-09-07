import { createHash, verify, type KeyLike } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';

export function canonicalBytes(value: unknown): Buffer {
  const serialized = canonicalize(value);
  return Buffer.from(serialized, 'utf8');
}

export function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function verifyEd25519(value: unknown, signature: string, publicKey: KeyLike): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) return false;
  try {
    const decoded = Buffer.from(signature, 'base64url');
    if (decoded.length !== 64 || decoded.toString('base64url') !== signature) return false;
    return verify(null, canonicalBytes(value), publicKey, decoded);
  } catch {
    return false;
  }
}
