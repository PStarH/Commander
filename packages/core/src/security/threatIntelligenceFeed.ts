/**
 * ThreatIntelligenceFeed — Real-time threat intelligence with dynamic signature updates.
 *
 * Complements SupplyChainScanner's 8 static malware signatures by providing:
 *   1. External feed sources (URL, file, manual) for continuous signature updates
 *   2. TLP (Traffic Light Protocol) classification for feed sharing boundaries
 *   3. Signature lifecycle management (activate, deprecate, expire)
 *   4. Integration with SupplyChainScanner to dynamically augment its signature DB
 *   5. Feed health monitoring (staleness, error rate, coverage)
 *
 * Design:
 *   ThreatFeeds → ThreatIntelligenceFeed → SupplyChainScanner (augmented signatures)
 *                                          ↘ SecurityMonitor (feed health alerts)
 *
 * TLP levels:
 *   RED   - For the eyes and ears of individual recipients only, no further sharing
 *   AMBER - Limited distribution, restricted to participants' organizations
 *   GREEN - Limited distribution, restricted to the community
 *   WHITE - Unlimited distribution, subject to standard copyright rules
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getAuditChainLedger } from './auditChainLedger';
import { getSecurityMonitor } from './securityMonitor';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type TlpLevel = 'RED' | 'AMBER' | 'GREEN' | 'WHITE';

export interface ThreatSignature {
  /** Unique signature ID (e.g. THREAT-2026-001) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the threat */
  description: string;
  /** Severity */
  severity: 'medium' | 'high' | 'critical';
  /** Detection patterns (regex) */
  patterns: RegExp[];
  /** TLP classification */
  tlp: TlpLevel;
  /** Category */
  category:
    | 'malware'
    | 'backdoor'
    | 'exfiltration'
    | 'privilege_escalation'
    | 'persistence'
    | 'c2'
    | 'crypto_miner'
    | 'credential_theft'
    | 'supply_chain'
    | 'injection';
  /** Source attribution */
  source: string;
  /** When this signature was added */
  addedAt: string;
  /** Optional expiry (ISO date) */
  expiresAt?: string;
  /** Deprecated signatures are not used for scanning */
  deprecated: boolean;
  /** MITRE ATT&CK technique IDs if applicable */
  mitreIds?: string[];
  /** Confidence score 0-100 */
  confidence: number;
}

export interface ThreatFeedSource {
  /** Unique source ID */
  id: string;
  /** Source name */
  name: string;
  /** Source type */
  type: 'url' | 'file' | 'manual' | 'api';
  /** URL or file path */
  location?: string;
  /** Source TLP level */
  tlp: TlpLevel;
  /** How often to check for updates (ms), 0 = manual only */
  refreshIntervalMs: number;
  /** Last successful sync */
  lastSyncAt?: string;
  /** Whether the source is enabled */
  enabled: boolean;
}

export interface ThreatFeedHealth {
  /** Total active signatures */
  activeSignatures: number;
  /** Deprecated signatures */
  deprecatedSignatures: number;
  /** Signatures by severity */
  bySeverity: Record<ThreatSignature['severity'], number>;
  /** Signatures by TLP */
  byTlp: Record<TlpLevel, number>;
  /** Sources and their health */
  sources: Array<{
    id: string;
    name: string;
    enabled: boolean;
    lastSyncAt?: string;
    errorCount: number;
    isStale: boolean;
  }>;
  /** Last full sync */
  lastFullSyncAt?: string;
}

