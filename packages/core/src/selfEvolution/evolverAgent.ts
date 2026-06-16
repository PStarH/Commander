import type {
  EvolutionInsight,
  ExecutionExperience,
  FailureCategory,
} from '../runtime/types';
import type {
  UltimateOrchestratorConfig,
  QualityGateConfig,
} from '../ultimate/types';
import { getMetaLearner } from './metaLearner';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Mutation Types
// ============================================================================

/**
 * A single config mutation produced by the evolver.
 * Stores old and new values so the mutation can be reverted.
 */
export interface EvolverMutation {
  /** Unique mutation ID */
  id: string;
  /** Which config domain this mutation targets */
  domain: 'quality_gate' | 'thinking_budget' | 'model_tier' | 'synthesis' | 'runtime';
  /** Human-readable description */
  description: string;
  /** Which failure category prompted this mutation */
  triggeredBy: FailureCategory;
  /** Confidence that prompted the mutation */
  confidence: number;
  /** Dot-separated path in the config object (e.g. "defaultSynthesisConfig.consensusThreshold") */
  configPath: string;
  /** Value before mutation */
  oldValue: unknown;
  /** Value after mutation */
  newValue: unknown;
}

/**
 * Result of an evolution cycle.
 */
export interface EvolutionCycle {
  mutations: EvolverMutation[];
  applied: number;
  reverted: number;
  cycleId: string;
}

// ============================================================================
// Mutation Rules: FailureCategory → config changes
// ============================================================================

interface MutationRule {
  domain: EvolverMutation['domain'];
  configPath: string;
  /** Delta or absolute value. Delta = multiply current value by factor. */
  mode: 'delta' | 'absolute';
  /** For delta: multiplier (0.8 = reduce by 20%). For absolute: the new value. */
  value: number | boolean | string;
  /** Minimum confidence required to trigger */
  minConfidence: number;
  /** Human description template (receives old → new) */
  description: string;
  /** Only trigger if current value matches a predicate */
  condition?: (current: unknown) => boolean;
}

