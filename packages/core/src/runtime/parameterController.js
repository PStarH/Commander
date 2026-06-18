"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setEvalProfile = setEvalProfile;
exports.isEvalProfileActive = isEvalProfileActive;
exports.getEvalProfile = getEvalProfile;
exports.getParamDecisions = getParamDecisions;
exports.classifyTask = classifyTask;
exports.getSamplingParams = getSamplingParams;
exports.getAdaptiveParams = getAdaptiveParams;
exports.applyControllerParams = applyControllerParams;
exports.createParameterControllerPlugin = createParameterControllerPlugin;
let activeEvalProfile = null;
/** Lock sampling parameters to a fixed profile (e.g. for eval runs). */
function setEvalProfile(profile) {
    activeEvalProfile = profile;
}
/** Check whether an eval profile is currently active. */
function isEvalProfileActive() {
    return activeEvalProfile !== null;
}
/** Get the active eval profile. */
function getEvalProfile() {
    return activeEvalProfile;
}
const paramDecisions = [];
const MAX_PARAM_DECISIONS = 1000;
function getParamDecisions() {
    return paramDecisions;
}
function recordDecision(d) {
    paramDecisions.push(d);
    if (paramDecisions.length > MAX_PARAM_DECISIONS) {
        paramDecisions.splice(0, paramDecisions.length - MAX_PARAM_DECISIONS + 200);
    }
}
const TASK_SIGNATURES = [
    {
        type: 'code_generation',
        keywords: [
            'implement',
            'function',
            'class',
            'write code',
            'generate',
            'fix bug',
            'refactor',
            'sort',
            'algorithm',
            'def ',
            '//',
            'import ',
            'const ',
            'let var',
            'return',
        ],
        patterns: [
            /def \w+\(/,
            /function\s+\w+\s*\(/,
            /class\s+\w+/,
            /fix (this|the|a) (bug|error|issue)/i,
            /generate.*code/i,
            /implement.*function/i,
            /write.*(function|program|script)/i,
        ],
    },
    {
        type: 'code_review',
        keywords: [
            'review',
            'audit',
            'security',
            'vulnerability',
            'code smell',
            'optimize',
            'performance',
        ],
        patterns: [
            /review (this|the|my) code/i,
            /find (bugs|issues|problems)/i,
            /is this code safe/i,
            /code review/i,
        ],
    },
    {
        type: 'tool_calling',
        keywords: ['search', 'fetch', 'read', 'write', 'edit', 'execute', 'run', 'list', 'find file'],
        patterns: [
            /search (for|the|web)/i,
            /read (file|this)/i,
            /execute (this|command)/i,
            /run (this|the) (test|script|command)/i,
        ],
    },
    {
        type: 'reasoning',
        keywords: [
            'calculate',
            'prove',
            'deduce',
            'infer',
            'logic',
            'math',
            'equation',
            'solve',
            'probability',
            'statistics',
        ],
        patterns: [
            /solve (for|this|the)/i,
            /prove that/i,
            /calculate (the|this)/i,
            /what is the (probability|expected)/i,
            /\d+\s*[+\-*\/]\s*\d+/,
        ],
    },
    {
        type: 'creative',
        keywords: [
            'brainstorm',
            'creative',
            'name',
            'slogan',
            'poem',
            'story',
            'design',
            'imagine',
            'invent',
            'metaphor',
        ],
        patterns: [
            /come up with (a|an|some)/i,
            /give me (some|a few) (ideas|options|names)/i,
            /write a (poem|story)/i,
            /creative/i,
        ],
    },
    {
        type: 'conversation',
        keywords: [
            'hello',
            'hi',
            'how are you',
            'thanks',
            'explain',
            'what is',
            'tell me about',
            'define',
        ],
        patterns: [
            /^(hi|hello|hey)/i,
            /explain (this|that|how|why)/i,
            /what is (the|a|an)/i,
            /tell me about/i,
        ],
    },
    {
        type: 'planning',
        keywords: [
            'plan',
            'strategy',
            'approach',
            'roadmap',
            'milestone',
            'step',
            'phase',
            'organize',
            'outline',
            'break down',
        ],
        patterns: [
            /create a (plan|strategy|roadmap)/i,
            /break down (this|the) (task|project)/i,
            /what are the steps/i,
            /plan (this|the|a)/i,
        ],
    },
];
const TASK_PARAMS = {
    code_generation: { temperature: 0.2, topP: 0.95 },
    code_review: { temperature: 0.3, topP: 0.95 },
    tool_calling: { temperature: 0.05, topP: 1.0 },
    reasoning: { temperature: 0.2, topP: 0.95 },
    creative: { temperature: 0.8, topP: 0.9, frequencyPenalty: 0.3, presencePenalty: 0.3 },
    conversation: { temperature: 0.6, topP: 0.95 },
    planning: { temperature: 0.4, topP: 0.95 },
    default: { temperature: 0.5, topP: 0.95 },
};
function classifyTask(userMessage, history) {
    const text = userMessage.toLowerCase();
    const scores = new Map();
    for (const sig of TASK_SIGNATURES) {
        let score = 0;
        for (const kw of sig.keywords) {
            if (text.includes(kw))
                score += 1;
        }
        for (const pat of sig.patterns) {
            if (pat.test(text))
                score += 2;
        }
        if (score > 0)
            scores.set(sig.type, score);
    }
    // Check if history has tool results — if so, this might be a continuation
    if (history && history.length > 0) {
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === 'tool') {
            scores.set('code_generation', (scores.get('code_generation') || 0) + 1);
        }
    }
    let bestType = 'default';
    let bestScore = 0;
    for (const [type, score] of scores) {
        if (score > bestScore) {
            bestScore = score;
            bestType = type;
        }
    }
    const confidence = bestScore > 0 ? Math.min(1.0, bestScore / 5) : 0.3;
    return {
        taskType: bestType,
        confidence,
        reasoning: bestType !== 'default'
            ? `Matched ${bestType} with score ${bestScore}`
            : 'No specific task signature matched',
    };
}
function getSamplingParams(profile, userOverride) {
    const base = { ...TASK_PARAMS[profile.taskType] };
    if (userOverride) {
        if (userOverride.temperature !== undefined)
            base.temperature = userOverride.temperature;
        if (userOverride.topP !== undefined)
            base.topP = userOverride.topP;
        if (userOverride.frequencyPenalty !== undefined)
            base.frequencyPenalty = userOverride.frequencyPenalty;
        if (userOverride.presencePenalty !== undefined)
            base.presencePenalty = userOverride.presencePenalty;
    }
    // Low confidence = more conservative params
    if (profile.confidence < 0.4 && base.temperature > 0.5) {
        base.temperature = Math.min(base.temperature, 0.5);
    }
    return base;
}
function getAdaptiveParams(userMessage, history, attemptNumber, userOverride) {
    // Eval profile takes absolute priority
    if (activeEvalProfile) {
        const evalParams = {
            temperature: activeEvalProfile.temperature,
            topP: activeEvalProfile.topP,
        };
        recordDecision({
            timestamp: new Date().toISOString(),
            taskType: 'default',
            confidence: 1.0,
            chosenTemperature: evalParams.temperature,
            chosenTopP: evalParams.topP,
            chosenMaxTokens: activeEvalProfile.maxTokens,
            reasoningConfig: activeEvalProfile.reasoningConfig,
            evalProfileApplied: true,
        });
        return evalParams;
    }
    const profile = classifyTask(userMessage, history);
    const params = getSamplingParams(profile, userOverride);
    // Self-correction loop: increase temperature on retry, then fall back
    if (attemptNumber === 1) {
        params.temperature = Math.min(params.temperature + 0.1, 0.5);
    }
    else if (attemptNumber >= 2) {
        params.temperature = Math.max(params.temperature - 0.1, 0.05);
    }
    recordDecision({
        timestamp: new Date().toISOString(),
        taskType: profile.taskType,
        confidence: profile.confidence,
        chosenTemperature: params.temperature,
        chosenTopP: params.topP,
        chosenMaxTokens: 4096,
        evalProfileApplied: false,
    });
    return params;
}
/** Build a full LLMRequest with all controller-managed parameters applied. */
function applyControllerParams(base, userMessage, history, attemptNumber) {
    const sampling = getAdaptiveParams(userMessage, history, attemptNumber);
    const result = {
        ...base,
        temperature: sampling.temperature,
    };
    // Apply eval profile reasoning config if active
    if (activeEvalProfile === null || activeEvalProfile === void 0 ? void 0 : activeEvalProfile.reasoningConfig) {
        result.reasoningConfig = activeEvalProfile.reasoningConfig;
    }
    return result;
}
function createParameterControllerPlugin(overrides) {
    // Apply user overrides to defaults (intentional module-level mutation — called once per process)
    if (overrides) {
        for (const [type, params] of Object.entries(overrides)) {
            if (TASK_PARAMS[type]) {
                Object.assign(TASK_PARAMS[type], params);
            }
        }
    }
    return {
        name: 'parameter-controller',
        description: 'Adaptive temperature/topP based on task type',
        version: '0.1.0',
        beforeLLMCall: (ctx) => {
            const lastUserMsg = [...ctx.request.messages].reverse().find((m) => m.role === 'user');
            const userContent = (lastUserMsg === null || lastUserMsg === void 0 ? void 0 : lastUserMsg.content) || '';
            const params = getAdaptiveParams(typeof userContent === 'string' ? userContent : '', ctx.request.messages, 0);
            return {
                ...ctx.request,
                temperature: params.temperature,
                // top_p is not in LLMRequest but providers may use it
            };
        },
    };
}
