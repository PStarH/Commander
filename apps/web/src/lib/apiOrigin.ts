/**
 * API origin resolution — where the bundle sends its calls, and which requests
 * may carry the session bearer token.
 *
 * The production image is built with `VITE_API_BASE_URL=""` (apps/web/Dockerfile)
 * and served by nginx, which proxies every API prefix on the SAME origin under
 * `connect-src 'self'` (apps/web/nginx.conf). An empty value therefore has to
 * mean "this page's own origin", not "fall back to the development default":
 *
 *   * `|| 'http://localhost:4000'` sent every deployed browser to the end user's
 *     own machine (and off `connect-src 'self'`, so the CSP blocked it), and
 *   * a bare relative base (`''`) is not usable either — `new URL(API_BASE)`
 *     and `new URL('/api/x')` both throw, which would break the auth-origin
 *     comparison in `isCommanderApiRequest` and every `new URL(\`${API_BASE}/…\`)`
 *     query builder in src/api.ts.
 *
 * Both decisions live here as pure functions over explicit parameters so they
 * can be exercised without a browser (scripts/web-api-origin.test.ts).
 */

/** The development API server (`vite dev` proxies to it — apps/web/vite.config.ts). */
export const DEV_API_BASE = 'http://localhost:4000';

/** The subset of `window.location` these decisions depend on. */
export interface BrowserLocationLike {
  /** `location.origin` — the page's own origin. */
  origin?: string | null;
  /** `location.href` — the base relative request paths resolve against. */
  href?: string | null;
}

/**
 * `location.origin` is the string `"null"` for an opaque origin (a `file://`
 * page, a sandboxed iframe) and is simply absent outside a browser. Neither can
 * be used as a URL base, so both are reported as "no browser origin".
 */
function usableBrowserOrigin(browser: BrowserLocationLike | undefined): string | undefined {
  const origin = browser?.origin?.trim();
  return origin && origin !== 'null' ? origin : undefined;
}

/**
 * Resolve the base URL that every API call is prefixed with.
 *
 * - `undefined` — the variable was never defined for this build (`vite dev`,
 *   unit tests, a plain `import` under Node): keep the development default.
 * - `''` (or blank) — the variable was deliberately set empty, which is exactly
 *   how the production image is built: serve same-origin, i.e. use the page's
 *   own origin. Falls back to the development default only when there is no
 *   usable browser origin at all, so no invented production origin is baked in.
 * - anything else — an explicit API origin (absolute), used verbatim.
 */
export function resolveApiBase(
  configured: string | undefined,
  browser: BrowserLocationLike | undefined,
  devFallback: string = DEV_API_BASE,
): string {
  if (configured === undefined) return devFallback;
  const value = configured.trim();
  if (value.length > 0) return value;
  return usableBrowserOrigin(browser) ?? devFallback;
}

/**
 * True when `requestUrl` targets the page's own origin or the configured API
 * origin. Relative paths resolve against the page URL, so they are same-origin
 * by construction.
 *
 * Unparseable input returns false: a destination that cannot be resolved must
 * never receive the session bearer token.
 */
export function apiRequestTargetsOrigin(
  apiBase: string,
  requestUrl: string | URL,
  browser: BrowserLocationLike | undefined,
): boolean {
  try {
    const selfOrigin = usableBrowserOrigin(browser);
    const base = browser?.href?.trim() || selfOrigin;
    const target = typeof requestUrl === 'string' ? new URL(requestUrl, base) : requestUrl;
    if (selfOrigin && target.origin === selfOrigin) return true;
    return target.origin === new URL(apiBase, base).origin;
  } catch {
    return false;
  }
}
