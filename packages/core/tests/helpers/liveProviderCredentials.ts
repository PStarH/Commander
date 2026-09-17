/**
 * Credential resolution for opt-in live-provider test scripts.
 *
 * The scripts under `tests/` that construct a real `MiMoProvider` talk to a
 * paid external provider. The API key must therefore come from the environment:
 * committing a key into the repository both leaks the secret and makes the
 * script look runnable when it is not. These helpers fail fast with an explicit
 * message instead of silently reusing a stale embedded credential.
 *
 * These modules are intentionally *not* `*.test.ts` — they are manual,
 * network-touching scripts, not part of the unit-test suite.
 */

/** Primary env var for the live MIMO API key. */
export const MIMO_API_KEY_ENV = 'COMMANDER_MIMO_API_KEY';
/** Accepted legacy/alternate env var for the live MIMO API key. */
export const MIMO_API_KEY_ENV_FALLBACK = 'MIMO_API_KEY';
/** Optional env var overriding the MIMO base URL. */
export const MIMO_BASE_URL_ENV = 'COMMANDER_MIMO_BASE_URL';

/**
 * Read the live MIMO API key from the environment.
 *
 * @throws {Error} when neither `COMMANDER_MIMO_API_KEY` nor `MIMO_API_KEY` is set.
 */
export function requireMimoApiKey(): string {
  const key = process.env[MIMO_API_KEY_ENV] ?? process.env[MIMO_API_KEY_ENV_FALLBACK];
  if (!key || key.trim().length === 0) {
    throw new Error(
      `Missing live provider credential: set ${MIMO_API_KEY_ENV} ` +
        `(or ${MIMO_API_KEY_ENV_FALLBACK}) before running this script.`,
    );
  }
  return key;
}

/**
 * Resolve the MIMO base URL, falling back to the provider's public endpoint.
 */
export function mimoBaseUrl(fallback: string): string {
  return process.env[MIMO_BASE_URL_ENV] ?? fallback;
}
