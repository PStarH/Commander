/**
 * OwaspAgenticAiTop10 — Unified ASI01-ASI10 scoring with rolling-window aggregation.
 *
 * Goal: give the SecurityPosturePage and SIEM consumers a single, OS-aligned
 *   view of which Agentic AI Top 10 risks were hit, how often, and at what
 *   severity, by aggregating signals from the many parallel modules that
 *   each cover their slice. Closes the gap where e.g. securityBenchmarkRunner
 *   only ever measures "did the test pass?" while GuardianAgent measures
 *   "did production trip?" — this module reconciles both at runtime.
 *
 * Memory model (chosen after architecture review):
 *   Time-bucketed per-minute counters. With a 24h default window, the upper
 *   bound is 1440 buckets per ASI × 10 ASIs = 14400 small records. This keeps
 *   memory O(window_minutes) rather than O(events_seen), so even an attacker
 *   firing 10k events/minute cannot trigger an OOM crash.
 *   Previously this module stored one record per event in a rolling list,
 *   which was a documented OOM risk.
 *
 * Scoring:
 *   score ∈ [0, 1]. score = highOrCritical / max(1, total).
 *   0 when no events in the window; bounded by 1 via min(...) at the call site.
 *   Higher = more threat pressure during the window.
 *
 * Threats:
 *   - Direct API bypass of `security.event` bus: the helper bridges
 *     (recordGuardianIntervention / recordSupplyChainFinding / etc.) emit
 *     directly to the per-ASI buckets. SIEM consumers subscribed to the
 *     bus will not see these increments unless the underlying module also
 *     publishes a security.event. This is intentional — keeps the watchdog
 *     low-latency — but documented for SOC operators.
 *   - Mtime-based retention in the Storage module: opt-in and all-or-nothing
 *     per file. See dataRetention.ts for the rationale.
 *
 * Avoiding blast-radius:
 *   - never throws on malformed input
 *   - tenant-aware singleton via createTenantAwareSingleton
 */

import {
  getSecurityAuditLogger,
  type SecurityEvent,
  type SecurityEventType,
  type SecuritySeverity,
} from './securityAuditLogger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import type { BusMessage } from '../runtime/types/messageBus';

// ============================================================================
// Public types
// ============================================================================

export type OwaspAsiId =
  | 'ASI01' // Agent Goal Hijack
  | 'ASI02' // Agent Output Capture
  | 'ASI03' // Agentic RCE / Tool sandbox escape
  | 'ASI04' // Agent Resource Exhaustion
  | 'ASI05' // Agent-to-Agent Interaction abuse
  | 'ASI06' // Agent Supply Chain
  | 'ASI07' // Agent Memory Poisoning
  | 'ASI08' // Agent Identity & Access
  | 'ASI09' // Agent Output Manipulation
  | 'ASI10'; // Agent Hallucination & Failure

export const ALL_ASIS: readonly OwaspAsiId[] = [
  'ASI01',
  'ASI02',
  'ASI03',
  'ASI04',
  'ASI05',
  'ASI06',
  'ASI07',
  'ASI08',
  'ASI09',
  'ASI10',
] as const;

export type AsSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AsBlockState = 'blocked' | 'observed' | 'unknown';

export interface AsDetection {
  asiId: OwaspAsiId;
  severity: AsSeverity;
  source: string;
  blocked: AsBlockState;
  detector?: string;
  fingerprint?: string;
  timestamp?: number;
  details?: Record<string, unknown>;
}

export interface AsiScore {
  asiId: OwaspAsiId;
  total: number;
  highOrCritical: number;
  blocked: number;
  /** highOrCritical / max(1, total). Always 0..1. */
  score: number;
  lastDetectedAt?: number;
  topSources: Array<{ source: string; count: number }>;
}

export interface OwaspAsiReport {
  windowMs: number;
  generatedAt: string;
  totalsByAsi: AsiScore[];
  overallScore: number;
  summary: string;
}

export interface OwaspAsiConfig {
  /** Rolling window in ms. Default 24h. */
  windowMs: number;
  /** Disable bus subscription (testing). Default false. */
  disableBusSubscription: boolean;
}

const DEFAULT_CONFIG: OwaspAsiConfig = {
  windowMs: 24 * 60 * 60 * 1000,
  disableBusSubscription: false,
};

// ============================================================================
// Classifier tables
// ============================================================================