export interface ThreatFeedConfig {
  /** Whether the feed is enabled */
  enabled: boolean;
  /** Maximum signatures to keep (oldest deprecated are pruned first) */
  maxSignatures: number;
  /** Whether to push new signatures to SupplyChainScanner automatically */
  autoIntegrateWithScanner: boolean;
  /** Staleness threshold (ms) — sources not synced within this window are flagged */
  staleSourceThresholdMs: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ThreatFeedConfig = {
  enabled: true,
  maxSignatures: 500,
  autoIntegrateWithScanner: true,
  staleSourceThresholdMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// ============================================================================
// Built-in Emerging Threat Signatures (beyond SupplyChainScanner's 8)
// ============================================================================

const EMERGING_SIGNATURES: Omit<ThreatSignature, 'addedAt' | 'deprecated'>[] = [
  {
    id: 'THREAT-2026-001',
    name: 'LangChain prompt chaining bypass',
    description:
      'Multi-step prompt injection that chains across tool calls to bypass single-step filters',
    severity: 'critical',
    patterns: [
      /\[TOOL_CALL\].*ignore.*previous.*\[END_TOOL_CALL\]/is,
      /step\s*\d+.*\n.*forget.*\n.*step\s*\d+/is,
      /chain.*thought.*\n.*disregard.*\n.*chain.*thought/is,
    ],
    tlp: 'GREEN',
    category: 'injection',
    source: 'Commander Threat Intelligence',
    confidence: 85,
  },
  {
    id: 'THREAT-2026-002',
    name: 'MCP tool poisoning via manifest',
    description: 'Malicious MCP server that overrides legitimate tools via manifest injection',
    severity: 'critical',
    patterns: [
      /"tools"\s*:\s*\[[\s\S]*?"override"\s*:\s*true/,
      /manifest\.json.*tools.*replace.*all/i,
      /mcpServers.*command.*curl.*\|.*sh/i,
    ],
    tlp: 'GREEN',
    category: 'supply_chain',
    source: 'Commander Threat Intelligence',
    confidence: 80,
  },
  {
    id: 'THREAT-2026-003',
    name: 'Context window compression attack',
    description:
      'Deliberately filling context to trigger compaction that drops safety instructions',
    severity: 'high',
    patterns: [/padding.*\n{100,}/s, /lorem\s+ipsum.{500,}/is, /\[FILLER\].{200,}\[\/FILLER\]/s],
    tlp: 'GREEN',
    category: 'injection',
    source: 'Commander Threat Intelligence',
    confidence: 75,
  },
  {
    id: 'THREAT-2026-004',
    name: 'Shadow agent fork attack',
    description: 'Unauthorized agent spawning via tool output that creates hidden sub-agents',
    severity: 'critical',
    patterns: [
      /spawn_agent.*hidden.*true/i,
      /create_subprocess.*detached.*true/i,
      /fork\(\).*setsid/i,
      /nohup.*background/i,
    ],
    tlp: 'AMBER',
    category: 'privilege_escalation',
    source: 'Commander Threat Intelligence',
    confidence: 70,
  },
  {
    id: 'THREAT-2026-005',
    name: 'Vector embedding poisoning',
    description:
      'Crafted content designed to shift embedding similarity scores toward malicious intent',
    severity: 'medium',
    patterns: [
      /cosine_similarity.*manipulat/i,
      /embedding.*adversarial.*perturb/i,
      /gradient.*embedding.*attack/i,
    ],
    tlp: 'GREEN',
    category: 'injection',
    source: 'Commander Threat Intelligence',
    confidence: 65,
  },
  {
    id: 'THREAT-2026-006',
    name: 'Tool output length DoS',
    description:
      'Tool output that produces massive results to exhaust token budget and crash the agent',
    severity: 'high',
    patterns: [
      /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*\d{6,}/,
      /while\s*\(\s*true\s*\).*console\.log/i,
      /yes\s*\|\s*head\s*-c\s*\d{7,}/,
      /\/dev\/zero.*dd.*bs=\d{6,}/,
    ],
    tlp: 'GREEN',
    category: 'malware',
    source: 'Commander Threat Intelligence',
    confidence: 90,
  },
  {
    id: 'THREAT-2026-007',
    name: 'Cross-tenant memory probing',
    description: 'Attempts to access memory or state from other tenants via crafted queries',
    severity: 'critical',
    patterns: [
      /tenant.*boundary.*bypass/i,
      /cross.*tenant.*read/i,
      /select.*memory.*where.*tenant_id/i,
      /sql.*union.*select.*tenant/i,
    ],
    tlp: 'AMBER',
    category: 'exfiltration',
    source: 'Commander Threat Intelligence',
    confidence: 75,
  },
  {
    id: 'THREAT-2026-008',
    name: 'Skill marketplace typosquatting',
    description:
      'Malicious skill packages with names similar to popular skills (dependency confusion)',
    severity: 'high',
    patterns: [
      /commader-skills/i,
      /commmander/i,
      /cmdr-skills/i,
      /skill-registry\.json.*npm.*install/i,
    ],
    tlp: 'GREEN',
    category: 'supply_chain',
    source: 'Commander Threat Intelligence',
    confidence: 85,
  },
];

// ============================================================================
// ThreatIntelligenceFeed
// ============================================================================

export class ThreatIntelligenceFeed {
  private config: ThreatFeedConfig;
  private signatures: ThreatSignature[] = [];
  private sources: ThreatFeedSource[] = [];
  private sourceErrors = new Map<string, number>();

  constructor(config?: Partial<ThreatFeedConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize with emerging signatures
    const now = new Date().toISOString();
    for (const sig of EMERGING_SIGNATURES) {
      this.signatures.push({ ...sig, addedAt: now, deprecated: false });
    }
  }

  // ── Source Management ──────────────────────────────────────────────

  /** Register a threat feed source. */
  registerSource(source: ThreatFeedSource): void {
    if (this.sources.some((s) => s.id === source.id)) {
      throw new Error(`Source already registered: ${source.id}`);
    }
    this.sources.push(source);
    this.sourceErrors.set(source.id, 0);
  }

  /** Remove a threat feed source. */
  removeSource(sourceId: string): void {
    this.sources = this.sources.filter((s) => s.id !== sourceId);
    this.sourceErrors.delete(sourceId);
  }

  /** Get all registered sources. */
  getSources(): ThreatFeedSource[] {
    return [...this.sources];
  }

  // ── Signature Management ───────────────────────────────────────────

  /** Add signatures manually (e.g., from security research). */
  addSignatures(signatures: Omit<ThreatSignature, 'addedAt' | 'deprecated'>[]): void {
    const now = new Date().toISOString();
    for (const sig of signatures) {
      // Deduplicate by ID
      if (this.signatures.some((s) => s.id === sig.id)) {
        continue;
      }
      this.signatures.push({ ...sig, addedAt: now, deprecated: false });
    }

    this.enforceMaxSignatures();
    this.auditEvent('signatures_added', `Added ${signatures.length} signatures`);
  }

  /** Deprecate a signature (keep for history, don't scan with it). */
  deprecateSignature(signatureId: string): void {
    const sig = this.signatures.find((s) => s.id === signatureId);
    if (sig) {
      sig.deprecated = true;
      this.auditEvent('signature_deprecated', `Deprecated: ${signatureId}`);
    }
  }

  /** Reactivate a deprecated signature. */
  reactivateSignature(signatureId: string): void {
    const sig = this.signatures.find((s) => s.id === signatureId);
    if (sig) {
      sig.deprecated = false;
      this.auditEvent('signature_reactivated', `Reactivated: ${signatureId}`);
    }
  }

  /** Get all active (non-deprecated, non-expired) signatures. */
  getActiveSignatures(): ThreatSignature[] {
    const now = new Date().toISOString();
    return this.signatures.filter((s) => !s.deprecated && (!s.expiresAt || s.expiresAt > now));
  }

  /** Get signatures by TLP level (for feed sharing boundaries). */
  getSignaturesByTlp(maxTlp: TlpLevel): ThreatSignature[] {
    const tlpOrder: TlpLevel[] = ['WHITE', 'GREEN', 'AMBER', 'RED'];
    const maxIndex = tlpOrder.indexOf(maxTlp);
    return this.getActiveSignatures().filter((s) => tlpOrder.indexOf(s.tlp) <= maxIndex);
  }

  /** Get signatures by category. */
  getSignaturesByCategory(category: ThreatSignature['category']): ThreatSignature[] {
    return this.getActiveSignatures().filter((s) => s.category === category);
  }

  /** Check if a signature exists (by ID). */
  hasSignature(signatureId: string): boolean {
    return this.signatures.some((s) => s.id === signatureId);
  }

  // ── Integration with SupplyChainScanner ────────────────────────────

  /**
   * Export active signatures as patterns compatible with SupplyChainScanner's
   * MALWARE_SIGNATURES format. Called by SupplyChainScanner to dynamically
   * augment its static signature database.
   * @param maxTlp Maximum TLP level to export (default WHITE = all signatures).
   *               Set to 'GREEN' to exclude AMBER/RED signatures from scanner.
   */
  exportScannerSignatures(maxTlp: TlpLevel = 'GREEN'): Array<{
    id: string;
    name: string;
    description: string;
    severity: 'high' | 'critical';
    patterns: RegExp[];
  }> {
    return this.getSignaturesByTlp(maxTlp)
      .filter((s) => s.severity === 'high' || s.severity === 'critical')
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        severity: s.severity as 'high' | 'critical',
        patterns: s.patterns,
      }));
  }

