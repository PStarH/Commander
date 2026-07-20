/**
 * Resolve `pg` from @commander/kernel for root scripts under pnpm
 * (workspace deps are not hoisted to the monorepo root by default).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromKernel = createRequire(
  fileURLToPath(new URL('../packages/kernel/package.json', import.meta.url)),
);

export const { Pool } = requireFromKernel('pg') as typeof import('pg');
