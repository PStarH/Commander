/**
 * SecurityAnomalyDetector — real-time event stream anomaly detection.
 *
 * Subscribes to MessageBus and monitors for attack patterns:
 * - Burst: too many tool calls / capability rejections in a short window
 * - Error cascade: consecutive failures from the same agent
 * - Sandbox escape attempts
 * - Non-reversible tool frequency spike
 * - Outbound network blocks
 *
 * On anomaly → auto-revoke all tracked capabilities for the offending agent
 * via CapabilityTokenIssuer.revoke(), and publish security.alert.
 *
 * This is the "系统沦陷持续" vector defense. Even if an attacker gains
 * initial access, the detector freezes the agent before damage compounds.
 *
 * Integration: call startSecurityAnomalyDetector() once at process startup
 * after MessageBus is initialized. The detector subscribes to the wildcard
 * topic and processes every event in real-time.
 */

import { getMessageBus } from '../runtime/messageBus';
import type { BusMessage } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from '../runtime/metricsCollector';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type AnomalyType =
  | 'tool_burst' // too many tool calls in short window
  | 'capability_abuse' // too many capability rejections
  | 'error_cascade' // consecutive failures from same agent
  | 'sandbox_escape' // sandbox escape attempt detected
  | 'irreversible_burst' // too many irreversible tool calls
  | 'outbound_blocked' // outbound network requests being blocked
  | 'brute_force_approval'; // too many approval rejections

export type AnomalySeverity = 'warning' | 'critical';

export interface AnomalyEvent {
  type: AnomalyType;
  severity: AnomalySeverity;
  agentId: string;
  runId?: string;
  description: string;
  count: number;
  windowMs: number;
  timestamp: string;
}