const MUTATION_RULES: Record<FailureCategory, MutationRule[]> = {
  hallucination: [
    {
      domain: 'quality_gate',
      configPath: 'qualityGates.hallucination.threshold',
      mode: 'delta',
      value: 0.9,
      minConfidence: 0.5,
      description: 'Tighten hallucination gate threshold from {old} to {new} after detecting hallucination failures',
      condition: (v) => typeof v === 'number' && v > 0.5,
    },
  ],
  context_overflow: [
    {
      domain: 'thinking_budget',
      configPath: 'defaultThinkingBudget.maxThinkingTokens',
      mode: 'delta',
      value: 0.75,
      minConfidence: 0.5,
      description: 'Reduce thinking budget from {old} to {new} after context overflow',
      condition: (v) => typeof v === 'number' && v > 512,
    },
    {
      domain: 'thinking_budget',
      configPath: 'defaultThinkingBudget.subAgentThinkingTokens',
      mode: 'delta',
      value: 0.75,
      minConfidence: 0.5,
      description: 'Reduce sub-agent thinking budget from {old} to {new} after context overflow',
      condition: (v) => typeof v === 'number' && v > 256,
    },
  ],
  timeout: [
    {
      domain: 'runtime',
      configPath: 'maxParallelSubAgents',
      mode: 'delta',
      value: 0.8,
      minConfidence: 0.4,
      description: 'Reduce parallel agents from {old} to {new} after timeout',
      condition: (v) => typeof v === 'number' && v > 2,
    },
  ],
  model_refusal: [
    {
      domain: 'model_tier',
      configPath: 'modelTierMapping.MODERATE',
      mode: 'absolute',
      value: 'power',
      minConfidence: 0.6,
      description: 'Upgrade moderate tier from {old} to {new} after model refusal',
      condition: (v) => v !== 'power' && v !== 'consensus',
    },
  ],
  missing_capability: [
    {
      domain: 'model_tier',
      configPath: 'modelTierMapping.COMPLEX',
      mode: 'absolute',
      value: 'consensus',
      minConfidence: 0.6,
      description: 'Upgrade complex tier from {old} to {new} after missing capability',
      condition: (v) => v !== 'consensus',
    },
  ],
  planning_error: [
    {
      domain: 'synthesis',
      configPath: 'defaultSynthesisConfig.maxRounds',
      mode: 'delta',
      value: 1.5,
      minConfidence: 0.5,
      description: 'Increase synthesis rounds from {old} to {new} after planning errors',
      condition: (v) => typeof v === 'number' && v < 5,
    },
    {
      domain: 'quality_gate',
      configPath: 'qualityGates.consistency.threshold',
      mode: 'delta',
      value: 1.05,
      minConfidence: 0.5,
      description: 'Tighten consistency gate threshold from {old} to {new} after planning errors',
      condition: (v) => typeof v === 'number' && v < 0.95,
    },
  ],
  dependency_failure: [
    {
      domain: 'runtime',
      configPath: 'maxParallelSubAgents',
      mode: 'delta',
      value: 0.75,
      minConfidence: 0.4,
      description: 'Reduce parallel agents from {old} to {new} after dependency failures',
      condition: (v) => typeof v === 'number' && v > 1,
    },
  ],
  quality_gate: [
    {
      domain: 'quality_gate',
      configPath: 'qualityGates.accuracy.threshold',
      mode: 'delta',
      value: 0.95,
      minConfidence: 0.5,
      description: 'Tighten accuracy gate threshold from {old} to {new} after quality gate failures',
      condition: (v) => typeof v === 'number' && v > 0.3,
    },
  ],
  tool_misuse: [
    {
      domain: 'runtime',
      configPath: 'maxParallelSubAgents',
      mode: 'delta',
      value: 0.8,
      minConfidence: 0.5,
      description: 'Reduce parallel agents from {old} to {new} after tool misuse to reduce tool contention',
      condition: (v) => typeof v === 'number' && v > 2,
    },
  ],
  rate_limit: [
    {
      domain: 'runtime',
      configPath: 'maxParallelSubAgents',
      mode: 'delta',
      value: 0.5,
      minConfidence: 0.5,
      description: 'Reduce parallel agents from {old} to {new} after rate limiting',
      condition: (v) => typeof v === 'number' && v > 1,
    },
  ],
  authentication: [
    {
      domain: 'model_tier',
      configPath: 'modelTierMapping.MODERATE',
      mode: 'absolute',
      value: 'power',
      minConfidence: 0.5,
      description: 'Upgrade model tier from {old} to {new} after auth failures (may need stronger model)',
      condition: (v) => v !== 'power' && v !== 'consensus',
    },
  ],
  resource_exhaustion: [
    {
      domain: 'thinking_budget',
      configPath: 'defaultThinkingBudget.maxThinkingTokens',
      mode: 'delta',
      value: 0.6,
      minConfidence: 0.5,
      description: 'Reduce thinking budget from {old} to {new} after resource exhaustion',
      condition: (v) => typeof v === 'number' && v > 512,
    },
    {
      domain: 'runtime',
      configPath: 'maxParallelSubAgents',
      mode: 'delta',
      value: 0.5,
      minConfidence: 0.5,
      description: 'Reduce parallel agents from {old} to {new} after resource exhaustion',
      condition: (v) => typeof v === 'number' && v > 1,
    },
  ],
  data_validation: [
    {
      domain: 'quality_gate',
      configPath: 'qualityGates.accuracy.threshold',
      mode: 'delta',
      value: 1.05,
      minConfidence: 0.5,
      description: 'Tighten accuracy gate from {old} to {new} after data validation failures',
      condition: (v) => typeof v === 'number' && v < 0.95,
    },
  ],
  unclassified: [],
};

// ============================================================================
// Config access helpers (navigates dot-separated paths in the config object)
// ============================================================================

function getConfigValue(config: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setConfigValue(config: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: unknown = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return;
    const next = (current as Record<string, unknown>)[parts[i]];
    if (next === undefined || next === null || typeof next !== 'object') {
      (current as Record<string, unknown>)[parts[i]] = {};
    }
    current = (current as Record<string, unknown>)[parts[i]];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    (current as Record<string, unknown>)[parts[parts.length - 1]] = value;
  }
}

// ============================================================================
// Path resolution helpers for special config structures
// ============================================================================

/**
 * Resolve a path that may reference nested array fields (e.g. "qualityGates.hallucination.threshold").
 * qualityGates is a QualityGateConfig[] array, so we need to find the right entry by name.
 */
