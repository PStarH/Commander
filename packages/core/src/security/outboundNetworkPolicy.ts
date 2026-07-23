/**
 * OutboundNetworkPolicy — egress firewall for all HTTP(S) requests.
 *
 * Monkey-patches globalThis.fetch to enforce domain allowlisting.
 * Even if an attacker exfiltrates data (e.g. PII scrubber misses something),
 * the data cannot leave the system because non-allowlisted domains are blocked.
 *
 * This is the "数据外泄" vector defense. Combined with local-first architecture
 * (user data stays on-device), this ensures that even a fully compromised agent
 * cannot send data to attacker-controlled servers.
 *
 * Integration: call installOutboundNetworkPolicy() once at process startup
 * (in serviceInitializer or earlier). The original fetch is preserved and
 * restored by uninstallOutboundNetworkPolicy().
 */

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { getGlobalLogger } from '../logging';

const MAX_PINNED_RESPONSE_BYTES = 5 * 1024 * 1024;

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type DataClassification = 'public' | 'internal' | 'pii' | 'phi' | 'confidential';

export interface OutboundNetworkPolicyConfig {
  /** Master switch. When false, all requests are allowed (passthrough). */
  enabled: boolean;
  /** Allowed domains for outbound requests (exact match or suffix match). */
  allowlist: string[];
  /** Domains always blocked (takes precedence over allowlist). */
  blocklist: string[];
  /** Whether to log all outbound requests for audit. */
  auditLog: boolean;
  /** Whether to block private/internal IPs (SSRF defense). Default: true. */
  blockPrivateIPs: boolean;
  /** Per-classification destination allowlists. If a classification is present,
   * requests carrying that classification must target domains in the corresponding
   * list. The global allowlist is still checked first. */
  classificationAllowlist?: Partial<Record<DataClassification, string[]>>;
}

export interface OutboundCheckResult {
  allowed: boolean;
  reason?: string;
  domain: string;
  /** Resolved public addresses used for IP pinning (DNS rebinding defense). */
  addresses?: string[];
}

export interface OutboundRequestLog {
  url: string;
  method: string;
  domain: string;
  allowed: boolean;
  reason?: string;
  timestamp: string;
}

/**
 * Build a URL that connects to a pinned IP while preserving the original Host
 * via headers (caller must set Host). Prevents DNS rebinding between check and connect.
 */
export function pinUrlToAddress(rawUrl: string, address: string): { href: string; host: string } {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname;
  const pinned = new URL(rawUrl);
  pinned.hostname = address.includes(':') ? `[${address}]` : address;
  return { href: pinned.href, host };
}

/**
 * Fetch via http/https with connection pinned to `address` and Host/SNI set to
 * the original hostname. Node's fetch forbids setting Host, so we use the
 * low-level clients for the pin path.
 */