/**
 * Each SecurityEventType maps to ONE OR MORE ASIs. Multi-mapping is rare
 * but correct — e.g. `auth_rate_limit` is BOTH an Identity & Access event
 * (ASI08, attacker behaviour) AND a Resource Exhaustion signal (ASI04).
 *
 * Truthiness: SecurityEventType is the source-of-truth union declared in
 * securityAuditLogger.ts. If you add a new value there, TypeScript will
 * surface a `Property ... is missing in type` here at compile time so the
 * table can be kept exhaustive without manual review.
 */
/**
 * Routing table — exported so HTTP-layer ingestion helpers (the
 * `/api/v1/security/owasp-agentic-ai-top10` POST) can derive the same
 * ASI routing a SecurityEvent would receive from the bus subscription
 * without re-implementing the table. Single source of truth.
 *
 * Adding a new SecurityEventType variant: TypeScript will surface a
 * "Property … is missing in type" compile error here so the routing
 * table is kept exhaustive without manual review.
 */
export const SECURITY_EVENT_TYPE_TO_ASI: Record<SecurityEventType, readonly OwaspAsiId[]> = {
  sandbox_violation: ['ASI03'],
  auth_failure: ['ASI08'],
  auth_success: [],
  auth_rate_limit: ['ASI08', 'ASI04'],
  approval_denied: ['ASI08'],
  approval_granted: [],
  content_threat: ['ASI01'],
  exec_policy_violation: ['ASI03'],
  exec_policy_forbidden: ['ASI03'],
  credential_access: ['ASI02'],
  input_validation_failure: ['ASI01'],
  path_traversal_attempt: ['ASI03'],
  command_injection_attempt: ['ASI03'],
  memory_poisoning_detected: ['ASI07'],
  skill_security_violation: ['ASI06'],
  config_change: [],
  // security_scan defaults to ASI10, but the detector hint can override
  // to ASI06 when the scan is a supply chain scan.
  security_scan: ['ASI10'],
  key_rotation_attempt: ['ASI08'],
  key_rotation_confirmed: ['ASI08'],
  key_rotation_dry_run: ['ASI08'],
  token_budget_breach: ['ASI04'],
  circuit_breaker_short_circuit: ['ASI04'],
};

/**
 * Detector hints override the default event-type routing so a single event
 * with a content_threat type can land in ASI01 (prompt injection) or ASI02
 * (output capture) based on which detector emitted it.
 */
/**
 * Detector hints override the default event-type routing so a single event
 * with a `content_threat` type can land in ASI01 (prompt injection) or ASI02
 * (output capture) based on which detector emitted it. Exported so the
 * HTTP ingest path can name the override without duplicating the table.
 */
export const DETECTOR_TO_ASI_OVERRIDE: Record<string, OwaspAsiId | undefined> = {
  mlInjectionDetector: 'ASI01',
  contentScanner: 'ASI01',
  guardianAgent: undefined,
  outputSanitizer: 'ASI02',
  supplyChainScanner: 'ASI06',
  supplyChainAttestor: 'ASI06',
  crossAgentCorrelator: 'ASI05',
  differentialPrivacyLayer: 'ASI02',
  privacyRouter: 'ASI02',
  federatedIdentity: 'ASI08',
  capabilityTokenIssuer: 'ASI08',
  redTeamFramework: 'ASI10',
  hallucinationDetector: 'ASI10',
  // When the event comes from GuardianAgent, route by intervention
  // (re-classified inside classifyFromSecurityEvent).
  outputTamper: 'ASI09',
};

const OUTPUT_TAMPER_CATEGORIES = new Set([
  'jwt_token',
  'connection_string',
  'base64_blob',
  'password_secret',
]);

// ============================================================================
// Per-minute bucket aggregation
// ============================================================================

interface BucketWindow {
  /** Total events in this minute. */
  total: number;
  /** Events with severity in {high, critical}. */
  highCritical: number;
  /** Events flagged as blocked. */
  blocked: number;
  bySource: Map<string, number>;
  /** Last event timestamp seen in this bucket (ms). */
  lastSeenMs: number;
}

const EMPTY_BUCKET: BucketWindow = {
  total: 0,
  highCritical: 0,
  blocked: 0,
  bySource: new Map(),
  lastSeenMs: 0,
};

function newBucket(): BucketWindow {
  return {
    total: 0,
    highCritical: 0,
    blocked: 0,
    bySource: new Map(),
    lastSeenMs: 0,
  };
}

function minuteEpoch(timestamp: number): number {
  return Math.floor(timestamp / 60_000);
}

// ============================================================================
// Aggregator
// ============================================================================

