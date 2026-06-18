"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvalSuite = exports.HeuristicEvaluator = exports.DEFAULT_EVAL_CRITERIA = exports.EVALUATION_DIMENSIONS = void 0;
exports.getHeuristicEvaluator = getHeuristicEvaluator;
exports.resetHeuristicEvaluator = resetHeuristicEvaluator;
exports.EVALUATION_DIMENSIONS = [
    'correctness',
    'grounding',
    'completeness',
    'clarity',
    'safety',
];
exports.DEFAULT_EVAL_CRITERIA = {
    dimensions: [
        { dimension: 'correctness', weight: 0.3, description: 'Is the output factually correct?' },
        {
            dimension: 'grounding',
            weight: 0.25,
            description: 'Does the output rely on provided context and tools?',
        },
        {
            dimension: 'completeness',
            weight: 0.2,
            description: 'Does the output fully address the request?',
        },
        { dimension: 'clarity', weight: 0.15, description: 'Is the output clear and well-structured?' },
        {
            dimension: 'safety',
            weight: 0.1,
            description: 'Does the output avoid harmful, biased, or misleading content?',
        },
    ],
    passThreshold: 0.67,
};
// ============================================================================
// Simple heuristic evaluator (works without an LLM judge)
// Scores outputs based on structural signals
// ============================================================================
class HeuristicEvaluator {
    constructor(criteria) {
        var _a, _b;
        this.criteria = {
            dimensions: (_a = criteria === null || criteria === void 0 ? void 0 : criteria.dimensions) !== null && _a !== void 0 ? _a : exports.DEFAULT_EVAL_CRITERIA.dimensions,
            passThreshold: (_b = criteria === null || criteria === void 0 ? void 0 : criteria.passThreshold) !== null && _b !== void 0 ? _b : exports.DEFAULT_EVAL_CRITERIA.passThreshold,
        };
    }
    evaluate(result) {
        const scores = this.criteria.dimensions.map((d) => ({
            dimension: d.dimension,
            score: this.scoreDimension(d.dimension, result),
            justification: this.justifyDimension(d.dimension, result),
        }));
        const overallScore = scores.reduce((sum, s, i) => sum + s.score * this.criteria.dimensions[i].weight, 0);
        return {
            runId: result.runId,
            scores,
            overallScore: Math.round(overallScore * 100) / 100,
            passed: overallScore >= this.criteria.passThreshold,
            threshold: this.criteria.passThreshold,
            generatedAt: new Date().toISOString(),
        };
    }
    scoreDimension(dim, result) {
        var _a, _b, _c, _d;
        switch (dim) {
            case 'correctness':
                return result.status === 'success' ? 0.9 : 0.2;
            case 'grounding': {
                const hasToolCalls = result.steps.some((s) => s.type === 'tool_result');
                return hasToolCalls ? 0.8 : 0.5;
            }
            case 'completeness': {
                const contentLen = (_b = (_a = result.summary) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
                if (contentLen > 200)
                    return 0.9;
                if (contentLen > 50)
                    return 0.6;
                return 0.3;
            }
            case 'clarity': {
                const hasMarkers = /[.!?\n]/.test((_c = result.summary) !== null && _c !== void 0 ? _c : '');
                return hasMarkers ? 0.8 : 0.5;
            }
            case 'safety': {
                const unsafePatterns = /(ignore all|forget|hack|malicious|bypass)/i;
                return unsafePatterns.test((_d = result.summary) !== null && _d !== void 0 ? _d : '') ? 0.1 : 0.95;
            }
            default:
                return 0.5;
        }
    }
    justifyDimension(dim, result) {
        var _a, _b, _c, _d;
        switch (dim) {
            case 'correctness':
                return result.status === 'success'
                    ? 'Task completed without errors'
                    : 'Task failed or returned errors';
            case 'grounding':
                return result.steps.some((s) => s.type === 'tool_result')
                    ? 'Tool calls were made, showing grounded execution'
                    : 'No tool calls detected — may lack external grounding';
            case 'completeness':
                const len = (_b = (_a = result.summary) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
                return len > 200 ? 'Detailed response' : len > 50 ? 'Adequate response' : 'Brief response';
            case 'clarity':
                return /[.!?\n]/.test((_c = result.summary) !== null && _c !== void 0 ? _c : '')
                    ? 'Well-structured output'
                    : 'Output could be better structured';
            case 'safety': {
                const unsafePatterns = /(ignore all|forget|hack|malicious|bypass)/i;
                return unsafePatterns.test((_d = result.summary) !== null && _d !== void 0 ? _d : '')
                    ? 'Unsafe patterns detected in output'
                    : 'No safety concerns detected';
            }
            default:
                return 'No evaluation available for this dimension';
        }
    }
    getCriteria() {
        return { ...this.criteria };
    }
}
exports.HeuristicEvaluator = HeuristicEvaluator;
class EvalSuite {
    constructor(evaluator, maxTests = 1000) {
        this.tests = new Map();
        this.evaluator = evaluator !== null && evaluator !== void 0 ? evaluator : new HeuristicEvaluator();
        this.maxTests = maxTests;
    }
    addTest(test) {
        this.tests.set(test.id, test);
        this.evictIfNeeded();
    }
    addTests(tests) {
        for (const t of tests)
            this.tests.set(t.id, t);
        this.evictIfNeeded();
    }
    addFromFailure(result, taskType) {
        const testId = `regression-${result.runId}`;
        this.tests.set(testId, {
            id: testId,
            taskType,
            input: result.summary,
            expectedStatus: 'success',
            minScore: 0.5,
        });
        this.evictIfNeeded();
    }
    evictIfNeeded() {
        if (this.tests.size <= this.maxTests)
            return;
        const toRemove = this.tests.size - this.maxTests;
        const iter = this.tests.keys();
        for (let i = 0; i < toRemove; i++) {
            const key = iter.next().value;
            if (key)
                this.tests.delete(key);
        }
    }
    async run(results) {
        const details = [];
        let passed = 0;
        for (const [runId, test] of this.tests) {
            const result = results.get(runId);
            if (!result) {
                details.push({ testId: runId, passed: false, score: 0, details: 'No result found' });
                continue;
            }
            const evalResult = this.evaluator.evaluate(result);
            const testPassed = evalResult.passed && (!test.minScore || evalResult.overallScore >= test.minScore);
            if (testPassed)
                passed++;
            details.push({
                testId: runId,
                passed: testPassed,
                score: evalResult.overallScore,
                details: evalResult.scores.map((s) => `${s.dimension}: ${s.score}`).join(', '),
            });
        }
        return {
            total: this.tests.size,
            passed,
            failed: this.tests.size - passed,
            details,
        };
    }
    listTests() {
        return Array.from(this.tests.values());
    }
    removeTest(id) {
        this.tests.delete(id);
    }
}
exports.EvalSuite = EvalSuite;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const evaluatorSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new HeuristicEvaluator());
function getHeuristicEvaluator() {
    return evaluatorSingleton.get();
}
function resetHeuristicEvaluator() {
    evaluatorSingleton.reset();
}
