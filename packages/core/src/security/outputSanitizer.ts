/**
 * OutputSanitizer — Data exfiltration prevention at the output boundary.
 *
 * Intercepts agent output before it leaves the system (SSE, HTTP response,
 * tool result to LLM) and redacts sensitive data. This is the last line of
 * defense against accidental credential leakage, PII exposure, and
 * intentional exfiltration via side channels.
 *
 * Design:
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ agentRuntime / SSEStream / httpServer                                │
 * │   │                                                                   │
 * │   ▼                                                                   │
 * │ OutputSanitizer.sanitize(output)                                      │
 * │   ├─ Phase 1: Detect (regex patterns, zero LLM cost)                  │
 * │   ├─ Phase 2: Redact (per-category strategy: mask/hash/remove)        │
 * │   ├─ Phase 3: Audit (tamper-evident log of every redaction)           │
 * │   └─ Phase 4: Return sanitized output + metadata                     │
 * │                                                                       │
 * │ Redaction strategies:                                                 │
 * │   mask    → [REDACTED:api_key]          (default, debuggable)         │
 * │   hash    → [REDACTED:a1b2c3d4]         (idempotent, correlatable)    │
 * │   remove  → ""                           (maximum privacy)            │
 * │   partial → sk-proj-abc...xyz12          (preserves pattern)          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Coverage:
 *   - API keys (OpenAI, Anthropic, Google, GitHub, HuggingFace, etc.)
 *   - Cloud credentials (AWS, GCP, Azure)
 *   - Connection strings (PostgreSQL, MongoDB, Redis, MySQL)
 *   - Private keys (RSA, EC, DSA, OpenSSH)
 *   - JWTs and session tokens
 *   - Internal IP addresses (10.x, 172.16-31.x, 192.168.x)
 *   - PII (email, phone, SSN, credit card)
 *   - Password/secrets in plain text assignments
 *   - Large base64 blobs (potential exfiltration)
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import { getAuditChainLedger } from './auditChainLedger';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { recordSinkFailure } from '../observability/sinkFailureCounter';

// ============================================================================
// Types
// ============================================================================

export type SensitivityCategory =
  | 'api_key'
  | 'cloud_credential'
  | 'connection_string'
  | 'private_key'
  | 'jwt_token'
  | 'internal_ip'
  | 'pii'
  | 'password_secret'
  | 'base64_blob';

export type RedactionStrategy = 'mask' | 'hash' | 'remove' | 'partial';

export interface RedactionRule {
  /** Sensitivity category this rule applies to */
  category: SensitivityCategory;
  /** Regex pattern to detect */
  pattern: RegExp;
  /** How to redact matches */
  strategy: RedactionStrategy;
  /** Human-readable label for audit trail */
  label: string;
}

export interface RedactionRecord {
  /** Which rule matched */
  category: SensitivityCategory;
  /** Which strategy was applied */
  strategy: RedactionStrategy;
  /** The sanitized replacement text (for audit confirmation) */
  replacement: string;
  /** How many instances were redacted */
  count: number;
}

export interface SanitizeResult {
  /** The sanitized output text (safe to transmit) */
  sanitized: string;
  /** Whether any redactions were performed */
  redacted: boolean;
  /** Total number of redacted instances */
  redactionCount: number;
  /** Per-category redaction summary */
  records: RedactionRecord[];
  /** SHA-256 hash of sanitized output (for integrity verification) */
  outputHash: string;
  /** Time taken for sanitization in ms */
  durationMs: number;
}

export interface OutputSanitizerConfig {
  /** Whether sanitization is enabled. Default: true. */
  enabled: boolean;
  /** Maximum output length to process (larger outputs are truncated before scanning). Default: 500KB. */
  maxOutputLength: number;
  /** Strategy overrides per category. Default: 'mask' for all. */
  strategyOverrides: Partial<Record<SensitivityCategory, RedactionStrategy>>;
  /** Categories to skip entirely (e.g., allow internal IPs in dev). */
  skipCategories: SensitivityCategory[];
  /** Enable audit logging for every redaction. Default: true. */
  auditEnabled: boolean;
  /** Enable SHA-256 output hashing. Default: true. */
  hashOutput: boolean;
}

const DEFAULT_CONFIG: OutputSanitizerConfig = {
  enabled: true,
  maxOutputLength: 500_000,
  strategyOverrides: {},
  skipCategories: [],
  auditEnabled: true,
  hashOutput: true,
};

