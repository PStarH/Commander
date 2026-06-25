/**
 * Goal Judge — Independent verification with a separate, cheaper model.
 *
 * Core insight from competitive analysis (MiMo Code / OhMyPi):
 * The main agent model is inherently biased toward declaring "done" because
 * completion is its training objective. An independent judge model, running
 * a different provider/model, catches premature declarations by evaluating
 * the output against user-defined stop conditions.
 *
 * Design principles:
 * 1. **Separate model**: Always uses an eco-tier model (cheapest in cascade
 *    chain) — different provider from the main agent to avoid shared biases.
 * 2. **Stop conditions**: User-defined criteria that MUST be met before
 *    declaring completion (e.g., "all tests pass", "no TypeScript errors").
 * 3. **Adversarial stance**: The judge is instructed to find reasons the
 *    task is NOT complete — false negative bias is intentional.
 * 4. **Evidence-based**: The judge must cite specific evidence from the
 *    output, not just say "looks good".
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { LLMProvider, LLMRequest } from './types';
import { ModelRouter, getModelRouter } from './modelRouter';
import { getMessageBus } from './messageBus';
import { getMetricsCollector } from './metricsCollector';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from './tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export interface StopCondition {
  /** Unique identifier (e.g., "no-ts-errors", "all-tests-pass") */
  id: string;
  /** Human-readable description shown to the judge and in CLI */
  description: string;
  /** Condition type determines how the judge evaluates it */
  type: 'MUST_HAVE' | 'MUST_NOT_HAVE' | 'MUST_MATCH' | 'MUST_BE_ABOVE' | 'CUSTOM';
  /** Pattern to check (for MUST_MATCH: regex; for MUST_HAVE: substring) */
  pattern?: string;
  /** Numeric threshold (for MUST_BE_ABOVE: e.g., test pass count) */
  threshold?: number;
  /** Custom evaluation prompt appended to judge instructions (for CUSTOM) */
  customPrompt?: string;
}

export interface StopConditionResult {
  conditionId: string;
  description: string;
  passed: boolean;
  evidence: string;
}

export interface JudgeVerdict {
  /** Did the output pass all stop conditions? */
  passed: boolean;
  /** Confidence 0-1 in the verdict */
  confidence: number;
  /** Human-readable reasoning */
  reasoning: string;
  /** Specific evidence from the output supporting the verdict */
  evidence: string[];
  /** Per-condition results */
  conditionsChecked: StopConditionResult[];
  /** Model used for judging */
  modelUsed: string;
  /** Provider used for judging */
  provider: string;
  /** Tokens consumed by the judge call */
  tokensUsed: number;
  /** When the verdict was made */
  timestamp: number;
}

export interface GoalJudgeConfig {
  /** Whether the judge gate is active */
  enabled: boolean;
  /** Specific model to use (default: cheapest eco model from cascade) */
  model?: string;
  /** Maximum token budget for the judge call (default: 800) */
  judgeTokenBudget: number;
  /** Minimum confidence to pass (default: 0.8) */
  passThreshold: number;
  /** Maximum judge retries — if exceeded, the verdict defaults to pass
   *  to avoid blocking the agent indefinitely (default: 1) */
  maxJudgeRetries: number;
}

export const DEFAULT_GOAL_JUDGE_CONFIG: GoalJudgeConfig = {
  enabled: true,
  judgeTokenBudget: 800,
  passThreshold: 0.8,
  maxJudgeRetries: 1,
};

// ============================================================================
// Stop Condition Registry (per-run)
// ============================================================================

class StopConditionRegistry {
  /** Per-run conditions: runId → conditions */
  private conditions: Map<string, StopCondition[]> = new Map();
  private readonly maxEntries = 200;

  set(runId: string, conditions: StopCondition[]): void {
    if (this.conditions.size >= this.maxEntries) {
      const firstKey = this.conditions.keys().next().value;
      if (firstKey) this.conditions.delete(firstKey);
    }
    this.conditions.set(runId, conditions);
  }

  get(runId: string): StopCondition[] {
    return this.conditions.get(runId) ?? [];
  }

  getGlobal(): StopCondition[] {
    return this.conditions.get('__global__') ?? [];
  }

  setGlobal(conditions: StopCondition[]): void {
    this.conditions.set('__global__', conditions);
  }

  delete(runId: string): void {
    this.conditions.delete(runId);
  }

  reset(): void {
    this.conditions.clear();
  }
}

// ============================================================================
// Premature-declaration patterns (adversarial checks)
// ============================================================================

/**
 * Common phrases where agents declare "done" without evidence.
 * The judge checks for these and flags them as insufficient.
 */