export function pinnedHttpFetch(
  rawUrl: string,
  address: string,
  init?: RequestInit,
): Promise<Response> {
  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Host: parsed.host };
  const configuredAgent = (init as (RequestInit & { agent?: unknown }) | undefined)?.agent;
  let transportAgent: http.Agent | https.Agent | undefined;
  if (configuredAgent !== undefined) {
    const validAgent = isHttps
      ? configuredAgent instanceof https.Agent
      : configuredAgent instanceof http.Agent && !(configuredAgent instanceof https.Agent);
    if (!validAgent) {
      throw new TypeError(
        `Pinned HTTP request requires a ${isHttps ? 'HTTPS' : 'HTTP'} agent for ${parsed.protocol}`,
      );
    }
    transportAgent = configuredAgent as http.Agent | https.Agent;
  }

  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((value, key) => {
      if (key.toLowerCase() === 'host') return;
      headers[key] = value;
    });
  }

  const body =
    typeof init?.body === 'string' ||
    init?.body instanceof Buffer ||
    init?.body instanceof Uint8Array
      ? init.body
      : undefined;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abortError = (): Error => {
      const error = new Error('Pinned HTTP request aborted');
      error.name = 'AbortError';
      return error;
    };
    const req = client.request(
      {
        hostname: address,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        servername: isHttps ? parsed.hostname : undefined,
        agent: transportAgent,
      },
      (res) => {
        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PINNED_RESPONSE_BYTES) {
          res.destroy();
          finishReject(
            new Error(`Pinned HTTP response body exceeds ${MAX_PINNED_RESPONSE_BYTES} bytes`),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          if (bytes > MAX_PINNED_RESPONSE_BYTES) {
            res.destroy();
            finishReject(
              new Error(`Pinned HTTP response body exceeds ${MAX_PINNED_RESPONSE_BYTES} bytes`),
            );
            return;
          }
          chunks.push(value);
        });
        res.on('end', () => {
          if (settled) return;
          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item);
            } else {
              responseHeaders.set(k, v);
            }
          }
          settled = true;
          resolve(
            new Response(Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
        res.on('error', finishReject);
      },
    );
    const signal = init?.signal;
    const onAbort = (): void => {
      req.destroy(abortError());
    };
    if (signal?.aborted) {
      req.destroy(abortError());
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', finishReject);
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Default allowlist — common LLM API and infrastructure domains
// (loopback / private hosts intentionally omitted — SSRF defense)
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWLIST: readonly string[] = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'api.cohere.ai',
  'api.together.xyz',
  'api.groq.com',
  'api.mistral.ai',
  'api.x.ai',
  'api.mimo.com',
];

/**
 * Private IP ranges for SSRF defense.
 */
const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // link-local / cloud metadata
  /^0\.0\.0\.0$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // loopback range
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  // Strip IPv6 brackets
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  // Trailing-dot FQDN (localhost. → localhost)
  if (h.endsWith('.')) {
    h = h.slice(0, -1);
  }
  // IPv4-mapped IPv6 → extract IPv4 (dotted or hex form ::ffff:7f00:1)
  if (h.startsWith('::ffff:')) {
    const rest = h.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
      h = rest;
    } else {
      const parts = rest.split(':');
      if (parts.length === 2) {
        const hi = Number.parseInt(parts[0], 16);
        const lo = Number.parseInt(parts[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          h = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        }
      }
    }
  }
  return h;
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets as [number, number, number, number];
}

/** Parse an IPv6 literal into its canonical 128-bit integer representation. */
function parseIpv6Value(hostname: string): bigint | null {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;

  const parseHextets = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const hextets: number[] = [];
    for (const token of tokens) {
      if (token.includes('.')) {
        const octets = parseIpv4Octets(token);
        if (!octets || token !== tokens[tokens.length - 1]) return null;
        hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(token)) {
        hextets.push(Number.parseInt(token, 16));
      } else {
        return null;
      }
    }
    return hextets;
  };

  const left = parseHextets(halves[0] ?? '');
  const right = parseHextets(halves[1] ?? '');
  if (!left || !right) return null;
  const hextets =
    halves.length === 2
      ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
      : left;
  if (hextets.length !== 8) return null;
  return hextets.reduce((value, hextet) => (value << 16n) | BigInt(hextet), 0n);
}

function hasPrefix(value: bigint, prefix: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === prefix;
}

