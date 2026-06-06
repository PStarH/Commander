/**
 * URL Safety — Single source of truth for SSRF / private network blocking.
 *
 * Both webSearchTool and browserTool previously had duplicated copies of this
 * check. Two copies = two places to forget when fixing a bug. Centralize it.
 *
 * Block list:
 *   - Loopback / unspecified: localhost, 127.0.0.1, ::1, 0.0.0.0
 *   - Link-local: 169.254.0.0/16 (AWS/GCP/Azure metadata)
 *   - Private IPv4: 10/8, 172.16/12, 192.168/16
 *   - IPv6 link-local: fe80:/10
 *   - Common internal service ports: 6379, 27017, 5432, 9200, 11211, 8500, 8300, 8501
 *
 * Known gaps (call out, do not silently fix):
 *   - DNS rebinding: a hostname may resolve to a public IP at check time
 *     and a private IP at fetch time. Defending against this requires
 *     resolving once and pinning the IP at the HTTP layer. Out of scope
 *     here; flag for the agent runtime's policy layer to enforce.
 *   - IPv6 ULA (fc00::/7) is not blocked. Add if you serve in IPv6 networks.
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '169.254.169.254',        // AWS / OpenStack / Azure instance metadata
  'metadata.google.internal', // GCP metadata
]);

const BLOCKED_IPV4_CIDRS: RegExp[] = [
  /^10\./,                                          // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[01])\./,                  // 172.16.0.0/12
  /^192\.168\./,                                    // 192.168.0.0/16
  /^169\.254\./,                                    // 169.254.0.0/16 (link-local)
];

const BLOCKED_PORTS: number[] = [
  6379,   // Redis
  27017,  // MongoDB
  5432,   // PostgreSQL
  9200,   // Elasticsearch
  11211,  // Memcached
  8500,   // Consul
  8300,   // Consul RPC
  8501,   // Consul UI
];

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check whether a URL is safe to fetch from a server-side agent context.
 *
 * @param url - The URL string to validate.
 * @returns A result object with `safe: boolean` and an optional `reason`.
 *
 * @example
 *   if (!isUrlSafe(target).safe) return 'Blocked';
 */
export function isUrlSafe(url: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'unparseable URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }

  // Normalize hostname: strip brackets from IPv6 addresses
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTS.has(host)) {
    return { safe: false, reason: `blocked host: ${host}` };
  }

  if (BLOCKED_IPV4_CIDRS.some(re => re.test(host))) {
    return { safe: false, reason: `private IPv4 range: ${host}` };
  }

  // IPv6 link-local
  if (host.startsWith('fe80:') || host.startsWith('fe80::')) {
    return { safe: false, reason: `IPv6 link-local: ${host}` };
  }

  // Port-based block (only when port is explicit)
  const port = parsed.port ? parseInt(parsed.port, 10) : null;
  if (port !== null && BLOCKED_PORTS.includes(port)) {
    return { safe: false, reason: `blocked port: ${port}` };
  }

  return { safe: true };
}