const PREMATURE_DECLARATION_PATTERNS = [
  "I've completed the task",
  'The task is now complete',
  'All done!',
  'Everything is working',
  'The implementation is finished',
  'I have successfully',
  'Task completed successfully',
  'Done!',
  'Finished!',
];

// ============================================================================
// Judge prompt
// ============================================================================

function buildJudgePrompt(
  goal: string,
  output: string,
  conditions: StopCondition[],
  evidenceCount: number,
): string {
  const outputSnippet =
    output.length > 4000
      ? output.slice(0, 2000) + '\n...[truncated]...\n' + output.slice(-2000)
      : output;

  const conditionsBlock =
    conditions.length > 0
      ? conditions
          .map((c, i) => {
            let detail = `  ${i + 1}. [${c.type}] ${c.description}`;
            if (c.pattern) detail += `\n     Pattern: ${c.pattern}`;
            if (c.threshold !== undefined) detail += `\n     Threshold: ${c.threshold}`;
            if (c.customPrompt) detail += `\n     Custom: ${c.customPrompt}`;
            return detail;
          })
          .join('\n')
      : '  No specific stop conditions defined.';

  return [
    'You are an independent Goal Judge. Your job is ADVERSARIAL — actively find reasons',
    'the task is NOT complete. The main agent may have prematurely declared success.',
    '',
    '## Original Goal',
    goal.slice(0, 1000),
    '',
    '## Agent Output',
    outputSnippet,
    '',
    '## Stop Conditions (ALL must be satisfied)',
    conditionsBlock,
    '',
    '## Evidence Summary',
    `Tool calls executed: ${evidenceCount}`,
    '',
    '## Instructions',
    '1. Check EACH stop condition against the output. For each, state PASS or FAIL with evidence.',
    '2. Check if the output actually demonstrates completion (not just claims it).',
    `3. Watch for premature declarations: ${PREMATURE_DECLARATION_PATTERNS.slice(0, 5).join(', ')} etc.`,
    '4. If the agent claims success but shows no concrete evidence (files changed, tests run, etc.), FAIL.',
    '5. If you are unsure, lean toward FAIL — false negatives are safer than false positives.',
    '',
    'Reply JSON:',
    '{',
    '  "passed": true/false,',
    '  "confidence": 0.0-1.0,',
    '  "reasoning": "brief explanation",',
    '  "evidence": ["specific evidence 1", "specific evidence 2"],',
    '  "conditions": [',
    '    {"id": "cond-id", "passed": true/false, "evidence": "specific check result"}',
    '  ]',
    '}',
  ].join('\n');
}

// ============================================================================
// Goal Judge
// ============================================================================

export class GoalJudge {
  private config: GoalJudgeConfig;
  private router: ModelRouter;
  private provider?: LLMProvider;
  private runtime?: { getProvider(name: string): LLMProvider | undefined };
  private registry: StopConditionRegistry;
  private verdictCache: Map<string, JudgeVerdict> = new Map();
  private readonly maxCacheSize = 100;

  constructor(config?: Partial<GoalJudgeConfig>, provider?: LLMProvider) {
    this.config = { ...DEFAULT_GOAL_JUDGE_CONFIG, ...config };
    this.router = getModelRouter();
    this.provider = provider;
    this.registry = new StopConditionRegistry();
  }

  /**
   * Set the LLM provider for the judge (can be different from the main agent).
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /**
   * Set the runtime reference to resolve cross-provider verification.
   */
  setRuntime(runtime: { getProvider(name: string): LLMProvider | undefined }): void {
    this.runtime = runtime;
  }

  /**
   * Set per-run stop conditions. Called before execution starts.
   */
  setStopConditions(runId: string, conditions: StopCondition[]): void {
    this.registry.set(runId, conditions);
  }

  /**
   * Set global stop conditions (applied to all runs).
   */
  setGlobalStopConditions(conditions: StopCondition[]): void {
    this.registry.setGlobal(conditions);
  }

  /**
   * Get current stop conditions for a run (run-specific + global merged).
   */
  getStopConditions(runId: string): StopCondition[] {
    const perRun = this.registry.get(runId);
    const global = this.registry.getGlobal();
    // Per-run conditions override global ones with the same id
    const merged = new Map<string, StopCondition>();
    for (const c of global) merged.set(c.id, c);
    for (const c of perRun) merged.set(c.id, c);
    return Array.from(merged.values());
  }

  /**
   * Get global conditions only.
   */
  getGlobalStopConditions(): StopCondition[] {
    return this.registry.getGlobal();
  }

