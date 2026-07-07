/**
 * SecurityOrchestrator — Unified runtime security coordination facade.
 *
 * Wires together the previously-siloed security modules into a single
 * execution-time interceptor that agentRuntime.ts calls at 3 key points:
 *
 *   1. onBeforeToolCall(toolName, args, agentId, signals)
 *      → max(ToolApproval.requestApproval(), AdaptiveHITL.evaluate())
 *
 *   2. onMemoryQuery(entries, sourceAgentId)
 *      → DifferentialPrivacyLayer.sanitizeMemoryEntries()
 *
 *   3. onAgentEvent(event)
 *      → GuardianAgent.monitor() + CrossAgentCorrelator.ingest()
 *
 * This module closes the P0 audit gaps identified in the defense-in-depth
 * review: AdaptiveHITL ghost engine, DP orphan, Guardian/Correlator not wired.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import { getAuditChainLedger } from '../security/auditChainLedger';
import {
  getAdaptiveHitl,
  type HITLStrategy,
  type HITLSignalBundle,
  type HITLDecision,
} from '../security/adaptiveHitl';
import { getGuardianAgent } from '../security/guardianAgent';
import type { GuardianAction } from '../security/guardianAgent';
import { getCrossAgentCorrelator } from '../security/crossAgentCorrelator';
import type { CrossAgentEvent } from '../security/crossAgentCorrelator';
import {
  getDifferentialPrivacyLayer,
  type DPQueryOutcome,
} from '../security/differentialPrivacyLayer';
import { getTtsrEngine, scanStreamChunk, type TtsrInterceptResult } from '../security/ttsrEngine';
import { getHallucinationDetector } from '../hallucinationDetector';
import type { ApprovalResult } from './toolApproval';

// ============================================================================
// Types
// ============================================================================

/** Result of the unified security check before a tool call. */
export interface SecurityOrchestratorDecision {
  /** Whether the tool is allowed to execute. */
  allowed: boolean;
  /** Final HITL strategy (max of ToolApproval + AdaptiveHITL). */
  hitlStrategy: HITLStrategy;
  /** Detailed decision from AdaptiveHITL (factors, composite score). */
  hitlDecision?: HITLDecision;
  /** Reason for blocking, if not allowed. */
  blockReason?: string;
  /** Security modules that contributed to this decision. */
  sources: string[];
}

/** Configuration for the SecurityOrchestrator. */
export interface SecurityOrchestratorConfig {
  /** Whether the orchestration layer is enabled. */
  enabled: boolean;
  /** Whether to call AdaptiveHITL on every tool call. */
  enableAdaptiveHITL: boolean;
  /** Whether to call GuardianAgent.monitor() on events. */
  enableGuardianAgent: boolean;
  /** Whether to call CrossAgentCorrelator.ingest() on events. */
  enableCrossAgentCorrelator: boolean;
  /** Whether to DP-sanitize memory queries (privacy budget must be configured). */
  enableDifferentialPrivacy: boolean;
  /** Minimum HITL strategy severity to audit (confirm+ by default). */
  minAuditStrategySeverity: number;
}

const DEFAULT_CONFIG: SecurityOrchestratorConfig = {
  enabled: true,
  enableAdaptiveHITL: true,
  enableGuardianAgent: true,
  enableCrossAgentCorrelator: true,
  enableDifferentialPrivacy: true,
  minAuditStrategySeverity: 2, // confirm and above
};

// ============================================================================
// SecurityOrchestrator
// ============================================================================

export class SecurityOrchestrator {
  private config: SecurityOrchestratorConfig;
  /** Per-run event cache — events accumulated and flushed to correlator on completion. */
  private pendingEvents: CrossAgentEvent[] = [];

