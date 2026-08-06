import { scryptSync } from 'node:crypto';

const API_KEY_HASH_SALT = 'commander-api-key-v2';
const API_KEY_HASH_BYTES = 32;

/** Deterministic, one-way API key derivation shared by storage and authentication. */
export function deriveApiKeyHash(key: string): Buffer {
  return scryptSync(key, API_KEY_HASH_SALT, API_KEY_HASH_BYTES);
}
