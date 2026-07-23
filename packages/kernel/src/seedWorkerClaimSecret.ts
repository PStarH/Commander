/**
 * Owner/migration helpers for worker admission, demo policy, and claim-secret seeding.
 * Worker LOGIN cannot INSERT into these tables.
 */
import { generateWorkerClaimSecret, hashWorkerClaimSecret } from './claimSecret.js';

export interface ClaimSecretSeedClient {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}

const DEMO_TICKET_ACTIONS = ['demo.ticket.create', 'compensate.demo.ticket.create'] as const;

/** Seed the opt-in Cell demo policy from the owner/migration path only. */
export async function seedDemoTicketAllowlist(
  client: ClaimSecretSeedClient,
  tenantIds: readonly string[],
): Promise<void> {
  const tenants = tenantIds.map((tenantId) => tenantId.trim());
  for (const tenantId of tenants) {
    if (!tenantId || tenantId === '*') {
      throw new Error(`WORKER_ALLOWED_TENANT_INVALID: refusing to seed '${tenantId}'`);
    }
  }
  for (const tenantId of tenants) {
    for (const action of DEMO_TICKET_ACTIONS) {
      await client.query(
        `INSERT INTO commander_effect_allowlist (tenant_id, action_pattern, allowed)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, action_pattern) DO NOTHING`,
        [tenantId, action, true],
      );
    }
  }
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