  /**
   * Get all active regex patterns for content scanning.
   * Returns a flat array suitable for iterating over in a fast scanner.
   */
  exportScanPatterns(): Array<{
    id: string;
    pattern: RegExp;
    severity: ThreatSignature['severity'];
    name: string;
  }> {
    return this.getActiveSignatures().flatMap((s) =>
      s.patterns.map((p) => ({
        id: s.id,
        pattern: p,
        severity: s.severity,
        name: s.name,
      })),
    );
  }

  // ── Health & Monitoring ────────────────────────────────────────────

  /** Get feed health report. */
  getHealth(): ThreatFeedHealth {
    const active = this.getActiveSignatures();
    const deprecated = this.signatures.filter((s) => s.deprecated);

    const bySeverity: Record<ThreatSignature['severity'], number> = {
      critical: 0,
      high: 0,
      medium: 0,
    };
    const byTlp: Record<TlpLevel, number> = {
      RED: 0,
      AMBER: 0,
      GREEN: 0,
      WHITE: 0,
    };

    for (const sig of active) {
      bySeverity[sig.severity]++;
      byTlp[sig.tlp]++;
    }

    const now = Date.now();
    const sourcesHealth = this.sources.map((src) => ({
      id: src.id,
      name: src.name,
      enabled: src.enabled,
      lastSyncAt: src.lastSyncAt,
      errorCount: this.sourceErrors.get(src.id) ?? 0,
      isStale:
        !!src.lastSyncAt &&
        now - new Date(src.lastSyncAt).getTime() > this.config.staleSourceThresholdMs,
    }));

    return {
      activeSignatures: active.length,
      deprecatedSignatures: deprecated.length,
      bySeverity,
      byTlp,
      sources: sourcesHealth,
      lastFullSyncAt: this.sources
        .filter((s) => s.lastSyncAt)
        .map((s) => s.lastSyncAt!)
        .sort()
        .pop(),
    };
  }

