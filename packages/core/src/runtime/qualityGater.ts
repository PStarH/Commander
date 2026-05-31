/**
 * Quality-Gated Escalation (Agent Capsules Pattern)
 *
 * Implements the Agent Capsules approach (arXiv:2605.00410):
 * - Start with compound execution (merged agents, fewer tokens)
 * - Track rolling quality scores
 * - When quality drops below threshold, escalate to per-agent execution
 * - When quality recovers, de-escalate back
 *
 * Key findings from the paper:
 * - Merging agents saves tokens but silently degrades quality
 * - Adding more context to merged calls worsens compression
 * - Quality-gated escalation achieves 42-51% token savings with slight quality gains
 *
 * Three modes:
 * 1. Compound: Multiple tasks in one agent call (cheapest, lowest quality)
 * 2. Standard: One task per agent call (balanced)
 * 3. Fine: One task per agent with enhanced context (most expensive, highest quality)
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type ExecutionMode = 'compound' | 'standard' | 'fine';

export interface QualityMetrics {
  /** Quality score (0-1) from verification/review */
  quality: number;
  /** Whether the task passed quality gates */
  passed: boolean;
  /** Number of issues found */
  issueCount: number;
  /** Severity of worst issue */
  worstSeverity: 'none' | 'info' | 'low' | 'medium' | 'high' | 'critical';
  /** Token cost for this execution */
  tokenCost: number;
  /** Timestamp */
  timestamp: number;
}

export interface QualityGaterConfig {
  /** Quality threshold to trigger escalation (default: 0.7) */
  escalationThreshold: number;
  /** Quality threshold to trigger de-escalation (default: 0.9) */
  deEscalationThreshold: number;
  /** Number of recent executions to track (rolling window) */
  windowSize: number;
  /** Minimum executions before making escalation decisions */
  minExecutions: number;
  /** Token budget pressure threshold (0-1, escalate when budget is tight) */
  budgetPressureThreshold: number;
  /** Maximum consecutive failures before forced escalation */
  maxConsecutiveFailures: number;
}

export interface EscalationDecision {
  /** Recommended execution mode */
  mode: ExecutionMode;
  /** Reason for the decision */
  reason: string;
  /** Confidence in the decision (0-1) */
  confidence: number;
  /** Rolling quality score */
  rollingQuality: number;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Whether this is an escalation, de-escalation, or maintain */
  action: 'escalate' | 'de-escalate' | 'maintain';
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: QualityGaterConfig = {
  escalationThreshold: 0.7,
  deEscalationThreshold: 0.9,
  windowSize: 10,
  minExecutions: 3,
  budgetPressureThreshold: 0.8,
  maxConsecutiveFailures: 3,
};

// ============================================================================
// Quality Gater
// ============================================================================

export class QualityGater {
  private config: QualityGaterConfig;
  private history: QualityMetrics[] = [];
  private currentMode: ExecutionMode = 'compound';
  private consecutiveFailures = 0;
  private modeChanges: Array<{ from: ExecutionMode; to: ExecutionMode; reason: string; timestamp: number; action: 'escalate' | 'de-escalate' | 'maintain' }> = [];

