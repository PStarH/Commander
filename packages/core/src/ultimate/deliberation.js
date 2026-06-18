"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliberate = deliberate;
exports.classifyTaskNature = classifyTaskNature;
exports.deliberateWithLLM = deliberateWithLLM;
const effortScaler_1 = require("./effortScaler");
const logging_1 = require("../logging");
const TASK_TYPES = [
    'FACTUAL',
    'REASONING',
    'RESEARCH',
    'ANALYSIS',
    'CODING',
    'CREATIVE',
];
// ── Reasoning model detection ────────────────────────────────────────────────
/** Providers where ALL models are reasoning/thinking models */
const REASONING_PROVIDERS = new Set(['mimo', 'xiaomi']);
/** Model name patterns that indicate a reasoning/thinking model */
const REASONING_MODEL_PATTERNS = [
    /reasoner/i,
    /\bo[134]-/i, // o1-preview, o3-mini, o4-mini
    /think/i, // generic "thinking" model variants
    /mimo/i, // MiMo reasoning models (may be proxied via OpenAI-compatible)
    /deepseek-r/i, // DeepSeek reasoning models
];
function isReasoningModel(provider) {
    var _a, _b, _c;
    if (REASONING_PROVIDERS.has(provider.name))
        return true;
    // Check if the provider's default model matches reasoning patterns.
    // Access config.defaultModel for BaseOpenAICompatibleProvider subclasses,
    // and defaultModel/model for direct providers like MiMoProvider.
    const p = provider;
    const config = p.config;
    const model = String((_c = (_b = (_a = p.defaultModel) !== null && _a !== void 0 ? _a : p.model) !== null && _b !== void 0 ? _b : config === null || config === void 0 ? void 0 : config.defaultModel) !== null && _c !== void 0 ? _c : '');
    return REASONING_MODEL_PATTERNS.some((re) => re.test(model));
}
const REASONING_TIMEOUT_MS = 120000; // Reasoning models (MiMo, DeepSeek) need more time
const STANDARD_TIMEOUT_MS = 30000;
// Precompiled word-boundary regex for short keywords (<= 3 chars)
const SHORT_WORD_RE = new Map();
const MAX_CACHED_RE = 500;
function getWordBoundaryRe(word) {
    const existing = SHORT_WORD_RE.get(word);
    if (existing)
        return existing;
    const re = new RegExp(`\\b${word}\\b`);
    if (SHORT_WORD_RE.size >= MAX_CACHED_RE) {
        const firstKey = SHORT_WORD_RE.keys().next().value;
        if (firstKey)
            SHORT_WORD_RE.delete(firstKey);
    }
    SHORT_WORD_RE.set(word, re);
    return re;
}
function deliberate(goal, context) {
    var _a, _b;
    const reasoning = [];
    const taskType = classifyTaskType(goal);
    reasoning.push(`Classified as ${taskType} task`);
    const effortLevel = (0, effortScaler_1.classifyEffortLevel)(goal, {
        toolCount: (_a = context === null || context === void 0 ? void 0 : context.availableTools) === null || _a === void 0 ? void 0 : _a.length,
        riskLevel: (_b = context === null || context === void 0 ? void 0 : context.governanceProfile) === null || _b === void 0 ? void 0 : _b.riskLevel,
    });
    reasoning.push(`Effort level: ${effortLevel}`);
    const requiresExternalInfo = detectRequiresExternalInfo(goal, taskType);
    reasoning.push(requiresExternalInfo ? 'External info required' : 'Can answer from knowledge');
    const isTemporal = hasTemporalQuery(goal);
    if (isTemporal) {
        reasoning.push('Temporal query detected - external search mandatory');
    }
    const recommendedTopology = selectTopology(taskType, effortLevel);
    reasoning.push(`Recommended topology: ${recommendedTopology}`);
    const decompositionStrategy = selectDecompositionStrategy(taskType, effortLevel);
    reasoning.push(`Decomposition strategy: ${decompositionStrategy}`);
    const capabilitiesNeeded = inferCapabilities(taskType, goal);
    reasoning.push(`Capabilities: ${capabilitiesNeeded.join(', ')}`);
    const tokenBudget = allocateThinkingBudget(effortLevel, taskType);
    const estimatedAgentCount = estimateAgentCount(taskType, effortLevel);
    reasoning.push(`Estimated agents needed: ${estimatedAgentCount}`);
    const estimatedSteps = estimateSteps(taskType, effortLevel);
    reasoning.push(`Estimated steps: ${estimatedSteps}`);
    const estimatedTokens = estimateTotalTokens(effortLevel, estimatedSteps);
    const estimatedDurationMs = estimateDuration(effortLevel, taskType, estimatedSteps, estimatedAgentCount);
    reasoning.push(`Estimated duration: ${(estimatedDurationMs / 1000).toFixed(1)}s`);
    // SPAgent-inspired: determine if early steps are simple evidence-gathering
    // suitable for speculative execution (start before full planning completes)
    const suitableForSpeculation = isSuitableForSpeculation(taskType, effortLevel);
    if (suitableForSpeculation) {
        reasoning.push('Suitable for speculative execution — early steps are independent');
    }
    // Astraea-inspired: classify task as I/O-bound or compute-bound
    const taskNature = classifyTaskNature(taskType, requiresExternalInfo);
    reasoning.push(`Task nature: ${taskNature}`);
    // Chimera-inspired: per-agent time budget from total duration and topology
    const timeBudgetPerAgentMs = allocateTimeBudget(estimatedDurationMs, estimatedAgentCount, recommendedTopology);
    reasoning.push(`Per-agent time budget: ${(timeBudgetPerAgentMs / 1000).toFixed(1)}s`);
    const confidence = calculateConfidence(goal, taskType, context);
    return {
        requiresExternalInfo,
        taskType,
        recommendedTopology,
        effortLevel,
        estimatedAgentCount,
        estimatedSteps,
        estimatedTokens,
        estimatedDurationMs,
        tokenBudget,
        decompositionStrategy,
        capabilitiesNeeded,
        confidence,
        reasoning,
        suitableForSpeculation,
        taskNature,
        timeBudgetPerAgentMs,
    };
}
function classifyTaskType(goal) {
    const lower = goal.toLowerCase();
    // For short keywords (<= 3 chars), use word boundary to avoid substring false positives
    // For longer keywords, substring matching is safe
    const wordMatch = (word) => {
        if (word.includes(' '))
            return lower.includes(word);
        if (word.length <= 3)
            return getWordBoundaryRe(word).test(lower);
        return lower.includes(word);
    };
    const coding = [
        'implement',
        'code',
        'function',
        'api',
        'refactor',
        'bug',
        'test',
        'deploy',
        'build',
    ];
    const research = ['research', 'find', 'search', 'look up', 'investigate', 'analyze', 'compare'];
    const reasoning = ['why', 'how', 'explain', 'reason', 'evaluate', 'assess', 'determine'];
    const creative = ['design', 'create', 'write', 'draft', 'compose', 'generate', 'brainstorm'];
    const analysis = ['review', 'audit', 'inspect', 'examine', 'summarize', 'report'];
    const factual = ['what is', 'who is', 'when did', 'list', 'show', 'tell me'];
    const count = (kw) => kw.filter((w) => wordMatch(w)).length;
    const scores = {
        FACTUAL: count(factual),
        REASONING: count(reasoning),
        RESEARCH: count(research),
        ANALYSIS: count(analysis),
        CODING: count(coding),
        CREATIVE: count(creative),
    };
    // Use TASK_TYPES (readonly const array) for deterministic iteration order
    const maxScore = Math.max(...TASK_TYPES.map((t) => scores[t]));
    if (maxScore === 0)
        return 'FACTUAL';
    for (const taskType of TASK_TYPES) {
        if (scores[taskType] === maxScore)
            return taskType;
    }
    return 'FACTUAL';
}
function detectRequiresExternalInfo(goal, taskType) {
    if (taskType === 'RESEARCH')
        return true;
    if (hasTemporalQuery(goal))
        return true;
    const lower = goal.toLowerCase();
    const externalTriggers = [
        'latest',
        'current',
        'recent',
        'news',
        'today',
        '2025',
        '2026',
        'weather',
        'stock',
        'price',
        'search',
        'find',
        'lookup',
    ];
    return externalTriggers.some((t) => lower.includes(t));
}
function hasTemporalQuery(goal) {
    const lower = goal.toLowerCase();
    return (/202[5-9]|20[3-9]\d/.test(goal) ||
        ['latest', 'current', 'recent', 'news', 'today', 'yesterday'].some((w) => lower.includes(w)));
}
function selectTopology(taskType, effortLevel) {
    if (effortLevel === 'SIMPLE')
        return 'SINGLE';
    if (effortLevel === 'DEEP_RESEARCH')
        return 'HYBRID';
    if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') {
        return effortLevel === 'COMPLEX' ? 'HIERARCHICAL' : 'PARALLEL';
    }
    if (taskType === 'CODING')
        return 'PARALLEL';
    if (taskType === 'REASONING')
        return 'DEBATE';
    if (taskType === 'CREATIVE')
        return 'ENSEMBLE';
    return 'SEQUENTIAL';
}
function selectDecompositionStrategy(taskType, effortLevel) {
    if (effortLevel === 'DEEP_RESEARCH')
        return 'RECURSIVE';
    // Research and analysis tasks always benefit from aspect decomposition
    if (taskType === 'RESEARCH' || taskType === 'ANALYSIS')
        return 'ASPECT';
    if (taskType === 'REASONING')
        return 'ASPECT';
    // Simple tasks that aren't research/analysis don't need decomposition
    if (effortLevel === 'SIMPLE')
        return 'NONE';
    if (taskType === 'CODING')
        return 'STEP';
    return 'STEP';
}
function inferCapabilities(taskType, goal) {
    const caps = new Set();
    const lower = goal.toLowerCase();
    if (taskType === 'CODING' || taskType === 'ANALYSIS')
        caps.add('code_understanding');
    if (taskType === 'RESEARCH')
        caps.add('web_search');
    if (lower.includes('image') || lower.includes('visual') || lower.includes('ui'))
        caps.add('vision');
    if (lower.includes('math') || lower.includes('calculate') || lower.includes('compute'))
        caps.add('math');
    if (lower.includes('data') || lower.includes('json') || lower.includes('parse'))
        caps.add('data_processing');
    if (lower.includes('security') || lower.includes('vulnerab') || lower.includes('audit'))
        caps.add('security_analysis');
    caps.add('reasoning');
    return Array.from(caps);
}
function allocateThinkingBudget(effortLevel, taskType) {
    const base = effortLevel === 'SIMPLE'
        ? 512
        : effortLevel === 'MODERATE'
            ? 2048
            : effortLevel === 'COMPLEX'
                ? 4096
                : 8192;
    const thinkingRatio = taskType === 'REASONING'
        ? 0.4
        : taskType === 'RESEARCH'
            ? 0.25
            : taskType === 'CREATIVE'
                ? 0.3
                : 0.2;
    const synthesisRatio = taskType === 'RESEARCH' ? 0.3 : taskType === 'ANALYSIS' ? 0.25 : 0.15;
    return {
        thinking: Math.round(base * thinkingRatio),
        execution: Math.round(base * (1 - thinkingRatio - synthesisRatio)),
        synthesis: Math.round(base * synthesisRatio),
    };
}
function estimateAgentCount(taskType, effortLevel) {
    if (effortLevel === 'SIMPLE')
        return 1;
    if (effortLevel === 'MODERATE')
        return taskType === 'RESEARCH' ? 3 : 2;
    if (effortLevel === 'COMPLEX')
        return taskType === 'RESEARCH' ? 7 : 5;
    return taskType === 'RESEARCH' ? 15 : 10;
}
function estimateSteps(taskType, effortLevel) {
    const base = effortLevel === 'SIMPLE'
        ? 5
        : effortLevel === 'MODERATE'
            ? 15
            : effortLevel === 'COMPLEX'
                ? 30
                : 60;
    const multiplier = taskType === 'RESEARCH'
        ? 1.5
        : taskType === 'CODING'
            ? 1.3
            : taskType === 'REASONING'
                ? 0.8
                : 1.0;
    return Math.round(base * multiplier);
}
function estimateTotalTokens(effortLevel, steps) {
    const perStepTokens = effortLevel === 'SIMPLE'
        ? 2000
        : effortLevel === 'MODERATE'
            ? 4000
            : effortLevel === 'COMPLEX'
                ? 8000
                : 16000;
    return steps * perStepTokens;
}
/**
 * Estimate total execution duration in milliseconds.
 *
 * Inspired by Astraea (2512.14142): uses historical state + future predictions.
 * Inspired by Chimera (2603.22206): predicts remaining output length for scheduling.
 *
 * Two-tier estimation:
 *   1. Heuristic baseline (effort level × task type × steps)
 *   2. History-aware calibration from meta-learner (when available)
 *
 * Parallel topologies get a discount based on estimated concurrency.
 */
