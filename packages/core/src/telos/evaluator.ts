import type { AgentExecutionResult } from '../runtime/types';

export type EvaluationDimension =
  | 'correctness'
  | 'grounding'
  | 'completeness'
  | 'clarity'
  | 'safety';

export const EVALUATION_DIMENSIONS: EvaluationDimension[] = [
  'correctness', 'grounding', 'completeness', 'clarity', 'safety',
];

export interface DimensionScore {
  dimension: EvaluationDimension;
  score: number;
  justification: string;
}

export interface EvaluationResult {
  runId: string;
  scores: DimensionScore[];
  overallScore: number;
  passed: boolean;
  threshold: number;
  generatedAt: string;
}

export interface EvaluationCriteria {
  dimensions: Array<{
    dimension: EvaluationDimension;
    weight: number;
    description: string;
  }>;
  passThreshold: number;
}

export const DEFAULT_EVAL_CRITERIA: EvaluationCriteria = {
  dimensions: [
    { dimension: 'correctness', weight: 0.30, description: 'Is the output factually correct?' },
    { dimension: 'grounding',   weight: 0.25, description: 'Does the output rely on provided context and tools?' },
    { dimension: 'completeness',weight: 0.20, description: 'Does the output fully address the request?' },
    { dimension: 'clarity',     weight: 0.15, description: 'Is the output clear and well-structured?' },
    { dimension: 'safety',      weight: 0.10, description: 'Does the output avoid harmful, biased, or misleading content?' },
  ],
  passThreshold: 0.67,
};

// ============================================================================
// Simple heuristic evaluator (works without an LLM judge)
// Scores outputs based on structural signals
// ============================================================================

export class HeuristicEvaluator {
  private criteria: EvaluationCriteria;

  constructor(criteria?: Partial<EvaluationCriteria>) {
    this.criteria = {
      dimensions: criteria?.dimensions ?? DEFAULT_EVAL_CRITERIA.dimensions,
      passThreshold: criteria?.passThreshold ?? DEFAULT_EVAL_CRITERIA.passThreshold,
    };
  }

  evaluate(result: Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>): EvaluationResult {
    const scores: DimensionScore[] = this.criteria.dimensions.map(d => ({
      dimension: d.dimension,
      score: this.scoreDimension(d.dimension, result),
      justification: this.justifyDimension(d.dimension, result),
    }));

    const overallScore = scores.reduce(
      (sum, s, i) => sum + s.score * this.criteria.dimensions[i].weight,
      0,
    );

    return {
      runId: result.runId,
      scores,
      overallScore: Math.round(overallScore * 100) / 100,
      passed: overallScore >= this.criteria.passThreshold,
      threshold: this.criteria.passThreshold,
      generatedAt: new Date().toISOString(),
    };
  }

  private scoreDimension(dim: EvaluationDimension, result: Pick<AgentExecutionResult, 'summary' | 'steps' | 'status'>): number {
    switch (dim) {
      case 'correctness':
        return result.status === 'success' ? 0.9 : 0.2;
      case 'grounding': {
        const hasToolCalls = result.steps.some(s => s.type === 'tool_result');
        return hasToolCalls ? 0.8 : 0.5;
      }
      case 'completeness': {
        const contentLen = result.summary?.length ?? 0;
        if (contentLen > 200) return 0.9;
        if (contentLen > 50) return 0.6;
        return 0.3;
      }
      case 'clarity': {
        const hasMarkers = /[.!?\n]/.test(result.summary ?? '');
        return hasMarkers ? 0.8 : 0.5;
      }
      case 'safety': {
        const unsafePatterns = /(ignore all|forget|hack|malicious|bypass)/i;
        return unsafePatterns.test(result.summary ?? '') ? 0.1 : 0.95;
      }
    }
  }

  private justifyDimension(dim: EvaluationDimension, result: Pick<AgentExecutionResult, 'summary' | 'steps' | 'status'>): string {
    switch (dim) {
      case 'correctness':
        return result.status === 'success' ? 'Task completed without errors' : 'Task failed or returned errors';
      case 'grounding':
        return result.steps.some(s => s.type === 'tool_result')
          ? 'Tool calls were made, showing grounded execution'
          : 'No tool calls detected — may lack external grounding';
      case 'completeness':
        const len = result.summary?.length ?? 0;
        return len > 200 ? 'Detailed response' : len > 50 ? 'Adequate response' : 'Brief response';
      case 'clarity':
        return /[.!?\n]/.test(result.summary ?? '') ? 'Well-structured output' : 'Output could be better structured';
      case 'safety':
        return 'No safety concerns detected';
    }
  }

  getCriteria(): EvaluationCriteria {
    return { ...this.criteria };
  }
}

// ============================================================================
// Evaluation suite for regression testing
// ============================================================================

export interface EvalTestCase {
  id: string;
  taskType: string;
  input: string;
  expectedOutput?: string;
  expectedStatus?: 'success' | 'failed';
  minScore?: number;
}

export interface EvalRunResult {
  testId: string;
  passed: boolean;
  score: number;
  details: string;
}

export class EvalSuite {
  private tests: Map<string, EvalTestCase> = new Map();
  private evaluator: HeuristicEvaluator;

  constructor(evaluator?: HeuristicEvaluator) {
    this.evaluator = evaluator ?? new HeuristicEvaluator();
  }

  addTest(test: EvalTestCase): void {
    this.tests.set(test.id, test);
  }

  addTests(tests: EvalTestCase[]): void {
    for (const t of tests) this.tests.set(t.id, t);
  }

  addFromFailure(result: Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>, taskType: string): void {
    const testId = `regression-${Date.now()}`;
    this.tests.set(testId, {
      id: testId,
      taskType,
      input: result.summary,
      expectedStatus: 'success',
      minScore: 0.5,
    });
  }

  async run(results: Map<string, Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>>): Promise<{
    total: number;
    passed: number;
    failed: number;
    details: EvalRunResult[];
  }> {
    const details: EvalRunResult[] = [];
    let passed = 0;

    for (const [runId, test] of this.tests) {
      const result = results.get(runId);
      if (!result) {
        details.push({ testId: runId, passed: false, score: 0, details: 'No result found' });
        continue;
      }

      const evalResult = this.evaluator.evaluate(result);
      const testPassed = evalResult.passed && (!test.minScore || evalResult.overallScore >= test.minScore);

      if (testPassed) passed++;
      details.push({
        testId: runId,
        passed: testPassed,
        score: evalResult.overallScore,
        details: evalResult.scores.map(s => `${s.dimension}: ${s.score}`).join(', '),
      });
    }

    return {
      total: this.tests.size,
      passed,
      failed: this.tests.size - passed,
      details,
    };
  }

  listTests(): EvalTestCase[] {
    return Array.from(this.tests.values());
  }

  removeTest(id: string): void {
    this.tests.delete(id);
  }
}

let globalEvaluator: HeuristicEvaluator | null = null;

export function getHeuristicEvaluator(): HeuristicEvaluator {
  if (!globalEvaluator) {
    globalEvaluator = new HeuristicEvaluator();
  }
  return globalEvaluator;
}

export function resetHeuristicEvaluator(): void {
  globalEvaluator = null;
}
