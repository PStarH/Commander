#!/usr/bin/env tsx
import {
  createTask1KubectlPorts,
  loadTask1PrerequisiteCommandContext,
  runTask1AdmissionAdministrator,
} from './task1-helm-prerequisite-command.js';

async function main(): Promise<void> {
  const context = await loadTask1PrerequisiteCommandContext(process.argv.slice(2), process.cwd());
  await runTask1AdmissionAdministrator(context, createTask1KubectlPorts());
  process.stdout.write(`${JSON.stringify({ stage: context.request.stage, status: 'ready' })}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'TENANT_POLICY_ADMIN_FAILED'}\n`,
  );
  process.exitCode = 1;
});
