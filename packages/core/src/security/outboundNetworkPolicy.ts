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
import { getGlobalLogger } from '../logging';

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

export interface OutboundRequestLog {
  url: string;
  method: string;
  domain: string;
  allowed: boolean;
  reason?: string;
  timestamp: string;
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

function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv6 ULA fc00::/7 and link-local fe80::/10
  if (/^fc[0-9a-f]{2}:/i.test(h) || /^fd[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) {
    return true;
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(h)) return true;
  }
  return false;
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
   */
  async checkAsync(
    url: string,
    classification?: DataClassification,
  ): Promise<{ allowed: boolean; reason?: string; domain: string }> {
    const sync = this.checkWithClassification(url, classification);
    if (!sync.allowed) return sync;
    if (!this.config.blockPrivateIPs) return sync;

    const domain = sync.domain;
    // Literal IPs / blocked hostnames already handled in sync check.
    if (isPrivateOrBlockedHost(domain) || PRIVATE_IP_PATTERNS.some((p) => p.test(domain))) {
      return { allowed: false, reason: `private IP blocked (SSRF defense): ${domain}`, domain };
    }
    // Skip DNS only for IPv4 literals already validated. IPv6 hostnames still
    // need isPrivateOrBlockedHost (done above); do not skip DNS merely because
    // the hostname contains ':' (that would skip hostnames incorrectly).
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) {
      return sync;
    }
    // Literal IPv6 (contains ':') — already checked via isPrivateOrBlockedHost.
    if (domain.includes(':')) {
      return sync;
    }

    try {
      const results = await dns.promises.lookup(domain, { all: true });
      for (const { address } of results) {
        if (isPrivateOrBlockedHost(address)) {
          return {
            allowed: false,
            reason: `DNS resolved to private IP (SSRF defense): ${address}`,
            domain,
          };
        }
      }
    } catch {
      return { allowed: false, reason: `DNS lookup failed for: ${domain}`, domain };
    }

    return sync;
  }

  /**
   * Check if a URL is allowed under the current policy, with an optional
   * data classification. When classification is provided, the URL must
   * pass BOTH the global allowlist AND the per-classification allowlist
   * (if one is configured for that classification).
   */
  checkWithClassification(
    url: string,
    classification?: DataClassification,
  ): { allowed: boolean; reason?: string; domain: string } {
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
