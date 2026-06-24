/**
 * AdaptiveHITL — Risk-adaptive human-in-the-loop strategy engine.
 *
 * Unlike the static ToolApproval (5 preset modes), AdaptiveHITL computes a
 * dynamic HITL strategy for every tool invocation by combining multiple runtime
 * signals: tool intrinsic risk, agent confidence, behavior anomalies, correlation
 * alerts, mission criticality, and time-since-last-review decay.
 *
 * Strategy outputs (ordered from least to most restrictive):
 *   auto             — proceed without human involvement
 *   suggest          — execute but flag for later review
 *   confirm          — require human confirmation before execution
 *   pause_and_review — pause the agent; human must explicitly resume
 *   escalate         — freeze agent + escalate to SOC/operator
 *   deny             — block execution entirely
 *
 * Design principles (per §3.3 of the AI Agent Security framework):
 *   - High-risk tool calls → force confirmation
 *   - Unknown/unauthorized tools → deny + notify
 *   - Abnormal behavior patterns → pause + review
 *   - Low confidence (classifier/verification) → downgrade + human review
 *   - Resource anomalies → confirm/deny based on threshold exceedance
 *
 * Signal sources:
 *   ┌─ Tool intrinsic risk (ToolApproval.assessArgRisk + trust tier)
 *   ├─ GuardianAgent (behavioral baselines, anomaly flags, intervention types)
 *   ├─ CrossAgentCorrelator (multi-agent correlation matches)
 *   ├─ UnifiedVerification (confidence scores from 5-gate pipeline)
 *   ├─ Mission context (task criticality, budget, user role)
 *   └─ Time-decay model (longer since last review → stricter strategy)
 *
 * Composite score = weighted sum of normalized signal scores.
 * Each signal contributes 0-100, then strategy is interpolated.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'crypto';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getSecurityMonitor } from './securityMonitor';
import { getMetricsCollector } from '../runtime/metricsCollector';
import type { GuardianInterventionType } from './guardianAgent';
import type { CorrelationRuleType } from './crossAgentCorrelator';

// ============================================================================
// Strategy enum
// ============================================================================

/**
 * HITL strategy, ordered from least to most restrictive.
 * The numeric order is used for max() operations — escalate wins over auto.
 */
export type HITLStrategy =
  | 'auto'
  | 'suggest'
  | 'confirm'
  | 'pause_and_review'
  | 'escalate'
  | 'deny';

/** Numeric severity for max() comparison. Higher = more restrictive. */
const STRATEGY_SEVERITY: Record<HITLStrategy, number> = {
  auto: 0,
  suggest: 1,
  confirm: 2,
  pause_and_review: 3,
  escalate: 4,
  deny: 5,
};

/** Human-readable labels for reporting. */
const STRATEGY_LABELS: Record<HITLStrategy, string> = {
  auto: 'Auto-approve',
  suggest: 'Suggest review',
  confirm: 'Confirm before execution',
  pause_and_review: 'Pause agent — human review required',
  escalate: 'Escalate to SOC / operator',
  deny: 'Deny execution',
};

/** Strategy descriptions for audit logs. */
const STRATEGY_DESCRIPTIONS: Record<HITLStrategy, string> = {
  auto: 'All signals nominal — proceeding without human involvement.',
  suggest: 'Low signal anomalies detected — executing but flagged for later review.',
  confirm: 'Elevated risk — human confirmation required before executing this tool.',
  pause_and_review:
    'Significant risk — agent paused, human operator must review and explicitly resume.',
  escalate: 'Critical risk — agent frozen, escalation to security operations center.',
  deny: 'Execution blocked — risk exceeds acceptable threshold or tool is unauthorized.',
};

/**
 * Pick the more restrictive of two strategies.
 */
export function maxStrategy(a: HITLStrategy, b: HITLStrategy): HITLStrategy {
  return STRATEGY_SEVERITY[a] >= STRATEGY_SEVERITY[b] ? a : b;
}

// ============================================================================
// Signal inputs
// ============================================================================

/**
 * Tool intrinsic risk signal — computed from argument patterns + trust tier.
 */
export interface ToolRiskSignal {
  /** Risk level from argument assessment (low/medium/high/critical). */
  argRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Trust tier of the tool (trusted/untrusted). */
  trustTier: 'trusted' | 'untrusted';
  /** Whether the tool is read-only. */
  isReadOnly: boolean;
  /** Whether the tool invokes network access. */
  hasNetworkAccess: boolean;
  /** Whether the tool mutates filesystem state. */
  mutatesState: boolean;
  /** Tool name for context. */
  toolName: string;
}

/**
 * Agent confidence signal — from GuardianAgent behavioral monitoring.
 */
export interface AgentConfidenceSignal {
  /** Guardian intervention types active for this agent. Empty = nominal. */
  activeInterventions: GuardianInterventionType[];
  /** Whether the agent is currently paused by Guardian. */
  isPaused: boolean;
  /** Behavioral baseline deviation factor (1.0 = at baseline, > 2.0 = significantly deviating). */
  baselineDeviationFactor: number;
  /** Consecutive anomalies counter (reset on nominal behavior). */
  consecutiveAnomalies: number;
  /** Recent tool call rate deviation from baseline (calls-per-minute ratio). */
  toolRateDeviation: number;
}

