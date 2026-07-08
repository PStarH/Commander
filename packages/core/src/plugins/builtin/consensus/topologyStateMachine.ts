/**
 * Topology State Machine — 4-State Dynamic Topology Switching
 *
 * Research basis: "Commander-BFT-C3" consensus report section 6 (Monitoring Layer).
 *
 * The monitoring layer uses BPD (Backward Propagation Detection) to identify
 * anomalous agents, then triggers dynamic topology switching through four states:
 *
 *   NORMAL    → Default operation, full connectivity, maximum efficiency
 *   ALERT     → Anomaly detected, increased monitoring, reduced fan-out
 *   LOCKDOWN  → Multiple anomalies, isolate suspicious agents, minimal communication
 *   ESCALATE  → Critical threat, halt autonomous operation, require human intervention
 *
 * Transitions are driven by anomaly scores from BPD and can be triggered by:
 *   - Detection rate thresholds (BPD anomaly score > threshold)
 *   - Consensus failure rates
 *   - Security events (GuardianAgent, CrossAgentCorrelator)
 *   - Manual operator commands
 */

import { getMessageBus } from '../../../runtime/messageBus';
import { getGlobalLogger } from '../../../logging';
import { reportSilentFailure } from '../../../silentFailureReporter';

// ── Types ────────────────────────────────────────────────────────────────────

export type TopologyState = 'NORMAL' | 'ALERT' | 'LOCKDOWN' | 'ESCALATE';

export interface TopologyStateConfig {
  /** BPD anomaly score threshold to transition NORMAL → ALERT. Default 0.3 */
  alertThreshold: number;
  /** BPD anomaly score threshold to transition ALERT → LOCKDOWN. Default 0.6 */
  lockdownThreshold: number;
  /** BPD anomaly score threshold to transition LOCKDOWN → ESCALATE. Default 0.85 */
  escalateThreshold: number;
  /** Number of consecutive consensus failures before state escalation. Default 3 */
  consensusFailuresBeforeEscalation: number;
  /** Minimum time (ms) to stay in a state before allowing downgrade. Default 30000 */
  minStateDurationMs: number;
  /** Maximum fan-out (parallel agents) per state */
  maxFanOutByState: Record<TopologyState, number>;
  /** Whether to allow autonomous operation in each state */
  allowAutonomousByState: Record<TopologyState, boolean>;
}

export const DEFAULT_CONFIG: TopologyStateConfig = {
  alertThreshold: 0.3,
  lockdownThreshold: 0.6,
  escalateThreshold: 0.85,
  consensusFailuresBeforeEscalation: 3,
  minStateDurationMs: 30_000,
  maxFanOutByState: {
    NORMAL: 10,
    ALERT: 5,
    LOCKDOWN: 2,
    ESCALATE: 0,
  },
  allowAutonomousByState: {
    NORMAL: true,
    ALERT: true,
    LOCKDOWN: false,
    ESCALATE: false,
  },
};

export interface StateTransitionEvent {
  from: TopologyState;
  to: TopologyState;
  reason: string;
  anomalyScore: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface TopologyStateSnapshot {
  currentState: TopologyState;
  anomalyScore: number;
  consecutiveConsensusFailures: number;
  isolatedAgents: string[];
  enteredAt: number;
  transitionHistory: StateTransitionEvent[];
  maxFanOut: number;
  autonomousAllowed: boolean;
}

export type StateTransitionHandler = (event: StateTransitionEvent) => void;

// ── Topology State Machine ───────────────────────────────────────────────────

export class TopologyStateMachine {
  private config: TopologyStateConfig;
  private currentState: TopologyState = 'NORMAL';
  private currentAnomalyScore = 0;
  private consecutiveConsensusFailures = 0;
  private isolatedAgents: Set<string> = new Set();
  private enteredAt: number = Date.now();
  private transitionHistory: StateTransitionEvent[] = [];
  private handlers: Set<StateTransitionHandler> = new Set();
  private degradedAnomalySince: number | null = null;

