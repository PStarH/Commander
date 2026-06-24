/**
 * Deliberation Engine - keyword-based task classification before tool invocation.
 *
 * Classifies tasks by keyword overlap against hardcoded lists, estimates
 * complexity via heuristic tables, and selects a topology. Two modes:
 *   deliberate()          — fast, keyword-based (no LLM call)
 *   deliberateWithLLM()   — LLM-powered planning (richer, but falls back to deliberate() for every field)
 */
import type { DeliberationPlan, OrchestrationTopology, EffortLevel } from './types';
import type { LLMProvider, LLMRequest } from '../runtime/types';
import { classifyEffortLevel } from './effortScaler';
import { getGlobalLogger } from '../logging';

type DeliberationTaskType = DeliberationPlan['taskType'];
const TASK_TYPES: readonly DeliberationTaskType[] = [
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

function isReasoningModel(provider: LLMProvider): boolean {
  if (REASONING_PROVIDERS.has(provider.name)) return true;
  // Check if the provider's default model matches reasoning patterns.
  // Access config.defaultModel for BaseOpenAICompatibleProvider subclasses,
  // and defaultModel/model for direct providers like MiMoProvider.
  const p = provider as unknown as Record<string, unknown>;
  const config = p.config as Record<string, unknown> | undefined;
  const model = String(p.defaultModel ?? p.model ?? config?.defaultModel ?? '');
  return REASONING_MODEL_PATTERNS.some((re) => re.test(model));
}

const REASONING_TIMEOUT_MS = 120_000; // Reasoning models (MiMo, DeepSeek) need more time
const STANDARD_TIMEOUT_MS = 30_000;

// Precompiled word-boundary regex for short keywords (<= 3 chars)
const SHORT_WORD_RE = new Map<string, RegExp>();
const MAX_CACHED_RE = 500;
function getWordBoundaryRe(word: string): RegExp {
  const existing = SHORT_WORD_RE.get(word);
  if (existing) return existing;
  const re = new RegExp(`\\b${word}\\b`);
  if (SHORT_WORD_RE.size >= MAX_CACHED_RE) {
    const firstKey = SHORT_WORD_RE.keys().next().value;
    if (firstKey) SHORT_WORD_RE.delete(firstKey);
  }
  SHORT_WORD_RE.set(word, re);
  return re;
}

export function deliberate(goal: string, context?: Record<string, unknown>): DeliberationPlan {
  const reasoning: string[] = [];

  const taskType = classifyTaskType(goal);
  reasoning.push(`Classified as ${taskType} task`);

  const effortLevel = classifyEffortLevel(goal, {
    toolCount: (context?.availableTools as string[] | undefined)?.length,
    riskLevel: (context?.governanceProfile as Record<string, string> | undefined)?.riskLevel,
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

  const estimatedDurationMs = estimateDuration(
    effortLevel,
    taskType,
    estimatedSteps,
    estimatedAgentCount,
  );
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
  const timeBudgetPerAgentMs = allocateTimeBudget(
    estimatedDurationMs,
    estimatedAgentCount,
    recommendedTopology,
  );
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

function classifyTaskType(goal: string): DeliberationTaskType {
  const lower = goal.toLowerCase();
  // Keyword overlap classifier: scores task types by counting hardcoded keyword matches.
  // This is not semantic classification.
  const wordMatch = (word: string) => {
    if (word.includes(' ')) return lower.includes(word);
    if (word.length <= 3) return getWordBoundaryRe(word).test(lower);
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

  const count = (kw: string[]) => kw.filter((w) => wordMatch(w)).length;

  const scores: Record<DeliberationTaskType, number> = {
    FACTUAL: count(factual),
    REASONING: count(reasoning),
    RESEARCH: count(research),
    ANALYSIS: count(analysis),
    CODING: count(coding),
    CREATIVE: count(creative),
  };

  // Use TASK_TYPES (readonly const array) for deterministic iteration order
  const maxScore = Math.max(...TASK_TYPES.map((t) => scores[t]));
  if (maxScore === 0) return 'FACTUAL';
  for (const taskType of TASK_TYPES) {
    if (scores[taskType] === maxScore) return taskType;
  }
  return 'FACTUAL';
}

function detectRequiresExternalInfo(goal: string, taskType: DeliberationPlan['taskType']): boolean {
  if (taskType === 'RESEARCH') return true;
  if (hasTemporalQuery(goal)) return true;
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

function hasTemporalQuery(goal: string): boolean {
  const lower = goal.toLowerCase();
  return (
    /202[5-9]|20[3-9]\d/.test(goal) ||
    ['latest', 'current', 'recent', 'news', 'today', 'yesterday'].some((w) => lower.includes(w))
  );
}

function selectTopology(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): OrchestrationTopology {
  if (effortLevel === 'SIMPLE') return 'SINGLE';
  if (effortLevel === 'DEEP_RESEARCH') return 'HYBRID';
  if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') {
    return effortLevel === 'COMPLEX' ? 'ORCHESTRATOR' : 'DISPATCH';
  }
  if (taskType === 'CODING') return 'DISPATCH';
  if (taskType === 'REASONING') {
    return effortLevel === 'COMPLEX' ? 'DEBATE' : 'CHAIN';
  }
  if (taskType === 'CREATIVE') {
    return effortLevel === 'COMPLEX' ? 'ENSEMBLE' : 'DISPATCH';
  }
  return 'CHAIN';
}

function selectDecompositionStrategy(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): DeliberationPlan['decompositionStrategy'] {
  if (effortLevel === 'DEEP_RESEARCH') return 'RECURSIVE';
  // Research and analysis tasks always benefit from aspect decomposition
  if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') return 'ASPECT';
  if (taskType === 'REASONING') return 'ASPECT';
  // Simple tasks that aren't research/analysis don't need decomposition
  if (effortLevel === 'SIMPLE') return 'NONE';
  if (taskType === 'CODING') return 'STEP';
  return 'STEP';
}

function inferCapabilities(taskType: DeliberationPlan['taskType'], goal: string): string[] {
  const caps = new Set<string>();
  const lower = goal.toLowerCase();

  if (taskType === 'CODING' || taskType === 'ANALYSIS') caps.add('code_understanding');
  if (taskType === 'RESEARCH') caps.add('web_search');
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

function allocateThinkingBudget(
  effortLevel: EffortLevel,
  taskType: DeliberationPlan['taskType'],
): { thinking: number; execution: number; synthesis: number } {
  const base =
    effortLevel === 'SIMPLE'
      ? 512
      : effortLevel === 'MODERATE'
        ? 2048
        : effortLevel === 'COMPLEX'
          ? 4096
          : 8192;

  const thinkingRatio =
    taskType === 'REASONING'
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

function estimateAgentCount(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): number {
  if (effortLevel === 'SIMPLE') return 1;
  if (effortLevel === 'MODERATE') return taskType === 'RESEARCH' ? 3 : 2;
  if (effortLevel === 'COMPLEX') return taskType === 'RESEARCH' ? 7 : 5;
  return taskType === 'RESEARCH' ? 15 : 10;
}

function estimateSteps(taskType: DeliberationPlan['taskType'], effortLevel: EffortLevel): number {
  const base =
    effortLevel === 'SIMPLE'
      ? 5
      : effortLevel === 'MODERATE'
        ? 15
        : effortLevel === 'COMPLEX'
          ? 30
          : 60;
  const multiplier =
    taskType === 'RESEARCH'
      ? 1.5
      : taskType === 'CODING'
        ? 1.3
        : taskType === 'REASONING'
          ? 0.8
          : 1.0;
  return Math.round(base * multiplier);
}

function estimateTotalTokens(effortLevel: EffortLevel, steps: number): number {
  const perStepTokens =
    effortLevel === 'SIMPLE'
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
 * Primary: hardcoded heuristic tables (effort level × task type × steps).
 * Secondary: historical averages from meta-learner (empty for first 5 runs,
 * so calibration is inert until then).
 *
 * Parallel topologies get a discount based on estimated concurrency.
 */
function estimateDuration(
  effortLevel: EffortLevel,
  taskType: DeliberationPlan['taskType'],
  steps: number,
  agentCount: number,
): number {
  const perStepMs =
    effortLevel === 'SIMPLE'
      ? 2000
      : effortLevel === 'MODERATE'
        ? 4000
        : effortLevel === 'COMPLEX'
          ? 8000
          : 12000;

  // Task-type multiplier: reasoning and research tasks tend to take longer per step
  const taskMultiplier =
    taskType === 'REASONING'
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
  const parallelismFactor =
    agentCount <= 1 ? 1.0 : Math.max(0.2, 1.0 / (1 + Math.log2(agentCount)));

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
function getHistoricalDuration(taskType: string): number {
  try {
    // Dynamic import to avoid circular dependency
    const { getMetaLearner } = require('../selfEvolution/metaLearner');
    const metaLearner = getMetaLearner();
    const scores = metaLearner.getStrategyScores(taskType);
    if (scores.length === 0) return 0;
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
  } catch (err) {
    console.warn('[Catch]', err);
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
function isSuitableForSpeculation(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): boolean {
  if (effortLevel === 'SIMPLE') return false; // too fast to benefit
  if (taskType === 'RESEARCH') return true;
  if (taskType === 'FACTUAL') return true;
  if (taskType === 'ANALYSIS') return true;
  if (taskType === 'CREATIVE' && effortLevel === 'DEEP_RESEARCH') return true;
  return false;
}

/**
 * Chimera-inspired: allocate per-agent time budget from total estimated duration.
 * For parallel topologies, each agent gets a fraction of total time (they run concurrently).
 * For sequential topologies, each agent gets total / count.
 * Critical path tasks should get more time; this is a simple heuristic allocation.
 */
function allocateTimeBudget(
  totalDurationMs: number,
  agentCount: number,
  topology: OrchestrationTopology,
): number {
  if (agentCount <= 1) return totalDurationMs;

  // Parallel topologies: agents run concurrently, so each gets roughly the full time
  // but with diminishing returns (not all agents start at the same time)
  const parallelFactor =
    topology === 'DISPATCH' || topology === 'ENSEMBLE'
      ? 0.85
      : topology === 'HYBRID'
        ? 0.7
        : topology === 'ORCHESTRATOR'
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
export function classifyTaskNature(
  taskType: DeliberationPlan['taskType'],
  requiresExternalInfo: boolean,
): 'IO_BOUND' | 'COMPUTE_BOUND' | 'MIXED' {
  if (taskType === 'RESEARCH' || (taskType === 'FACTUAL' && requiresExternalInfo))
    return 'IO_BOUND';
  if (taskType === 'REASONING' || taskType === 'CODING') return 'COMPUTE_BOUND';
  return 'MIXED';
}

function calculateConfidence(
  goal: string,
  taskType: DeliberationPlan['taskType'],
  context?: Record<string, unknown>,
): number {
  let confidence = 0.5;

  if (goal.length > 50 && goal.length < 2000) confidence += 0.1;
  if (goal.length > 2000) confidence -= 0.1;

  if (taskType === 'FACTUAL') confidence += 0.2;
  if (taskType === 'CODING') confidence += 0.1;

  const tools = context?.availableTools as string[] | undefined;
  if (tools && tools.length > 0) confidence += 0.1;

  const gov = context?.governanceProfile as Record<string, string> | undefined;
  if (gov?.riskLevel === 'LOW') confidence += 0.1;
  if (gov?.riskLevel === 'CRITICAL') confidence -= 0.2;

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
 * LLM-powered deliberation — sends goal to an LLM, then falls back to
 * keyword-based deliberate() for every field. The LLM call adds latency
 * and cost with no behavioral benefit over deliberate() alone.
 */
export async function deliberateWithLLM(
  goal: string,
  provider?: LLMProvider,
  context?: Record<string, unknown>,
): Promise<DeliberationPlan> {
  // Fallback to keyword deliberation if no LLM available
  if (!provider) {
    return deliberate(goal, context);
  }

  try {
    const timeoutMs = isReasoningModel(provider) ? REASONING_TIMEOUT_MS : STANDARD_TIMEOUT_MS;

    const request: LLMRequest = {
      model: String((provider as unknown as Record<string, unknown>).defaultModel ?? ''),
      messages: [
        { role: 'system', content: DELIBERATION_PROMPT },
        {
          role: 'user',
          content: `Task: ${goal}\n\nAvailable tools: ${((context?.availableTools as string[] | undefined) ?? []).join(', ') || 'none'}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.2,
    };

    let timeoutTimer: ReturnType<typeof setTimeout>;
    const response = await Promise.race([
      provider.call(request).finally(() => clearTimeout(timeoutTimer)),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error(`Deliberation LLM call timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
        timeoutTimer.unref();
      }),
    ]);
    // Reasoning models (MiMo, DeepSeek-R) put output in reasoning_content.
    // Try content first, then reasoning_content.
    const raw = (
      response.content ||
      (response as { reasoning_content?: string }).reasoning_content ||
      ''
    ).trim();

    // Extract JSON from response — handle markdown code fences, text wrapping, etc.
    let jsonStr = raw;
    // Strip markdown code fences if present
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    // Try to find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in LLM response');
    const parsed = JSON.parse(jsonMatch[0]);

    const llmReasoning: string[] = Array.isArray(parsed.reasoning) ? parsed.reasoning : [];

    // Validate and fill any missing fields with keyword-based fallback
    const keywordPlan = deliberate(goal, context);
    const effortLevel = classifyEffortLevel(goal, {
      toolCount: (context?.availableTools as string[] | undefined)?.length,
      riskLevel: (context?.governanceProfile as Record<string, string> | undefined)?.riskLevel,
    });

    const plan: DeliberationPlan = {
      requiresExternalInfo:
        typeof parsed.requiresExternalInfo === 'boolean'
          ? parsed.requiresExternalInfo
          : keywordPlan.requiresExternalInfo,
      taskType: isValidTaskType(parsed.taskType) ? parsed.taskType : keywordPlan.taskType,
      recommendedTopology: isValidTopology(parsed.recommendedTopology)
        ? parsed.recommendedTopology
        : keywordPlan.recommendedTopology,
      effortLevel,
      estimatedAgentCount:
        typeof parsed.estimatedAgentCount === 'number'
          ? parsed.estimatedAgentCount
          : keywordPlan.estimatedAgentCount,
      estimatedSteps:
        typeof parsed.estimatedSteps === 'number'
          ? parsed.estimatedSteps
          : keywordPlan.estimatedSteps,
      estimatedTokens:
        typeof parsed.estimatedTokens === 'number'
          ? parsed.estimatedTokens
          : keywordPlan.estimatedTokens,
      estimatedDurationMs:
        typeof parsed.estimatedDurationMs === 'number'
          ? parsed.estimatedDurationMs
          : keywordPlan.estimatedDurationMs,
      tokenBudget: keywordPlan.tokenBudget,
      decompositionStrategy: isValidDecomposition(parsed.decompositionStrategy)
        ? parsed.decompositionStrategy
        : keywordPlan.decompositionStrategy,
      capabilitiesNeeded: Array.isArray(parsed.capabilitiesNeeded)
        ? parsed.capabilitiesNeeded
        : keywordPlan.capabilitiesNeeded,
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0.1, Math.min(1.0, parsed.confidence))
          : keywordPlan.confidence,
      suitableForSpeculation:
        typeof parsed.suitableForSpeculation === 'boolean'
          ? parsed.suitableForSpeculation
          : keywordPlan.suitableForSpeculation,
      taskNature: isValidTaskNature(parsed.taskNature) ? parsed.taskNature : keywordPlan.taskNature,
      timeBudgetPerAgentMs:
        typeof parsed.timeBudgetPerAgentMs === 'number'
          ? parsed.timeBudgetPerAgentMs
          : keywordPlan.timeBudgetPerAgentMs,
      reasoning: [
        '=== LLM deliberation ===',
        ...llmReasoning.slice(0, 10),
        `=== Effort level: ${effortLevel} ===`,
      ],
    };

    return plan;
  } catch (e) {
    getGlobalLogger().warn(
      'Deliberation',
      'LLM deliberation failed, falling back to heuristic plan',
      { error: (e as Error)?.message },
    );
    return deliberate(goal, context);
  }
}

function isValidTaskType(t: unknown): t is DeliberationPlan['taskType'] {
  return (
    typeof t === 'string' &&
    ['FACTUAL', 'REASONING', 'CREATIVE', 'RESEARCH', 'CODING', 'ANALYSIS'].includes(t)
  );
}

function isValidTopology(t: unknown): t is OrchestrationTopology {
  return (
    typeof t === 'string' &&
    [
      // Canonical names (Anthropic-aligned)
      'SINGLE',
      'CHAIN',
      'DISPATCH',
      'ORCHESTRATOR',
      'REVIEW',
      // Legacy aliases (deprecated but still accepted)
      'SEQUENTIAL',
      'HANDOFF',
      'PARALLEL',
      'ENSEMBLE',
      'CONSENSUS',
      'HIERARCHICAL',
      'HYBRID',
      'EVALUATOR_OPTIMIZER',
      'DEBATE',
    ].includes(t)
  );
}

function isValidDecomposition(d: unknown): d is DeliberationPlan['decompositionStrategy'] {
  return typeof d === 'string' && ['NONE', 'ASPECT', 'STEP', 'RECURSIVE'].includes(d);
}

function isValidTaskNature(n: unknown): n is 'IO_BOUND' | 'COMPUTE_BOUND' | 'MIXED' {
  return typeof n === 'string' && ['IO_BOUND', 'COMPUTE_BOUND', 'MIXED'].includes(n);
}