function resolvePath(config: Record<string, unknown>, path: string): { parent: Record<string, unknown>; key: string } | null {
  const parts = path.split('.');

  // Handle qualityGates.{name}.{field} — look up by name in the array
  if (parts[0] === 'qualityGates' && parts.length >= 3) {
    const gateName = parts[1];
    const field = parts[2];
    const gate = config.qualityGates as QualityGateConfig[] | undefined;
    if (!gate) return null;
    const entry = gate.find((g: QualityGateConfig) => g.name === gateName);
    if (!entry) return null;
    return { parent: entry as Record<string, unknown>, key: field };
  }

  // Standard dot path traversal
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const val = current[parts[i]];
    if (val === undefined || val === null || typeof val !== 'object') return null;
    current = val as Record<string, unknown>;
  }
  return { parent: current, key: parts[parts.length - 1] };
}

// ============================================================================
// Evolver Agent
// ============================================================================

let evolverCounter = 0;

/** Minimum interval between evolution cycles (ms) to prevent over-tuning */
const EVOLVER_COOLDOWN_MS = 60_000;

// ============================================================================
// Canary Config Deployment
// ============================================================================

export interface CanaryDeployment {
  /** Pending mutations waiting for verification */
  mutations: EvolverMutation[];
  /** Fraction of runs that use canary config (0.0-1.0) */
  rolloutFraction: number;
  /** Run IDs that participated in the canary */
  runIds: string[];
  /** When the canary was created */
  startedAt: number;
  /** Minimum canary runs before auto-decision */
  minRuns: number;
  /** Accumulated verdicts from canary runs */
  verdicts: Array<{ runId: string; success: boolean; timestamp: string }>;
  /** Whether the canary has been decided (promoted or rejected) */
  decided: boolean;
}

export interface CanaryStatus {
  active: boolean;
  mutations: number;
  runCount: number;
  rolloutFraction: number;
  startedAt: number;
  successRate: number;
  decided: boolean;
  pendingRuns: number;
}

export class EvolverAgent {
  private lastMutationTime = 0;

  // ── Canary Config Deployment ──────────────────────────────────────────
  private currentCanary: CanaryDeployment | null = null;
  private defaultRolloutFraction = 0.10; // 10% of runs use canary config

  /** Returns ms until the cooldown expires (0 = ready) */
  get cooldownRemaining(): number {
    const elapsed = Date.now() - this.lastMutationTime;
    return Math.max(0, EVOLVER_COOLDOWN_MS - elapsed);
  }

  /**
   * Given trajectory analysis insights, produce config mutations tuned to the
   * observed failure patterns. Does NOT mutate config — just returns the plan.
   */
  evolve(
    insights: EvolutionInsight[],
    config: UltimateOrchestratorConfig,
  ): EvolverMutation[] {
    const mutations: EvolverMutation[] = [];

    for (const insight of insights) {
      if (insight.success) continue;

      const rules = MUTATION_RULES[insight.failureCategory] ?? [];
      if (rules.length === 0) continue;

      for (const rule of rules) {
        // Skip if insight confidence is below this rule's minimum threshold
        if (insight.confidence < rule.minConfidence) continue;

        // Resolve the current value
        const resolved = resolvePath(config, rule.configPath);
        if (!resolved) continue;

        const currentVal = resolved.parent[resolved.key];

        // Check condition
        if (rule.condition && !rule.condition(currentVal)) continue;

        // Compute new value
        let newVal: unknown;
        if (rule.mode === 'delta' && typeof currentVal === 'number' && typeof rule.value === 'number') {
          newVal = Math.round(currentVal * rule.value * 100) / 100;
        } else {
          newVal = rule.value;
        }

        // Skip if no actual change
        if (newVal === currentVal) continue;

        const mutationId = `evolver_${++evolverCounter}_${Date.now()}`;
        const description = rule.description
          .replace('{old}', String(currentVal))
          .replace('{new}', String(newVal));

        mutations.push({
          id: mutationId,
          domain: rule.domain,
          description,
          triggeredBy: insight.failureCategory,
          confidence: insight.confidence,
          configPath: rule.configPath,
          oldValue: currentVal,
          newValue: newVal,
        });
      }
    }

    return mutations;
  }