/** Return true for addresses that are not globally routable. */
function isNonGlobalAddress(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  const ipv4 = parseIpv4Octets(h);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const ipv6 = parseIpv6Value(h);
  if (ipv6 === null) return false;
  if (ipv6 === 0n || ipv6 === 1n) return true;
  if (hasPrefix(ipv6, 0xffn, 8)) return true; // multicast ff00::/8
  if (hasPrefix(ipv6, 0x7en, 7)) return true; // ULA fc00::/7
  if (hasPrefix(ipv6, 0x3fan, 10)) return true; // link-local fe80::/10
  if (hasPrefix(ipv6, 0x3f9n, 10)) return true; // deprecated site-local fec0::/10

  // IPv4-mapped and deprecated IPv4-compatible IPv6 addresses inherit the
  // routability of their embedded IPv4 address.
  const embeddedIpv4Prefix = ipv6 >> 32n;
  if (embeddedIpv4Prefix === 0xffffn || embeddedIpv4Prefix === 0n) {
    const embedded = Number(ipv6 & 0xffffffffn);
    const octets: [number, number, number, number] = [
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ];
    return isNonGlobalAddress(octets.join('.'));
  }

  // Currently allocated global-unicast space is 2000::/3. Keep IETF protocol,
  // documentation, and deprecated transition prefixes inside that space out of
  // the outbound trust boundary as well.
  if (!hasPrefix(ipv6, 0x1n, 3)) return true;
  if (hasPrefix(ipv6, 0x100080n, 23)) return true; // 2001::/23 protocol assignments
  if (hasPrefix(ipv6, 0x20010db8n, 32)) return true; // documentation 2001:db8::/32
  if (hasPrefix(ipv6, 0x2002n, 16)) return true; // deprecated 6to4 2002::/16
  if (hasPrefix(ipv6, 0x3fff0n, 20)) return true; // documentation 3fff::/20
  return false;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  return isNonGlobalAddress(h) || PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(h));
}

// ──────────────────────────────────────────────────────────────────────────
// OutboundNetworkPolicy
// ──────────────────────────────────────────────────────────────────────────

export class OutboundNetworkPolicy {
  private config: OutboundNetworkPolicyConfig;
  private originalFetch: typeof globalThis.fetch | null = null;
  private installed = false;
  private readonly auditLogs: OutboundRequestLog[] = [];
  private static readonly MAX_AUDIT_LOGS = 10_000;

