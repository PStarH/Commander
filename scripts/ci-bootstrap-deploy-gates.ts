import { Pool } from 'pg';
import {
  runKernelMigrations,
  runTask1ClosureMigrations,
} from '../packages/kernel/src/migrations.js';

const connectionString = process.env.COMMANDER_OWNER_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('COMMANDER_OWNER_DATABASE_URL_REQUIRED');
}

const pool = new Pool({ connectionString, max: 2 });
async function main(): Promise<void> {
  try {
    // The GitHub service container is isolated and intentionally has no Commander TLS
    // identity. Keep the same owner-only migration functions while using the service's
    // local transport for this bootstrap job.
    const mode = process.argv[2] ?? 'full';
    if (mode === 'closure') {
      await runKernelMigrations(pool, { requiredRole: 'owner' });
      await runTask1ClosureMigrations(pool, 'enforce');
      console.log('CI deploy-gate owner bootstrap and enforced closure applied');
    } else if (mode === 'full') {
      await runKernelMigrations(pool, { requiredRole: 'owner' });
      console.log('CI deploy-gate post-closure migrations applied');
    } else {
      throw new Error('CI_DEPLOY_GATES_BOOTSTRAP_MODE_INVALID');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