function estimateDuration(effortLevel, taskType, steps, agentCount) {
    const perStepMs = effortLevel === 'SIMPLE'
        ? 2000
        : effortLevel === 'MODERATE'
            ? 4000
            : effortLevel === 'COMPLEX'
                ? 8000
                : 12000;
    // Task-type multiplier: reasoning and research tasks tend to take longer per step
    const taskMultiplier = taskType === 'REASONING'
        ? 1.3
        : taskType === 'RESEARCH'
            ? 1.4
            : taskType === 'CODING'
                ? 1.2
                : taskType === 'CREATIVE'
                    ? 1.1
                    : 1.0;
    const rawDuration = steps * perStepMs * taskMultiplier;
    // Parallelism discount: more agents → more concurrency → shorter wall-clock time
    // Diminishing returns: 2 agents ≈ 0.6x, 5 agents ≈ 0.35x, 10+ agents ≈ 0.25x
    const parallelismFactor = agentCount <= 1 ? 1.0 : Math.max(0.2, 1.0 / (1 + Math.log2(agentCount)));
    const heuristicEstimate = rawDuration * parallelismFactor;
    // History-aware calibration (Astraea-inspired): if meta-learner has data for
    // this task type, use it to calibrate the heuristic estimate.
    // Blend: 60% heuristic + 40% historical (when available).
    const historicalMs = getHistoricalDuration(taskType);
    if (historicalMs > 0) {
        return Math.round(heuristicEstimate * 0.6 + historicalMs * 0.4);
    }
    return Math.round(heuristicEstimate);
}
/**
 * Query meta-learner for historical average duration of a task type.
 * Returns 0 if no historical data is available.
 */