  constructor(config: Partial<OutboundNetworkPolicyConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true, // enabled by default — fail-closed (data exfiltration defense)
      allowlist: config.allowlist ?? [...DEFAULT_ALLOWLIST],
      blocklist: config.blocklist ?? [],
      auditLog: config.auditLog ?? true,
      blockPrivateIPs: config.blockPrivateIPs ?? true,
      classificationAllowlist: config.classificationAllowlist,
    };
  }

  /**
   * Check if a URL is allowed under the current policy (sync hostname checks).
   * Private/loopback/metadata hosts are always denied when blockPrivateIPs is on —
   * allowlist cannot bypass SSRF defense.
   */
  check(url: string): { allowed: boolean; reason?: string; domain: string } {
    return this.checkWithClassification(url, undefined);
  }

  /**
   * Async check including DNS resolution of the hostname. Lookup failure → deny.
   * On success, `addresses` contains public IPs suitable for connection pinning.
   */
  async checkAsync(url: string, classification?: DataClassification): Promise<OutboundCheckResult> {
    const sync = this.checkWithClassification(url, classification);
    if (!sync.allowed) return sync;
    return this.resolveAddresses(url, sync.domain);
  }

  /**
   * SSRF-only check (private/loopback/metadata + DNS). Does NOT enforce the
   * domain allowlist — used by webhook delivery to arbitrary customer URLs.
   */
  async checkSsrfAsync(url: string): Promise<OutboundCheckResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'malformed URL', domain: '' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'unsupported protocol', domain: '' };
    }
    const domain = normalizeHostname(parsed.hostname);
    if (this.config.blockPrivateIPs && isPrivateOrBlockedHost(domain)) {
      return { allowed: false, reason: `private IP blocked (SSRF defense): ${domain}`, domain };
    }
    if (!this.config.blockPrivateIPs) {
      return { allowed: true, domain };
    }
    return this.resolveAddresses(url, domain);
  }

  /**
   * Fetch after SSRF check + IP pin, bypassing the domain allowlist.
   * Uses the pre-patch fetch so OutboundNetworkPolicy allowlist does not
   * block legitimate webhook destinations.
   */
  async ssrfCheckedFetch(input: string, init?: RequestInit): Promise<Response> {
    const result = await this.checkSsrfAsync(input);
    if (!result.allowed) {
      const err = new Error(`OUTBOUND_BLOCKED: ${result.reason}`);
      err.name = 'OutboundNetworkPolicyError';
      throw err;
    }
    const address =
      result.addresses?.[0] ??
      (/^\d{1,3}(\.\d{1,3}){3}$/.test(result.domain) || result.domain.includes(':')
        ? result.domain
        : undefined);
    if (address) {
      return pinnedHttpFetch(input, address, init);
    }
    const fetchFn = this.originalFetch ?? globalThis.fetch;
    return fetchFn.call(globalThis, input, init);
  }

  private async resolveAddresses(url: string, domain: string): Promise<OutboundCheckResult> {
    // Literal IPs / blocked hostnames already handled in sync check.
    if (isPrivateOrBlockedHost(domain) || PRIVATE_IP_PATTERNS.some((p) => p.test(domain))) {
      return { allowed: false, reason: `private IP blocked (SSRF defense): ${domain}`, domain };
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) {
      return { allowed: true, domain, addresses: [domain] };
    }
    if (domain.includes(':')) {
      return { allowed: true, domain, addresses: [domain] };
    }

    try {
      const results = await dns.promises.lookup(domain, { all: true });
      const addresses: string[] = [];
      for (const { address } of results) {
        if (isPrivateOrBlockedHost(address)) {
          return {
            allowed: false,
            reason: `DNS resolved to private IP (SSRF defense): ${address}`,
            domain,
          };
        }
        addresses.push(address);
      }
      if (addresses.length === 0) {
        return {
          allowed: false,
          reason: `DNS lookup returned no addresses for: ${domain}`,
          domain,
        };
      }
      return { allowed: true, domain, addresses };
    } catch {
      return { allowed: false, reason: `DNS lookup failed for: ${domain}`, domain };
    }
  }

  /**
   * Check if a URL is allowed under the current policy, with an optional
   * data classification. When classification is provided, the URL must
   * pass BOTH the global allowlist AND the per-classification allowlist
   * (if one is configured for that classification).
   */
  checkWithClassification(url: string, classification?: DataClassification): OutboundCheckResult {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'malformed URL', domain: '' };
    }

    const domain = normalizeHostname(parsed.hostname);

    // Check blocklist first (always takes precedence)
    for (const blocked of this.config.blocklist) {
      const b = blocked.toLowerCase();
      if (domain === b || domain.endsWith('.' + b)) {
        return { allowed: false, reason: `domain in blocklist: ${domain}`, domain };
      }
    }

    // SSRF defense: always block private/loopback/metadata — allowlist cannot bypass.
    if (this.config.blockPrivateIPs && isPrivateOrBlockedHost(domain)) {
      return { allowed: false, reason: `private IP blocked (SSRF defense): ${domain}`, domain };
    }

    // Check global allowlist (public domains only)
    let globallyAllowed = false;
    for (const allowed of this.config.allowlist) {
      const a = allowed.toLowerCase();
      if (domain === a || domain.endsWith('.' + a)) {
        globallyAllowed = true;
        break;
      }
    }

    if (!globallyAllowed) {
      return { allowed: false, reason: `domain not in allowlist: ${domain}`, domain };
    }

    // If classification is provided, check per-classification allowlist
    if (classification && this.config.classificationAllowlist?.[classification]) {
      const classAllowlist = this.config.classificationAllowlist[classification]!;
      let classAllowed = false;
      for (const allowed of classAllowlist) {
        const a = allowed.toLowerCase();
        if (domain === a || domain.endsWith('.' + a)) {
          classAllowed = true;
          break;
        }
      }
      if (!classAllowed) {
        return {
          allowed: false,
          reason: `domain '${domain}' not in classification '${classification}' allowlist`,
          domain,
        };
      }
    }

    return { allowed: true, domain };
  }

  /**
   * Install the fetch interceptor. Call once at process startup.
   */
  install(): void {
    if (this.installed) return;

    if (!this.config.enabled) {
      getGlobalLogger().info('OutboundNetworkPolicy', 'disabled — passthrough mode');
      return;
    }

    this.originalFetch = globalThis.fetch;
    const self = this;

    globalThis.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method =
        init?.method ??
        (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');

      const result = await self.checkAsync(url);

      // Audit log
      if (self.config.auditLog) {
        self.logRequest({
          url,
          method,
          domain: result.domain,
          allowed: result.allowed,
          reason: result.reason,
          timestamp: new Date().toISOString(),
        });
      }

      if (!result.allowed) {
        const err = new Error(`OUTBOUND_BLOCKED: ${result.reason}`);
        err.name = 'OutboundNetworkPolicyError';
        return Promise.reject(err);
      }

      // Pin to a resolved public IP (Host/SNI preserved) to defeat DNS rebinding TOCTOU.
      const address = result.addresses?.[0];
      if (address && (url.startsWith('http://') || url.startsWith('https://'))) {
        return pinnedHttpFetch(url, address, init);
      }

      // Pass through to original fetch
      return self.originalFetch!.call(globalThis, input, init);
    } as typeof globalThis.fetch;

    // Mark the patched function so we can identify it
    (globalThis.fetch as unknown as { __outboundPolicy?: boolean }).__outboundPolicy = true;

    this.installed = true;
    getGlobalLogger().info('OutboundNetworkPolicy', 'installed', {
      allowlistCount: this.config.allowlist.length,
      blocklistCount: this.config.blocklist.length,
    });
  }

  /**
   * Uninstall the fetch interceptor and restore the original.
   */
  uninstall(): void {
    if (!this.installed || !this.originalFetch) return;
    globalThis.fetch = this.originalFetch;
    this.originalFetch = null;
    this.installed = false;
  }

  /**
   * Update the policy configuration at runtime.
   */
  updateConfig(updates: Partial<OutboundNetworkPolicyConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Add a domain to the allowlist at runtime.
   */
  allowDomain(domain: string): void {
    if (!this.config.allowlist.includes(domain)) {
      this.config.allowlist.push(domain);
    }
  }

  /**
   * Block a domain at runtime.
   */
  blockDomain(domain: string): void {
    if (!this.config.blocklist.includes(domain)) {
      this.config.blocklist.push(domain);
    }
  }

  /**
   * Get recent audit logs.
   */
  getAuditLogs(limit = 100): OutboundRequestLog[] {
    return this.auditLogs.slice(-limit);
  }

  /**
   * Get current config (for inspection).
   */
  getConfig(): Readonly<OutboundNetworkPolicyConfig> {
    return {
      ...this.config,
      allowlist: [...this.config.allowlist],
      blocklist: [...this.config.blocklist],
    };
  }

  isInstalled(): boolean {
    return this.installed;
  }

  private logRequest(entry: OutboundRequestLog): void {
    this.auditLogs.push(entry);
    if (this.auditLogs.length > OutboundNetworkPolicy.MAX_AUDIT_LOGS) {
      this.auditLogs.shift();
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let policyInstance: OutboundNetworkPolicy | null = null;

export function getOutboundNetworkPolicy(
  config?: Partial<OutboundNetworkPolicyConfig>,
): OutboundNetworkPolicy {
  if (!policyInstance || config) {
    policyInstance = new OutboundNetworkPolicy(config);
  }
  return policyInstance;
}

export function installOutboundNetworkPolicy(
  config?: Partial<OutboundNetworkPolicyConfig>,
): OutboundNetworkPolicy {
  const policy = getOutboundNetworkPolicy(config);
  policy.install();
  return policy;
}

export function uninstallOutboundNetworkPolicy(): void {
  policyInstance?.uninstall();
}

export function resetOutboundNetworkPolicy(): void {
  policyInstance?.uninstall();
  policyInstance = null;
}