  constructor(config?: Partial<QualityGaterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record the outcome of an execution and get the next recommended mode.
   */
  recordOutcome(metrics: QualityMetrics): EscalationDecision {
    // Add to rolling window
    this.history.push(metrics);
    if (this.history.length > this.config.windowSize) {
      this.history.shift();
    }

    // Track consecutive failures
    if (!metrics.passed || metrics.worstSeverity === 'high' || metrics.worstSeverity === 'critical') {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 0;
    }

    // Calculate rolling quality
    const rollingQuality = this.calculateRollingQuality();

    // Make escalation decision
    return this.makeDecision(rollingQuality, metrics);
  }

  /**
   * Get the current recommended execution mode.
   */
  getCurrentMode(): ExecutionMode {
    return this.currentMode;
  }

  /**
   * Get the rolling quality score.
   */
  getRollingQuality(): number {
    return this.calculateRollingQuality();
  }

  /**
   * Get the escalation history.
   */
  getModeChanges(): Array<{ from: ExecutionMode; to: ExecutionMode; reason: string; timestamp: number }> {
    return this.modeChanges;
  }

  /**
   * Get execution statistics.
   */
  getStats(): {
    totalExecutions: number;
    averageQuality: number;
    averageTokenCost: number;
    currentMode: ExecutionMode;
    consecutiveFailures: number;
    escalationCount: number;
    deEscalationCount: number;
  } {
    const avgQuality = this.history.length > 0
      ? this.history.reduce((s, m) => s + m.quality, 0) / this.history.length
      : 0;
    const avgCost = this.history.length > 0
      ? this.history.reduce((s, m) => s + m.tokenCost, 0) / this.history.length
      : 0;

    return {
      totalExecutions: this.history.length,
      averageQuality: Math.round(avgQuality * 100) / 100,
      averageTokenCost: Math.round(avgCost),
      currentMode: this.currentMode,
      consecutiveFailures: this.consecutiveFailures,
      escalationCount: this.modeChanges.filter(m => m.action === 'escalate').length,
      deEscalationCount: this.modeChanges.filter(m => m.action === 'de-escalate').length,
    };
  }

  /**
   * Force a specific mode (e.g., for testing or manual override).
   */
  forceMode(mode: ExecutionMode, reason: string): void {
    const prev = this.currentMode;
    this.currentMode = mode;
    const action = this.getModeLevel(mode) > this.getModeLevel(prev) ? 'escalate'
      : this.getModeLevel(mode) < this.getModeLevel(prev) ? 'de-escalate'
      : 'maintain';
    this.modeChanges.push({
      from: prev,
      to: mode,
      reason: `Forced: ${reason}`,
      timestamp: Date.now(),
      action,
    });
  }

  /**
   * Reset the gater (e.g., for a new project or task type).
   */
  reset(): void {
    this.history = [];
    this.currentMode = 'compound';
    this.consecutiveFailures = 0;
    this.modeChanges = [];
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private calculateRollingQuality(): number {
    if (this.history.length === 0) return 1;

    // Weighted average: more recent executions have higher weight
    let totalWeight = 0;
    let weightedSum = 0;
    for (let i = 0; i < this.history.length; i++) {
      const weight = i + 1; // More recent = higher weight
      weightedSum += this.history[i].quality * weight;
      totalWeight += weight;
    }

    return weightedSum / totalWeight;
  }

  private makeDecision(rollingQuality: number, latest: QualityMetrics): EscalationDecision {
    const prevMode = this.currentMode;

    // Rule 1: Force escalation on consecutive failures
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      const newMode = this.escalateMode(prevMode);
      if (newMode !== prevMode) {
        this.changeMode(newMode, `${this.consecutiveFailures} consecutive failures`);
        return {
          mode: newMode,
          reason: `Escalated due to ${this.consecutiveFailures} consecutive failures`,
          confidence: 0.95,
          rollingQuality,
          consecutiveFailures: this.consecutiveFailures,
          action: 'escalate',
        };
      }
    }

    // Rule 2: Escalate on low quality
    if (rollingQuality < this.config.escalationThreshold) {
      const newMode = this.escalateMode(prevMode);
      if (newMode !== prevMode) {
        this.changeMode(newMode, `Quality ${rollingQuality.toFixed(2)} below threshold ${this.config.escalationThreshold}`);
        return {
          mode: newMode,
          reason: `Escalated: rolling quality ${rollingQuality.toFixed(2)} below ${this.config.escalationThreshold}`,
          confidence: 0.8,
          rollingQuality,
          consecutiveFailures: this.consecutiveFailures,
          action: 'escalate',
        };
      }
    }

    // Rule 3: Escalate on critical issues
    if (latest.worstSeverity === 'critical') {
      const newMode = this.escalateMode(prevMode);
      if (newMode !== prevMode) {
        this.changeMode(newMode, 'Critical issue detected');
        return {
          mode: newMode,
          reason: 'Escalated: critical issue detected',
          confidence: 0.9,
          rollingQuality,
          consecutiveFailures: this.consecutiveFailures,
          action: 'escalate',
        };
      }
    }

    // Rule 4: De-escalate when quality is consistently high
    if (rollingQuality >= this.config.deEscalationThreshold && this.history.length >= this.config.minExecutions) {
      // Check last N executions are all high quality
      const recentWindow = Math.min(this.config.windowSize, this.history.length);
      const recentSlice = this.history.slice(-recentWindow);
      const allHighQuality = recentSlice.every(m => m.quality >= this.config.deEscalationThreshold);

      if (allHighQuality && prevMode !== 'compound') {
        const newMode = this.deEscalateMode(prevMode);
        this.changeMode(newMode, `Quality consistently high (${rollingQuality.toFixed(2)})`);
        return {
          mode: newMode,
          reason: `De-escalated: quality consistently ${rollingQuality.toFixed(2)}`,
          confidence: 0.7,
          rollingQuality,
          consecutiveFailures: this.consecutiveFailures,
          action: 'de-escalate',
        };
      }
    }

    // Rule 5: Maintain current mode
    return {
      mode: prevMode,
      reason: 'Maintaining current mode',
      confidence: 0.6,
      rollingQuality,
      consecutiveFailures: this.consecutiveFailures,
      action: 'maintain',
    };
  }

  private escalateMode(current: ExecutionMode): ExecutionMode {
    switch (current) {
      case 'compound': return 'standard';
      case 'standard': return 'fine';
      case 'fine': return 'fine'; // Already at max
    }
  }

  private deEscalateMode(current: ExecutionMode): ExecutionMode {
    switch (current) {
      case 'fine': return 'standard';
      case 'standard': return 'compound';
      case 'compound': return 'compound'; // Already at min
    }
  }

  private changeMode(newMode: ExecutionMode, reason: string): void {
    const prev = this.currentMode;
    this.currentMode = newMode;
    const action = this.getModeLevel(newMode) > this.getModeLevel(prev) ? 'escalate'
      : this.getModeLevel(newMode) < this.getModeLevel(prev) ? 'de-escalate'
      : 'maintain';
    this.modeChanges.push({
      from: prev,
      to: newMode,
      reason,
      timestamp: Date.now(),
      action,
    });

    getGlobalLogger().info('QualityGater', `Mode change: ${prev} → ${newMode}`, { reason, action });
  }

  private getModeLevel(mode: ExecutionMode): number {
    switch (mode) {
      case 'compound': return 0;
      case 'standard': return 1;
      case 'fine': return 2;
    }
  }
}

// ============================================================================
// Mode Configuration Helpers
// ============================================================================

/**
 * Get the recommended configuration for an execution mode.
 */
export function getModeConfig(mode: ExecutionMode): {
  maxAgents: number;
  contextLevel: 'minimal' | 'standard' | 'full';
  verificationLevel: 'none' | 'basic' | 'thorough';
  tokenMultiplier: number;
} {
  switch (mode) {
    case 'compound':
      return {
        maxAgents: 1,
        contextLevel: 'minimal',
        verificationLevel: 'none',
        tokenMultiplier: 1.0,
      };
    case 'standard':
      return {
        maxAgents: 3,
        contextLevel: 'standard',
        verificationLevel: 'basic',
        tokenMultiplier: 2.5,
      };
    case 'fine':
      return {
        maxAgents: 5,
        contextLevel: 'full',
        verificationLevel: 'thorough',
        tokenMultiplier: 4.0,
      };
  }
}

/**
 * Determine the initial mode based on task complexity.
 */
export function getInitialMode(complexity: number): ExecutionMode {
  if (complexity <= 3) return 'compound';
  if (complexity <= 7) return 'standard';
  return 'fine';
}

// ============================================================================
// Singleton
// ============================================================================

let globalQualityGater: QualityGater | null = null;

export function getQualityGater(config?: Partial<QualityGaterConfig>): QualityGater {
  if (!globalQualityGater) {
    globalQualityGater = new QualityGater(config);
  }
  return globalQualityGater;
}