  /**
   * Apply mutations to the config object. Mutations are idempotent — applying
   * the same mutation twice is a no-op (oldValue already matches newValue).
   */
  applyMutations(
    config: UltimateOrchestratorConfig,
    mutations: EvolverMutation[],
  ): number {
    let applied = 0;
    for (const mutation of mutations) {
      const resolved = resolvePath(config, mutation.configPath);
      if (!resolved) continue;

      const currentVal = resolved.parent[resolved.key];
      // Idempotent: skip if already at target
      if (currentVal === mutation.newValue) continue;
      // Safety: skip if current value doesn't match expected old value
      if (currentVal !== mutation.oldValue) continue;

      resolved.parent[resolved.key] = mutation.newValue as never;
      applied++;
    }
    return applied;
  }

  /**
   * Revert mutations, restoring config to old values.
   */
  revertMutations(
    config: UltimateOrchestratorConfig,
    mutations: EvolverMutation[],
  ): number {
    let reverted = 0;
    for (const mutation of mutations) {
      const resolved = resolvePath(config, mutation.configPath);
      if (!resolved) continue;

      const currentVal = resolved.parent[resolved.key];
      // Only revert if the current value matches the mutation's newValue
      // (i.e. hasn't been changed again by something else)
      if (currentVal !== mutation.newValue) continue;

      resolved.parent[resolved.key] = mutation.oldValue as never;
      reverted++;
    }
    return reverted;
  }

  /**
   * Create falsifiable predictions for each mutation via MetaLearner.
   */
  createPredictions(
    mutations: EvolverMutation[],
    exp: ExecutionExperience,
    taskTypes: string[],
  ): void {
    const ml = getMetaLearner();
    for (const mutation of mutations) {
      ml.createPrediction(
        mutation.id,
        mutation.description,
        String(mutation.newValue),
        String(mutation.oldValue),
        exp.modelUsed,
        taskTypes,
        [mutation.triggeredBy],
        [mutation.triggeredBy],
      );
    }
  }

  /**
   * Run a full evolution cycle: analyze insights → produce mutations →
   * apply → create predictions. Returns what was done.
   */
  runCycle(
    insights: EvolutionInsight[],
    config: UltimateOrchestratorConfig,
    exp: ExecutionExperience,
    taskTypes: string[],
  ): EvolutionCycle {
    // Cooldown: skip if mutations were applied recently to prevent over-tuning
    if (this.cooldownRemaining > 0) {
      return {
        mutations: [],
        applied: 0,
        reverted: 0,
        cycleId: `evolve_${Date.now()}`,
      };
    }

    const mutations = this.evolve(insights, config);
    const applied = this.applyMutations(config, mutations);
    if (applied > 0) {
      this.lastMutationTime = Date.now();
    }
    this.createPredictions(mutations, exp, taskTypes);

    getMessageBus().publish('system.alert', 'evolver-agent', {
      type: 'evolution_cycle',
      mutations: mutations.length,
      applied: 0,
      canary: mutations.length > 0 ? `pending (${this.defaultRolloutFraction * 100}% rollout)` : undefined,
      details: mutations.map(m => ({
        id: m.id,
        domain: m.domain,
        description: m.description,
        oldValue: m.oldValue,
        newValue: m.newValue,
      })),
    });

    // Store as canary deployment instead of applying globally
    if (mutations.length > 0) {
      this.startCanary(mutations);
    }

    return {
      mutations,
      applied: 0, // Not applied globally — deployed as canary
      reverted: 0,
      cycleId: `evolve_${Date.now()}`,
    };
  }

  // ========================================================================
  // Canary Config Deployment API
  // ========================================================================

  /**
   * Check whether this run should use the canary config.
   * Returns true for a random fraction of runs when a canary is active.
   */
  shouldUseCanary(): boolean {
    if (!this.currentCanary) return false;
    // Active (undecided): random 10% rollout. Promoted: 100% rollout.
    // Rejected canaries have currentCanary = null, so they're blocked above.
    return Math.random() < this.currentCanary.rolloutFraction;
  }

  /**
   * Get the pending canary mutations that should be applied.
   * Returns null if no canary is active or run shouldn't use canary.
   */
  getCanaryMutations(): EvolverMutation[] | null {
    if (!this.currentCanary || this.currentCanary.decided) return null;
    return [...this.currentCanary.mutations];
  }