  /**
   * Clear per-run conditions.
   */
  clear(runId: string): void {
    this.registry.delete(runId);
    this.verdictCache.delete(runId);
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.registry.reset();
    this.verdictCache.clear();
  }

  /**
   * Evaluate whether a task is truly complete.
   *
   * This is the main entry point. It:
   * 1. Resolves a cheap independent model (eco tier, different provider if possible)
   * 2. Runs the adversarial judge prompt with stop conditions
   * 3. Returns a verdict with pass/fail, reasoning, and evidence
   *
   * Falls back to a rule-based heuristic when no provider is available.
   */
  async judge(params: {
    runId: string;
    goal: string;
    output: string;
    evidenceCount?: number;
    /** Optional cached verdict for idempotency */
    idempotencyKey?: string;
  }): Promise<JudgeVerdict> {
    const { runId, goal, output, evidenceCount = 0, idempotencyKey } = params;

    // Cache check for idempotent retries
    const cacheKey = idempotencyKey ?? `${runId}:${goal.slice(0, 50)}:${output.slice(0, 50)}`;
    const cached = this.verdictCache.get(cacheKey);
    if (cached) {
      getGlobalLogger().debug('GoalJudge', 'Returning cached verdict', {
        cacheKey: cacheKey.slice(0, 60),
      });
      return cached;
    }

    const bus = getMessageBus();
    const mc = getMetricsCollector();
    const conditions = this.getStopConditions(runId);

    // Publish judge start event
    bus.publish('goal.judge_started', 'goal-judge', {
      runId,
      conditionCount: conditions.length,
      evidenceCount,
    });

    let verdict: JudgeVerdict;

    // Try LLM-based judging if a provider is available
    if (this.provider && this.config.enabled) {
      try {
        verdict = await this.judgeWithLLM(goal, output, conditions, evidenceCount);
      } catch (err) {
        getGlobalLogger().warn('GoalJudge', 'LLM judge failed, falling back to rule-based', {
          error: (err as Error).message,
        });
        verdict = this.judgeWithRules(goal, output, conditions, evidenceCount);
        verdict.reasoning = `[LLM judge failed: ${(err as Error).message}] ${verdict.reasoning}`;
      }
    } else {
      // No provider → rule-based heuristic
      verdict = this.judgeWithRules(goal, output, conditions, evidenceCount);
      verdict.modelUsed = 'rule-based';
      verdict.provider = 'heuristic';
      verdict.tokensUsed = 0;
    }

    // Cache and publish
    this.verdictCache.set(cacheKey, verdict);
    if (this.verdictCache.size > this.maxCacheSize) {
      const firstKey = this.verdictCache.keys().next().value;
      if (firstKey) this.verdictCache.delete(firstKey);
    }

    bus.publish('goal.judge_completed', 'goal-judge', {
      runId,
      passed: verdict.passed,
      confidence: verdict.confidence,
      tokensUsed: verdict.tokensUsed,
      modelUsed: verdict.modelUsed,
    });

    try {
      mc.incrementCounter('goal_judge_total', 'Goal judge verdicts', 1, [
        { name: 'passed', value: String(verdict.passed) },
        { name: 'model', value: verdict.modelUsed },
      ]);
    } catch (err) {
      reportSilentFailure(err, 'goalJudge:385');
      /* best-effort */
    }

    return verdict;
  }

  // --------------------------------------------------------------------------
  // LLM-based judging
  // --------------------------------------------------------------------------

