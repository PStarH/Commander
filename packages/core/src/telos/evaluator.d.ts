import type { AgentExecutionResult } from '../runtime/types';
export type EvaluationDimension = 'correctness' | 'grounding' | 'completeness' | 'clarity' | 'safety';
export declare const EVALUATION_DIMENSIONS: EvaluationDimension[];
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
export declare const DEFAULT_EVAL_CRITERIA: EvaluationCriteria;
export declare class HeuristicEvaluator {
    private criteria;
    constructor(criteria?: Partial<EvaluationCriteria>);
    evaluate(result: Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>): EvaluationResult;
    private scoreDimension;
    private justifyDimension;
    getCriteria(): EvaluationCriteria;
}
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
export declare class EvalSuite {
    private tests;
    private evaluator;
    private maxTests;
    constructor(evaluator?: HeuristicEvaluator, maxTests?: number);
    addTest(test: EvalTestCase): void;
    addTests(tests: EvalTestCase[]): void;
    addFromFailure(result: Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>, taskType: string): void;
    private evictIfNeeded;
    run(results: Map<string, Pick<AgentExecutionResult, 'runId' | 'summary' | 'steps' | 'status'>>): Promise<{
        total: number;
        passed: number;
        failed: number;
        details: EvalRunResult[];
    }>;
    listTests(): EvalTestCase[];
    removeTest(id: string): void;
}
export declare function getHeuristicEvaluator(): HeuristicEvaluator;
export declare function resetHeuristicEvaluator(): void;
//# sourceMappingURL=evaluator.d.ts.map