/**
 * Owner/migration helpers for worker allowlist + claim-secret seeding.
 * Worker LOGIN cannot INSERT into these tables.
 */
import { generateWorkerClaimSecret, hashWorkerClaimSecret } from './claimSecret.js';

export interface ClaimSecretSeedClient {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Seed cell tenants into commander_worker_allowed_tenants (owner/migration only). */
export async function seedWorkerAllowedTenants(
  client: ClaimSecretSeedClient,
  tenantIds: readonly string[],
): Promise<void> {
  for (const tenantId of tenantIds) {
    const trimmed = tenantId.trim();
    if (!trimmed || trimmed === '*') {
      throw new Error(`WORKER_ALLOWED_TENANT_INVALID: refusing to seed '${tenantId}'`);
    }
    await client.query(
      `INSERT INTO commander_worker_allowed_tenants (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [trimmed],
    );
  }
}

/**
 * Owner/test helper: insert claim-secret hash for a worker row.
 * Used by integration / rls-live-fire / authority proof when workers are
 * inserted via SQL instead of PostgresWorkerRegistry.register.
 */
export async function seedWorkerClaimSecret(
  client: ClaimSecretSeedClient,
  workerId: string,
  generation: number,
  plaintext?: string,
): Promise<string> {
  const secret = plaintext ?? generateWorkerClaimSecret();
  const hash = hashWorkerClaimSecret(secret);
  await client.query(
    `INSERT INTO commander_worker_claim_secrets (worker_id, generation, secret_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (worker_id) DO UPDATE
       SET generation = EXCLUDED.generation,
           secret_hash = EXCLUDED.secret_hash,
           updated_at = now()`,
    [workerId, generation, hash],
  );
  return secret;
}
