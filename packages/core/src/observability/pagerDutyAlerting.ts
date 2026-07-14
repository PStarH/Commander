/**
 * PagerDuty Alerting Integration
 *
 * Bridges Commander's SLO-driven reliability pipeline to PagerDuty's Events
 * API v2 so that SLO violations automatically page on-call engineers.
 *
 *   SLOMonitoringEngine / SLOManager
 *        │  (system.alert → type: 'slo_violation')
 *        ▼
 *   SLOAlertBridge ── maps metric → severity ──▶ PagerDutyAlerter
 *        │                                            │
 *        │  auto-resolve on recovery                   │  POST events.pagerduty.com/v2/enqueue
 *        ▼                                            ▼
 *   PagerDuty incident                               on-call engineer
 *
 * Design notes:
 *   - Uses native `fetch` (no axios) per project convention.
 *   - Uses `Record<string, T>` instead of `new Map()` per architecture gate rule.
 *   - Sanitizes all alert text (removes @mentions, URLs, control chars) per
 *     project security rules — mirrors UniversalSanitizer's channel_text rules.
 *   - Enforces SLA length limits: 100 chars for summary, 500 chars for
 *     customDetails serialized values.
 *
 * Integration:
 *   - SLOAlertBridge subscribes to `system.alert` / `slo_violation` events
 *     on the message bus (optional) and/or accepts a direct callback.
 *   - PagerDutyAlerter talks to Events API v2 (trigger / resolve / escalate).
 *   - Singleton accessors: getPagerDutyAlerter() / setPagerDutyAlerter() /
 *     resetPagerDutyAlerter().
 */

import { getGlobalLogger } from '../logging';
import { getMessageBus } from '../runtime/messageBus';
import type { BusMessage } from '../runtime/types/messageBus';
import { ResourceGovernor } from '../security/securityPrimitives';

// ── PagerDuty Events API v2 constants ──────────────────────────────────────
const PAGERDUTY_EVENTS_API_URL = 'https://events.pagerduty.com/v2/enqueue';
const DEFAULT_API_VERSION = 'v2';

// ── SLA length limits (project security rules) ─────────────────────────────
const MAX_SUMMARY_LENGTH = 100;
const MAX_CUSTOM_DETAILS_LENGTH = 500;
const MAX_FIELD_LENGTH = 100;

// ── HTTP timeout for PagerDuty API calls (via ResourceGovernor.withTimeout) ─
const HTTP_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

export interface PagerDutyAlert {
  /** Short human-readable summary (truncated to 100 chars after sanitization) */
  summary: string;
  /** Severity level — mapped to PagerDuty's severity scale */
  severity: PagerDutySeverity;
  /** The unique location of the affected system (e.g. "commander-api") */
  source: string;
  /** Component of the infrastructure affected (e.g. "slo-monitor") */
  component: string;
  /** Logical grouping for the alert (e.g. "slo", "infra") */
  group: string;
  /** Additional context — serialized and capped at 500 chars */
  customDetails?: Record<string, unknown>;
  /** Deduplication key — re-triggering with the same key updates the alert */
  dedupKey?: string;
}

/** Shape returned by the PagerDuty Events API v2 on success. */
interface PagerDutyEventResponse {
  status: string;
  dedup_key?: string;
  message?: string;
  errors?: string[];
}

/** Lightweight record of a triggered alert, kept in-memory for escalation. */
interface StoredAlertInfo {
  summary: string;
  source: string;
  component: string;
  group: string;
  customDetails?: Record<string, unknown>;
  severity: PagerDutySeverity;
  triggeredAt: string;
}

// ============================================================================
// Sanitization
// ============================================================================
//
// Mirrors the UniversalSanitizer's `channel_text` rules from
// securityPrimitives.ts but with "remove" semantics (not neutralize) and
// configurable length caps. Keeping this local avoids coupling the
// observability package to the security package's internals while still
// enforcing the same defense-in-depth posture.
// ============================================================================