/**
 * OwaspAgenticAiTop10 — the aggregator. Per-ASI, per-minute counters with a
 * rolling-window sum. Bounded memory.
 */
export class OwaspAgenticAiTop10 {
  private readonly config: OwaspAsiConfig;
  /** Map<uasiId, Map<minuteEpoch, BucketWindow>>. Lazy-allocated, gets trimmed. */
  private readonly buckets = new Map<OwaspAsiId, Map<number, BucketWindow>>();
  /** (asiId, fingerprint) → minuteEpoch; for dedup within a window. */
  private readonly fingerprints = new Map<string, number>();
  private busUnsub: (() => void) | null = null;

  constructor(config: Partial<OwaspAsiConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.disableBusSubscription) this.subscribeToBus();
  }

  // ── Public ingestion ──────────────────────────────────────────────────

  record(detection: AsDetection): void {
    if (!detection || !ALL_ASIS.includes(detection.asiId)) return;
    const ts = detection.timestamp ?? Date.now();
    const fpKey = detection.fingerprint ? `${detection.asiId}::${detection.fingerprint}` : null;

    if (fpKey) {
      this.pruneFingerprints(ts);
      if (this.fingerprints.has(fpKey)) return;
      this.fingerprints.set(fpKey, ts);
    }

    const buckets = this.getOrCreateBuckets(detection.asiId);
    const minute = minuteEpoch(ts);
    let bucket = buckets.get(minute);
    if (!bucket) {
      bucket = newBucket();
      buckets.set(minute, bucket);
    }
    bucket.total += 1;
    if (detection.severity === 'high' || detection.severity === 'critical') {
      bucket.highCritical += 1;
    }
    if (detection.blocked === 'blocked') bucket.blocked += 1;
    if (ts > bucket.lastSeenMs) bucket.lastSeenMs = ts;
    if (detection.source) {
      bucket.bySource.set(detection.source, (bucket.bySource.get(detection.source) ?? 0) + 1);
    }

    this.pruneBucketsIfWindowChanged(detection.asiId);
  }

  private getOrCreateBuckets(asiId: OwaspAsiId): Map<number, BucketWindow> {
    let b = this.buckets.get(asiId);
    if (!b) {
      b = new Map();
      this.buckets.set(asiId, b);
    }
    return b;
  }

  private pruneBucketsIfWindowChanged(asiId: OwaspAsiId): void {
    const buckets = this.buckets.get(asiId);
    if (!buckets) return;
    const cutoffMinute = minuteEpoch(Date.now() - this.config.windowMs);
    for (const m of Array.from(buckets.keys())) {
      if (m < cutoffMinute) buckets.delete(m);
    }
  }

  private pruneFingerprints(now: number): void {
    const cutoffMinute = minuteEpoch(now - this.config.windowMs);
    for (const [key, m] of Array.from(this.fingerprints)) {
      if (m < cutoffMinute) this.fingerprints.delete(key);
    }
  }

  unsubscribeFromBus(): void {
    if (this.busUnsub) {
      try {
        this.busUnsub();
      } catch (err) {
        console.warn('[Catch]', err);
        /* swallow */
      }
      this.busUnsub = null;
    }
  }

  // ── Bus hookup ────────────────────────────────────────────────────────

  private subscribeToBus(): void {
    this.unsubscribeFromBus();
    try {
      // Lazy require avoids hard-cyclic dependency in test environments where
      // the bus singleton has not been constructed.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getMessageBus } = require('../runtime/messageBus');
      const bus = getMessageBus();
      this.busUnsub = bus.subscribe('security.event', (msg: BusMessage) => {
        const event = msg?.payload as SecurityEvent | undefined;
        if (!event || !event.type) return;
        this.classifyFromSecurityEvent(event);
      });
    } catch (err) {
      console.warn('[Catch]', err);
      this.busUnsub = null;
    }
  }

  // ── Public reporting ──────────────────────────────────────────────────

  /**
   * Score a single ASI right now. Returns 0..1, where 0 = no detections in
   * window. Higher = more threat pressure.
   */
  score(asiId: OwaspAsiId): number {
    const { total, highCritical } = this.summarise(asiId);
    if (total === 0) return 0;
    return Math.min(1, highCritical / Math.max(1, total));
  }

  report(): OwaspAsiReport {
    const totalsByAsi: AsiScore[] = ALL_ASIS.map((asiId) => {
      const summary = this.summarise(asiId);
      const topSources = Array.from(summary.bySource.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([source, count]) => ({ source, count }));
      return {
        asiId,
        total: summary.total,
        highOrCritical: summary.highCritical,
        blocked: summary.blocked,
        score: summary.total === 0 ? 0 : Math.min(1, summary.highCritical / summary.total),
        lastDetectedAt: summary.lastSeenMs > 0 ? summary.lastSeenMs : undefined,
        topSources,
      };
    });
    const overallScore = totalsByAsi.reduce((sum, s) => sum + s.score, 0) / totalsByAsi.length;
    return {
      windowMs: this.config.windowMs,
      generatedAt: new Date().toISOString(),
      totalsByAsi,
      overallScore,
      summary: this.buildSummary(totalsByAsi, overallScore),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private summarise(asiId: OwaspAsiId): {
    total: number;
    highCritical: number;
    blocked: number;
    bySource: Map<string, number>;
    lastSeenMs: number;
  } {
    const buckets = this.buckets.get(asiId);
    if (!buckets) {
      return {
        total: EMPTY_BUCKET.total,
        highCritical: EMPTY_BUCKET.highCritical,
        blocked: EMPTY_BUCKET.blocked,
        bySource: EMPTY_BUCKET.bySource,
        lastSeenMs: EMPTY_BUCKET.lastSeenMs,
      };
    }
    let total = 0;
    let highCritical = 0;
    let blocked = 0;
    let lastSeenMs = 0;
    const bySource = new Map<string, number>();
    for (const b of buckets.values()) {
      total += b.total;
      highCritical += b.highCritical;
      blocked += b.blocked;
      if (b.lastSeenMs > lastSeenMs) lastSeenMs = b.lastSeenMs;
      for (const [k, v] of b.bySource) {
        bySource.set(k, (bySource.get(k) ?? 0) + v);
      }
    }
    return { total, highCritical, blocked, bySource, lastSeenMs };
  }

  private buildSummary(scores: AsiScore[], overall: number): string {
    const top3 = scores
      .filter((s) => s.total > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (top3.length === 0) return 'No OWASP Agentic AI Top 10 detections in window';
    const parts = top3.map((s) => `${s.asiId}(${(s.score * 100).toFixed(0)}%)`);
    const grade =
      overall < 0.05 ? 'GREEN' : overall < 0.2 ? 'YELLOW' : overall < 0.4 ? 'ORANGE' : 'RED';
    return `${grade} · overall=${(overall * 100).toFixed(1)}% · worst ${parts.join(', ')}`;
  }

  /**
   * Classify an inbound SecurityEvent into one or more OWASP ASIs and
   * record a detection per (asi, fingerprint). Made public for test
   * determinism — production callers reach this via the `security.event`
   * bus subscription, but tests can drive it directly without subscribing.
   * Never throws — failures are swallowed silently so a malformed event
   * cannot crash the aggregator.
   */
  classifyFromSecurityEvent(event: SecurityEvent): void {
    try {
      if (!event.type) return;
      const routingAsis = SECURITY_EVENT_TYPE_TO_ASI[event.type as SecurityEventType];
      if (!routingAsis || routingAsis.length === 0) return;

      const detector = (event.details?.detector as string | undefined) ?? event.source ?? undefined;
      const overrideAsi = detector ? DETECTOR_TO_ASI_OVERRIDE[detector] : undefined;

      const category = (event.details?.category as string | undefined) ?? '';
      const isOutputTamper =
        detector === 'outputSanitizer' && OUTPUT_TAMPER_CATEGORIES.has(category);

      const finalAsis = new Set<OwaspAsiId>(routingAsis);
      if (overrideAsi) finalAsis.add(overrideAsi);
      if (isOutputTamper) finalAsis.add('ASI09');

      const sev = (event.severity as AsSeverity | undefined) ?? 'medium';
      const blocked: AsBlockState = inferBlocked(event);

      for (const asiId of finalAsis) {
        this.record({
          asiId,
          severity: sev,
          source: event.source ?? 'securityAuditLogger',
          detector,
          blocked,
          fingerprint: buildFingerprint(event, asiId),
          timestamp: event.timestamp ? Date.parse(event.timestamp) : undefined,
          details: { type: event.type, message: event.message },
        });
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* never throw */
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function inferBlocked(event: SecurityEvent): AsBlockState {
  if (
    event.type === 'exec_policy_forbidden' ||
    event.type === 'approval_denied' ||
    event.type === 'auth_rate_limit' ||
    event.details?.action === 'block' ||
    event.details?.decision === 'denied'
  ) {
    return 'blocked';
  }
  const sev = (event.details?.severity as SecuritySeverity | undefined) ?? event.severity;
  if (sev === 'critical' || sev === 'high') return 'observed';
  return 'unknown';
}

function buildFingerprint(event: SecurityEvent, asiId: string): string {
  const parts = [
    asiId,
    event.type,
    event.source ?? '',
    String(event.details?.category ?? ''),
    String(event.details?.toolName ?? ''),
    String(event.details?.severity ?? ''),
    String(event.message ?? '').slice(0, 120),
  ].join('|');
  return fnv1aHex(parts);
}

function fnv1aHex(s: string): string {
  // FNV-1a 32-bit; deterministic, dependency-free. Sufficient for in-window
  // dedup (collision-avoidance only, not cryptographic).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ============================================================================
// Singleton
// ============================================================================

const asiSingleton = createTenantAwareSingleton(() => new OwaspAgenticAiTop10());

export function getOwaspAsiTop10(): OwaspAgenticAiTop10 {
  return asiSingleton.get();
}

export function resetOwaspAsiTop10(): void {
  asiSingleton.reset();
}

// ============================================================================
// Direct-record bridges for callers that don't go through `security.event`.
// These intentionally bypass the bus to keep detection latency low.
// SIEM consumers subscribed to `security.event` will not see increments
// unless the upstream module ALSO publishes a security.event.
// ============================================================================

const GUARDIAN_INTERVENTION_TO_ASI: Record<string, OwaspAsiId | undefined> = {
  semantic_drift: 'ASI01',
  goal_hijack: 'ASI01',
  anomaly: 'ASI01',
  safety_violation: 'ASI03',
  cost_overrun: 'ASI04',
  behavioral_baseline_deviation: 'ASI09',
  tool_usage_spike: 'ASI04',
  data_exfiltration: 'ASI02',
};

export function recordGuardianIntervention(
  intervention: string,
  severity: AsSeverity,
  agentId: string,
  details?: Record<string, unknown>,
): void {
  const asiId = GUARDIAN_INTERVENTION_TO_ASI[intervention];
  if (!asiId) return;
  getOwaspAsiTop10().record({
    asiId,
    severity,
    source: 'guardianAgent',
    detector: 'guardianAgent',
    blocked: 'observed',
    fingerprint: `guardian:${agentId}:${intervention}`,
    details: { agentId, intervention, ...details },
  });
}

export function recordSupplyChainFinding(
  severity: AsSeverity,
  blocked: boolean,
  signature?: string,
): void {
  getOwaspAsiTop10().record({
    asiId: 'ASI06',
    severity,
    source: 'supplyChainScanner',
    detector: 'supplyChainScanner',
    blocked: blocked ? 'blocked' : 'observed',
    fingerprint: signature ? `asisc:${signature}` : undefined,
  });
}

export function recordCrossAgentFinding(
  correlationType: string,
  severity: AsSeverity,
  fingerprintSuffix?: string,
): void {
  getOwaspAsiTop10().record({
    asiId: 'ASI05',
    severity,
    source: 'crossAgentCorrelator',
    detector: 'crossAgentCorrelator',
    blocked: 'observed',
    fingerprint: fingerprintSuffix
      ? `a2a:${correlationType}:${fingerprintSuffix}`
      : `a2a:${correlationType}`,
    details: { correlationType },
  });
}

// Compile-time exhaustiveness: if SecurityEventType gets a new value, the
// table above will fail to type-check with a "Property X is missing" error.
// This is intentional — keeps the routing table honest.
const _SECURITY_TYPE_IS_EXHAUSTIVE: Record<SecurityEventType, true> = {
  sandbox_violation: true,
  auth_failure: true,
  auth_success: true,
  auth_rate_limit: true,
  approval_denied: true,
  approval_granted: true,
  content_threat: true,
  exec_policy_violation: true,
  exec_policy_forbidden: true,
  credential_access: true,
  input_validation_failure: true,
  path_traversal_attempt: true,
  command_injection_attempt: true,
  memory_poisoning_detected: true,
  skill_security_violation: true,
  config_change: true,
  security_scan: true,
  key_rotation_attempt: true,
  key_rotation_confirmed: true,
  key_rotation_dry_run: true,
  token_budget_breach: true,
  circuit_breaker_short_circuit: true,
};
void _SECURITY_TYPE_IS_EXHAUSTIVE;

// Re-export dependencies so consumers can wire without cross-import guesswork.
export { getSecurityAuditLogger };
export type { SecurityEvent };