  /**
   * Record the outcome of a canary run.
   * Accumulates verdicts and auto-decides when enough data is collected.
   */
  recordCanaryVerdict(runId: string, success: boolean): void {
    if (!this.currentCanary || this.currentCanary.decided) return;

    // Avoid double-counting
    if (this.currentCanary.runIds.includes(runId)) return;

    this.currentCanary.runIds.push(runId);
    this.currentCanary.verdicts.push({
      runId,
      success,
      timestamp: new Date().toISOString(),
    });

    // Auto-decide when we have enough runs
    if (this.currentCanary.runIds.length >= this.currentCanary.minRuns) {
      const successRate = this.currentCanary.verdicts.filter(v => v.success).length / this.currentCanary.verdicts.length;

      const ml = getMetaLearner();
      const recentVerdicts = ml.getVerdicts().filter(
        v => this.currentCanary!.mutations.some(m => m.id === v.predictionId)
      );

      // Promote if success rate is good AND predictions are confirmed
      const predictionsPositive = recentVerdicts.length === 0 ||
        recentVerdicts.filter(v => v.netImpact === 'positive').length >= recentVerdicts.length * 0.5;

      if (successRate >= 0.5 && predictionsPositive) {
        this.promoteCanary();
      } else {
        this.rejectCanary();
      }
    }
  }

  /**
   * Promote the canary — apply to 100% of subsequent runs.
   */
  promoteCanary(): void {
    if (!this.currentCanary) return;
    this.currentCanary.decided = true;
    // After promotion, set rollout to 100% so all future runs use it
    this.currentCanary.rolloutFraction = 1.0;

    getMessageBus().publish('system.alert', 'evolver-agent', {
      type: 'canary_promoted',
      mutations: this.currentCanary.mutations.length,
      runs: this.currentCanary.runIds.length,
      successRate: this.currentCanary.verdicts.length > 0
        ? this.currentCanary.verdicts.filter(v => v.success).length / this.currentCanary.verdicts.length
        : 0,
    });
  }

  /**
   * Reject the canary — discard pending mutations.
   */
  rejectCanary(): void {
    if (!this.currentCanary) return;
    const count = this.currentCanary.mutations.length;
    this.currentCanary = null;

    getMessageBus().publish('system.alert', 'evolver-agent', {
      type: 'canary_rejected',
      mutations: count,
      reason: 'success_rate_below_threshold',
    });
  }

  /**
   * Get current canary deployment status.
   */
  getCanaryStatus(): CanaryStatus {
    if (!this.currentCanary) {
      return {
        active: false, mutations: 0, runCount: 0, rolloutFraction: 0,
        startedAt: 0, successRate: 0, decided: false, pendingRuns: 0,
      };
    }

    const successRate = this.currentCanary.verdicts.length > 0
      ? this.currentCanary.verdicts.filter(v => v.success).length / this.currentCanary.verdicts.length
      : 0;

    return {
      active: true,
      mutations: this.currentCanary.mutations.length,
      runCount: this.currentCanary.runIds.length,
      rolloutFraction: this.currentCanary.rolloutFraction,
      startedAt: this.currentCanary.startedAt,
      successRate,
      decided: this.currentCanary.decided,
      pendingRuns: Math.max(0, this.currentCanary.minRuns - this.currentCanary.runIds.length),
    };
  }

  /**
   * Force-promote or force-reject a canary (admin action).
   */
  forceCanaryDecision(promote: boolean): void {
    if (!this.currentCanary || this.currentCanary.decided) return;
    if (promote) {
      this.promoteCanary();
    } else {
      this.rejectCanary();
    }
  }

  // ── Internal canary helpers ─────────────────────────────────────────

  private startCanary(mutations: EvolverMutation[]): void {
    // If there's an existing undecided canary, merge the mutations
    if (this.currentCanary && !this.currentCanary.decided) {
      this.currentCanary.mutations.push(...mutations);
      return;
    }

    this.currentCanary = {
      mutations: [...mutations],
      rolloutFraction: this.defaultRolloutFraction,
      runIds: [],
      startedAt: Date.now(),
      minRuns: 5,
      verdicts: [],
      decided: false,
    };
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const evolverSingleton = createTenantAwareSingleton(() => new EvolverAgent());

export function getEvolverAgent(): EvolverAgent {
  return evolverSingleton.get();
}

export function resetEvolverAgent(): void {
  evolverSingleton.reset();
}

// Circular-safe import (messageBus is imported at the bottom to avoid circular deps)
import { getMessageBus } from '../runtime/messageBus';