function getHistoricalDuration(taskType) {
    try {
        // Dynamic import to avoid circular dependency
        const { getMetaLearner } = require('../selfEvolution/metaLearner');
        const metaLearner = getMetaLearner();
        const scores = metaLearner.getStrategyScores(taskType);
        if (scores.length === 0)
            return 0;
        // Weighted average of strategy durations by their score (probability of selection)
        let totalWeight = 0;
        let weightedDuration = 0;
        for (const s of scores) {
            if (s.avgDurationMs && s.avgDurationMs > 0) {
                const weight = s.score * s.trials;
                weightedDuration += s.avgDurationMs * weight;
                totalWeight += weight;
            }
        }
        return totalWeight > 0 ? weightedDuration / totalWeight : 0;
    }
    catch {
        return 0;
    }
}
/**
 * SPAgent-inspired speculation hint.
 * Tasks where early steps are independent evidence-gathering benefit from
 * speculative execution — starting work before full planning completes.
 * Good candidates: RESEARCH (parallel lookups), FACTUAL (simple queries),
 * ANALYSIS (independent review aspects). Bad: CODING (sequential dependencies),
 * REASONING (each step builds on prior).
 */
function isSuitableForSpeculation(taskType, effortLevel) {
    if (effortLevel === 'SIMPLE')
        return false; // too fast to benefit
    if (taskType === 'RESEARCH')
        return true;
    if (taskType === 'FACTUAL')
        return true;
    if (taskType === 'ANALYSIS')
        return true;
    if (taskType === 'CREATIVE' && effortLevel === 'DEEP_RESEARCH')
        return true;
    return false;
}
/**
 * Chimera-inspired: allocate per-agent time budget from total estimated duration.
 * For parallel topologies, each agent gets a fraction of total time (they run concurrently).
 * For sequential topologies, each agent gets total / count.
 * Critical path tasks should get more time; this is a simple heuristic allocation.
 */