  private async judgeWithLLM(
    goal: string,
    output: string,
    conditions: StopCondition[],
    evidenceCount: number,
  ): Promise<JudgeVerdict> {
    // Select cheapest eco model from the cascade chain
    const cascade = this.router.getCascadeChain('general', 3);
    const judgeModel = cascade[0] ?? this.router.getModel('gpt-4o-mini');
    const modelId = this.config.model ?? judgeModel?.id ?? 'gpt-4o-mini';

    // Resolve the provider — prefer a different provider from the main agent
    // to avoid shared biases (e.g., if main agent uses claude-sonnet, judge
    // could use gpt-4o-mini). The cascade chain's first entry is typically eco-tier.
    const resolvedModel = this.router.getModel(modelId) ?? judgeModel;
    const providerName = resolvedModel?.provider ?? 'openai';

    // Build the judge prompt
    const prompt = buildJudgePrompt(goal, output, conditions, evidenceCount);
    const maxTokens = Math.min(this.config.judgeTokenBudget, 300);

    // Use the provider — prefixed model for routing
    const apiModel = modelId.replace(/@\w+$/, '');

    const request: LLMRequest = {
      model: apiModel,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature: 0, // Deterministic judging
    };

    // Resolve cross-provider: try to use a different provider from the main agent
    let judgeProvider = this.provider;
    if (this.runtime && providerName) {
      const crossProvider = this.runtime.getProvider(providerName);
      if (crossProvider && crossProvider !== this.provider) {
        judgeProvider = crossProvider;
      }
    }

    const startTime = Date.now();
    const response = await (judgeProvider ?? this.provider!).call(request);
    const elapsed = Date.now() - startTime;
    const tokensUsed = response.usage?.totalTokens ?? 0;

    interface JudgeCondition {
      id?: string;
      passed?: boolean;
      evidence?: string;
    }

    interface JudgeResponse {
      passed: boolean;
      reasoning?: string;
      confidence?: number;
      evidence?: string | string[];
      conditions?: JudgeCondition[];
    }

    // Parse the JSON response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    let parsed: JudgeResponse | null;
    try {
      parsed = jsonMatch ? (JSON.parse(jsonMatch[0]) as JudgeResponse) : null;
    } catch (err) {
      reportSilentFailure(err, 'goalJudge:461');
      parsed = null;
    }

    if (!parsed || typeof parsed.passed !== 'boolean') {
      // Failed to parse — use rule-based fallback
      getGlobalLogger().warn(
        'GoalJudge',
        'Failed to parse judge LLM response, using rule-based fallback',
        {
          content: response.content.slice(0, 200),
        },
      );
      const fallback = this.judgeWithRules(goal, output, conditions, evidenceCount);
      fallback.tokensUsed = tokensUsed;
      fallback.modelUsed = modelId;
      fallback.provider = providerName;
      fallback.reasoning = `[Parse failed] ${fallback.reasoning}`;
      return fallback;
    }

    const conditionsChecked: StopConditionResult[] = Array.isArray(parsed.conditions)
      ? parsed.conditions.map((c: JudgeCondition) => ({
          conditionId: c.id ?? 'unknown',
          description: conditions.find((sc) => sc.id === c.id)?.description ?? c.id ?? 'unknown',
          passed: c.passed ?? false,
          evidence: c.evidence ?? '',
        }))
      : conditions.map((c) => ({
          conditionId: c.id,
          description: c.description,
          passed: parsed.passed,
          evidence: 'Judged holistically',
        }));

    const verdict: JudgeVerdict = {
      passed: parsed.passed,
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? (parsed.passed ? 0.8 : 0.3))),
      reasoning: parsed.reasoning ?? 'No reasoning provided',
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      conditionsChecked,
      modelUsed: modelId,
      provider: providerName,
      tokensUsed,
      timestamp: Date.now(),
    };

    try {
      getMetricsCollector().recordLLMCall(
        modelId,
        providerName,
        tokensUsed,
        elapsed,
        undefined,
        undefined,
      );
    } catch (err) {
      reportSilentFailure(err, 'goalJudge:518');
      /* best-effort */
    }

    return verdict;
  }

  // --------------------------------------------------------------------------
  // Rule-based fallback judging (zero-cost, works without provider)
  // --------------------------------------------------------------------------

  private judgeWithRules(
    goal: string,
    output: string,
    conditions: StopCondition[],
    evidenceCount: number,
  ): JudgeVerdict {
    const outputLower = output.toLowerCase();
    const conditionsChecked: StopConditionResult[] = [];
    const evidence: string[] = [];
    let allPassed = true;

    // 1. Check premature declaration signals
    let hasPrematureSignal = false;
    for (const pattern of PREMATURE_DECLARATION_PATTERNS) {
      if (outputLower.includes(pattern.toLowerCase())) {
        hasPrematureSignal = true;
        evidence.push(`WARNING: Output contains premature declaration: "${pattern}"`);
        break;
      }
    }

    // 2. Check each stop condition
    for (const c of conditions) {
      const result = this.checkCondition(c, output, goal);
      conditionsChecked.push(result);
      if (!result.passed) {
        allPassed = false;
        evidence.push(`FAILED condition [${c.id}]: ${result.evidence}`);
      } else {
        evidence.push(`PASSED condition [${c.id}]: ${result.evidence}`);
      }
    }

    // 3. Evidence count check: very low evidence with premature declaration = fail
    if (evidenceCount < 2 && hasPrematureSignal) {
      allPassed = false;
      evidence.push(`INSUFFICIENT: Only ${evidenceCount} tool calls but claims completion`);
    }

    // 4. Output length check: trivially short outputs with "done" signal are suspicious
    const outputWords = output.split(/\s+/).length;
    if (outputWords < 50 && hasPrematureSignal) {
      allPassed = false;
      evidence.push(`SUSPICIOUS: Short output (${outputWords} words) with completion claim`);
    }

    // 5. Check if goal keywords appear in the output (basic relevance)
    const goalKeywords = goal
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .map((w) => w.toLowerCase());
    const matchedKeywords = goalKeywords.filter((kw) => outputLower.includes(kw));
    const keywordRatio = goalKeywords.length > 0 ? matchedKeywords.length / goalKeywords.length : 1;

    if (keywordRatio < 0.3 && goalKeywords.length > 3) {
      allPassed = false;
      evidence.push(
        `RELEVANCE: Only ${matchedKeywords.length}/${goalKeywords.length} goal keywords found in output`,
      );
    }

    const confidence = allPassed ? 0.75 : 0.3;
    const reasoning = allPassed
      ? `Rule-based check passed: ${conditionsChecked.length} conditions checked, ${evidenceCount} tool calls, no premature-declaration flags.`
      : `Rule-based check failed: ${conditionsChecked.filter((c) => !c.passed).length}/${conditionsChecked.length} conditions not met.`;

    return {
      passed: allPassed,
      confidence,
      reasoning,
      evidence,
      conditionsChecked,
      modelUsed: 'rule-based',
      provider: 'heuristic',
      tokensUsed: 0,
      timestamp: Date.now(),
    };
  }

  private checkCondition(
    condition: StopCondition,
    output: string,
    _goal: string,
  ): StopConditionResult {
    const outputLower = output.toLowerCase();

    switch (condition.type) {
      case 'MUST_HAVE': {
        const pattern = condition.pattern ?? condition.description;
        const found = outputLower.includes(pattern.toLowerCase());
        return {
          conditionId: condition.id,
          description: condition.description,
          passed: found,
          evidence: found ? `Found "${pattern}" in output` : `Missing "${pattern}" in output`,
        };
      }

      case 'MUST_NOT_HAVE': {
        const pattern = condition.pattern ?? condition.description;
        const found = outputLower.includes(pattern.toLowerCase());
        return {
          conditionId: condition.id,
          description: condition.description,
          passed: !found,
          evidence: found
            ? `Found forbidden pattern "${pattern}" in output`
            : `Forbidden pattern "${pattern}" not found`,
        };
      }

      case 'MUST_MATCH': {
        if (!condition.pattern) {
          return {
            conditionId: condition.id,
            description: condition.description,
            passed: false,
            evidence: 'No pattern specified for MUST_MATCH condition',
          };
        }
        try {
          const regex = new RegExp(condition.pattern, 'i');
          const match = regex.test(output);
          return {
            conditionId: condition.id,
            description: condition.description,
            passed: match,
            evidence: match
              ? `Output matches pattern: ${condition.pattern}`
              : `Output does not match pattern: ${condition.pattern}`,
          };
        } catch (err) {
          reportSilentFailure(err, 'goalJudge:661');
          return {
            conditionId: condition.id,
            description: condition.description,
            passed: false,
            evidence: `Invalid regex pattern: ${condition.pattern}`,
          };
        }
      }

      case 'MUST_BE_ABOVE':
        // MUST_BE_ABOVE requires semantic understanding to find the right number.
        // Rule-based mode cannot reliably distinguish "100 tests passed" from
        // "100 errors found". Mark as requiring LLM judge.
        return {
          conditionId: condition.id,
          description: condition.description,
          passed: false,
          evidence: `MUST_BE_ABOVE requires LLM judge — cannot reliably verify threshold ${condition.threshold ?? 0} in rule-based mode`,
        };

      case 'CUSTOM':
        // CUSTOM conditions can only be evaluated by LLM.
        // Rule-based mode marks them as passed with a note.
        return {
          conditionId: condition.id,
          description: condition.description,
          passed: true,
          evidence: 'CUSTOM condition requires LLM judge — passed by default in rule-based mode',
        };

      default:
        return {
          conditionId: condition.id,
          description: condition.description,
          passed: false,
          evidence: `Unknown condition type: ${(condition as { type?: string }).type ?? 'undefined'}`,
        };
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

const goalJudgeSingleton = createTenantAwareSingleton(() => new GoalJudge());

/** Get the global GoalJudge (single-tenant) or tenant-scoped (multi-tenant). */
export function getGoalJudge(): GoalJudge {
  return goalJudgeSingleton.get();
}

/** Reset the GoalJudge singleton (for test isolation). */
export function resetGoalJudge(): void {
  goalJudgeSingleton.reset();
}