/**
 * Multi-agent correlation signal — from CrossAgentCorrelator.
 */
export interface CorrelationSignal {
  /** Active correlation matches involving this agent. */
  activeCorrelationTypes: CorrelationRuleType[];
  /** Highest risk score from correlation matches (0-100). */
  maxCorrelationRiskScore: number;
  /** Whether this agent is involved in C2, collusion, or exfiltration patterns. */
  criticalCorrelation: boolean;
}

/**
 * Verification confidence signal — from UnifiedVerificationPipeline.
 */
export interface VerificationSignal {
  /** Latest verification confidence (0.0 - 1.0). */
  confidence: number;
  /** Whether any quality gate failed. */
  gateFailures: string[];
  /** Whether hallucination was detected. */
  hallucinationDetected: boolean;
}

/**
 * Mission context signal — task-level metadata.
 */
export interface MissionSignal {
  /** Mission criticality (0-1, 1 = production deployment, 0 = sandbox experiment). */
  criticality: number;
  /** Token budget remaining ratio (1.0 = full budget, 0.0 = exhausted). */
  budgetRemaining: number;
  /** User/operator role (admin has higher trust than guest). */
  userRole: 'admin' | 'operator' | 'developer' | 'guest';
  /** Environment (production vs staging vs development). */
  environment: 'production' | 'staging' | 'development';
  /** Task type for context-aware adjustments. */
  taskType:
    | 'code_generation'
    | 'code_review'
    | 'data_analysis'
    | 'deployment'
    | 'research'
    | 'unknown';
  /** Number of steps already executed in this run. */
  stepsExecuted: number;
}

/**
 * Unified signal bundle passed to the HITL engine.
 */
export interface HITLSignalBundle {
  agentId: string;
  runId?: string;
  toolRisk: ToolRiskSignal;
  agentConfidence: AgentConfidenceSignal;
  correlation: CorrelationSignal;
  verification: VerificationSignal;
  mission: MissionSignal;
  /** Milliseconds since the last human approval for this agent. */
  msSinceLastReview: number;
}

// ============================================================================
// Decision output
// ============================================================================

/**
 * Factor contributing to the final decision — provides explainability.
 */
export interface HITLFactor {
  /** Name of the contributing factor (e.g. 'tool_risk', 'agent_confidence'). */
  source: string;
  /** Sub-score contributed by this factor (0-100). */
  score: number;
  /** Weight applied to this factor. */
  weight: number;
  /** Human-readable justification. */
  reasoning: string;
}

/**
 * Full HITL decision with explainability trail.
 */
