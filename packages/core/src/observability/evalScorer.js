"use strict";
/**
 * P-obs-3: LLM-as-judge eval scorer (Braintrust-style).
 *
 * Takes a rubric (prompt template + score range + judge model) and a
 * "target" (a trace summary, a single output string, or a
 * {input, output, expected} tuple) and returns a numeric score via
 * a judge LLM. The judge LLM is the same `LLMProvider` interface
 * Commander already uses for agent execution — no new dependency.
 *
 * Design notes:
 *  - The judge prompt is a small templated string. We inject the
 *    target's fields as JSON blocks so the judge can reason about
 *    them. No fancy tool-use, no agent loop, no retries — this is
 *    a single-shot LLM call.
 *  - The judge response MUST be JSON in the shape
 *    `{ "score": <number>, "reasoning": "<string>" }`. We
 *    robustly parse the response (the LLM sometimes wraps the
 *    JSON in markdown code fences) and fall back to a score of 0
 *    with a synthetic reasoning if parsing fails.
 *  - The score is clamped to the rubric's range. Out-of-range
 *    scores are clamped, not rejected.
 *  - We never throw on judge failure — the caller (experiment
 *    runner, auto-scorer) gets back a result with `error` set.
 *    The eval pipeline is best-effort: a judge outage must not
 *    break the run.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvalScorer = void 0;
exports.parseJudgeResponse = parseJudgeResponse;
const DEFAULT_RUBRIC = {
    id: 'default-quality',
    name: 'Default Quality',
    description: 'Generic correctness + completeness rubric.',
    promptTemplate: `You are an evaluation judge. Score the agent's output against the expected output on a scale of 0.0 to 1.0.

INPUT:
{{input}}

OUTPUT:
{{output}}

EXPECTED:
{{expected}}

TOOLS CALLED:
{{tools}}

DURATION_MS: {{durationMs}}
COST_USD: {{costUsd}}
TOKENS: {{tokens}}

Respond with ONLY a JSON object in this exact shape (no markdown, no extra text):
{"score": <number between 0.0 and 1.0>, "reasoning": "<one short sentence explaining the score>"}`,
    scoreRange: { min: 0, max: 1 },
    judgeModel: 'gpt-4o-mini',
    criteria: ['correctness', 'completeness', 'no_hallucination'],
};
class EvalScorer {
    constructor(
    /** Provider used for judge calls. May be null in tests/disabled mode. */
    provider, config = {}) {
        var _a, _b, _c, _d, _e, _f;
        this.provider = provider;
        /** Registry of named rubrics, looked up by id. */
        this.rubrics = new Map();
        this.defaultRubric = (_a = config.defaultRubric) !== null && _a !== void 0 ? _a : DEFAULT_RUBRIC;
        this.defaultJudgeModel =
            (_c = (_b = config.defaultJudgeModel) !== null && _b !== void 0 ? _b : this.defaultRubric.judgeModel) !== null && _c !== void 0 ? _c : 'gpt-4o-mini';
        this.maxJudgeTokens = (_d = config.maxJudgeTokens) !== null && _d !== void 0 ? _d : 500;
        this.temperature = (_e = config.temperature) !== null && _e !== void 0 ? _e : 0;
        this.timeoutMs = (_f = config.timeoutMs) !== null && _f !== void 0 ? _f : 30000;
        this.rubrics.set(this.defaultRubric.id, this.defaultRubric);
    }
    /** Register a named rubric. */
    registerRubric(rubric) {
        this.rubrics.set(rubric.id, rubric);
    }
    /** List all registered rubrics. */
    listRubrics() {
        return Array.from(this.rubrics.values());
    }
    /** Get a rubric by id, falling back to the default. */
    getRubric(id) {
        if (id) {
            const r = this.rubrics.get(id);
            if (r)
                return r;
        }
        return this.defaultRubric;
    }
    /**
     * Score a target against a rubric. Returns an EvalScore. Never
     * throws — judge failures are returned as `error` on the result.
     */
    async score(target, rubricId) {
        var _a, _b, _c, _d;
        const rubric = this.getRubric(rubricId);
        const judgeModel = (_a = rubric.judgeModel) !== null && _a !== void 0 ? _a : this.defaultJudgeModel;
        const range = (_b = rubric.scoreRange) !== null && _b !== void 0 ? _b : { min: 0, max: 1 };
        if (!this.provider) {
            return {
                score: clamp(0, range.min, range.max),
                reasoning: '',
                judgeModel,
                judgeTokens: { input: 0, output: 0, total: 0 },
                judgeDurationMs: 0,
                error: 'no_provider_configured',
            };
        }
        const prompt = this.renderPrompt(rubric, target);
        const start = Date.now();
        try {
            const response = await this.callJudge(judgeModel, prompt);
            const elapsed = Date.now() - start;
            const tokens = response.usage;
            const parsed = parseJudgeResponse(response.content);
            if (parsed.error) {
                return {
                    score: clamp(0, range.min, range.max),
                    reasoning: '',
                    judgeModel,
                    judgeTokens: {
                        input: tokens.promptTokens,
                        output: tokens.completionTokens,
                        total: tokens.totalTokens,
                    },
                    judgeDurationMs: elapsed,
                    error: parsed.error,
                };
            }
            return {
                score: clamp((_c = parsed.score) !== null && _c !== void 0 ? _c : 0, range.min, range.max),
                reasoning: (_d = parsed.reasoning) !== null && _d !== void 0 ? _d : '',
                judgeModel,
                judgeTokens: {
                    input: tokens.promptTokens,
                    output: tokens.completionTokens,
                    total: tokens.totalTokens,
                },
                judgeDurationMs: elapsed,
            };
        }
        catch (err) {
            return {
                score: clamp(0, range.min, range.max),
                reasoning: '',
                judgeModel,
                judgeTokens: { input: 0, output: 0, total: 0 },
                judgeDurationMs: Date.now() - start,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    // ────────── private ──────────
    renderPrompt(rubric, target) {
        var _a, _b, _c, _d;
        return rubric.promptTemplate
            .replace('{{input}}', safeJson(target.input))
            .replace('{{output}}', safeJson(target.output))
            .replace('{{expected}}', safeJson(target.expected))
            .replace('{{tools}}', safeJson((_a = target.toolsCalled) !== null && _a !== void 0 ? _a : []))
            .replace('{{durationMs}}', String((_b = target.durationMs) !== null && _b !== void 0 ? _b : 0))
            .replace('{{costUsd}}', String((_c = target.costUsd) !== null && _c !== void 0 ? _c : 0))
            .replace('{{tokens}}', String((_d = target.tokens) !== null && _d !== void 0 ? _d : 0));
    }
    async callJudge(model, prompt) {
        const request = {
            model,
            messages: [
                {
                    role: 'system',
                    content: 'You are an evaluation judge. Respond with ONLY a JSON object.',
                },
                { role: 'user', content: prompt },
            ],
            maxTokens: this.maxJudgeTokens,
            temperature: this.temperature,
        };
        // Race the judge call against a timeout. A hung judge must not
        // block the experiment runner.
        return await Promise.race([
            this.provider.call(request),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`judge_call_timeout_${this.timeoutMs}ms`)), this.timeoutMs);
            }),
        ]);
    }
}
exports.EvalScorer = EvalScorer;
/** Clamp a value into [min, max]. */
function clamp(v, min, max) {
    if (!Number.isFinite(v))
        return min;
    if (v < min)
        return min;
    if (v > max)
        return max;
    return v;
}
/** JSON.stringify with a fallback for circular references / non-serializable values. */
function safeJson(v) {
    try {
        return JSON.stringify(v, (_k, val) => {
            if (typeof val === 'bigint')
                return val.toString();
            if (typeof val === 'function')
                return '[function]';
            if (typeof val === 'undefined')
                return '[undefined]';
            return val;
        }, 2);
    }
    catch {
        return String(v);
    }
}
/**
 * Parse the judge's text response into a numeric score. Tolerant
 * of markdown code fences, leading prose, and trailing text — the
 * LLM doesn't always follow instructions perfectly.
 */
function parseJudgeResponse(text) {
    if (!text || typeof text !== 'string') {
        return { error: 'empty_response' };
    }
    // Try the whole string first.
    const direct = tryParseJson(text);
    if (direct)
        return extractScore(direct);
    // Try to extract the first JSON object from the text.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        const inside = tryParseJson(match[0]);
        if (inside)
            return extractScore(inside);
    }
    return { error: 'parse_failed' };
}
function tryParseJson(s) {
    try {
        const v = JSON.parse(s);
        if (v && typeof v === 'object' && !Array.isArray(v))
            return v;
    }
    catch {
        /* fall through */
    }
    return null;
}
function extractScore(obj) {
    const score = typeof obj['score'] === 'number' ? obj['score'] : Number(obj['score']);
    const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : '';
    if (!Number.isFinite(score))
        return { error: 'invalid_score' };
    return { score, reasoning };
}