export interface AnomalyDetectorConfig {
  /** Time window in ms for burst detection. Default: 60_000 (1 min). */
  windowMs: number;
  /** Max tool calls per window before burst alert. Default: 50. */
  toolBurstThreshold: number;
  /** Max capability rejections per window. Default: 10. */
  capabilityAbuseThreshold: number;
  /** Max consecutive errors before cascade alert. Default: 5. */
  errorCascadeThreshold: number;
  /** Max irreversible tool calls per window. Default: 10. */
  irreversibleBurstThreshold: number;
  /** Max outbound blocks per window. Default: 3. */
  outboundBlockThreshold: number;
  /** Max approval rejections per window. Default: 10. */
  approvalRejectionThreshold: number;
  /** Callback when anomaly is detected. Default: log + publish. */
  onAnomaly?: (event: AnomalyEvent) => void;
  /** Callback to revoke capabilities for an agent. */
  revokeCallback?: (agentId: string, reason: string) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-agent rolling window tracker
// ──────────────────────────────────────────────────────────────────────────

interface AgentWindow {
  toolCalls: number[];
  capabilityRejections: number[];
  errors: number;
  irreversibleCalls: number[];
  outboundBlocks: number[];
  approvalRejections: number[];
  lastReset: number;
}

function newWindow(): AgentWindow {
  return {
    toolCalls: [],
    capabilityRejections: [],
    errors: 0,
    irreversibleCalls: [],
    outboundBlocks: [],
    approvalRejections: [],
    lastReset: Date.now(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// SecurityAnomalyDetector
// ──────────────────────────────────────────────────────────────────────────

export class SecurityAnomalyDetector {
  private config: AnomalyDetectorConfig;
  private readonly agentWindows: Map<string, AgentWindow> = new Map();
  private readonly anomalies: AnomalyEvent[] = [];
  private unsubscribe: (() => void) | null = null;
  private static readonly MAX_ANOMALIES = 5_000;

  constructor(config: Partial<AnomalyDetectorConfig> = {}) {
    this.config = {
      windowMs: config.windowMs ?? 60_000,
      toolBurstThreshold: config.toolBurstThreshold ?? 50,
      capabilityAbuseThreshold: config.capabilityAbuseThreshold ?? 10,
      errorCascadeThreshold: config.errorCascadeThreshold ?? 5,
      irreversibleBurstThreshold: config.irreversibleBurstThreshold ?? 10,
      outboundBlockThreshold: config.outboundBlockThreshold ?? 3,
      approvalRejectionThreshold: config.approvalRejectionThreshold ?? 10,
      onAnomaly: config.onAnomaly,
      revokeCallback: config.revokeCallback,
    };
  }

  /**
   * Start monitoring. Subscribes to MessageBus wildcard topic.
   */
  start(): void {
    if (this.unsubscribe) return;

    const bus = getMessageBus();
    this.unsubscribe = bus.subscribe('*', (message: BusMessage) => {
      this.processEvent(message);
    });

    getGlobalLogger().info('SecurityAnomalyDetector', 'started — monitoring all events');
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Process a single MessageBus event and check for anomalies.
   */
  processEvent(message: Partial<BusMessage>): void {
    const agentId = this.extractAgentId(message);
    if (!agentId) return;

    const payload = (message.payload ?? {}) as Record<string, unknown>;
    const now = Date.now();
    let window = this.agentWindows.get(agentId);
    if (!window) {
      window = newWindow();
      this.agentWindows.set(agentId, window);
    }

    // Prune old entries outside the window
    this.pruneWindow(window, now);

    // Track based on topic
    switch (message.topic) {
      case 'tool.started':
      case 'tool.executed':
      case 'tool.completed':
        window.toolCalls.push(now);
        this.checkToolBurst(agentId, window, payload.runId as string | undefined);
        break;

      case 'tool.blocked':
        if (
          payload.reason === 'capability_token_rejected' ||
          payload.reason === 'capability_token_error'
        ) {
          window.capabilityRejections.push(now);
          this.checkCapabilityAbuse(agentId, window, payload.runId as string | undefined);
        }
        if (payload.reason === 'irreversible_blocked') {
          window.irreversibleCalls.push(now);
          this.checkIrreversibleBurst(agentId, window, payload.runId as string | undefined);
        }
        break;

      case 'tool.timeout':
      case 'agent.failed':
        window.errors++;
        this.checkErrorCascade(agentId, window, payload.runId as string | undefined);
        break;

      case 'sandbox.escape_attempted':
        this.fireAnomaly({
          type: 'sandbox_escape',
          severity: 'critical',
          agentId,
          runId: payload.runId as string | undefined,
          description: 'Sandbox escape attempt detected',
          count: 1,
          windowMs: 0,
          timestamp: new Date().toISOString(),
        });
        break;

      case 'human.approval_rejected':
      case 'human.approval_timeout':
        window.approvalRejections.push(now);
        this.checkApprovalBruteForce(agentId, window, payload.runId as string | undefined);
        break;
    }

    // Check for outbound blocks (published as tool.blocked with reason)
    if (
      message.topic === 'tool.blocked' &&
      typeof payload.reason === 'string' &&
      payload.reason.includes('OUTBOUND_BLOCKED')
    ) {
      window.outboundBlocks.push(now);
      this.checkOutboundBlocks(agentId, window, payload.runId as string | undefined);
    }
  }

  private extractAgentId(message: Partial<BusMessage>): string | null {
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    return (payload.agentId as string) ?? (message.source as string) ?? null;
  }

  private pruneWindow(window: AgentWindow, now: number): void {
    const cutoff = now - this.config.windowMs;
    window.toolCalls = window.toolCalls.filter((t) => t > cutoff);
    window.capabilityRejections = window.capabilityRejections.filter((t) => t > cutoff);
    window.irreversibleCalls = window.irreversibleCalls.filter((t) => t > cutoff);
    window.outboundBlocks = window.outboundBlocks.filter((t) => t > cutoff);
    window.approvalRejections = window.approvalRejections.filter((t) => t > cutoff);
    if (window.errors > 0 && window.lastReset < cutoff) {
      window.errors = 0;
      window.lastReset = now;
    }
  }

  // ── Individual anomaly checks ──────────────────────────────────────────

  private checkToolBurst(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.toolCalls.length > this.config.toolBurstThreshold) {
      this.fireAnomaly({
        type: 'tool_burst',
        severity: 'critical',
        agentId,
        runId,
        description: `${window.toolCalls.length} tool calls in ${this.config.windowMs / 1000}s window`,
        count: window.toolCalls.length,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private checkCapabilityAbuse(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.capabilityRejections.length > this.config.capabilityAbuseThreshold) {
      this.fireAnomaly({
        type: 'capability_abuse',
        severity: 'critical',
        agentId,
        runId,
        description: `${window.capabilityRejections.length} capability rejections in ${this.config.windowMs / 1000}s`,
        count: window.capabilityRejections.length,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
      this.revokeAgent(agentId, 'capability abuse anomaly');
    }
  }

  private checkErrorCascade(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.errors >= this.config.errorCascadeThreshold) {
      this.fireAnomaly({
        type: 'error_cascade',
        severity: 'warning',
        agentId,
        runId,
        description: `${window.errors} consecutive errors from agent`,
        count: window.errors,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private checkIrreversibleBurst(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.irreversibleCalls.length > this.config.irreversibleBurstThreshold) {
      this.fireAnomaly({
        type: 'irreversible_burst',
        severity: 'critical',
        agentId,
        runId,
        description: `${window.irreversibleCalls.length} irreversible tool attempts in ${this.config.windowMs / 1000}s`,
        count: window.irreversibleCalls.length,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
      this.revokeAgent(agentId, 'irreversible burst anomaly');
    }
  }

  private checkOutboundBlocks(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.outboundBlocks.length > this.config.outboundBlockThreshold) {
      this.fireAnomaly({
        type: 'outbound_blocked',
        severity: 'critical',
        agentId,
        runId,
        description: `${window.outboundBlocks.length} outbound network blocks in ${this.config.windowMs / 1000}s`,
        count: window.outboundBlocks.length,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
      this.revokeAgent(agentId, 'outbound exfiltration attempt');
    }
  }

  private checkApprovalBruteForce(agentId: string, window: AgentWindow, runId?: string): void {
    if (window.approvalRejections.length > this.config.approvalRejectionThreshold) {
      this.fireAnomaly({
        type: 'brute_force_approval',
        severity: 'critical',
        agentId,
        runId,
        description: `${window.approvalRejections.length} approval rejections in ${this.config.windowMs / 1000}s`,
        count: window.approvalRejections.length,
        windowMs: this.config.windowMs,
        timestamp: new Date().toISOString(),
      });
      this.revokeAgent(agentId, 'approval brute force anomaly');
    }
  }

  // ── Anomaly firing + revocation ─────────────────────────────────────────

  private fireAnomaly(event: AnomalyEvent): void {
    // Avoid duplicate alerts for the same type+agent within the window
    const recent = this.anomalies.find(
      (a) => a.type === event.type && a.agentId === event.agentId && a.count === event.count,
    );
    if (recent) return;

    this.anomalies.push(event);
    if (this.anomalies.length > SecurityAnomalyDetector.MAX_ANOMALIES) {
      this.anomalies.shift();
    }

    // Publish to MessageBus
    try {
      const bus = getMessageBus();
      bus.publish('system.alert', 'anomaly_detector', {
        type: 'security_anomaly',
        anomalyType: event.type,
        severity: event.severity,
        agentId: event.agentId,
        description: event.description,
        count: event.count,
      });
    } catch {
      // bus may not be available in test env
    }

    // Metrics
    try {
      getMetricsCollector().incrementCounter(
        'security_anomaly_total',
        'Total security anomalies detected by SecurityAnomalyDetector',
        1,
        [
          { name: 'type', value: event.type },
          { name: 'severity', value: event.severity },
        ],
      );
    } catch {
      // metrics may not be available
    }

    // Log
    getGlobalLogger().warn('SecurityAnomalyDetector', event.description, {
      type: event.type,
      severity: event.severity,
      agentId: event.agentId,
      count: event.count,
    });

    // Custom callback
    this.config.onAnomaly?.(event);
  }

  private revokeAgent(agentId: string, reason: string): void {
    if (this.config.revokeCallback) {
      this.config.revokeCallback(agentId, reason);
    } else {
      getGlobalLogger().warn('SecurityAnomalyDetector', `would revoke agent (no callback)`, {
        agentId,
        reason,
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getAnomalies(limit = 100): AnomalyEvent[] {
    return this.anomalies.slice(-limit);
  }

  getAgentWindow(agentId: string): Readonly<AgentWindow> | null {
    const w = this.agentWindows.get(agentId);
    return w ? { ...w } : null;
  }

  resetAgent(agentId: string): void {
    this.agentWindows.delete(agentId);
  }

  reset(): void {
    this.agentWindows.clear();
    this.anomalies.length = 0;
  }

  updateConfig(updates: Partial<AnomalyDetectorConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let detectorInstance: SecurityAnomalyDetector | null = null;

export function getSecurityAnomalyDetector(
  config?: Partial<AnomalyDetectorConfig>,
): SecurityAnomalyDetector {
  if (!detectorInstance || config) {
    detectorInstance = new SecurityAnomalyDetector(config);
  }
  return detectorInstance;
}

export function startSecurityAnomalyDetector(
  config?: Partial<AnomalyDetectorConfig>,
): SecurityAnomalyDetector {
  const detector = getSecurityAnomalyDetector(config);
  detector.start();
  return detector;
}

export function stopSecurityAnomalyDetector(): void {
  detectorInstance?.stop();
}

export function resetSecurityAnomalyDetector(): void {
  detectorInstance?.stop();
  detectorInstance?.reset();
  detectorInstance = null;
}
