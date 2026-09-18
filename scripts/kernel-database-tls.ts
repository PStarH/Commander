/**
 * Pinned database TLS material for the kernel-on Compose profiles.
 *
 * `createVerifiedPostgresPool` is the only sanctioned pool factory and it
 * verifies the CA, the DSN hostname and a pinned server SPKI, refusing any
 * `sslmode` other than `verify-full`. So `docker-compose.v2.yml` and
 * `docker-compose.cell.yml` — which are kernel-on — cannot start without this
 * material, and `apps/api`'s auth stores need it too.
 *
 * Kept in its own module so the compose command constant
 * (`l4-b-cell-compose.ts`) can reference the material without a cycle.
 *
 * The generator's server certificate carries `DNS:postgres` (the in-network DSN
 * host) plus `localhost`, which is why this reuses the deployment generator
 * rather than the `deploy/testing/postgres-tls` fixture (pinned to `localhost`).
 * Cached: the generator shells out to openssl.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Repo root, derived from this file rather than cwd. */
const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Pinned-TLS file consumed by BOTH kernel-on compose profiles. */
export const KERNEL_TLS_COMPOSE_FILE = 'docker-compose.kernel-tls.yml';

let materials: Record<string, string> | undefined;

export function generateCellDatabaseTlsMaterials(): Record<string, string> {
  if (materials) return materials;
  const directory = mkdtempSync(join(tmpdir(), 'commander-cell-db-tls-'));
  execFileSync(
    'sh',
    [join(REPO_ROOT, 'deploy/docker/kernel-tls/generate-certificates.sh'), directory, 'postgres'],
    { stdio: 'pipe' },
  );
  const certificate = new X509Certificate(readFileSync(join(directory, 'server.crt')));
  materials = {
    COMMANDER_DATABASE_TLS_HOST_DIR: directory,
    COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: createHash('sha256')
      .update(certificate.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex'),
  };
  return materials;
}
