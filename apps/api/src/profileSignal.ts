/**
 * apps/api — Deployment profile signal.
 *
 * WS3 freezes the enterprise API surface to `/v1`. The profile decides whether
 * non-`/v1` product routes are served (standard) or rejected with 410 Gone
 * (enterprise). This centralizes the rule so route-freeze middleware, the
 * x-legacy header injector, and OpenAPI generation all agree on one definition.
 *
 * Resolution order (first match wins):
 *   1. `COMMANDER_PROFILE=enterprise|standard` — explicit operator override.
 *   2. Any production env signal (`NODE_ENV=production`, `COMMANDER_ENV=production|prod`)
 *      → `enterprise`. Reuses envSignal.ts so the definition of "production"
 *      cannot drift between this module and existing call sites.
 *   3. Otherwise `standard`.
 *
 * An explicit `COMMANDER_PROFILE` value always wins, even against a production
 * signal, so operators can force `standard` for a staging box that happens to
 * set NODE_ENV=production, or force `enterprise` on a dev box.
 */

import { isProductionEnv } from './envSignal';

export type CommanderProfile = 'enterprise' | 'standard';

/**
 * Resolve the active deployment profile. Reads env at call time so tests can
 * flip env vars between cases; callers must not cache across requests that may
 * span env changes (in practice env is static after boot).
 */
export function getCommanderProfile(env: NodeJS.ProcessEnv = process.env): CommanderProfile {
  const explicit = (env.COMMANDER_PROFILE ?? '').trim().toLowerCase();
  if (explicit === 'enterprise') return 'enterprise';
  if (explicit === 'standard') return 'standard';
  // Unknown / unset explicit value: fall back to production-signal inference.
  // isProductionEnv() reads the same env at call time.
  return isProductionEnv() ? 'enterprise' : 'standard';
}

/** Boolean form for middleware that only needs the enterprise branch. */
export function isEnterpriseProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return getCommanderProfile(env) === 'enterprise';
}