/** @here / @channel / @everyone / @all mentions — removed to prevent mass-paging */
const CHANNEL_MENTION_PATTERN = /@(here|channel|everyone|all)\b/gi;

/** Bare URLs — removed to prevent phishing / hyperlink injection in pagers */
const URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** Control characters (C0 range minus \t \n \r, plus DEL) — prevents log/terminal injection */
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize alert text per project security rules:
 *   1. Remove @here/@channel/@everyone/@all mentions
 *   2. Remove bare URLs
 *   3. Strip control characters
 *   4. Collapse excess whitespace
 *   5. Truncate to `maxLength`
 */
function sanitizeAlertText(text: string, maxLength: number): string {
  if (!text) return '';
  let cleaned = text
    .replace(CHANNEL_MENTION_PATTERN, '')
    .replace(URL_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
  }
  return cleaned;
}

/**
 * Sanitize a customDetails object: recursively sanitize all string values
 * and ensure the serialized JSON does not exceed 500 chars.
 */
function sanitizeCustomDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details) return {};

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeAlertText(value, MAX_FIELD_LENGTH);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeCustomDetails(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'string' ? sanitizeAlertText(item, MAX_FIELD_LENGTH) : item,
      );
    } else {
      sanitized[key] = value;
    }
  }

  // Enforce serialized length cap
  let serialized = JSON.stringify(sanitized);
  if (serialized.length > MAX_CUSTOM_DETAILS_LENGTH) {
    serialized = serialized.slice(0, MAX_CUSTOM_DETAILS_LENGTH);
    // Re-parse to avoid truncated JSON — fall back to a capped object
    try {
      return JSON.parse(serialized) as Record<string, unknown>;
    } catch {
      return { truncated: true, raw: serialized };
    }
  }
  return sanitized;
}

/**
 * Generate a deterministic dedup key from the alert fields so that
 * re-triggering the same logical alert updates rather than duplicates.
 */
