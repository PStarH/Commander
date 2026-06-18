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
export declare function isUrlSafe(url: string): UrlSafetyResult;
//# sourceMappingURL=urlSafety.d.ts.map