function allocateTimeBudget(totalDurationMs, agentCount, topology) {
    if (agentCount <= 1)
        return totalDurationMs;
    // Parallel topologies: agents run concurrently, so each gets roughly the full time
    // but with diminishing returns (not all agents start at the same time)
    const parallelFactor = topology === 'PARALLEL' || topology === 'ENSEMBLE'
        ? 0.85
        : topology === 'HYBRID'
            ? 0.7
            : topology === 'HIERARCHICAL'
                ? 0.5
                : topology === 'DEBATE' || topology === 'CONSENSUS'
                    ? 0.6
                    : 1.0 / agentCount; // sequential: divide evenly
    return Math.round(totalDurationMs * parallelFactor);
}
/**
 * Astraea-inspired: classify task as I/O-bound or compute-bound.
 * I/O-bound tasks spend most time waiting for external data (web search, API calls).
 * Compute-bound tasks spend most time in LLM reasoning.
 * This classification informs scheduling: I/O-bound tasks benefit more from parallelism.
 */
function classifyTaskNature(taskType, requiresExternalInfo) {
    if (taskType === 'RESEARCH' || (taskType === 'FACTUAL' && requiresExternalInfo))
        return 'IO_BOUND';
    if (taskType === 'REASONING' || taskType === 'CODING')
        return 'COMPUTE_BOUND';
    return 'MIXED';
}
function calculateConfidence(goal, taskType, context) {
    let confidence = 0.5;
    if (goal.length > 50 && goal.length < 2000)
        confidence += 0.1;
    if (goal.length > 2000)
        confidence -= 0.1;
    if (taskType === 'FACTUAL')
        confidence += 0.2;
    if (taskType === 'CODING')
        confidence += 0.1;
    const tools = context === null || context === void 0 ? void 0 : context.availableTools;
    if (tools && tools.length > 0)
        confidence += 0.1;
    const gov = context === null || context === void 0 ? void 0 : context.governanceProfile;
    if ((gov === null || gov === void 0 ? void 0 : gov.riskLevel) === 'LOW')
        confidence += 0.1;
    if ((gov === null || gov === void 0 ? void 0 : gov.riskLevel) === 'CRITICAL')
        confidence -= 0.2;
    return Math.max(0.1, Math.min(1.0, confidence));
}
// ============================================================================
// LLM-Powered Deliberation
// ============================================================================
const DELIBERATION_PROMPT = `You are a task analysis engine. Analyze the task and output ONLY a JSON object.

IMPORTANT: Your ENTIRE response must be a single JSON object. Do NOT include any text before or after the JSON. Do NOT use markdown code fences. Do NOT explain anything.

Required JSON format:
{"taskType":"CODING","requiresExternalInfo":false,"recommendedTopology":"SINGLE","decompositionStrategy":"NONE","capabilitiesNeeded":["reasoning"],"estimatedAgentCount":1,"estimatedSteps":5,"estimatedTokens":10000,"estimatedDurationMs":11000,"confidence":0.6,"suitableForSpeculation":false,"taskNature":"MIXED","reasoning":["Analyzed task"]}

Field values:
- taskType: one of "FACTUAL","REASONING","CREATIVE","RESEARCH","CODING","ANALYSIS"
- requiresExternalInfo: true or false
- recommendedTopology: one of "SINGLE","SEQUENTIAL","PARALLEL","HIERARCHICAL","HYBRID","DEBATE","ENSEMBLE","EVALUATOR_OPTIMIZER"
- decompositionStrategy: one of "NONE","ASPECT","STEP","RECURSIVE"
- capabilitiesNeeded: array of strings
- estimatedAgentCount: number 1-20
- estimatedSteps: number 1-60
- estimatedTokens: number
- estimatedDurationMs: number in milliseconds
- confidence: number 0.0-1.0
- suitableForSpeculation: true or false
- taskNature: one of "IO_BOUND","COMPUTE_BOUND","MIXED"
- reasoning: array of strings

Remember: output ONLY the JSON object, nothing else.`;
/**
 * LLM-powered deliberation — rich meta-reasoning using a cheap LLM call.
 * Falls back to keyword-based deliberate() if no provider is available or the call fails.
 */
