"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryAnalyzer = void 0;
const logging_1 = require("../logging");
const structuredOutput_1 = require("../runtime/structuredOutput");
const CLASSIFIER_RULES = [
    {
        category: 'tool_misuse',
        keywords: [
            'tool error',
            'tool not found',
            'invalid tool',
            'tool failed',
            'missing tool',
            'unknown tool',
            'tool call',
            'no such tool',
            'permission denied to tool',
            'tool timeout',
            'tool crashed',
            'malformed tool',
        ],
        confidence: 0.7,
    },
    {
        category: 'context_overflow',
        keywords: [
            'context length',
            'token limit',
            'too many tokens',
            'max tokens',
            'context window',
            'truncated',
            'token budget exceeded',
            'context overflow',
            'maximum context',
            'prompt too long',
            'input too large',
        ],
        confidence: 0.8,
    },
    {
        category: 'timeout',
        keywords: [
            'timeout',
            'timed out',
            'deadline',
            'took too long',
            'exceeded time',
            'execution timeout',
            'request timed out',
            'duration limit',
            'operation expired',
            'connection timeout',
            'read timeout',
        ],
        confidence: 0.8,
    },
    {
        category: 'model_refusal',
        keywords: [
            'cannot',
            'unable to',
            'i cannot',
            'i am not able',
            "don't have access",
            'not implemented',
            "i don't",
            "i won't",
            'sorry, i cannot',
            'as an ai',
            "i'm not able",
            "i'm sorry",
            'refused',
            'declined',
            'not allowed',
        ],
        confidence: 0.65,
    },
    {
        category: 'missing_capability',
        keywords: [
            'not supported',
            'not available',
            'not installed',
            'command not found',
            'no such file',
            'dependency',
            'not found',
            'missing requirement',
            'does not exist',
            'not configured',
            'module not found',
            'package not found',
        ],
        confidence: 0.6,
    },
    {
        category: 'planning_error',
        keywords: [
            'plan changed',
            'unexpected',
            'wrong approach',
            'strategy failed',
            'incorrect plan',
            'misunderstood',
            'wrong direction',
            'not what was asked',
            'redundant',
            'circular',
            'backtrack',
            're-plan',
            'went off track',
        ],
        confidence: 0.55,
    },
    {
        category: 'hallucination',
        keywords: [
            'fabricated',
            "doesn't exist",
            'made up',
            'hallucination',
            'incorrect information',
            'not real',
            'invented',
            'never existed',
            'fake reference',
            'nonexistent',
            'phantom',
        ],
        confidence: 0.7,
    },
    {
        category: 'dependency_failure',
        keywords: [
            'dependency failed',
            'subtask failed',
            'child task',
            'prerequisite',
            'dependency error',
            'chain failed',
            'upstream',
            'cascade failure',
            'blocked by',
            'waiting on',
        ],
        confidence: 0.65,
    },
    {
        category: 'quality_gate',
        keywords: [
            'quality gate',
            'gate failed',
            'verification failed',
            'hallucination detected',
            'consistency check',
            'safety check',
            'score threshold',
            'review rejected',
            'below threshold',
            'quality check',
        ],
        confidence: 0.75,
    },
    {
        category: 'rate_limit',
        keywords: [
            'rate limit',
            'rate limited',
            'too many requests',
            '429',
            'throttled',
            'quota exceeded',
            'retry after',
            'back off',
            'slow down',
        ],
        confidence: 0.85,
    },
    {
        category: 'authentication',
        keywords: [
            'authentication',
            'unauthorized',
            '401',
            '403',
            'forbidden',
            'invalid token',
            'expired token',
            'access denied',
            'permission denied',
            'invalid credentials',
            'api key',
            'auth failed',
        ],
        confidence: 0.8,
    },
    {
        category: 'resource_exhaustion',
        keywords: [
            'out of memory',
            'oom',
            'disk full',
            'no space',
            'resource exhausted',
            'memory limit',
            'heap',
            'stack overflow',
            'file descriptor',
            'too many open',
        ],
        confidence: 0.8,
    },
    {
        category: 'data_validation',
        keywords: [
            'validation error',
            'invalid format',
            'malformed',
            'parse error',
            'schema violation',
            'type mismatch',
            'invalid input',
            'bad request',
            'unexpected format',
            'encoding error',
        ],
        confidence: 0.7,
    },
];
function classifyWithHeuristics(exp) {
    var _a, _b, _c;
    const corpus = [
        (_a = exp.errorPattern) !== null && _a !== void 0 ? _a : '',
        ...exp.lessons,
        ...((_b = exp.toolsUsed) !== null && _b !== void 0 ? _b : []),
        (_c = exp.topology) !== null && _c !== void 0 ? _c : '',
        exp.taskType,
    ]
        .join(' ')
        .toLowerCase();
    let best = {
        category: 'unclassified',
        confidence: 0,
        evidence: [],
    };
    for (const rule of CLASSIFIER_RULES) {
        const matched = rule.keywords.filter((kw) => corpus.includes(kw));
        if (matched.length === 0)
            continue;
        // Boost confidence per additional keyword match (capped)
        const boost = Math.min(0.2, matched.length * 0.05);
        const confidence = Math.min(0.95, rule.confidence + boost);
        if (confidence > best.confidence) {
            best = { category: rule.category, confidence, evidence: matched };
        }
    }
    return best;
}
// ============================================================================
// LLM-based classifier (used in balanced/thorough modes)
// ============================================================================
const CLASSIFY_PROMPT = [
    'Analyse the following execution failure and classify it into exactly one category.',
    'Categories:',
    '- tool_misuse: wrong tool called or tool error',
    '- context_overflow: token/context budget exceeded',
    '- timeout: execution took too long',
    '- model_refusal: model refused to comply',
    '- missing_capability: required capability/command/file not found',
    '- planning_error: wrong approach or misunderstanding',
    '- hallucination: made-up content or references',
    '- dependency_failure: a subtask or dependency failed',
    '- quality_gate: quality/verification gate rejected output',
    '- rate_limit: API rate limiting or throttling',
    '- authentication: auth/permission failures',
    '- resource_exhaustion: memory/disk/CPU limits hit',
    '- data_validation: invalid input/output format or schema',
    '- unclassified: does not fit any above category',
    '',
    'Return a JSON object with: category (string), confidence (0-1), evidence (string[]), suggestion (string).',
    'Output ONLY valid JSON with no markdown formatting.',
].join('\n');
async function classifyWithLLM(provider, model, exps) {
    var _a, _b, _c, _d, _e, _f, _g;
    const results = [];
    for (const exp of exps) {
        try {
            const userMsg = [
                `Task type: ${exp.taskType}`,
                `Strategy: ${exp.strategyUsed}`,
                `Model: ${exp.modelUsed}`,
                `Duration: ${exp.durationMs}ms`,
                `Tokens: ${exp.tokenCost}`,
                `Error pattern: ${(_a = exp.errorPattern) !== null && _a !== void 0 ? _a : '(none)'}`,
                `Lessons: ${exp.lessons.join('; ')}`,
                `Tools used: ${((_b = exp.toolsUsed) !== null && _b !== void 0 ? _b : []).join(', ')}`,
            ].join('\n');
            const response = await provider.call({
                model,
                messages: [
                    { role: 'system', content: CLASSIFY_PROMPT },
                    { role: 'user', content: userMsg },
                ],
                temperature: 0.1,
                maxTokens: 300,
            });
            const cleaned = response.content
                .trim()
                .replace(/^```(?:json)?\s*/, '')
                .replace(/```\s*$/, '');
            const raw = JSON.parse(cleaned);
            if (!(0, structuredOutput_1.validateShape)(raw, { category: 'string', confidence: 'number', evidence: 'array' })) {
                (0, logging_1.getGlobalLogger)().warn('TrajectoryAnalyzer', 'LLM response failed shape validation, skipping');
                continue;
            }
            const parsed = raw;
            results.push({
                runId: (_c = exp.runId) !== null && _c !== void 0 ? _c : exp.id,
                taskType: exp.taskType,
                modelUsed: exp.modelUsed,
                strategyUsed: exp.strategyUsed,
                success: exp.success,
                errorPattern: exp.errorPattern,
                failureCategory: isValidCategory(parsed.category) ? parsed.category : 'unclassified',
                confidence: (_d = parsed.confidence) !== null && _d !== void 0 ? _d : 0.5,
                evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
                suggestion: parsed.suggestion,
                analysisTokens: (_f = (_e = response.usage) === null || _e === void 0 ? void 0 : _e.totalTokens) !== null && _f !== void 0 ? _f : 0,
            });
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().warn('TrajectoryAnalyzer', 'LLM classification failed, falling back to heuristic', { error: err === null || err === void 0 ? void 0 : err.message });
            results.push({
                runId: (_g = exp.runId) !== null && _g !== void 0 ? _g : exp.id,
                taskType: exp.taskType,
                modelUsed: exp.modelUsed,
                strategyUsed: exp.strategyUsed,
                success: exp.success,
                errorPattern: exp.errorPattern,
                failureCategory: 'unclassified',
                confidence: 0.3,
                evidence: ['LLM analysis failed'],
                analysisTokens: 0,
            });
        }
    }
    return results;
}
function isValidCategory(s) {
    return [
        'tool_misuse',
        'context_overflow',
        'timeout',
        'model_refusal',
        'missing_capability',
        'planning_error',
        'hallucination',
        'dependency_failure',
        'quality_gate',
        'rate_limit',
        'authentication',
        'resource_exhaustion',
        'data_validation',
        'unclassified',
    ].includes(s);
}
// ============================================================================
// TrajectoryAnalyzer
// ============================================================================
class TrajectoryAnalyzer {
    constructor(mode, provider, model) {
        this.mode = mode;
        this.provider = provider;
        this.model = model;
    }
    /**
     * Analyse a batch of execution experiences.
     *
     * light:     heuristic-only, zero LLM calls
     * balanced:  heuristic first, LLM fallback for unclassified failures
     * thorough:  LLM for every failure, successes use heuristic
     */
    async analyze(experiences) {
        const successes = experiences.filter((e) => e.success);
        const failures = experiences.filter((e) => !e.success);
        const successInsights = successes.map((e) => {
            var _a;
            return ({
                runId: (_a = e.runId) !== null && _a !== void 0 ? _a : e.id,
                taskType: e.taskType,
                modelUsed: e.modelUsed,
                strategyUsed: e.strategyUsed,
                success: true,
                errorPattern: e.errorPattern,
                failureCategory: 'unclassified',
                confidence: 1,
                evidence: [],
                analysisTokens: 0,
            });
        });
        if (this.mode === 'light') {
            const failureInsights = failures.map((e) => {
                var _a;
                const hc = classifyWithHeuristics(e);
                return {
                    runId: (_a = e.runId) !== null && _a !== void 0 ? _a : e.id,
                    taskType: e.taskType,
                    modelUsed: e.modelUsed,
                    strategyUsed: e.strategyUsed,
                    success: false,
                    errorPattern: e.errorPattern,
                    failureCategory: hc.category,
                    confidence: hc.confidence,
                    evidence: hc.evidence,
                    analysisTokens: 0,
                };
            });
            return [...successInsights, ...failureInsights];
        }
        if (this.mode === 'balanced') {
            const heuristicResults = failures.map((e) => {
                const hc = classifyWithHeuristics(e);
                return { exp: e, category: hc.category, confidence: hc.confidence, evidence: hc.evidence };
            });
            const unclassified = heuristicResults
                .filter((h) => h.category === 'unclassified')
                .map((h) => h.exp);
            let llmResults = [];
            if (unclassified.length > 0 && this.provider && this.model) {
                llmResults = await classifyWithLLM(this.provider, this.model, unclassified);
            }
            const llmMap = new Map(llmResults.map((r) => [r.runId, r]));
            const failureInsights = heuristicResults.map((h) => {
                var _a, _b;
                const llm = llmMap.get((_a = h.exp.runId) !== null && _a !== void 0 ? _a : h.exp.id);
                if (llm)
                    return llm;
                return {
                    runId: (_b = h.exp.runId) !== null && _b !== void 0 ? _b : h.exp.id,
                    taskType: h.exp.taskType,
                    modelUsed: h.exp.modelUsed,
                    strategyUsed: h.exp.strategyUsed,
                    success: false,
                    errorPattern: h.exp.errorPattern,
                    failureCategory: h.category,
                    confidence: h.confidence,
                    evidence: h.evidence,
                    analysisTokens: 0,
                };
            });
            return [...successInsights, ...failureInsights];
        }
        // thorough: LLM for all failures
        if (this.provider && this.model && failures.length > 0) {
            const llmResults = await classifyWithLLM(this.provider, this.model, failures);
            const llmMap = new Map(llmResults.map((r) => [r.runId, r]));
            const failureInsights = failures.map((e) => {
                var _a, _b;
                const llm = llmMap.get((_a = e.runId) !== null && _a !== void 0 ? _a : e.id);
                if (llm)
                    return llm;
                const hc = classifyWithHeuristics(e);
                return {
                    runId: (_b = e.runId) !== null && _b !== void 0 ? _b : e.id,
                    taskType: e.taskType,
                    modelUsed: e.modelUsed,
                    strategyUsed: e.strategyUsed,
                    success: false,
                    errorPattern: e.errorPattern,
                    failureCategory: hc.category,
                    confidence: hc.confidence,
                    evidence: hc.evidence,
                    analysisTokens: 0,
                };
            });
            return [...successInsights, ...failureInsights];
        }
        // Fallback: no LLM available for thorough mode — degrade to heuristic
        const failureInsights = failures.map((e) => {
            var _a;
            const hc = classifyWithHeuristics(e);
            return {
                runId: (_a = e.runId) !== null && _a !== void 0 ? _a : e.id,
                taskType: e.taskType,
                modelUsed: e.modelUsed,
                strategyUsed: e.strategyUsed,
                success: false,
                errorPattern: e.errorPattern,
                failureCategory: hc.category,
                confidence: hc.confidence,
                evidence: hc.evidence,
                analysisTokens: 0,
            };
        });
        return [...successInsights, ...failureInsights];
    }
}
exports.TrajectoryAnalyzer = TrajectoryAnalyzer;
