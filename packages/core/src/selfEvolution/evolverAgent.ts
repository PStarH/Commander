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
function resolvePath(config: UltimateOrchestratorConfig, path: string): { parent: Record<string, unknown>; key: string } | null {
  const parts = path.split('.');

  // Handle qualityGates.{name}.{field} — look up by name in the array
  if (parts[0] === 'qualityGates' && parts.length >= 3) {
    const gateName = parts[1];
    const field = parts[2];
    const gate = (config as unknown as Record<string, unknown>).qualityGates as QualityGateConfig[] | undefined;
    if (!gate) return null;
    const entry = gate.find((g: QualityGateConfig) => g.name === gateName);
    if (!entry) return null;
    return { parent: entry as unknown as Record<string, unknown>, key: field };
  }

  // Standard dot path traversal
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
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

export class EvolverAgent {
  private lastMutationTime = 0;

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
      applied,
      details: mutations.map(m => ({
        id: m.id,
        domain: m.domain,
        description: m.description,
        oldValue: m.oldValue,
        newValue: m.newValue,
      })),
    });

    return {
      mutations,
      applied,
      reverted: 0,
      cycleId: `evolve_${Date.now()}`,
    };
  }
}

// Singleton
let activeEvolver: EvolverAgent | null = null;

export function getEvolverAgent(): EvolverAgent {
  if (!activeEvolver) {
    activeEvolver = new EvolverAgent();
  }
  return activeEvolver;
}

export function resetEvolverAgent(): void {
  activeEvolver = null;
}

// Circular-safe import (messageBus is imported at the bottom to avoid circular deps)
import { getMessageBus } from '../runtime/messageBus';