async function deliberateWithLLM(goal, provider, context) {
    var _a, _b, _c, _d;
    // Fallback to keyword deliberation if no LLM available
    if (!provider) {
        return deliberate(goal, context);
    }
    try {
        const timeoutMs = isReasoningModel(provider) ? REASONING_TIMEOUT_MS : STANDARD_TIMEOUT_MS;
        const request = {
            model: String((_a = provider.defaultModel) !== null && _a !== void 0 ? _a : ''),
            messages: [
                { role: 'system', content: DELIBERATION_PROMPT },
                {
                    role: 'user',
                    content: `Task: ${goal}\n\nAvailable tools: ${((_b = context === null || context === void 0 ? void 0 : context.availableTools) !== null && _b !== void 0 ? _b : []).join(', ') || 'none'}`,
                },
            ],
            maxTokens: 1024,
            temperature: 0.2,
        };
        let timeoutTimer;
        const response = await Promise.race([
            provider.call(request).finally(() => clearTimeout(timeoutTimer)),
            new Promise((_, reject) => {
                timeoutTimer = setTimeout(() => reject(new Error(`Deliberation LLM call timed out after ${timeoutMs / 1000}s`)), timeoutMs);
                timeoutTimer.unref();
            }),
        ]);
        // Reasoning models (MiMo, DeepSeek-R) put output in reasoning_content.
        // Try content first, then reasoning_content.
        const raw = (response.content ||
            response.reasoning_content ||
            '').trim();
        // Extract JSON from response — handle markdown code fences, text wrapping, etc.
        let jsonStr = raw;
        // Strip markdown code fences if present
        const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) {
            jsonStr = fenceMatch[1].trim();
        }
        // Try to find JSON object
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            throw new Error('No JSON object found in LLM response');
        const parsed = JSON.parse(jsonMatch[0]);
        const llmReasoning = Array.isArray(parsed.reasoning) ? parsed.reasoning : [];
        // Validate and fill any missing fields with keyword-based fallback
        const keywordPlan = deliberate(goal, context);
        const effortLevel = (0, effortScaler_1.classifyEffortLevel)(goal, {
            toolCount: (_c = context === null || context === void 0 ? void 0 : context.availableTools) === null || _c === void 0 ? void 0 : _c.length,
            riskLevel: (_d = context === null || context === void 0 ? void 0 : context.governanceProfile) === null || _d === void 0 ? void 0 : _d.riskLevel,
        });
        const plan = {
            requiresExternalInfo: typeof parsed.requiresExternalInfo === 'boolean'
                ? parsed.requiresExternalInfo
                : keywordPlan.requiresExternalInfo,
            taskType: isValidTaskType(parsed.taskType) ? parsed.taskType : keywordPlan.taskType,
            recommendedTopology: isValidTopology(parsed.recommendedTopology)
                ? parsed.recommendedTopology
                : keywordPlan.recommendedTopology,
            effortLevel,
            estimatedAgentCount: typeof parsed.estimatedAgentCount === 'number'
                ? parsed.estimatedAgentCount
                : keywordPlan.estimatedAgentCount,
            estimatedSteps: typeof parsed.estimatedSteps === 'number'
                ? parsed.estimatedSteps
                : keywordPlan.estimatedSteps,
            estimatedTokens: typeof parsed.estimatedTokens === 'number'
                ? parsed.estimatedTokens
                : keywordPlan.estimatedTokens,
            estimatedDurationMs: typeof parsed.estimatedDurationMs === 'number'
                ? parsed.estimatedDurationMs
                : keywordPlan.estimatedDurationMs,
            tokenBudget: keywordPlan.tokenBudget,
            decompositionStrategy: isValidDecomposition(parsed.decompositionStrategy)
                ? parsed.decompositionStrategy
                : keywordPlan.decompositionStrategy,
            capabilitiesNeeded: Array.isArray(parsed.capabilitiesNeeded)
                ? parsed.capabilitiesNeeded
                : keywordPlan.capabilitiesNeeded,
            confidence: typeof parsed.confidence === 'number'
                ? Math.max(0.1, Math.min(1.0, parsed.confidence))
                : keywordPlan.confidence,
            suitableForSpeculation: typeof parsed.suitableForSpeculation === 'boolean'
                ? parsed.suitableForSpeculation
                : keywordPlan.suitableForSpeculation,
            taskNature: isValidTaskNature(parsed.taskNature) ? parsed.taskNature : keywordPlan.taskNature,
            timeBudgetPerAgentMs: typeof parsed.timeBudgetPerAgentMs === 'number'
                ? parsed.timeBudgetPerAgentMs
                : keywordPlan.timeBudgetPerAgentMs,
            reasoning: [
                '=== LLM deliberation ===',
                ...llmReasoning.slice(0, 10),
                `=== Effort level: ${effortLevel} ===`,
            ],
        };
        return plan;
    }
    catch (e) {
        (0, logging_1.getGlobalLogger)().warn('Deliberation', 'LLM deliberation failed, falling back to heuristic plan', { error: e === null || e === void 0 ? void 0 : e.message });
        return deliberate(goal, context);
    }
}
function isValidTaskType(t) {
    return (typeof t === 'string' &&
        ['FACTUAL', 'REASONING', 'CREATIVE', 'RESEARCH', 'CODING', 'ANALYSIS'].includes(t));
}
function isValidTopology(t) {
    return (typeof t === 'string' &&
        [
            'SINGLE',
            'SEQUENTIAL',
            'PARALLEL',
            'HIERARCHICAL',
            'HYBRID',
            'DEBATE',
            'ENSEMBLE',
            'EVALUATOR_OPTIMIZER',
        ].includes(t));
}
function isValidDecomposition(d) {
    return typeof d === 'string' && ['NONE', 'ASPECT', 'STEP', 'RECURSIVE'].includes(d);
}
function isValidTaskNature(n) {
    return typeof n === 'string' && ['IO_BOUND', 'COMPUTE_BOUND', 'MIXED'].includes(n);
}
