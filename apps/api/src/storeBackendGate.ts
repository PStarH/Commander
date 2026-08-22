/**
 * AUDIT-K2 (api leg): the API used to fall back to an in-memory store with a
 * warning when neither API_STORE_BACKEND nor DATABASE_URL was configured.
 * In production that is a silent loss of durable state on every restart —
 * the same class of single-signal fail-open as AUDIT-K1.
 *
 * Production now refuses to boot unless a durable backend is configured.
 * COMMANDER_ALLOW_MEMORY_STORE=1 is the explicit, documented escape hatch for
 * intentionally ephemeral single-node deployments.
 */

import { isProductionEnv } from './envSignal';

export class StoreBackendConfigError extends Error {}

export function assertDurableStoreConfigured(env: NodeJS.ProcessEnv): void {
  if (!isProductionEnv(env)) return;
  const hasBackend = Boolean(
    (env.API_STORE_BACKEND ?? '').trim() || (env.DATABASE_URL ?? '').trim(),
  );
  if (hasBackend) return;
  const optOut = (env.COMMANDER_ALLOW_MEMORY_STORE ?? '').toLowerCase();
  if (['1', 'true', 'yes'].includes(optOut)) return;
  throw new StoreBackendConfigError(
    'Neither API_STORE_BACKEND nor DATABASE_URL is set in production. Refusing to ' +
      'start with an ephemeral in-memory store. Configure a durable backend, or set ' +
      'COMMANDER_ALLOW_MEMORY_STORE=1 to explicitly accept an ephemeral single-node store.',
  );
}
