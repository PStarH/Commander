/**
 * AUDIT-E2: fail-closed resolution of Express `trust proxy`.
 *
 * Baseline behaviour defaulted to '1' — trusting one proxy hop even when the
 * API is directly exposed. In that topology a client fully controls
 * `X-Forwarded-For`, so `req.ip` (which feeds the auth-failure lockout and the
 * per-IP rate-limit bucket) was spoofable: brute-force lockout bypass by IP
 * rotation, and targeted lockout of arbitrary victim IPs.
 *
 * Now: no proxy is trusted unless an operator explicitly configures it, and a
 * malformed value refuses to boot in production rather than silently meaning
 * something else. Error messages carry no secrets.
 */

export type TrustProxySetting = boolean | number;

export class TrustProxyConfigError extends Error {}

/**
 * Maps TRUST_PROXY_HOPS to an Express `trust proxy` value.
 *
 *  - unset            → false (trust nothing; direct exposure is the safe default)
 *  - '0'              → false (explicit no-trust)
 *  - '1'..'N'         → N (trust exactly N proxy hops in front of the server)
 *
 * Anything else (negative, fractional, non-numeric, empty) throws — the caller
 * must abort startup in production instead of guessing.
 */
export function resolveTrustProxySetting(env: NodeJS.ProcessEnv): TrustProxySetting {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined) return false;
  if (raw === '0') return false;
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  throw new TrustProxyConfigError(
    'TRUST_PROXY_HOPS must be a non-negative integer (proxy hop count) or unset. ' +
      `Refusing to start with the provided value (length ${raw.length}).`,
  );
}
