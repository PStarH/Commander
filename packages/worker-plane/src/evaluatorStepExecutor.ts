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
 *
 * Fail-closed contract: an evaluation that cannot be measured is an error, never a
 * pass. A missing rule set, an unimplemented custom evaluator, an unknown method and
 * a malformed rule weight all throw (`EVALUATION_UNMEASURED` / `INVALID_INPUT`) rather
 * than reporting an invented score.
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
      throw new WorkerExecutionError(`Step ${step.id} missing required field: criteria`, {
        code: 'INVALID_INPUT',
        retryable: false,
      });
    }

    const method = input.method ?? 'rules';
    const minScore = input.minScore ?? 0.7;
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new WorkerExecutionError(
        `Step ${step.id} evaluator minScore must be a number between 0 and 1`,
        { code: 'INVALID_INPUT', retryable: false },
      );
    }
    const rules = input.criteria.rules ?? [];
    // Fail closed: an evaluation that cannot be measured must never be reported as a
    // pass. The previous code invented `score: 0.5` for an unimplemented custom
    // evaluator and `score: 1.0, passed: true` when no rules were supplied — a
    // fabricated pass on the quality gate.
    if (method === 'custom') {
      throw new WorkerExecutionError(
        `Step ${step.id} evaluator method 'custom' is not implemented; refusing to report a fabricated score`,
        { code: 'EVALUATION_UNMEASURED', retryable: false },
      );
    }
    if (rules.length === 0) {
      throw new WorkerExecutionError(
        `Step ${step.id} evaluator has no rules to measure (method '${method}'); an unmeasured evaluation must not pass`,
        { code: 'EVALUATION_UNMEASURED', retryable: false },
      );
    }
    const started = Date.now();

    let result: EvaluatorStepOutput;

    switch (method) {
      case 'rules':
        result = this.evaluateWithRules(input.subject, rules, minScore, started);
        break;
      case 'llm':
        // LLM-based evaluation requires an AgentRuntime — for now, fall back to rules
        // In production, this would call AgentRuntime with a specialized evaluation prompt
        result = this.evaluateWithRules(input.subject, rules, minScore, started);
        break;
      default:
        throw new WorkerExecutionError(`Unknown evaluation method: ${method}`, {
          code: 'INVALID_INPUT',
          retryable: false,
        });
    }

    return result as unknown as Record<string, unknown>;
  }

  private evaluateWithRules(
    subject: unknown,
    rules: EvaluationRule[],
    minScore: number,
    started: number,
  ): EvaluatorStepOutput {
    const results: Array<{ name: string; passed: boolean; actual?: unknown }> = [];
    let totalWeight = 0;
    let passedWeight = 0;

    for (const rule of rules) {
      const weight = rule.weight ?? 1;
      // A zero/NaN/negative weight silently disabled the rule's contribution while
      // still counting it in the result set; reject it instead of scoring it away.
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new WorkerExecutionError(
          `Evaluator rule '${rule.name}' has an invalid weight; expected a positive number`,
          { code: 'INVALID_INPUT', retryable: false },
        );
      }
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
          passed =
            typeof value === 'string' &&
            typeof rule.expected === 'string' &&
            value.includes(rule.expected);
          break;
        case 'regex':
          passed =
            typeof value === 'string' &&
            typeof rule.expected === 'string' &&
            new RegExp(rule.expected).test(value);
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

    // Every rule above contributed a positive weight, so totalWeight > 0 here: an
    // unweighted evaluation is rejected before it can be scored as a pass.
    const score = passedWeight / totalWeight;
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