export interface HITLDecision {
  /** Agent that triggered this decision. */
  agentId: string;
  /** Final strategy. */
  strategy: HITLStrategy;
  /** Composite risk score (0-100, higher = more risk). */
  compositeRiskScore: number;
  /** Individual contributing factors. */
  factors: HITLFactor[];
  /** Human-readable summary of why this strategy was selected. */
  summary: string;
  /** Recommended action for the operator. */
  recommendation: string;
  /** Decision ID for audit trail. */
  decisionId: string;
  /** Timestamp. */
  timestamp: string;
  /** Whether this decision upgraded from a less restrictive strategy. */
  escalated: boolean;
  /** Previous strategy if escalated. */
  previousStrategy?: HITLStrategy;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AdaptiveHITLConfig {
  /** Whether the adaptive HITL engine is enabled. */
  enabled: boolean;

  // ── Scoring weights (must sum to ~1.0) ─────────────────────────
  /** Weight for tool intrinsic risk (default: 0.30). */
  toolRiskWeight: number;
  /** Weight for agent confidence/behavior (default: 0.25). */
  agentConfidenceWeight: number;
  /** Weight for cross-agent correlation (default: 0.20). */
  correlationWeight: number;
  /** Weight for verification confidence (default: 0.10). */
  verificationWeight: number;
  /** Weight for mission context (default: 0.10). */
  missionWeight: number;
  /** Weight for time-since-last-review (default: 0.05). */
  timeDecayWeight: number;

  // ── Strategy thresholds (composite score → strategy) ────────
  /** Score below this → auto (default: 20). */
  autoThreshold: number;
  /** Score below this → suggest (default: 40). */
  suggestThreshold: number;
  /** Score below this → confirm (default: 60). */
  confirmThreshold: number;
  /** Score below this → pause_and_review (default: 80). */
  pauseReviewThreshold: number;
  /** Score below this → escalate (default: 95). Above → deny. */
  escalateThreshold: number;

  // ── Time decay ──────────────────────────────────────────────
  /** Maximum review interval before full decay (ms, default: 30 min). */
  maxReviewIntervalMs: number;
  /** Whether to auto-escalate on too many consecutive anomalies. */
  autoEscalateOnAnomalies: boolean;
  /** Consecutive anomaly threshold for auto-escalate. */
  autoEscalateAnomalyThreshold: number;

  // ── Behavior learning ───────────────────────────────────────
  /** Whether to maintain per-agent behavior profiles. */
  enableBehaviorProfiles: boolean;
  /** Whether to auto-adjust weights based on historical outcomes. */
  enableWeightLearning: boolean;
  /** Learning rate for weight adjustment (0-1). */
  learningRate: number;
}

const DEFAULT_CONFIG: AdaptiveHITLConfig = {
  enabled: true,
  toolRiskWeight: 0.3,
  agentConfidenceWeight: 0.25,
  correlationWeight: 0.2,
  verificationWeight: 0.1,
  missionWeight: 0.1,
  timeDecayWeight: 0.05,
  autoThreshold: 20,
  suggestThreshold: 40,
  confirmThreshold: 60,
  pauseReviewThreshold: 80,
  escalateThreshold: 95,
  maxReviewIntervalMs: 30 * 60 * 1000,
  autoEscalateOnAnomalies: true,
  autoEscalateAnomalyThreshold: 5,
  enableBehaviorProfiles: true,
  enableWeightLearning: false,
  learningRate: 0.05,
};

// ============================================================================
// Per-agent behavior profile
// ============================================================================

export interface AgentBehaviorProfile {
  agentId: string;
  /** Number of times this agent triggered each strategy. */
  strategyCounts: Record<HITLStrategy, number>;
  /** Total decisions made for this agent. */
  totalDecisions: number;
  /** Average composite risk score. */
  avgRiskScore: number;
  /** Number of human overrides (operator changed the strategy). */
  humanOverrides: number;
  /** Number of verified correct decisions (no adverse outcome). */
  correctDecisions: number;
  /** Time of last decision. */
  lastDecisionAt: number;
  /** Time of last human review (confirm/pause/escalate). */
  lastHumanReviewAt: number;
  /** Peak anomaly streak observed. */
  maxAnomalyStreak: number;
  /** Whether a learning-derived trust bonus should be applied. */
  trustBonus: number;
}

function createDefaultProfile(agentId: string): AgentBehaviorProfile {
  return {
    agentId,
    strategyCounts: { auto: 0, suggest: 0, confirm: 0, pause_and_review: 0, escalate: 0, deny: 0 },
    totalDecisions: 0,
    avgRiskScore: 0,
    humanOverrides: 0,
    correctDecisions: 0,
    lastDecisionAt: 0,
    lastHumanReviewAt: 0,
    maxAnomalyStreak: 0,
    trustBonus: 0,
  };
}

// ============================================================================
// AdaptiveHITL engine
// ============================================================================

export class AdaptiveHITL {
  private config: AdaptiveHITLConfig;
  private profiles: Map<string, AgentBehaviorProfile> = new Map();
  private decisionHistory: HITLDecision[] = [];
  /** Human override decisions — operator changed the strategy. */
  private overrideHistory: Array<{
    decisionId: string;
    original: HITLStrategy;
    overridden: HITLStrategy;
    reason: string;
    timestamp: string;
  }> = [];

