import { scryptSync } from 'node:crypto';

/** Prefix-scoped scrypt. Kernel `hashCellApiKey` must keep these parameters. */
export function hashSecret(secret: string): string {
  const salt = Buffer.from(`commander.api-credential.v1:${secret.slice(0, 8)}`);
  return scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
