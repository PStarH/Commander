import { Pool } from 'pg';
import { runKernelMigrations } from './migrations.js';
import { seedWorkerAllowedTenants } from './seedWorkerClaimSecret.js';

/** Parse comma-separated tenant list; reject empty and '*'. */
export function parseAllowedTenantsEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== '*');
}

async function main() {
  const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Missing COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runKernelMigrations(pool, { requiredRole: 'owner' });
    // Seed cell tenants so register_worker can admit worker LOGIN registrations.
    // Prefer COMMANDER_WORKER_ALLOWED_TENANTS; fall back to COMMANDER_WORKER_TENANTS.
    const tenants = parseAllowedTenantsEnv(
      process.env.COMMANDER_WORKER_ALLOWED_TENANTS ?? process.env.COMMANDER_WORKER_TENANTS,
    );
    if (tenants.length > 0) {
      await seedWorkerAllowedTenants(pool, tenants);
      console.log(`Seeded commander_worker_allowed_tenants: ${tenants.join(',')}`);
    }
    console.log('Kernel migrations applied successfully');
  } catch (err) {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