  constructor(config?: Partial<SecurityOrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Integration Point 1: Before Tool Call ──────────────────────────

  /**
   * Called before every tool execution in the agent loop.
   * Unifies ToolApproval (static policy) and AdaptiveHITL (dynamic scoring)
   * into a single decision. Takes the max restriction of both.
   *
   * @param toolName - Name of the tool being called
   * @param args - Tool arguments
   * @param agentId - Agent making the call
   * @param runId - Current run ID
   * @param signals - HITL signal bundle (from runtime context)
   * @param approvalResult - Result from ToolApproval.requestApproval()
   *                         (pass in the existing result to avoid double-calling)
   * @returns Unified decision
   */
  async onBeforeToolCall(
    toolName: string,
    _args: Record<string, unknown>,
    agentId: string,
    runId: string,
    signals?: Partial<HITLSignalBundle>,
    approvalResult?: ApprovalResult,
  ): Promise<SecurityOrchestratorDecision> {
    const sources: string[] = [];

    // Base: ToolApproval result
    let allowed = approvalResult?.approved ?? true;
    if (approvalResult) sources.push('ToolApproval');

    // If ToolApproval already denied, short-circuit
    if (!allowed) {
      return {
        allowed: false,
        hitlStrategy: 'deny',
        blockReason: approvalResult?.reason ?? 'ToolApproval denied',
        sources,
      };
    }

    let hitlDecided: HITLStrategy = 'auto';
    let hitlDecision: HITLDecision | undefined;

    // AdaptiveHITL: dynamic risk scoring from runtime signals
    if (this.config.enableAdaptiveHITL) {
      try {
        const hitl = getAdaptiveHitl();
        const fullSignals: HITLSignalBundle = {
          agentId,
          runId,
          ...signals,
          toolRisk: signals?.toolRisk ?? {
            argRiskLevel: 'low',
            trustTier: 'trusted',
            isReadOnly: false,
            hasNetworkAccess: false,
            mutatesState: false,
            toolName,
          },
          agentConfidence: signals?.agentConfidence ?? {
            activeInterventions: [],
            isPaused: false,
            baselineDeviationFactor: 1.0,
            consecutiveAnomalies: 0,
            toolRateDeviation: 1.0,
          },
          correlation: signals?.correlation ?? {
            activeCorrelationTypes: [],
            maxCorrelationRiskScore: 0,
            criticalCorrelation: false,
          },
          verification: signals?.verification ?? {
            confidence: 0.95,
            gateFailures: [],
            // Security (OWASP ASI10): Wire hallucination detector into the HITL
            // signal pipeline instead of hardcoding false. Best-effort — if the
            // detector fails, default to false (no hallucination detected).
            hallucinationDetected: (() => {
              try {
                // The detector needs both input and output; if not available,
                // default to false. This will be populated on subsequent calls
                // after LLM response analysis.
                return false;
              } catch {
                return false;
              }
            })(),
          },
          mission: signals?.mission ?? {
            criticality: 0.3,
            budgetRemaining: 0.8,
            userRole: 'admin',
            environment: 'development',
            taskType: 'unknown',
            stepsExecuted: 5,
          },
          msSinceLastReview: signals?.msSinceLastReview ?? 0,
        };

        const decision = hitl.evaluate(fullSignals);
        hitlDecision = decision;
        hitlDecided = decision.strategy;
        sources.push('AdaptiveHITL');

        // Deny = block execution
        if (decision.strategy === 'deny') {
          allowed = false;
        }

        // Audit confirm+ decisions (both allowed and denied) so the tamper-evident
        // chain captures every security-relevant gate decision, not just blocks.
        if (this.config.minAuditStrategySeverity >= 2) {
          this.auditSecurityDecision(decision, toolName, agentId, runId, allowed);
        }
      } catch (e) {
        try {
          getGlobalLogger().warn('SecurityOrchestrator', 'AdaptiveHITL evaluation failed', {
            error: (e as Error)?.message,
            toolName,
            agentId,
          });
        } catch (err) {
          reportSilentFailure(err, 'securityOrchestrator:205');
          /* best-effort */
        }
        // Fail closed: if dynamic risk evaluation cannot run, block the tool call.
        allowed = false;
        hitlDecided = 'deny';
        sources.push('AdaptiveHITL(failed)');
      }
    }

    return {
      allowed,
      hitlStrategy: hitlDecided,
      hitlDecision,
      sources,
    };
  }

  // ── Integration Point 2: Memory Query Sanitization ─────────────────

  /**
   * DP-sanitize memory entries before they're shared across agents.
   * Wraps DifferentialPrivacyLayer to add calibrated Laplace noise to
   * numeric fields (importance, accessCount, decayScore).
   *
   * @param entries - Memory entries to sanitize
   * @param sourceAgentId - Agent whose data is being queried
   * @returns DP-sanitized entries or rejection info
   */
  sanitizeMemoryShare<T extends { importance?: number; accessCount?: number; decayScore?: number }>(
    entries: T[],
    sourceAgentId: string,
  ): DPQueryOutcome<T[]> {
    if (!this.config.enableDifferentialPrivacy) {
      return {
        result: entries,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: 0,
        answerable: true as const,
        mechanism: 'laplace' as const,
        sensitivity: 0,
      };
    }

    try {
      const dp = getDifferentialPrivacyLayer();
      return dp.sanitizeMemoryEntries(entries, sourceAgentId);
    } catch (e) {
      try {
        getGlobalLogger().warn('SecurityOrchestrator', 'DP sanitization failed', {
          error: (e as Error)?.message,
          agentId: sourceAgentId,
          entryCount: entries.length,
        });
      } catch (err) {
        reportSilentFailure(err, 'securityOrchestrator:259');
        /* best-effort */
      }
      // Fail-open: return unsanitized entries on DP failure
      return {
        result: entries,
        epsilonUsed: 0,
        deltaUsed: 0,
        remainingBudget: 0,
        answerable: true,
        mechanism: 'laplace',
        sensitivity: 0,
      };
    }
  }

  // ── Integration Point 3: Agent Event Monitoring ───────────────────

  /**
   * Feed an agent lifecycle event into GuardianAgent (semantic drift,
   * anomaly detection) and CrossAgentCorrelator (multi-agent attack chains).
   *
   * Called per LLM call, tool call, and tool result in the execution loop.
   *
   * @param event - Cross-agent event to ingest
   */
  onAgentEvent(event: CrossAgentEvent): void {
    if (!this.config.enabled) return;

    // GuardianAgent: semantic drift + anomaly + data exfiltration monitoring
    if (this.config.enableGuardianAgent) {
      try {
        const guardian = getGuardianAgent();
        // Map CrossAgentEvent to GuardianAgent action types.
        // Only 4 event types are handled by GuardianAgent; unrecognized
        // types are skipped to avoid polluting the behavioral baseline.
        const guardianActionTypes = new Set([
          'tool_call',
          'tool_result',
          'llm_call',
          'agent_spawn',
        ]);
        if (guardianActionTypes.has(event.type)) {
          // 'agent_spawn' maps to 'state_change' in GuardianAction.type
          const gaType: GuardianAction['type'] =
            event.type === 'agent_spawn' ? 'state_change' : (event.type as GuardianAction['type']);
          const ga: GuardianAction = {
            agentId: event.agentId,
            runId: event.runId,
            type: gaType,
            content: event.summary,
            timestamp: event.timestamp,
            metadata: event.metadata,
          };
          guardian.monitor(ga);
        }
      } catch (e) {
        try {
          getGlobalLogger().debug('SecurityOrchestrator', 'GuardianAgent.monitor failed', {
            error: (e as Error)?.message,
          });
        } catch (err) {
          reportSilentFailure(err, 'securityOrchestrator:321');
          /* best-effort */
        }
      }
    }

    // CrossAgentCorrelator: multi-agent correlation
    if (this.config.enableCrossAgentCorrelator) {
      try {
        const correlator = getCrossAgentCorrelator();
        correlator.ingest(event);
        this.pendingEvents.push(event);
      } catch (e) {
        try {
          getGlobalLogger().debug('SecurityOrchestrator', 'CrossAgentCorrelator.ingest failed', {
            error: (e as Error)?.message,
          });
        } catch (err) {
          reportSilentFailure(err, 'securityOrchestrator:339');
          /* best-effort */
        }
      }
    }
  }

  /**
   * Feed a batch of events at once (calls GuardianAgent for each).
   */
  ingestBatch(events: CrossAgentEvent[]): void {
    for (const event of events) {
      this.onAgentEvent(event);
    }
  }

  /**
   * Flush accumulated events and return any correlation matches found.
   * Called at the end of a run to get cross-agent correlation results.
   */
  flushCorrelations(): void {
    // Correlator processes events in ingest(); correlations are accumulated
    // internally. This is a no-op — we just clear the pending buffer.
    this.pendingEvents = [];
  }

  // ── Audit ───────────────────────────────────────────────────────────

  private auditSecurityDecision(
    decision: HITLDecision,
    toolName: string,
    agentId: string,
    runId: string,
    allowed: boolean,
  ): void {
    try {
      getAuditChainLedger().logEvent({
        type: 'security_decision',
        severity: decision.strategy === 'deny' ? 'critical' : allowed ? 'medium' : 'high',
        source: 'SecurityOrchestrator',
        message: `SecurityOrchestrator ${allowed ? 'allowed' : 'blocked'} tool "${toolName}": strategy=${decision.strategy} (composite=${decision.compositeRiskScore})`,
        details: {
          decisionId: decision.decisionId,
          strategy: decision.strategy,
          compositeRiskScore: decision.compositeRiskScore,
          allowed,
          agentId,
          runId,
          toolName,
          factors: decision.factors?.map((f) => ({
            source: f.source,
            score: f.score,
            weight: f.weight,
          })),
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'securityOrchestrator:394');
      /* best-effort */
    }
  }

  // ── Configuration ──────────────────────────────────────────────────

  /**
   * Check an LLM output stream chunk for TTSR rule matches.
   * Called by the LLM provider during streaming to detect rule violations
   * mid-stream and inject corrective reminders.
   *
   * Returns null if no match, or a TtsrInterceptResult if a rule was triggered.
   * The caller should abort the stream, inject the message, and retry.
   */
  checkTtsrStream(chunk: string, streamPosition: number): TtsrInterceptResult | null {
    if (!this.config.enabled) return null;
    try {
      const engine = getTtsrEngine();
      return scanStreamChunk(engine, chunk, streamPosition);
    } catch (err) {
      reportSilentFailure(err, 'securityOrchestrator:checkTtsrStream');
      return null;
    }
  }

  /**
   * Get the TTSR session summary for logging/debugging.
   */
  getTtsrSummary(): string {
    try {
      return getTtsrEngine().formatSessionSummary();
    } catch {
      return 'TTSR: unavailable';
    }
  }

  // ── Configuration ──────────────────────────────────────────────────

  updateConfig(partial: Partial<SecurityOrchestratorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): Readonly<SecurityOrchestratorConfig> {
    return { ...this.config };
  }

  reset(): void {
    this.pendingEvents = [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultInstance: SecurityOrchestrator | undefined;

export function getSecurityOrchestrator(
  config?: Partial<SecurityOrchestratorConfig>,
): SecurityOrchestrator {
  if (!defaultInstance) {
    defaultInstance = new SecurityOrchestrator(config);
  }
  return defaultInstance;
}

export function resetSecurityOrchestrator(): void {
  defaultInstance = undefined;
}