// ============================================================================
// Detection Patterns (extended from PrivacyRouter + GuardianAgent + new)
// ============================================================================

const DETECTION_RULES: RedactionRule[] = [
  // ── API Keys (critical) ────────────────────────────────────────────────
  {
    category: 'api_key',
    pattern: /sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}/g,
    strategy: 'mask',
    label: 'OpenAI/Anthropic API key',
  },
  {
    category: 'api_key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    strategy: 'mask',
    label: 'Google API key',
  },
  {
    category: 'api_key',
    pattern: /gh[pousr]_[A-Za-z0-9]{36}/g,
    strategy: 'mask',
    label: 'GitHub personal access token',
  },
  {
    category: 'api_key',
    pattern: /hf_[A-Za-z0-9]{32,}/g,
    strategy: 'mask',
    label: 'HuggingFace API key',
  },
  {
    category: 'api_key',
    pattern: /xai-[A-Za-z0-9]{32,}/g,
    strategy: 'mask',
    label: 'xAI API key',
  },
  {
    category: 'api_key',
    pattern: /glm-[A-Za-z0-9]{20,}/g,
    strategy: 'mask',
    label: 'GLM API key',
  },
  {
    category: 'api_key',
    pattern: /xox[bpras]-[A-Za-z0-9-]{10,}/g,
    strategy: 'mask',
    label: 'Slack bot token',
  },
  {
    category: 'api_key',
    pattern: /(?:stripe|sk_live|sk_test)_[A-Za-z0-9]{24,}/g,
    strategy: 'mask',
    label: 'Stripe API key',
  },
  {
    category: 'api_key',
    pattern: /(?:SG\.|sendgrid)[A-Za-z0-9._-]{20,}/g,
    strategy: 'mask',
    label: 'SendGrid API key',
  },

  // ── Cloud Credentials (critical) ───────────────────────────────────────
  {
    category: 'cloud_credential',
    pattern: /AKIA[0-9A-Z]{16}/g,
    strategy: 'mask',
    label: 'AWS Access Key ID',
  },
  {
    category: 'cloud_credential',
    pattern: /ASIA[0-9A-Z]{16}/g,
    strategy: 'mask',
    label: 'AWS STS temporary key',
  },
  {
    category: 'cloud_credential',
    pattern: /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*\S+/gi,
    strategy: 'mask',
    label: 'AWS credential config line',
  },
  {
    category: 'cloud_credential',
    pattern: /AZURE_CLIENT_SECRET\s*[:=]\s*\S+/gi,
    strategy: 'mask',
    label: 'Azure client secret',
  },
  {
    category: 'cloud_credential',
    pattern: /AZURE_SUBSCRIPTION_KEY\s*[:=]\s*\S+/gi,
    strategy: 'mask',
    label: 'Azure subscription key',
  },
  {
    category: 'cloud_credential',
    pattern: /service_account.*\.json/gi,
    strategy: 'mask',
    label: 'GCP service account reference',
  },

  // ── Connection Strings (critical) ──────────────────────────────────────
  {
    category: 'connection_string',
    pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|sqlite):\/\/[^\s"'<>]+/gi,
    strategy: 'partial',
    label: 'Database connection URI',
  },
  {
    category: 'connection_string',
    pattern: /DATABASE_URL\s*=\s*['"][^'"]+['"]/gi,
    strategy: 'mask',
    label: 'DATABASE_URL assignment',
  },
  {
    category: 'connection_string',
    pattern: /(?:REDIS_URL|MONGODB_URI|POSTGRES_URL)\s*=\s*['"][^'"]+['"]/gi,
    strategy: 'mask',
    label: 'Named database URL',
  },

  // ── Private Keys (critical) ────────────────────────────────────────────
  {
    category: 'private_key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----\s*[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    strategy: 'remove',
    label: 'Private key block (PEM)',
  },
  {
    category: 'private_key',
    pattern: /ssh-(?:rsa|dss|ed25519|ecdsa)\s+[A-Za-z0-9+/=]{100,}/g,
    strategy: 'partial',
    label: 'SSH public key',
  },
  {
    category: 'private_key',
    pattern: /-----BEGIN\s+CERTIFICATE-----\s*[\s\S]*?-----END\s+CERTIFICATE-----/g,
    strategy: 'mask',
    label: 'X.509 certificate',
  },

  // ── JWT Tokens ─────────────────────────────────────────────────────────
  {
    category: 'jwt_token',
    pattern: /Bearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    strategy: 'mask',
    label: 'Bearer JWT in auth header',
  },
  {
    category: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    strategy: 'partial',
    label: 'JWT token',
  },

  // ── Internal IPs ───────────────────────────────────────────────────────
  {
    category: 'internal_ip',
    pattern: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    strategy: 'mask',
    label: 'Class A private IP (10.x)',
  },
  {
    category: 'internal_ip',
    pattern: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
    strategy: 'mask',
    label: 'Class B private IP (172.16-31.x)',
  },
  {
    category: 'internal_ip',
    pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
    strategy: 'mask',
    label: 'Class C private IP (192.168.x)',
  },
  {
    category: 'internal_ip',
    pattern: /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    strategy: 'mask',
    label: 'Loopback IP (127.x)',
  },

  // ── PII ────────────────────────────────────────────────────────────────
  {
    category: 'pii',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    strategy: 'partial',
    label: 'Email address',
  },
  {
    category: 'pii',
    pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    strategy: 'mask',
    label: 'Phone number (US)',
  },
  {
    category: 'pii',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    strategy: 'mask',
    label: 'SSN (US)',
  },
  {
    category: 'pii',
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    strategy: 'mask',
    label: 'Credit card number',
  },

  // ── Password/Secret assignments ────────────────────────────────────────
  {
    category: 'password_secret',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{2,}['"]/gi,
    strategy: 'mask',
    label: 'Password assignment',
  },
  {
    category: 'password_secret',
    pattern: /(?:secret|SECRET|SECRET_KEY)\s*[:=]\s*['"][A-Za-z0-9_\-+=/]{6,}['"]/g,
    strategy: 'mask',
    label: 'Secret key assignment',
  },
  {
    category: 'password_secret',
    pattern: /(?:token|TOKEN|API_TOKEN)\s*[:=]\s*['"][A-Za-z0-9_.\-]{6,}['"]/g,
    strategy: 'mask',
    label: 'Token assignment',
  },
  {
    category: 'password_secret',
    pattern: /Authorization\s*:\s*(?:Bearer|Basic)?\s*['"]?\s*[A-Za-z0-9+/=]{20,}\s*['"]?/gi,
    strategy: 'mask',
    label: 'Authorization header value',
  },

  // ── Large Base64 Blobs (potential exfiltration) ────────────────────────
  {
    category: 'base64_blob',
    pattern: /[A-Za-z0-9+/]{200,}={0,2}/g,
    strategy: 'remove',
    label: 'Large Base64-encoded payload',
  },
];

// ============================================================================
// OutputSanitizer
// ============================================================================

export class OutputSanitizer {
  private config: OutputSanitizerConfig;
  private effectiveRules: RedactionRule[];

  constructor(config?: Partial<OutputSanitizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.effectiveRules = this.buildEffectiveRules();
  }

  /**
   * Sanitize output text by detecting and redacting sensitive data.
   * This is the main entry point — call it before every output boundary.
   *
   * @param output - The raw output text to sanitize
   * @param context - Optional context for audit trail (agentId, runId, source)
   * @returns SanitizeResult with sanitized text, redaction metadata, and audit hash
   */
  sanitize(
    output: string,
    context?: { agentId?: string; runId?: string; source?: string },
  ): SanitizeResult {
    const startTime = Date.now();

    if (!this.config.enabled || !output || output.length === 0) {
      return {
        sanitized: output,
        redacted: false,
        redactionCount: 0,
        records: [],
        outputHash: this.config.hashOutput ? this.hashString(output) : '',
        durationMs: Date.now() - startTime,
      };
    }

    // Truncate oversized output before scanning (DoS protection)
    const scanOutput =
      output.length > this.config.maxOutputLength
        ? output.slice(0, this.config.maxOutputLength) +
          `\n[... ${output.length - this.config.maxOutputLength} chars truncated before sanitization ...]`
        : output;

    let sanitized = scanOutput;
    const records: RedactionRecord[] = [];
    let totalRedactions = 0;

    for (const rule of this.effectiveRules) {
      // Reset lastIndex for global regex reuse
      rule.pattern.lastIndex = 0;

      const strategy = this.config.strategyOverrides[rule.category] ?? rule.strategy;
      const matches: string[] = [];
      let match: RegExpExecArray | null;

      while ((match = rule.pattern.exec(sanitized)) !== null) {
        matches.push(match[0]);
      }

      if (matches.length === 0) continue;

      // Redact all matches for this rule
      rule.pattern.lastIndex = 0;
      sanitized = sanitized.replace(rule.pattern, (matched) =>
        this.applyRedaction(matched, rule.category, strategy),
      );

      records.push({
        category: rule.category,
        strategy,
        replacement: this.formatRedacted(rule.category, strategy, ''),
        count: matches.length,
      });
      totalRedactions += matches.length;
    }

    const outputHash = this.config.hashOutput ? this.hashString(sanitized) : '';
    const durationMs = Date.now() - startTime;

    if (totalRedactions > 0) {
      try {
        getMetricsCollector().incrementCounter(
          'output_sanitizer_redactions_total',
          'Output sanitizer redaction events',
          totalRedactions,
          [{ name: 'category', value: records[0]?.category ?? 'unknown' }],
        );
      } catch (err) {
        reportSilentFailure(err, 'outputSanitizer:455');
        /* best-effort */
      }
    }

    // Audit every sanitization event
    if (this.config.auditEnabled && totalRedactions > 0) {
      this.auditSanitization(sanitized, records, totalRedactions, context, durationMs);
    }

    return {
      sanitized,
      redacted: totalRedactions > 0,
      redactionCount: totalRedactions,
      records,
      outputHash,
      durationMs,
    };
  }

  /**
   * Quick synchronous check: does this output contain ANY sensitive data?
   * Zero-allocation where possible. For pre-flight use.
   */
  containsSensitiveData(output: string): boolean {
    if (!output) return false;
    for (const rule of this.effectiveRules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(output)) {
        rule.pattern.lastIndex = 0; // Clean up after match
        return true;
      }
      rule.pattern.lastIndex = 0; // Clean up after no match too
    }
    return false;
  }

  /**
   * Get the categories of sensitive data found in the output.
   * Useful for conditional routing decisions.
   */
  categorizeSensitiveData(output: string): SensitivityCategory[] {
    const categories = new Set<SensitivityCategory>();
    for (const rule of this.effectiveRules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(output)) {
        categories.add(rule.category);
      }
      rule.pattern.lastIndex = 0; // Clean up after test
    }
    return [...categories];
  }

  /**
   * Sanitize a batch of tool results, returning sanitized versions.
   * Respects the tool output structure from agentRuntime.
   */
  sanitizeToolResults(
    results: Array<{
      toolCallId: string;
      name: string;
      output: string;
      error?: string;
      durationMs: number;
    }>,
  ): {
    results: Array<{
      toolCallId: string;
      name: string;
      output: string;
      error?: string;
      durationMs: number;
    }>;
    totalRedacted: number;
    categories: SensitivityCategory[];
  } {
    let totalRedacted = 0;
    const allCategories = new Set<SensitivityCategory>();

    const sanitized = results.map((r) => {
      if (r.error) return r;
      const result = this.sanitize(r.output, {
        source: `tool:${r.name}`,
      });
      totalRedacted += result.redactionCount;
      for (const rec of result.records) {
        allCategories.add(rec.category);
      }
      return { ...r, output: result.sanitized };
    });

    return {
      results: sanitized,
      totalRedacted,
      categories: [...allCategories],
    };
  }

  /**
   * Update configuration at runtime.
   */
  reconfigure(config: Partial<OutputSanitizerConfig>): void {
    this.config = { ...this.config, ...config };
    this.effectiveRules = this.buildEffectiveRules();
  }

  // ========================================================================
  // Internal
  // ========================================================================

  /**
   * Build effective rules, applying skipCategories and strategy overrides.
   */
  private buildEffectiveRules(): RedactionRule[] {
    const skipSet = new Set(this.config.skipCategories);
    return DETECTION_RULES.filter((rule) => !skipSet.has(rule.category)).map((rule) => {
      const override = this.config.strategyOverrides[rule.category];
      return override ? { ...rule, strategy: override } : rule;
    });
  }

  /**
   * Apply a redaction strategy to a matched string.
   */
  private applyRedaction(
    matched: string,
    category: SensitivityCategory,
    strategy: RedactionStrategy,
  ): string {
    switch (strategy) {
      case 'remove':
        return '';

      case 'hash':
        return this.formatRedacted(category, 'hash', this.hashString(matched));

      case 'partial':
        return this.applyPartialRedact(matched, category);

      case 'mask':
      default:
        return this.formatRedacted(category, 'mask', '');
    }
  }

  /**
   * Format a redacted replacement string (used for 'mask' and 'hash' strategies).
   */
  private formatRedacted(
    category: SensitivityCategory,
    strategy: RedactionStrategy,
    hashOrEmpty: string,
  ): string {
    const label = category.replace(/_/g, '-');
    switch (strategy) {
      case 'hash':
        return `[REDACTED:${label}:${hashOrEmpty.slice(0, 8)}]`;
      case 'mask':
      default:
        return `[REDACTED:${label}]`;
    }
  }

  /**
   * Partial redaction: show first 3 + last 3 characters for pattern recognition.
   * Useful for environments where operators need to verify which key was redacted.
   */
  private applyPartialRedact(matched: string, _category: SensitivityCategory): string {
    if (matched.length <= 8) return '[REDACTED]';
    const show = Math.min(3, Math.floor(matched.length / 4));
    return matched.slice(0, show) + '...' + matched.slice(-show);
  }

  /**
   * SHA-256 hash for output integrity verification.
   */
  private hashString(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Log redaction events to the tamper-evident audit chain.
   */
  private auditSanitization(
    sanitized: string,
    records: RedactionRecord[],
    totalRedactions: number,
    context: { agentId?: string; runId?: string; source?: string } | undefined,
    durationMs: number,
  ): void {
    try {
      const audit = getAuditChainLedger();
      const categories = records.map((r) => r.category);
      const uniqueCategories = [...new Set(categories)];

      audit.logEvent({
        type: 'security_scan',
        severity: records.some(
          (r) =>
            r.category === 'api_key' ||
            r.category === 'private_key' ||
            r.category === 'cloud_credential',
        )
          ? 'critical'
          : records.some((r) => r.category === 'password_secret' || r.category === 'jwt_token')
            ? 'high'
            : 'medium',
        source: `OutputSanitizer${context?.source ? `:${context.source}` : ''}`,
        message: `Sanitized ${totalRedactions} sensitive value(s): ${uniqueCategories.join(', ')}`,
        details: {
          totalRedactions,
          records: records.map((r) => ({
            category: r.category,
            strategy: r.strategy,
            count: r.count,
          })),
          outputHash: this.hashString(sanitized).slice(0, 16),
          durationMs,
          outputLength: sanitized.length,
        },
        context: {
          agentId: context?.agentId,
          runId: context?.runId,
          tenantId: getCurrentTenantId(),
        },
      });
    } catch {
      recordSinkFailure('outputSanitizer');
    }
  }
}

// ============================================================================
// Convenience functions
// ============================================================================

/**
 * Quick sanitize: one-shot sanitization with default config.
 * Use this for simple inline calls.
 */
export function sanitizeOutput(
  output: string,
  context?: { agentId?: string; runId?: string; source?: string },
): string {
  const sanitizer = getOutputSanitizer();
  return sanitizer.sanitize(output, context).sanitized;
}

/**
 * Check if output needs sanitization before transmitting.
 * Returns the sanitized output + a flag indicating if redaction occurred.
 */
export function sanitizeIfNeeded(
  output: string,
  context?: { agentId?: string; runId?: string; source?: string },
): { output: string; wasRedacted: boolean; categories: SensitivityCategory[] } {
  const sanitizer = getOutputSanitizer();
  if (!sanitizer.containsSensitiveData(output)) {
    return { output, wasRedacted: false, categories: [] };
  }
  const result = sanitizer.sanitize(output, context);
  return {
    output: result.sanitized,
    wasRedacted: true,
    categories: result.records.map((r) => r.category),
  };
}

// ============================================================================
// Singleton
// ============================================================================

const outputSanitizerSingleton = createTenantAwareSingleton(() => new OutputSanitizer());

export function getOutputSanitizer(): OutputSanitizer {
  return outputSanitizerSingleton.get();
}

export function resetOutputSanitizer(): void {
  outputSanitizerSingleton.reset();
}
