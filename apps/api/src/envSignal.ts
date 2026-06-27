/**
 * apps/api — Production-environment signal detection.
 *
 * Centralizes the rules for what counts as a "production" deploy so that
 * downstream call sites (authMiddleware's AUTH_DISABLED warn, hub admin
 * reset helpers, future SRE escape-hatch invocations) cannot drift on
 * what production means when a deployment only sets `COMMANDER_ENV`
 * variants or only `NODE_ENV` is unavailable on the runtime platform.
 *
 * Three signals are recognized today:
 *
 *   1. `NODE_ENV === 'production'` — the canonical Express/Node signal.
 *      Set by `NODE_ENV` convention or by platforms that auto-inject it.
 *
 *   2. `COMMANDER_ENV === 'production'` — Commander apps opt-in secondary.
 *      Use this when your runtime platform doesn't forward `NODE_ENV`
 *      reliably (some reverse-proxy / containerized CI configurations).
 *
 *   3. `COMMANDER_ENV === 'prod'` — short-form alias for case 2, retained
 *      only because one of Commander's deploy platforms historically emits
 *      the abbreviated form into the env when promoting from staging to
 *      production. NOT a public contract — operators should set
 *      `COMMANDER_ENV=production` to remain forward-compatible.
 *
 * INVARIANT for callers: `describeProdSignal()` must only be invoked when
 * `isProductionEnv()` would have returned true for the same env state at
 * the same moment. The function will throw if invoked outside a production
 * context — this is intentional: do not reason about which env var
 * "triggered" production when no production signal is set.
 *
 * Any new helper that operates on the production signal should live here,
 * not in a per-feature module. If a future fourth signal is added (e.g.
 * staging gate), add it here AND update the test plan for both consumers
 * in lockstep.
 *
 * Location: chosen as apps/api/src/envSignal.ts because apps/api is the
 * only consumer today. If a future Commander sibling (apps/web, etc.)
 * needs the same rules, hoist to packages/core/src/envSignal.ts instead of
 * copy-pasting across consumers.
 */

/**
 * Returns true if the current process is running in a production context.
 * Use this for any production-only side-effects (warn, gate, log).
 */
export function isProductionEnv(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_ENV === 'production' ||
    process.env.COMMANDER_ENV === 'prod'
  );
}

/**
 * Returns a human-readable string naming which env var indicated
 * "production" at the time of the call (e.g. `'NODE_ENV=production'`).
 * Used inside log/warn message bodies so operators can disambiguate the
 * trigger source during triage.
 *
 * INVARIANT: callers must only invoke this when `isProductionEnv()` would
 * return true for the same env state at the same moment. To make misuse
 * loud, this function throws when called outside a production context —
 * log/warn callers should gate behind `isProductionEnv()` so the throw
 * never fires in practice.
 */
export function describeProdSignal(): string {
  if (!isProductionEnv()) {
    throw new Error(
      'envSignal.describeProdSignal() invoked outside a production context. ' +
        'Gate the call behind isProductionEnv() so the function only runs ' +
        'when NODE_ENV=production, COMMANDER_ENV=production, or COMMANDER_ENV=prod is set.',
    );
  }
  if (process.env.NODE_ENV === 'production') return 'NODE_ENV=production';
  if (process.env.COMMANDER_ENV === 'production') return 'COMMANDER_ENV=production';
  return 'COMMANDER_ENV=prod';
}
