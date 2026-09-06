/**
 * AUDIT-K1: production detection for kernel fail-closed gates.
 *
 * Baseline gates (postgres.ts RLS downgrade refusal, repositoryFactory sqlite
 * refusal) keyed solely on `NODE_ENV === 'production'`. A deployment that
 * loses that single variable — or uses `NODE_ENV=prod` — silently degraded
 * every "production refuses" guarantee into dev behaviour (RLS bypass with one
 * console.warn, ephemeral signing keys, sqlite kernel). Centralise a
 * multi-signal check so all gates agree.
 */

export interface ProductionSignalEnv {
  NODE_ENV?: string;
  COMMANDER_ENV?: string;
  COMMANDER_PROFILE?: string;
  COMMANDER_CELL_TIER?: string;
}

/**
 * True when any recognised signal marks the process as production/enterprise.
 * Signals are additive — new signals must only ever widen fail-closed
 * behaviour, never narrow it.
 */
export function isProductionEnvironment(env: ProductionSignalEnv): boolean {
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_ENV === 'production' ||
    env.COMMANDER_PROFILE === 'enterprise' ||
    env.COMMANDER_CELL_TIER === 'enterprise'
  );
}

/**
 * AUDIT-K1 gate: whether the missing-commander_app path must refuse to serve.
 * `COMMANDER_ALLOW_RLS_BYPASS` remains an explicit, documented escape hatch —
 * but only via its exact opt-in values, and it is logged as a warning.
 */
export function mustRefuseMissingAppRole(
  env: ProductionSignalEnv & {
    COMMANDER_ALLOW_RLS_BYPASS?: string;
  },
): boolean {
  if (!isProductionEnvironment(env)) return false;
  const bypass = (env.COMMANDER_ALLOW_RLS_BYPASS ?? '').toLowerCase();
  return !['1', 'true', 'yes'].includes(bypass);
}