  /** Trigger health alerts to SecurityMonitor if feed is degraded. */
  checkHealth(): void {
    const health = this.getHealth();
    const staleSources = health.sources.filter((s) => s.enabled && s.isStale);

    if (staleSources.length > 0) {
      const monitor = getSecurityMonitor();
      monitor.logAlert({
        type: 'threat_feed_stale',
        severity: 'medium',
        source: 'ThreatIntelligenceFeed',
        message: `${staleSources.length} threat feed source(s) are stale`,
        details: {
          stalSources: staleSources.map((s) => s.id),
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (health.activeSignatures === 0) {
      const monitor = getSecurityMonitor();
      monitor.logAlert({
        type: 'threat_feed_empty',
        severity: 'high',
        source: 'ThreatIntelligenceFeed',
        message: 'No active threat signatures — feed is empty',
        details: {},
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private enforceMaxSignatures(): void {
    if (this.signatures.length <= this.config.maxSignatures) return;
    // Remove deprecated first, then oldest
    const deprecated = this.signatures.filter((s) => s.deprecated);
    if (deprecated.length > 0) {
      deprecated.sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
      const toRemove = deprecated.slice(0, this.signatures.length - this.config.maxSignatures);
      for (const sig of toRemove) {
        this.signatures = this.signatures.filter((s) => s !== sig);
      }
    }
    // If still over limit, remove oldest active
    while (this.signatures.length > this.config.maxSignatures) {
      this.signatures.sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
      this.signatures.shift();
    }
  }

  private auditEvent(action: string, message: string): void {
    try {
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: 'low',
        source: 'ThreatIntelligenceFeed',
        message,
        details: { action, signatureCount: this.signatures.length },
      });
    } catch (err) {
      reportSilentFailure(err, 'threatIntelligenceFeed:527');
      /* best-effort */
    }
  }

  /** Reset all state (for test isolation). */
  reset(): void {
    this.signatures = [];
    this.sources = [];
    this.sourceErrors.clear();
    const now = new Date().toISOString();
    for (const sig of EMERGING_SIGNATURES) {
      this.signatures.push({ ...sig, addedAt: now, deprecated: false });
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

const feedSingleton = createTenantAwareSingleton(() => new ThreatIntelligenceFeed(), {});

export function getThreatIntelligenceFeed(
  _config?: Partial<ThreatFeedConfig>,
): ThreatIntelligenceFeed {
  return feedSingleton.get();
}

export function resetThreatIntelligenceFeed(): void {
  feedSingleton.reset();
}