  constructor(config?: Partial<TopologyStateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Submit a new anomaly score from BPD or other detectors.
   * This may trigger a state transition.
   */
  submitAnomalyScore(score: number, metadata?: Record<string, unknown>): TopologyState {
    const clamped = Math.max(0, Math.min(1, score));
    this.currentAnomalyScore = clamped;

    const previousState = this.currentState;
    let newState = previousState;

    // Determine target state based on anomaly score
    if (clamped >= this.config.escalateThreshold) {
      newState = 'ESCALATE';
    } else if (clamped >= this.config.lockdownThreshold) {
      newState = 'LOCKDOWN';
    } else if (clamped >= this.config.alertThreshold) {
      newState = 'ALERT';
    } else {
      // Score below alert threshold — can downgrade
      newState = 'NORMAL';
    }

    // Apply consensus failure override: consecutive failures force escalation
    if (this.consecutiveConsensusFailures >= this.config.consensusFailuresBeforeEscalation) {
      if (newState === 'NORMAL') newState = 'ALERT';
      else if (newState === 'ALERT') newState = 'LOCKDOWN';
    }

    if (newState !== previousState) {
      // Check minimum state duration before allowing downgrade
      const timeInState = Date.now() - this.enteredAt;
      const isUpgrade = this.stateSeverity(newState) > this.stateSeverity(previousState);
      if (!isUpgrade && timeInState < this.config.minStateDurationMs) {
        // Don't downgrade yet — stay in current state
        newState = previousState;
      }
    }

    if (newState !== previousState) {
      this.transition(newState, `Anomaly score ${clamped.toFixed(4)}`, clamped, metadata);
    }

    // Track anomaly degradation for auto-downgrade
    if (clamped < this.config.alertThreshold) {
      if (this.degradedAnomalySince === null) {
        this.degradedAnomalySince = Date.now();
      }
    } else {
      this.degradedAnomalySince = null;
    }

    return this.currentState;
  }

  /**
   * Record a consensus result. Failures accumulate and can trigger escalation.
   */
  recordConsensusResult(success: boolean): void {
    if (success) {
      this.consecutiveConsensusFailures = 0;
      // Check if we can downgrade after sustained success
      if (this.currentState !== 'NORMAL' && this.degradedAnomalySince !== null) {
        const degradedDuration = Date.now() - this.degradedAnomalySince;
        if (degradedDuration > this.config.minStateDurationMs) {
          const targetState =
            this.currentState === 'ESCALATE'
              ? 'LOCKDOWN'
              : this.currentState === 'LOCKDOWN'
                ? 'ALERT'
                : 'NORMAL';
          this.transition(
            targetState,
            'Sustained low anomaly + consensus success',
            this.currentAnomalyScore,
          );
        }
      }
    } else {
      this.consecutiveConsensusFailures++;
      if (this.consecutiveConsensusFailures >= this.config.consensusFailuresBeforeEscalation) {
        this.submitAnomalyScore(Math.max(this.currentAnomalyScore, this.config.alertThreshold), {
          reason: 'consecutive_consensus_failures',
          count: this.consecutiveConsensusFailures,
        });
      }
    }
  }

  /**
   * Isolate a specific agent (remove from active topology).
   */
  isolateAgent(agentId: string, reason: string): void {
    this.isolatedAgents.add(agentId);
    this.submitAnomalyScore(Math.max(this.currentAnomalyScore, this.config.alertThreshold), {
      reason: `agent_isolated: ${agentId} — ${reason}`,
      agentId,
    });
  }

  /**
   * Release an isolated agent back into the topology.
   */
  releaseAgent(agentId: string): void {
    this.isolatedAgents.delete(agentId);
  }

  /**
   * Get the set of isolated agent IDs.
   */
  getIsolatedAgents(): string[] {
    return Array.from(this.isolatedAgents);
  }

  /**
   * Force a state transition (operator command).
   */
  forceState(state: TopologyState, reason: string): void {
    if (state !== this.currentState) {
      this.transition(state, `Operator override: ${reason}`, this.currentAnomalyScore);
    }
  }

  /**
   * Get the current state.
   */
  getState(): TopologyState {
    return this.currentState;
  }

  /**
   * Get the current maximum fan-out (parallel agents allowed).
   */
  getMaxFanOut(): number {
    return this.config.maxFanOutByState[this.currentState];
  }

  /**
   * Whether autonomous operation is allowed in the current state.
   */
  isAutonomousAllowed(): boolean {
    return this.config.allowAutonomousByState[this.currentState];
  }

  /**
   * Get a full snapshot of the state machine.
   */
  getSnapshot(): TopologyStateSnapshot {
    return {
      currentState: this.currentState,
      anomalyScore: this.currentAnomalyScore,
      consecutiveConsensusFailures: this.consecutiveConsensusFailures,
      isolatedAgents: Array.from(this.isolatedAgents),
      enteredAt: this.enteredAt,
      transitionHistory: [...this.transitionHistory],
      maxFanOut: this.getMaxFanOut(),
      autonomousAllowed: this.isAutonomousAllowed(),
    };
  }

  /**
   * Register a handler for state transition events.
   */
  onTransition(handler: StateTransitionHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Reset to NORMAL state and clear all tracking.
   */
  reset(): void {
    this.currentState = 'NORMAL';
    this.currentAnomalyScore = 0;
    this.consecutiveConsensusFailures = 0;
    this.isolatedAgents.clear();
    this.enteredAt = Date.now();
    this.transitionHistory = [];
    this.degradedAnomalySince = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private transition(
    to: TopologyState,
    reason: string,
    anomalyScore: number,
    metadata?: Record<string, unknown>,
  ): void {
    const event: StateTransitionEvent = {
      from: this.currentState,
      to,
      reason,
      anomalyScore,
      timestamp: new Date().toISOString(),
      metadata,
    };

    const from = this.currentState;
    this.currentState = to;
    this.enteredAt = Date.now();
    this.transitionHistory.push(event);

    // Keep history bounded
    if (this.transitionHistory.length > 100) {
      this.transitionHistory.shift();
    }

    // Notify handlers
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        reportSilentFailure(err, 'topologyStateMachine:transition');
      }
    }

    // Publish to message bus
    try {
      const bus = getMessageBus();
      bus.publish('system.alert', 'topology-state-machine', {
        type: 'topology_state_change',
        from,
        to,
        reason,
        anomalyScore,
        isolatedAgents: Array.from(this.isolatedAgents),
        maxFanOut: this.config.maxFanOutByState[to],
        autonomousAllowed: this.config.allowAutonomousByState[to],
      });
    } catch (err) {
      reportSilentFailure(err, 'topologyStateMachine:publish');
    }

    getGlobalLogger().warn('TopologyStateMachine', `State transition: ${from} → ${to}`, {
      reason,
      anomalyScore: anomalyScore.toFixed(4),
    });
  }

  private stateSeverity(state: TopologyState): number {
    switch (state) {
      case 'NORMAL':
        return 0;
      case 'ALERT':
        return 1;
      case 'LOCKDOWN':
        return 2;
      case 'ESCALATE':
        return 3;
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

import { createTenantAwareSingleton } from '../../../runtime/tenantAwareSingleton';

const topologyStateMachineSingleton = createTenantAwareSingleton(
  () => new TopologyStateMachine(),
  {},
);

export function getTopologyStateMachine(): TopologyStateMachine {
  return topologyStateMachineSingleton.get();
}

export function resetTopologyStateMachine(): void {
  topologyStateMachineSingleton.reset();
}
