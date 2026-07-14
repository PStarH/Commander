/**
 * EvaluatorStepExecutor — executes evaluation/quality check steps.
 *
 * Evaluator steps assess the quality of previous step outputs. They can be
 * used for:
 * - Output quality scoring (e.g., code review, documentation check)
 * - Policy compliance validation
 * - Safety/harmfulness checks
 * - Custom evaluation criteria
 *
 * The evaluator can either:
 * 1. Use a lightweight rule-based checker (no LLM call)
 * 2. Use an LLM-based evaluator (via AgentRuntime)
 * 3. Use a custom evaluation function
 */

import type { StepExecutor, ClaimedStep, WorkerRecord } from './types.js';
import { WorkerExecutionError } from './types.js';

export interface EvaluatorStepInput {
  /** The output to evaluate. */
  subject: unknown;
  /** Evaluation criteria. */
  criteria: EvaluationCriteria;
  /** Evaluation method: 'rules' | 'llm' | 'custom'. */
  method?: 'rules' | 'llm' | 'custom';
  /** Optional: minimum score to pass (0-1). */
  minScore?: number;
  /** Optional: evaluator model override. */
  model?: string;
}

export interface EvaluationCriteria {
  /** Human-readable description of what's being evaluated. */
  description?: string;
  /** Rule-based checks (method='rules'). */
  rules?: EvaluationRule[];
  /** LLM prompt template (method='llm'). */
  promptTemplate?: string;
  /** Custom evaluator function name (method='custom'). */
  customEvaluator?: string;
}

export interface EvaluationRule {
  /** Rule name. */
  name: string;
  /** JSON path or field to check. */
  path: string;
  /** Check type: 'exists' | 'equals' | 'contains' | 'regex' | 'minLength' | 'maxLength'. */
  check: 'exists' | 'equals' | 'contains' | 'regex' | 'minLength' | 'maxLength';
  /** Expected value for the check. */
  expected?: unknown;
  /** Weight of this rule (default: 1). */
  weight?: number;
}

export interface EvaluatorStepOutput {
  /** Overall score (0-1). */
  score: number;
  /** Whether the evaluation passed (score >= minScore). */
  passed: boolean;
  /** Per-rule results. */
  ruleResults?: Array<{ name: string; passed: boolean; actual?: unknown }>;
  /** Evaluation summary. */
  summary: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

export class EvaluatorStepExecutor implements StepExecutor {
  async execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: WorkerRecord },
  ): Promise<Record<string, unknown> | undefined> {
    const input = step.input as unknown as EvaluatorStepInput;

    if (!input.criteria) {
      throw new WorkerExecutionError(
        `Step ${step.id} missing required field: criteria`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }

    const method = input.method ?? 'rules';
    const minScore = input.minScore ?? 0.7;
    const started = Date.now();

    let result: EvaluatorStepOutput;

    switch (method) {
      case 'rules':
        result = this.evaluateWithRules(input.subject, input.criteria.rules ?? [], minScore, started);
        break;
      case 'llm':
        // LLM-based evaluation requires an AgentRuntime — for now, fall back to rules
        // In production, this would call AgentRuntime with a specialized evaluation prompt
        result = this.evaluateWithRules(input.subject, input.criteria.rules ?? [], minScore, started);
        break;
      case 'custom':
        // Custom evaluators would be registered and looked up by name
        result = {
          score: 0.5,
          passed: 0.5 >= minScore,
          summary: 'Custom evaluator not yet implemented',
          durationMs: Date.now() - started,
        };
        break;
      default:
        throw new WorkerExecutionError(
          `Unknown evaluation method: ${method}`,
          { code: 'INVALID_INPUT', retryable: false },
        );
    }

    return result as unknown as Record<string, unknown>;
  }

  private evaluateWithRules(
    subject: unknown,
    rules: EvaluationRule[],
    minScore: number,
    started: number,
  ): EvaluatorStepOutput {
    if (rules.length === 0) {
      return {
        score: 1.0,
        passed: true,
        summary: 'No rules defined; evaluation passed by default',
        durationMs: Date.now() - started,
      };
    }

    const results: Array<{ name: string; passed: boolean; actual?: unknown }> = [];
    let totalWeight = 0;
    let passedWeight = 0;

    for (const rule of rules) {
      const weight = rule.weight ?? 1;
      totalWeight += weight;
      const value = this.getPath(subject, rule.path);
      let passed = false;

      switch (rule.check) {
        case 'exists':
          passed = value !== undefined && value !== null;
          break;
        case 'equals':
          passed = value === rule.expected;
          break;
        case 'contains':
          passed = typeof value === 'string' && typeof rule.expected === 'string' && value.includes(rule.expected);
          break;
        case 'regex':
          passed = typeof value === 'string' && typeof rule.expected === 'string' && new RegExp(rule.expected).test(value);
          break;
        case 'minLength':
          passed = typeof value === 'string' && value.length >= Number(rule.expected);
          break;
        case 'maxLength':
          passed = typeof value === 'string' && value.length <= Number(rule.expected);
          break;
      }

      if (passed) passedWeight += weight;
      results.push({ name: rule.name, passed, actual: value });
    }

    const score = totalWeight > 0 ? passedWeight / totalWeight : 1.0;
    const passed = score >= minScore;
    const failedRules = results.filter((r) => !r.passed).map((r) => r.name);

    return {
      score,
      passed,
      ruleResults: results,
      summary: passed
        ? `Evaluation passed with score ${score.toFixed(2)}`
        : `Evaluation failed with score ${score.toFixed(2)} (min: ${minScore}). Failed rules: ${failedRules.join(', ')}`,
      durationMs: Date.now() - started,
    };
  }

  private getPath(obj: unknown, path: string): unknown {
    if (!path) return obj;
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