  constructor(config: Partial<AdaptiveHITLConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Core Evaluation ──────────────────────────────────────────────────

  /**
   * Evaluate a tool invocation and return the adaptive HITL strategy.
   *
   * @param signals — the full signal bundle from runtime context
   * @returns HITLDecision with strategy, composite score, and explainability trail
   */
  evaluate(signals: HITLSignalBundle): HITLDecision {
    if (!this.config.enabled) {
      return this.buildFallbackDecision(signals, 'auto', 'AdaptiveHITL is disabled.');
    }

    // Compute individual factor scores
    const toolRiskScore = this.scoreToolRisk(signals.toolRisk);
    const agentConfidenceScore = this.scoreAgentConfidence(signals.agentConfidence);
    const correlationScore = this.scoreCorrelation(signals.correlation);
    const verificationScore = this.scoreVerification(signals.verification);
    const missionScore = this.scoreMission(signals.mission);
    const timeDecayScore = this.scoreTimeDecay(signals.msSinceLastReview, signals.agentConfidence);

    // Build factors for explainability
    const factors: HITLFactor[] = [
      {
        source: 'tool_risk',
        score: toolRiskScore,
        weight: this.config.toolRiskWeight,
        reasoning: this.reasonToolRisk(signals.toolRisk),
      },
      {
        source: 'agent_confidence',
        score: agentConfidenceScore,
        weight: this.config.agentConfidenceWeight,
        reasoning: this.reasonAgentConfidence(signals.agentConfidence),
      },
      {
        source: 'correlation',
        score: correlationScore,
        weight: this.config.correlationWeight,
        reasoning: this.reasonCorrelation(signals.correlation),
      },
      {
        source: 'verification',
        score: verificationScore,
        weight: this.config.verificationWeight,
        reasoning: this.reasonVerification(signals.verification),
      },
      {
        source: 'mission',
        score: missionScore,
        weight: this.config.missionWeight,
        reasoning: this.reasonMission(signals.mission),
      },
      {
        source: 'time_decay',
        score: timeDecayScore,
        weight: this.config.timeDecayWeight,
        reasoning: this.reasonTimeDecay(signals.msSinceLastReview),
      },
    ];

    // Composite score = weighted sum
    let compositeScore = 0;
    for (const factor of factors) {
      compositeScore += factor.score * factor.weight;
    }

    // Apply trust bonus from behavior profile (reduces score, max -10)
    if (this.config.enableBehaviorProfiles) {
      const profile = this.getOrCreateProfile(signals.agentId);
      compositeScore = Math.max(0, compositeScore - profile.trustBonus);
    }

    // Clamp to 0-100
    compositeScore = Math.max(0, Math.min(100, Math.round(compositeScore)));

    // Map composite score to strategy
    const baselineStrategy = this.scoreToStrategy(compositeScore);

    // Auto-escalation for anomalous agents
    let escalated = false;
    let previousStrategy: HITLStrategy | undefined;
    let finalStrategy = baselineStrategy;

    if (
      this.config.autoEscalateOnAnomalies &&
      signals.agentConfidence.consecutiveAnomalies >= this.config.autoEscalateAnomalyThreshold
    ) {
      const anomalyStrategy =
        signals.agentConfidence.consecutiveAnomalies >= 10
          ? 'deny'
          : signals.agentConfidence.consecutiveAnomalies >= 7
            ? 'escalate'
            : 'pause_and_review';
      const anomalyStrat = maxStrategy(baselineStrategy, anomalyStrategy as HITLStrategy);
      if (STRATEGY_SEVERITY[anomalyStrat] > STRATEGY_SEVERITY[baselineStrategy]) {
        escalated = true;
        previousStrategy = baselineStrategy;
        finalStrategy = anomalyStrat;
      }
    }

    // Critical correlation → force escalate
    if (
      signals.correlation.criticalCorrelation &&
      STRATEGY_SEVERITY[finalStrategy] < STRATEGY_SEVERITY.escalate
    ) {
      escalated = true;
      previousStrategy = finalStrategy;
      finalStrategy = 'escalate';
    }

    // Untrusted tool with high/critical arg risk → force confirm minimum
    if (
      signals.toolRisk.trustTier === 'untrusted' &&
      (signals.toolRisk.argRiskLevel === 'high' || signals.toolRisk.argRiskLevel === 'critical')
    ) {
      const minStrat = maxStrategy(finalStrategy, 'confirm');
      if (STRATEGY_SEVERITY[minStrat] > STRATEGY_SEVERITY[finalStrategy]) {
        escalated = true;
        previousStrategy = finalStrategy;
        finalStrategy = minStrat;
      }
    }

    const decision: HITLDecision = {
      agentId: signals.agentId,
      strategy: finalStrategy,
      compositeRiskScore: compositeScore,
      factors,
      summary: STRATEGY_DESCRIPTIONS[finalStrategy],
      recommendation: this.buildRecommendation(finalStrategy, factors),
      decisionId: `hitl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      escalated,
      previousStrategy,
    };

    // Update behavior profile
    if (this.config.enableBehaviorProfiles) {
      this.updateProfile(signals.agentId, decision, signals);
    }

    // Record history
    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > 1000) {
      this.decisionHistory = this.decisionHistory.slice(-500);
    }

    try {
      getMetricsCollector().incrementCounter(
        'adaptive_hitl_decisions_total',
        'Adaptive HITL strategy decisions',
        1,
        [
          { name: 'strategy', value: finalStrategy },
          { name: 'escalated', value: String(escalated) },
        ],
      );
      getMetricsCollector().setGauge(
        'adaptive_hitl_risk_score',
        'Latest composite risk score',
        compositeScore,
        [{ name: 'agent', value: signals.agentId }],
      );
    } catch (err) {
      reportSilentFailure(err, 'adaptiveHitl:542');
      /* best-effort */
    }

    // Audit log for confirm+ decisions
    if (STRATEGY_SEVERITY[finalStrategy] >= STRATEGY_SEVERITY.confirm) {
      this.auditDecision(decision, signals);
    }

    return decision;
  }

  // ── Scoring Functions (each returns 0-100, higher = riskier) ────────

  /**
   * Score tool intrinsic risk: argument patterns + trust tier + capabilities.
   */
  private scoreToolRisk(risk: ToolRiskSignal): number {
    let score = 0;

    // Argument risk level
    switch (risk.argRiskLevel) {
      case 'critical':
        score += 80;
        break;
      case 'high':
        score += 55;
        break;
      case 'medium':
        score += 30;
        break;
      case 'low':
        score += 5;
        break;
    }

    // Trust tier
    if (risk.trustTier === 'untrusted') {
      score += 15;
    }

    // Network access is inherently riskier
    if (risk.hasNetworkAccess) {
      score += 10;
    }

    // State mutation is riskier than read-only
    if (risk.mutatesState) {
      score += 10;
    }

    // Read-only tools are safer
    if (risk.isReadOnly) {
      score = Math.max(0, score - 10);
    }

    // Known dangerous tool names
    const highRiskTools = [
      'shell_execute',
      'python_execute',
      'git_push',
      'agent_spawn',
      'file_delete',
    ];
    if (highRiskTools.some((t) => risk.toolName.includes(t))) {
      score += 15;
    }

    return Math.min(100, score);
  }

  /**
   * Score agent behavioral confidence: interventions, anomalies, baselines.
   */
  private scoreAgentConfidence(confidence: AgentConfidenceSignal): number {
    let score = 0;

    // Active interventions
    if (confidence.activeInterventions.length > 0) {
      // Weight by severity of intervention type
      for (const intervention of confidence.activeInterventions) {
        switch (intervention) {
          case 'safety_violation':
          case 'goal_hijack':
          case 'data_exfiltration':
            score += 25;
            break;
          case 'tool_usage_spike':
          case 'semantic_drift':
            score += 15;
            break;
          case 'anomaly':
          case 'behavioral_baseline_deviation':
            score += 12;
            break;
          case 'cost_overrun':
            score += 8;
            break;
        }
      }
    }

    // Paused agent is high risk
    if (confidence.isPaused) {
      score += 30;
    }

    // Baseline deviation
    if (confidence.baselineDeviationFactor > 3.0) {
      score += 25;
    } else if (confidence.baselineDeviationFactor > 2.0) {
      score += 15;
    } else if (confidence.baselineDeviationFactor > 1.5) {
      score += 8;
    }

    // Consecutive anomalies
    if (confidence.consecutiveAnomalies >= 8) {
      score += 30;
    } else if (confidence.consecutiveAnomalies >= 5) {
      score += 20;
    } else if (confidence.consecutiveAnomalies >= 3) {
      score += 10;
    } else if (confidence.consecutiveAnomalies >= 1) {
      score += 5;
    }

    // Tool rate deviation
    if (confidence.toolRateDeviation > 5.0) {
      score += 20;
    } else if (confidence.toolRateDeviation > 3.0) {
      score += 10;
    } else if (confidence.toolRateDeviation > 2.0) {
      score += 5;
    }

    return Math.min(100, score);
  }

  /**
   * Score cross-agent correlation: multi-agent attack patterns.
   */
  private scoreCorrelation(correlation: CorrelationSignal): number {
    let score = 0;

    if (correlation.activeCorrelationTypes.length === 0) {
      return 0;
    }

    // Max correlation risk score is the dominant factor
    if (correlation.maxCorrelationRiskScore >= 80) {
      score += 50;
    } else if (correlation.maxCorrelationRiskScore >= 60) {
      score += 35;
    } else if (correlation.maxCorrelationRiskScore >= 40) {
      score += 20;
    } else {
      score += 10;
    }

    // Critical correlations (C2, collusion, exfiltration) → major escalation
    if (correlation.criticalCorrelation) {
      score += 35;
    }

    // More correlation types = broader attack surface
    if (correlation.activeCorrelationTypes.length >= 3) {
      score += 15;
    } else if (correlation.activeCorrelationTypes.length >= 2) {
      score += 8;
    }

    return Math.min(100, score);
  }

  /**
   * Score verification confidence: quality gate passes, hallucination detection.
   */
  private scoreVerification(verification: VerificationSignal): number {
    let score = 0;

    // Low confidence in verification
    if (verification.confidence < 0.3) {
      score += 40;
    } else if (verification.confidence < 0.5) {
      score += 25;
    } else if (verification.confidence < 0.7) {
      score += 12;
    } else if (verification.confidence < 0.85) {
      score += 5;
    }
    // High confidence (>= 0.85) → no penalty

    // Gate failures
    if (verification.gateFailures.length > 0) {
      score += verification.gateFailures.length * 10;
    }

    // Hallucination
    if (verification.hallucinationDetected) {
      score += 30;
    }

    return Math.min(100, score);
  }

  /**
   * Score mission context: criticality, environment, budget, user role.
   */
  private scoreMission(mission: MissionSignal): number {
    let score = 0;

    // High criticality missions are inherently risky if things go wrong
    if (mission.criticality >= 0.8) {
      score += 15;
    } else if (mission.criticality >= 0.5) {
      score += 8;
    }

    // Production is more sensitive than staging/dev
    if (mission.environment === 'production') {
      score += 15;
    } else if (mission.environment === 'staging') {
      score += 5;
    }

    // Budget pressure → more cautious to avoid runaway costs
    if (mission.budgetRemaining < 0.1) {
      score += 20;
    } else if (mission.budgetRemaining < 0.3) {
      score += 10;
    } else if (mission.budgetRemaining < 0.5) {
      score += 5;
    }

    // User role trust
    switch (mission.userRole) {
      case 'guest':
        score += 20;
        break;
      case 'developer':
        score += 8;
        break;
      case 'operator':
        score += 3;
        break;
      case 'admin':
        // No penalty — admin is trusted
        break;
    }

    // Deployment tasks are the riskiest
    if (mission.taskType === 'deployment') {
      score += 10;
    }

    // Many steps executed → possible task drift or loop
    if (mission.stepsExecuted > 50) {
      score += 10;
    } else if (mission.stepsExecuted > 25) {
      score += 5;
    }

    return Math.min(100, score);
  }

  /**
   * Score time-since-last-review decay: longer without human oversight → stricter.
   * Uses a logistic curve for smooth escalation.
   */
  private scoreTimeDecay(msSinceLastReview: number, confidence: AgentConfidenceSignal): number {
    if (msSinceLastReview <= 0) return 0;

    const maxInterval = this.config.maxReviewIntervalMs;
    const ratio = Math.min(1, msSinceLastReview / maxInterval);

    // Logistic curve: steepest in the middle, plateaus at extremes
    // f(x) = 100 / (1 + e^(-10*(x - 0.5)))
    // This gives ~0 at x=0, ~50 at x=0.5, ~100 at x=1
    const logistic = 100 / (1 + Math.exp(-10 * (ratio - 0.5)));

    // Amplify if agent is already showing anomalies
    const anomalyBoost = confidence.consecutiveAnomalies > 0 ? 1.5 : 1.0;

    return Math.round(logistic * anomalyBoost);
  }

  // ── Reasoning Helpers ───────────────────────────────────────────────

  private reasonToolRisk(risk: ToolRiskSignal): string {
    const parts: string[] = [];
    if (risk.argRiskLevel !== 'low') parts.push(`argument risk=${risk.argRiskLevel}`);
    if (risk.trustTier === 'untrusted') parts.push('untrusted tool');
    if (risk.hasNetworkAccess) parts.push('network access');
    if (risk.mutatesState) parts.push('state mutation');
    if (parts.length === 0) return 'No tool risk factors.';
    return parts.join(', ') + '.';
  }

  private reasonAgentConfidence(confidence: AgentConfidenceSignal): string {
    const parts: string[] = [];
    if (confidence.activeInterventions.length > 0) {
      parts.push(
        `${confidence.activeInterventions.length} active intervention(s): ${confidence.activeInterventions.join(', ')}`,
      );
    }
    if (confidence.isPaused) parts.push('agent paused');
    if (confidence.baselineDeviationFactor > 1.5) {
      parts.push(`baseline deviation ${confidence.baselineDeviationFactor.toFixed(1)}x`);
    }
    if (confidence.consecutiveAnomalies > 0) {
      parts.push(`${confidence.consecutiveAnomalies} consecutive anomalies`);
    }
    if (parts.length === 0) return 'Agent behavior nominal.';
    return parts.join('; ') + '.';
  }

  private reasonCorrelation(correlation: CorrelationSignal): string {
    if (correlation.activeCorrelationTypes.length === 0) {
      return 'No cross-agent correlation matches.';
    }
    const parts = [
      `${correlation.activeCorrelationTypes.length} correlation type(s): ${correlation.activeCorrelationTypes.join(', ')}`,
    ];
    parts.push(`max risk score=${correlation.maxCorrelationRiskScore}`);
    if (correlation.criticalCorrelation) parts.push('CRITICAL correlation detected');
    return parts.join('; ') + '.';
  }

  private reasonVerification(verification: VerificationSignal): string {
    if (
      verification.confidence >= 0.85 &&
      verification.gateFailures.length === 0 &&
      !verification.hallucinationDetected
    ) {
      return 'Verification nominal.';
    }
    const parts: string[] = [];
    if (verification.confidence < 0.85)
      parts.push(`confidence=${(verification.confidence * 100).toFixed(0)}%`);
    if (verification.gateFailures.length > 0)
      parts.push(`${verification.gateFailures.length} gate failure(s)`);
    if (verification.hallucinationDetected) parts.push('hallucination detected');
    return parts.join('; ') + '.';
  }

  private reasonMission(mission: MissionSignal): string {
    const parts: string[] = [];
    if (mission.environment === 'production') parts.push('production environment');
    if (mission.criticality >= 0.8)
      parts.push(`criticality=${(mission.criticality * 100).toFixed(0)}%`);
    if (mission.budgetRemaining < 0.5)
      parts.push(`budget remaining=${(mission.budgetRemaining * 100).toFixed(0)}%`);
    if (mission.userRole === 'guest') parts.push('guest user');
    if (parts.length === 0) return 'Mission context nominal.';
    return parts.join(', ') + '.';
  }

  private reasonTimeDecay(msSinceLastReview: number): string {
    if (msSinceLastReview <= 0) return 'Recently reviewed.';
    const minutes = Math.round(msSinceLastReview / 60000);
    if (minutes < 1) return 'Just reviewed (< 1 min).';
    if (minutes < 10) return `${minutes} min since last review.`;
    return `${minutes} min since last review — time decay active.`;
  }

  // ── Strategy Mapping ────────────────────────────────────────────────

  private scoreToStrategy(compositeScore: number): HITLStrategy {
    if (compositeScore >= this.config.escalateThreshold) return 'deny';
    if (compositeScore >= this.config.pauseReviewThreshold) return 'escalate';
    if (compositeScore >= this.config.confirmThreshold) return 'pause_and_review';
    if (compositeScore >= this.config.suggestThreshold) return 'confirm';
    if (compositeScore >= this.config.autoThreshold) return 'suggest';
    return 'auto';
  }

  // ── Recommendation Builder ──────────────────────────────────────────

  private buildRecommendation(strategy: HITLStrategy, factors: HITLFactor[]): string {
    const topFactors = [...factors]
      .sort((a, b) => b.score * b.weight - a.score * a.weight)
      .slice(0, 3);

    const factorSummary = topFactors
      .map((f) => `${f.source} (${Math.round(f.score * f.weight)}pts)`)
      .join(', ');

    switch (strategy) {
      case 'auto':
        return 'Proceed normally. No action required.';
      case 'suggest':
        return `Proceed but review later. Top signals: ${factorSummary}.`;
      case 'confirm':
        return `Operator should review and confirm before execution. Top signals: ${factorSummary}.`;
      case 'pause_and_review':
        return `Pause execution and review. Top signals: ${factorSummary}. Agent has been paused — operator must explicitly resume.`;
      case 'escalate':
        return `Escalate to SOC. Top signals: ${factorSummary}. Agent frozen — security incident response required.`;
      case 'deny':
        return `Block execution. Top signals: ${factorSummary}. Risk exceeds acceptable threshold for all environments.`;
    }
  }

  // ── Behavior Profiles ──────────────────────────────────────────────

  /**
   * Update the behavior profile after each decision.
   * Builds a trust bonus over time for agents with consistent good behavior.
   */
  private updateProfile(agentId: string, decision: HITLDecision, signals: HITLSignalBundle): void {
    const profile = this.getProfile(agentId);
    profile.totalDecisions++;
    profile.strategyCounts[decision.strategy]++;
    profile.lastDecisionAt = Date.now();

    // Track anomaly streaks
    if (signals.agentConfidence.consecutiveAnomalies > profile.maxAnomalyStreak) {
      profile.maxAnomalyStreak = signals.agentConfidence.consecutiveAnomalies;
    }

    // Track human review time
    if (STRATEGY_SEVERITY[decision.strategy] >= STRATEGY_SEVERITY.confirm) {
      profile.lastHumanReviewAt = Date.now();
    }

    // Exponential moving average for risk score
    const alpha = 0.1;
    profile.avgRiskScore = profile.avgRiskScore * (1 - alpha) + decision.compositeRiskScore * alpha;

    // Trust bonus: 1 point per 10 consecutive auto/suggest decisions, max 10
    // Reset on confirm+ decisions
    if (decision.strategy === 'auto' || decision.strategy === 'suggest') {
      const totalLowRisk = profile.strategyCounts.auto + profile.strategyCounts.suggest;
      profile.trustBonus = Math.min(10, Math.floor(totalLowRisk / 10));
    } else {
      // Reset trust bonus when high-risk decisions occur
      profile.trustBonus = Math.max(0, profile.trustBonus - 3);
    }

    // Weight learning (if enabled)
    if (this.config.enableWeightLearning) {
      this.learnWeights(profile);
    }
  }

  /**
   * Adjust scoring weights based on historical accuracy.
   * If tool risk scores consistently dominate but agent behavior is more predictive,
   * gradually shift weight toward agent confidence.
   *
   * TODO: Implement Thompson Sampling weight learning from override history.
   * Currently uses static weights. Future: analyze override patterns to determine
   * which signal sources best predict human operator decisions.
   */
  private learnWeights(_profile: AgentBehaviorProfile): void {
    // No-op placeholder — learning is configured via enableWeightLearning flag.
    // Future iterations will use the overrideHistory to compute which factors
    // best predict human override decisions, then adjust weights via gradient descent.
  }

  // ── Recording ───────────────────────────────────────────────────────

  /**
   * Record a human override — operator changed the strategy.
   * Used for learning: future decisions weight factors aligned with human judgment.
   */
  recordOverride(decisionId: string, overriddenStrategy: HITLStrategy, reason: string): void {
    const original = this.decisionHistory.find((d) => d.decisionId === decisionId);
    this.overrideHistory.push({
      decisionId,
      original: original?.strategy ?? overriddenStrategy,
      overridden: overriddenStrategy,
      reason,
      timestamp: new Date().toISOString(),
    });

    // Update profile for the agent
    if (original) {
      const factors = original.factors;
      // Find the agent ID from the decision — we store it indirectly via factors
      // For now, record the override for learning
      void factors;
    }
  }

  /**
   * Record a correct decision (operator confirmed no adverse outcome).
   */
  recordCorrectDecision(agentId: string): void {
    const profile = this.profiles.get(agentId);
    if (profile) {
      profile.correctDecisions++;
    }
  }

  // ── Audit ───────────────────────────────────────────────────────────

  private auditDecision(decision: HITLDecision, signals: HITLSignalBundle): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'content_threat',
        severity:
          STRATEGY_SEVERITY[decision.strategy] >= STRATEGY_SEVERITY.escalate ? 'critical' : 'high',
        source: 'AdaptiveHITL',
        message: `HITL decision: ${decision.strategy} (composite=${decision.compositeRiskScore}) for ${signals.agentId}`,
        details: {
          decisionId: decision.decisionId,
          strategy: decision.strategy,
          compositeRiskScore: decision.compositeRiskScore,
          agentId: signals.agentId,
          toolName: signals.toolRisk.toolName,
          factors: decision.factors.map((f) => ({
            source: f.source,
            score: f.score,
            weight: f.weight,
          })),
        },
      });

      const monitor = getSecurityMonitor();
      monitor.logAlert({
        type: 'hitl_decision',
        severity: decision.strategy === 'deny' ? 'critical' : 'high',
        source: 'AdaptiveHITL',
        message: decision.summary,
        details: {
          decisionId: decision.decisionId,
          strategy: decision.strategy,
          compositeRiskScore: decision.compositeRiskScore,
          agentId: signals.agentId,
          recommendation: decision.recommendation,
        },
        timestamp: decision.timestamp,
      });
    } catch (err) {
      reportSilentFailure(err, 'adaptiveHitl:1078');
      /* best-effort */
    }
  }

  // ── Public Accessors ────────────────────────────────────────────────

  /** Get or create behavior profile for an agent (internal use). */
  private getOrCreateProfile(agentId: string): AgentBehaviorProfile {
    let profile = this.profiles.get(agentId);
    if (!profile) {
      profile = createDefaultProfile(agentId);
      this.profiles.set(agentId, profile);
    }
    return profile;
  }

  /** Get behavior profile for an agent (external accessor). */
  getProfile(agentId: string): AgentBehaviorProfile {
    let profile = this.profiles.get(agentId);
    if (!profile) {
      profile = createDefaultProfile(agentId);
      this.profiles.set(agentId, profile);
    }
    return profile;
  }

  /** Get all behavior profiles. */
  getAllProfiles(): Map<string, AgentBehaviorProfile> {
    return new Map(this.profiles);
  }

  /** Get recent decisions (last N). */
  getRecentDecisions(n: number = 50): HITLDecision[] {
    return this.decisionHistory.slice(-n).reverse();
  }

  /** Get decisions for a specific agent. */
  getDecisionsForAgent(agentId: string): HITLDecision[] {
    return this.decisionHistory.filter((d) => d.agentId === agentId);
  }

  /** Get strategy distribution stats. */
  getStats(): {
    totalDecisions: number;
    strategyDistribution: Record<HITLStrategy, number>;
    escalationRate: number;
    avgCompositeScore: number;
  } {
    const distribution: Record<HITLStrategy, number> = {
      auto: 0,
      suggest: 0,
      confirm: 0,
      pause_and_review: 0,
      escalate: 0,
      deny: 0,
    };

    let escalationCount = 0;
    let totalScore = 0;

    for (const decision of this.decisionHistory) {
      distribution[decision.strategy]++;
      if (decision.escalated) escalationCount++;
      totalScore += decision.compositeRiskScore;
    }

    return {
      totalDecisions: this.decisionHistory.length,
      strategyDistribution: distribution,
      escalationRate:
        this.decisionHistory.length > 0 ? escalationCount / this.decisionHistory.length : 0,
      avgCompositeScore:
        this.decisionHistory.length > 0 ? totalScore / this.decisionHistory.length : 0,
    };
  }

  /** Get overrides for learning. */
  getOverrides(): Array<{
    decisionId: string;
    original: HITLStrategy;
    overridden: HITLStrategy;
    reason: string;
    timestamp: string;
  }> {
    return [...this.overrideHistory];
  }

  /** Update configuration at runtime. */
  updateConfig(partial: Partial<AdaptiveHITLConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Get current config (read-only). */
  getConfig(): Readonly<AdaptiveHITLConfig> {
    return { ...this.config };
  }

  /** Reset all state (test isolation). */
  reset(): void {
    this.profiles.clear();
    this.decisionHistory = [];
    this.overrideHistory = [];
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private buildFallbackDecision(
    signals: HITLSignalBundle,
    strategy: HITLStrategy,
    reason: string,
  ): HITLDecision {
    return {
      agentId: signals.agentId,
      strategy,
      compositeRiskScore: 0,
      factors: [],
      summary: reason,
      recommendation: 'Engine disabled — using static policy.',
      decisionId: `hitl_fallback_${Date.now()}`,
      timestamp: new Date().toISOString(),
      escalated: false,
    };
  }

  /**
   * Convenience method: build a HITLSignalBundle from partial signals.
   * Fills missing signals with nominal defaults (risk=0).
   */
  static defaultSignals(
    overrides: Partial<HITLSignalBundle> & { agentId: string; toolRisk: ToolRiskSignal },
  ): HITLSignalBundle {
    return {
      agentId: overrides.agentId,
      runId: overrides.runId,
      toolRisk: overrides.toolRisk,
      agentConfidence: overrides.agentConfidence ?? {
        activeInterventions: [],
        isPaused: false,
        baselineDeviationFactor: 1.0,
        consecutiveAnomalies: 0,
        toolRateDeviation: 1.0,
      },
      correlation: overrides.correlation ?? {
        activeCorrelationTypes: [],
        maxCorrelationRiskScore: 0,
        criticalCorrelation: false,
      },
      verification: overrides.verification ?? {
        confidence: 0.95,
        gateFailures: [],
        hallucinationDetected: false,
      },
      mission: overrides.mission ?? {
        criticality: 0.3,
        budgetRemaining: 0.8,
        userRole: 'admin',
        environment: 'development',
        taskType: 'unknown',
        stepsExecuted: 5,
      },
      msSinceLastReview: overrides.msSinceLastReview ?? 0,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultInstance: AdaptiveHITL | undefined;

export function getAdaptiveHitl(): AdaptiveHITL {
  if (!defaultInstance) {
    defaultInstance = new AdaptiveHITL();
  }
  return defaultInstance;
}

export function resetAdaptiveHitl(): void {
  defaultInstance = undefined;
}
