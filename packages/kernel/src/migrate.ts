import { Pool } from 'pg';
import { runKernelMigrations } from './migrations.js';

async function main() {
  const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Missing COMMANDER_KERNEL_DATABASE_URL or DATABASE_URL');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runKernelMigrations(pool, { requiredRole: 'owner' });
    console.log('Kernel migrations applied successfully');
  } catch (err) {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
