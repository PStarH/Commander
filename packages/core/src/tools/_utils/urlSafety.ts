/**
 * URL Safety — Single source of truth for SSRF / private network blocking.
 *
 * Both webSearchTool and browserTool previously had duplicated copies of this
 * check. Two copies = two places to forget when fixing a bug. Centralize it.
 *
 * Block list:
 *   - Loopback / unspecified: localhost, 127.0.0.0/8, ::1, 0.0.0.0/8
 *   - Link-local: 169.254.0.0/16 (AWS/GCP/Azure metadata)
 *   - Private IPv4: 10/8, 172.16/12, 192.168/16
 *   - CGNAT: 100.64.0.0/10
 *   - IPv6 link-local fe80::/10, ULA fc00::/7, IPv4-mapped ::ffff:x.x.x.x
 *   - Common internal service ports: 6379, 27017, 5432, 9200, 11211, 8500, 8300, 8501
 *
 * Node's URL parser already expands decimal/hex/octal IPv4 literals
 * (e.g. 2130706433 → 127.0.0.1), so range checks on the normalized host cover
 * those encodings.
 *
 * Known residual gap:
 *   - DNS rebinding: a hostname may resolve to a public IP at check time
 *     and a private IP at fetch time. Defending against this requires
 *     resolving once and pinning the IP at the HTTP layer (see outboundNetworkPolicy).
 */

import { reportSilentFailure } from '../../silentFailureReporter';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata
  'metadata',
]);

const BLOCKED_PORTS: number[] = [
  6379, // Redis
  27017, // MongoDB
  5432, // PostgreSQL
  9200, // Elasticsearch
  11211, // Memcached
  8500, // Consul
  8300, // Consul RPC
  8501, // Consul UI
];

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
}

/** Parse dotted-decimal IPv4; return null if not a plain a.b.c.d form. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateOrBlockedIpv4(parts: [number, number, number, number]): string | null {
  const [a, b] = parts;
  // 0.0.0.0/8 — "this" network / unspecified
  if (a === 0) return 'unspecified IPv4 (0.0.0.0/8)';
  // 127.0.0.0/8 — full loopback range (not just 127.0.0.1)
  if (a === 127) return 'loopback IPv4 (127.0.0.0/8)';
  // 10.0.0.0/8
  if (a === 10) return 'private IPv4 (10.0.0.0/8)';
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return 'private IPv4 (172.16.0.0/12)';
  // 192.168.0.0/16
  if (a === 192 && b === 168) return 'private IPv4 (192.168.0.0/16)';
  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 169 && b === 254) return 'link-local IPv4 (169.254.0.0/16)';
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT IPv4 (100.64.0.0/10)';
  // 192.0.0.0/24 IETF protocol assignments (includes some special-use)
  if (a === 192 && b === 0 && parts[2] === 0) return 'special-use IPv4 (192.0.0.0/24)';
  return null;
}

/**
 * Extract IPv4 from IPv4-mapped IPv6 forms:
 *   ::ffff:7f00:1  /  ::ffff:127.0.0.1  /  0:0:0:0:0:ffff:…
 * Returns dotted parts or null.
 */
function ipv4FromMappedIpv6(host: string): [number, number, number, number] | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  // ::ffff:a.b.c.d (URL parser may already rewrite dotted form to hex)
  const dotted = h.match(/(?:^|:)(?:0:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return parseIpv4(dotted[1]!);

  // ::ffff:XXXX:YYYY (two 16-bit hex hextets)
  const hex = h.match(/(?:^|:)(?:0:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function isBlockedIpv6Literal(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'IPv6 loopback';
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return 'IPv6 unspecified';
  // link-local fe80::/10
  if (h.startsWith('fe80:') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return 'IPv6 link-local (fe80::/10)';
  }
  // ULA fc00::/7 → fc00::/8 and fd00::/8
  if (h.startsWith('fc') || h.startsWith('fd')) {
    return 'IPv6 ULA (fc00::/7)';
  }
  const mapped = ipv4FromMappedIpv6(h);
  if (mapped) {
    const why = isPrivateOrBlockedIpv4(mapped);
    if (why) return `IPv4-mapped IPv6 → ${why}`;
  }
  return null;
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
  } catch (err) {
    reportSilentFailure(err, 'urlSafety:68');
    return { safe: false, reason: 'unparseable URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }

  // Normalize hostname: strip brackets from IPv6 addresses
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    return { safe: false, reason: `blocked host: ${host}` };
  }

  // Plain IPv4 (including forms Node already expanded from decimal/hex/octal)
  const v4 = parseIpv4(host);
  if (v4) {
    const why = isPrivateOrBlockedIpv4(v4);
    if (why) return { safe: false, reason: why };
  } else {
    // IPv6 / mapped forms
    const v6why = isBlockedIpv6Literal(host);
    if (v6why) return { safe: false, reason: v6why };
  }

  // Port-based block (only when port is explicit)
  const port = parsed.port ? parseInt(parsed.port, 10) : null;
  if (port !== null && BLOCKED_PORTS.includes(port)) {
    return { safe: false, reason: `blocked port: ${port}` };
  }

  return { safe: true };
}