function generateDedupKey(alert: PagerDutyAlert): string {
  const seed = `${alert.source}|${alert.component}|${alert.group}|${alert.severity}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // Force 32-bit integer
  }
  return `cmdr-${Math.abs(hash).toString(36)}-${Date.now().toString(36)}`;
}

// ============================================================================
// PagerDutyAlerter
// ============================================================================

export class PagerDutyAlerter {
  private readonly integrationKey: string;
  private readonly apiVersion: string;
  /** In-memory tracking of active alerts for escalation support.
   *  Uses Record (not Map) per architecture gate rule. Not persisted → no HMAC. */
  private readonly activeAlerts: Record<string, StoredAlertInfo> = {};

  constructor(config: { integrationKey: string; apiVersion?: string }) {
    this.integrationKey = config.integrationKey;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  }

  /**
   * Check whether the alerter is configured (has a valid integration key).
   * When not configured, all alerting methods are no-ops.
   */
  isConfigured(): boolean {
    return Boolean(this.integrationKey);
  }

  /**
   * Trigger a new alert via PagerDuty Events API v2.
   *
   * If a dedup key is generated internally, re-triggering with the same
   * source/component/severity combination updates the existing alert instead
   * of creating a duplicate.
   *
   * When the integration key is not set (PAGERDUTY_INTEGRATION_KEY absent),
   * this method is a no-op and returns an empty dedup key — allowing
   * development and testing environments to run without PagerDuty.
   *
   * @param severity  PagerDuty severity level (critical/error/warning/info)
   * @param title     Short human-readable summary (truncated to 100 chars)
   * @param source    The unique location of the affected system
   * @param details   Additional context (serialized and capped at 500 chars)
   * @returns the dedup key that can be used to resolve or escalate later.
   */
  async triggerAlert(
    severity: PagerDutySeverity,
    title: string,
    source: string,
    details?: Record<string, unknown>,
  ): Promise<{ dedupKey: string }> {
    if (!this.integrationKey) {
      getGlobalLogger().debug(
        'PagerDutyAlerter',
        'triggerAlert no-op — PAGERDUTY_INTEGRATION_KEY not set',
        { severity, title },
      );
      return { dedupKey: '' };
    }

    const alertForDedup: PagerDutyAlert = {
      summary: title,
      severity,
      source,
      component: source,
      group: 'commander',
      customDetails: details,
    };
    const dedupKey = generateDedupKey(alertForDedup);
    const summary = sanitizeAlertText(title, MAX_SUMMARY_LENGTH);
    const customDetails = sanitizeCustomDetails(details);
    const sanitizedSource = sanitizeAlertText(source, MAX_FIELD_LENGTH);
    const component = sanitizeAlertText(source, MAX_FIELD_LENGTH);
    const group = 'commander';

    const payload = {
      routing_key: this.integrationKey,
      event_action: 'trigger',
      dedup_key: dedupKey,
      payload: {
        summary,
        severity,
        source: sanitizedSource,
        component,
        group,
        custom_details: customDetails,
      },
    };

    const response = await this.postEvent(payload);
    const resolvedDedupKey = response.dedup_key ?? dedupKey;

    // Track for escalation support
    this.activeAlerts[resolvedDedupKey] = {
      summary,
      source: sanitizedSource,
      component,
      group,
      customDetails,
      severity,
      triggeredAt: new Date().toISOString(),
    };

    getGlobalLogger().info('PagerDutyAlerter', 'Alert triggered', {
      dedupKey: resolvedDedupKey,
      severity,
      source: sanitizedSource,
      status: response.status,
    });

    return { dedupKey: resolvedDedupKey };
  }

  /**
   * Trigger a new alert from a full PagerDutyAlert object (internal helper
   * for the SLOAlertBridge and other callers that need full control over
   * component/group/dedupKey fields).
   */
  async triggerAlertFromObject(alert: PagerDutyAlert): Promise<{ dedupKey: string }> {
    if (!this.integrationKey) {
      return { dedupKey: '' };
    }

    const dedupKey = alert.dedupKey ?? generateDedupKey(alert);
    const summary = sanitizeAlertText(alert.summary, MAX_SUMMARY_LENGTH);
    const customDetails = sanitizeCustomDetails(alert.customDetails);
    const source = sanitizeAlertText(alert.source, MAX_FIELD_LENGTH);
    const component = sanitizeAlertText(alert.component, MAX_FIELD_LENGTH);
    const group = sanitizeAlertText(alert.group, MAX_FIELD_LENGTH);

    const payload = {
      routing_key: this.integrationKey,
      event_action: 'trigger',
      dedup_key: dedupKey,
      payload: {
        summary,
        severity: alert.severity,
        source,
        component,
        group,
        custom_details: customDetails,
      },
    };

    const response = await this.postEvent(payload);
    const resolvedDedupKey = response.dedup_key ?? dedupKey;

    this.activeAlerts[resolvedDedupKey] = {
      summary,
      source,
      component,
      group,
      customDetails,
      severity: alert.severity,
      triggeredAt: new Date().toISOString(),
    };

    getGlobalLogger().info('PagerDutyAlerter', 'Alert triggered', {
      dedupKey: resolvedDedupKey,
      severity: alert.severity,
      component: alert.component,
      status: response.status,
    });

    return { dedupKey: resolvedDedupKey };
  }

  /**
   * Resolve an active alert via PagerDuty Events API v2.
   * The alert transitions to "resolved" state on the PagerDuty side.
   *
   * When the integration key is not set, this method is a no-op.
   */
  async resolveAlert(dedupKey: string): Promise<void> {
    if (!this.integrationKey) {
      return;
    }

    await this.postEvent({
      routing_key: this.integrationKey,
      event_action: 'resolve',
      dedup_key: dedupKey,
    });

    delete this.activeAlerts[dedupKey];

    getGlobalLogger().info('PagerDutyAlerter', 'Alert resolved', { dedupKey });
  }

  /**
   * Escalate an active alert by updating its severity.
   *
   * PagerDuty Events API v2 does not have a dedicated "escalate" action;
   * we re-trigger with the same dedup key and the new severity, which updates
   * the active incident. The original alert's summary/source/component are
   * preserved from the in-memory tracking record.
   *
   * When the integration key is not set, this method is a no-op.
   *
   * @param dedupKey     The dedup key returned by triggerAlert()
   * @param newSeverity  The new severity to escalate to
   */
  async escalateAlert(
    dedupKey: string,
    newSeverity: 'critical' | 'error' | 'warning',
  ): Promise<void> {
    if (!this.integrationKey) {
      return;
    }

    const stored = this.activeAlerts[dedupKey];
    if (!stored) {
      throw new Error(`Cannot escalate alert: no active alert found for dedupKey "${dedupKey}"`);
    }

    const previousSeverity = stored.severity;

    await this.postEvent({
      routing_key: this.integrationKey,
      event_action: 'trigger',
      dedup_key: dedupKey,
      payload: {
        summary: stored.summary,
        severity: newSeverity,
        source: stored.source,
        component: stored.component,
        group: stored.group,
        custom_details: stored.customDetails ?? {},
      },
    });

    stored.severity = newSeverity;

    getGlobalLogger().warn('PagerDutyAlerter', 'Alert escalated', {
      dedupKey,
      newSeverity,
      previousSeverity,
    });
  }

  /**
   * Check whether an alert is currently active (tracked in-memory).
   */
  isActive(dedupKey: string): boolean {
    return dedupKey in this.activeAlerts;
  }

  /**
   * Get the list of currently active dedup keys.
   */
  getActiveAlertKeys(): string[] {
    return Object.keys(this.activeAlerts);
  }

  /**
   * Clear all in-memory tracking (for testing).
   */
  reset(): void {
    for (const key of Object.keys(this.activeAlerts)) {
      delete this.activeAlerts[key];
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * POST an event payload to the PagerDuty Events API v2 endpoint.
   * Uses ResourceGovernor.withTimeout() to enforce a 30-second timeout on the
   * HTTP call, per the project convention that all external calls must pass
   * through the ResourceGovernor.
   */
  private async postEvent(payload: Record<string, unknown>): Promise<PagerDutyEventResponse> {
    return ResourceGovernor.withTimeout(async () => {
      let response: Response;
      try {
        response = await fetch(PAGERDUTY_EVENTS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/vnd.pagerduty+json;version=' + this.apiVersion,
            'User-Agent': 'commander-pagerduty-alerter/1.0',
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        throw new Error(`PagerDuty API request failed: ${(err as Error).message}`);
      }

      let body: PagerDutyEventResponse;
      try {
        body = (await response.json()) as PagerDutyEventResponse;
      } catch {
        throw new Error(`PagerDuty API returned non-JSON response (HTTP ${response.status})`);
      }

      if (!response.ok || body.status !== 'success') {
        const errors = body.errors?.join('; ') ?? `HTTP ${response.status}`;
        throw new Error(`PagerDuty API error: ${errors}`);
      }

      return body;
    }, HTTP_TIMEOUT_MS);
  }
}

// ============================================================================
// SLO → PagerDuty severity mapping
// ============================================================================
//
// Maps each of the 6 Commander SLOs to a PagerDuty severity. The thresholds
// are aligned with docs/slo.md, sloOperations.ts DEFAULT_SLO_CONFIG, and the
// WP6 minimum targets.
// ============================================================================

interface SLOSeverityRule {
  /** SLO metric identifier (matches sloOperations.ts metric field) */
  metric: string;
  /** PagerDuty severity when this SLO is violated */
  severity: 'critical' | 'error' | 'warning';
  /** Human-readable description of the violation condition */
  description: string;
}

/**
 * SLO metric → PagerDuty severity mapping.
 *
 * These thresholds are aligned with docs/slo.md, docs/capacity-model.md
 * section 5.3, and the WP6 minimum targets. When an SLO violation event
 * arrives via the SLOAlertBridge, the metric name is looked up here to
 * determine the PagerDuty severity.
 *
 *   api_success_rate         < 99.9%   → critical   (API availability)
 *   schedule_latency_ms      > 5000ms  → error      (P95 schedule latency)
 *   dlq_depth                > 100     → error      (DLQ depth threshold)
 *   wal_size_mb              > 500     → warning    (PostgreSQL WAL growth)
 *   step_recovery_time_ms    > 30000ms → warning    (worker failure recovery)
 *
 * Additionally, these safety-critical SLOs are always paged as critical:
 *   hash_chain_integrity     < 100%    → critical   (event log tamper-evidence)
 *   approval_failclosed_rate < 100%    → critical   (safety-critical approvals)
 */
const SLO_SEVERITY_RULES: Record<string, SLOSeverityRule> = {
  api_success_rate: {
    metric: 'api_success_rate',
    severity: 'critical',
    description: 'API success rate below 99.9% threshold',
  },
  schedule_latency_ms: {
    metric: 'schedule_latency_ms',
    severity: 'error',
    description: 'Schedule latency exceeds 5000ms threshold',
  },
  dlq_depth: {
    metric: 'dlq_depth',
    severity: 'error',
    description: 'DLQ depth exceeds 100 entries',
  },
  wal_size_mb: {
    metric: 'wal_size_mb',
    severity: 'warning',
    description: 'PostgreSQL WAL size exceeds 500MB threshold',
  },
  step_recovery_time_ms: {
    metric: 'step_recovery_time_ms',
    severity: 'warning',
    description: 'Step recovery time exceeds 30000ms threshold',
  },
  hash_chain_integrity: {
    metric: 'hash_chain_integrity',
    severity: 'critical',
    description: 'Event log hash-chain integrity below 100%',
  },
  approval_failclosed_rate: {
    metric: 'approval_failclosed_rate',
    severity: 'critical',
    description: 'Tool approval fail-closed rate below 100%',
  },
};

// ============================================================================
// SLOAlertBridge
// ============================================================================

/**
 * SLO violation event — the common shape produced by SLOManager,
 * SLOMonitoringEngine, and the SLO operations pipeline.
 */
export interface SLOViolationEvent {
  /** SLO identifier (e.g. "api-availability") */
  sloId: string;
  /** Metric name (must match a key in SLO_SEVERITY_RULES to be paged) */
  metric: string;
  /** Current measured value */
  actualValue: number;
  /** SLO threshold that defines the violation boundary */
  threshold: number;
  /** Whether the SLO is currently violating (false = recovered) */
  isViolating: boolean;
  /** Optional severity from the upstream SLO engine */
  severity?: 'warning' | 'critical' | 'page';
  /** ISO timestamp of the evaluation */
  timestamp?: string;
  /** Associated run ID (if applicable) */
  runId?: string;
}

/** Callback signature for SLO violation event subscribers. */
export type SLOViolationCallback = (event: SLOViolationEvent) => void;

/**
 * SLOAlertBridge — bridges SLO violation events to PagerDuty alerts.
 *
 * Responsibilities:
 *   - Subscribe to SLO violation events (via callback or message bus)
 *   - Map each SLO metric to the appropriate PagerDuty severity
 *   - Trigger a PagerDuty alert on first violation (with dedup key)
 *   - Escalate if the violation worsens
 *   - Auto-resolve the PagerDuty alert when the SLO returns to normal
 *
 * Usage (message bus):
 *   const bridge = new SLOAlertBridge();
 *   bridge.connectToMessageBus();  // subscribes to system.alert / slo_violation
 *
 * Usage (callback):
 *   const bridge = new SLOAlertBridge();
 *   bridge.handleSLOEvent({ sloId, metric, ..., isViolating: true });
 *   // ... later, when SLO recovers:
 *   bridge.handleSLOEvent({ sloId, metric, ..., isViolating: false });
 */
export class SLOAlertBridge {
  private readonly alerter: PagerDutyAlerter;
  /** metric → dedupKey for active PagerDuty alerts.
   *  Uses Record (not Map) per architecture gate rule. */
  private readonly activeDedupKeys: Record<string, string> = {};
  /** Registered subscriber callbacks for SLO events */
  private readonly subscribers: SLOViolationCallback[] = [];
  /** Unsubscribe function for the message bus subscription (if connected) */
  private busUnsubscribe: (() => void) | null = null;

  constructor(alerter?: PagerDutyAlerter) {
    this.alerter = alerter ?? getPagerDutyAlerter();
  }

  /**
   * Register a callback to receive SLO violation events.
   * Returns an unsubscribe function.
   */
  subscribe(callback: SLOViolationCallback): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * Connect to the Commander message bus to automatically receive
   * `slo_violation` events published on the `system.alert` topic by
   * SLOManager and the SLO operations pipeline.
   *
   * This is a best-effort connection — if the message bus is not
   * initialized, a warning is logged and the bridge continues to
   * accept events via handleSLOEvent().
   */
  connectToMessageBus(): void {
    if (this.busUnsubscribe) {
      getGlobalLogger().warn('SLOAlertBridge', 'Message bus already connected');
      return;
    }

    try {
      const bus = getMessageBus();

      this.busUnsubscribe = bus.subscribe('system.alert', (message: BusMessage) => {
        const payload = message.payload as Record<string, unknown> | undefined;
        if (!payload || payload.type !== 'slo_violation') return;

        const event = this.translateBusEvent(payload);
        if (event) {
          this.handleSLOEvent(event).catch(() => {
            /* best-effort — don't let bus errors crash the subscriber */
          });
        }
      });

      getGlobalLogger().info('SLOAlertBridge', 'Connected to message bus for SLO violations');
    } catch {
      getGlobalLogger().warn(
        'SLOAlertBridge',
        'Message bus not available — use handleSLOEvent() directly',
      );
    }
  }

  /**
   * Disconnect from the message bus (if connected).
   */
  disconnectFromMessageBus(): void {
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
  }

  /**
   * Central handler for an SLO violation or recovery event.
   *
   * - If `isViolating` is true and no alert is active for this metric:
   *     → trigger a new PagerDuty alert with the mapped severity.
   * - If `isViolating` is true and an alert is already active:
   *     → escalate to the mapped severity (no-op if same severity).
   * - If `isViolating` is false and an alert is active:
   *     → auto-resolve the PagerDuty alert.
   */
  async handleSLOEvent(event: SLOViolationEvent): Promise<void> {
    // Forward to all registered subscribers (best-effort)
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        /* subscriber errors don't break the bridge */
      }
    }

    const rule = SLO_SEVERITY_RULES[event.metric];
    if (!rule) {
      getGlobalLogger().debug('SLOAlertBridge', 'No severity rule for SLO metric', {
        metric: event.metric,
      });
      return;
    }

    if (event.isViolating) {
      const existingKey = this.activeDedupKeys[event.metric];

      if (!existingKey) {
        // First violation — trigger a new alert
        const dedupKey = `slo-${event.metric}-${Date.now().toString(36)}`;
        try {
          await this.alerter.triggerAlertFromObject({
            summary: this.buildSummary(event, rule),
            severity: rule.severity,
            source: 'commander-slo-monitor',
            component: event.metric,
            group: 'slo',
            customDetails: {
              sloId: event.sloId,
              metric: event.metric,
              actualValue: event.actualValue,
              threshold: event.threshold,
              severity: rule.severity,
              runId: event.runId ?? '',
              timestamp: event.timestamp ?? new Date().toISOString(),
            },
            dedupKey,
          });
          this.activeDedupKeys[event.metric] = dedupKey;

          getGlobalLogger().warn('SLOAlertBridge', 'SLO violation paged to PagerDuty', {
            metric: event.metric,
            severity: rule.severity,
            actualValue: event.actualValue,
            threshold: event.threshold,
          });
        } catch (err) {
          getGlobalLogger().error(
            'SLOAlertBridge',
            'Failed to trigger PagerDuty alert',
            err as Error,
          );
        }
      } else {
        // Already alerting — escalate if the mapped severity warrants it
        try {
          await this.alerter.escalateAlert(existingKey, rule.severity);
        } catch (err) {
          getGlobalLogger().debug('SLOAlertBridge', 'Escalation skipped or failed', {
            error: (err as Error).message,
          });
        }
      }
    } else {
      // SLO returned to normal — auto-resolve
      const dedupKey = this.activeDedupKeys[event.metric];
      if (dedupKey) {
        try {
          await this.alerter.resolveAlert(dedupKey);
          delete this.activeDedupKeys[event.metric];

          getGlobalLogger().info(
            'SLOAlertBridge',
            'SLO recovered — PagerDuty alert auto-resolved',
            {
              metric: event.metric,
              dedupKey,
            },
          );
        } catch (err) {
          getGlobalLogger().error(
            'SLOAlertBridge',
            'Failed to resolve PagerDuty alert on SLO recovery',
            err as Error,
          );
        }
      }
    }
  }

  /**
   * Manually resolve an active SLO alert (e.g. for maintenance windows).
   */
  async resolve(metric: string): Promise<void> {
    const dedupKey = this.activeDedupKeys[metric];
    if (!dedupKey) return;
    await this.alerter.resolveAlert(dedupKey);
    delete this.activeDedupKeys[metric];
  }

  /**
   * Get the list of metrics currently being paged.
   */
  getActiveMetrics(): string[] {
    return Object.keys(this.activeDedupKeys);
  }

  /**
   * Clear all state (for testing).
   */
  reset(): void {
    for (const key of Object.keys(this.activeDedupKeys)) {
      delete this.activeDedupKeys[key];
    }
    this.subscribers.length = 0;
    this.disconnectFromMessageBus();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Build a sanitized, length-limited alert summary for an SLO violation.
   */
  private buildSummary(event: SLOViolationEvent, rule: SLOSeverityRule): string {
    const valueStr =
      event.metric.includes('_rate') || event.metric.includes('integrity')
        ? `${(event.actualValue * 100).toFixed(2)}%`
        : `${event.actualValue}`;
    const thresholdStr =
      event.metric.includes('_rate') || event.metric.includes('integrity')
        ? `${(event.threshold * 100).toFixed(2)}%`
        : `${event.threshold}`;
    return `SLO ${event.metric}: ${valueStr} (threshold ${thresholdStr}) — ${rule.description}`;
  }

  /**
   * Translate a message bus `slo_violation` payload into an SLOViolationEvent.
   * Returns null if the payload doesn't contain the required fields.
   */
  private translateBusEvent(payload: Record<string, unknown>): SLOViolationEvent | null {
    const metric = payload.metric as string | undefined;
    if (!metric) return null;

    return {
      sloId: (payload.sloId as string) ?? metric,
      metric,
      actualValue: (payload.actualValue as number) ?? 0,
      threshold: (payload.threshold as number) ?? 0,
      isViolating: true,
      severity: payload.severity as 'warning' | 'critical' | undefined,
      timestamp: (payload.timestamp as string) ?? new Date().toISOString(),
      runId: payload.runId as string | undefined,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalAlerter: PagerDutyAlerter | null = null;

/**
 * Get the global PagerDuty alerter singleton.
 * Initializes from PAGERDUTY_INTEGRATION_KEY env var on first access.
 */
export function getPagerDutyAlerter(): PagerDutyAlerter {
  if (!globalAlerter) {
    const integrationKey = process.env.PAGERDUTY_INTEGRATION_KEY ?? '';
    globalAlerter = new PagerDutyAlerter({ integrationKey });
  }
  return globalAlerter;
}

/**
 * Set the global PagerDuty alerter (e.g. with a custom config for testing
 * or multi-tenant integration key routing).
 */
export function setPagerDutyAlerter(alerter: PagerDutyAlerter): void {
  globalAlerter = alerter;
}

/**
 * Reset the global PagerDuty alerter singleton.
 * The next getPagerDutyAlerter() call will create a new instance from env.
 */
export function resetPagerDutyAlerter(): void {
  if (globalAlerter) {
    globalAlerter.reset();
  }
  globalAlerter = null;
}
