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
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
];

/**
 * Private IP ranges for SSRF defense.
 */
const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // link-local
  /^0\.0\.0\.0$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // loopback range
];

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
   * Check if a URL is allowed under the current policy.
   */
  check(url: string): { allowed: boolean; reason?: string; domain: string } {
    return this.checkWithClassification(url, undefined);
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

    const domain = parsed.hostname;

    // Check blocklist first (always takes precedence)
    for (const blocked of this.config.blocklist) {
      if (domain === blocked || domain.endsWith('.' + blocked)) {
        return { allowed: false, reason: `domain in blocklist: ${domain}`, domain };
      }
    }

    // SSRF defense: block private IPs (unless explicitly allowlisted)
    if (this.config.blockPrivateIPs && !this.config.allowlist.includes(domain)) {
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(domain)) {
          return { allowed: false, reason: `private IP blocked (SSRF defense): ${domain}`, domain };
        }
      }
    }

    // Check global allowlist
    let globallyAllowed = false;
    for (const allowed of this.config.allowlist) {
      if (domain === allowed || domain.endsWith('.' + allowed)) {
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
        if (domain === allowed || domain.endsWith('.' + allowed)) {
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

    globalThis.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method =
        init?.method ??
        (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');

      const result = self.check(url);

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
