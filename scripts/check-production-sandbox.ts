import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionSandboxSource } from '../packages/core/src/sandbox/productionPolicy.ts';

try {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assertProductionSandboxSource(repositoryRoot);
  console.log('[production-sandbox] static policy check passed');
} catch (error) {
  console.error(`[production-sandbox] static policy check failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
