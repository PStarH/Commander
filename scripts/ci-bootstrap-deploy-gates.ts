import { Pool } from 'pg';
import {
  runKernelMigrations,
  runTask1ClosureMigrations,
} from '../packages/kernel/src/migrations.js';
import { assertProvisionedCiInstance, formatAdmissionFailure } from './ci-database-scope.js';

/**
 * Apply kernel migrations to a CI instance that a provisioner created for this
 * run. Migrations are a mutating, schema-level operation, so this refuses to run
 * unless the provisioned-instance admission conditions hold. It is not part of
 * the ordinary acceptance chain (`test:deploy-gates`) — see package.json.
 */

const connectionString = process.env.COMMANDER_OWNER_DATABASE_URL?.trim();
if (!connectionString) {
  console.error('CI_DEPLOY_GATES_BOOTSTRAP_REFUSED: COMMANDER_OWNER_DATABASE_URL is not set');
  process.exit(1);
}

const admissionFailures = assertProvisionedCiInstance(process.env, connectionString);
if (admissionFailures.length > 0) {
  console.error(formatAdmissionFailure(admissionFailures));
  process.exit(1);
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
