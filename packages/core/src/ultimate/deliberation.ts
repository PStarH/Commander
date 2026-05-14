/**
 * Deliberation Engine - DOVA-inspired meta-reasoning before tool invocation.
 *
 * DOVA research shows deliberation-first orchestration reduces unnecessary
 * API calls by 40-60% on simple tasks while preserving deep reasoning capacity.
 * The engine determines whether external info is needed, classifies the task,
 * and allocates thinking budget before any agent is spawned.
 *
 * Two modes:
 *   deliberate()          — fast, keyword-based (no LLM call)
 *   deliberateWithLLM()   — LLM-powered meta-reasoning (richer, more accurate)
 */
import type { DeliberationPlan, OrchestrationTopology, EffortLevel } from './types';
import type { LLMProvider, LLMRequest } from '../runtime/types';
import { classifyEffortLevel } from './effortScaler';

export function deliberate(
  goal: string,
  context?: Record<string, unknown>,
): DeliberationPlan {
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

  const confidence = calculateConfidence(goal, taskType, context);

  return {
    requiresExternalInfo,
    taskType,
    recommendedTopology,
    estimatedAgentCount,
    estimatedSteps,
    estimatedTokens,
    tokenBudget,
    decompositionStrategy,
    capabilitiesNeeded,
    confidence,
    reasoning,
  };
}

function classifyTaskType(goal: string): DeliberationPlan['taskType'] {
  const lower = goal.toLowerCase();
  // For short keywords (<= 3 chars), use word boundary to avoid substring false positives
  // For longer keywords, substring matching is safe
  const wordMatch = (word: string) => {
    if (word.includes(' ')) return lower.includes(word);
    if (word.length <= 3) return new RegExp(`\\b${word}\\b`).test(lower);
    return lower.includes(word);
  };
  const coding = ['implement', 'code', 'function', 'api', 'refactor', 'bug', 'test', 'deploy', 'build'];
  const research = ['research', 'find', 'search', 'look up', 'investigate', 'analyze', 'compare'];
  const reasoning = ['why', 'how', 'explain', 'reason', 'evaluate', 'assess', 'determine'];
  const creative = ['design', 'create', 'write', 'draft', 'compose', 'generate', 'brainstorm'];
  const analysis = ['review', 'audit', 'inspect', 'examine', 'summarize', 'report'];
  const factual = ['what is', 'who is', 'when did', 'list', 'show', 'tell me'];

  const count = (kw: string[]) => kw.filter(w => wordMatch(w)).length;

  const scores: Record<string, number> = {
    FACTUAL: count(factual),
    REASONING: count(reasoning),
    RESEARCH: count(research),
    ANALYSIS: count(analysis),
    CODING: count(coding),
    CREATIVE: count(creative),
  };

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'FACTUAL';
  // FACTUAL first in object, so ties default to FACTUAL
  return (Object.entries(scores).find(([, v]) => v === maxScore)![0] as DeliberationPlan['taskType']);
}

function detectRequiresExternalInfo(goal: string, taskType: DeliberationPlan['taskType']): boolean {
  if (taskType === 'RESEARCH') return true;
  if (hasTemporalQuery(goal)) return true;
  const lower = goal.toLowerCase();
  const externalTriggers = [
    'latest', 'current', 'recent', 'news', 'today', '2025', '2026',
    'weather', 'stock', 'price', 'search', 'find', 'lookup',
  ];
  return externalTriggers.some(t => lower.includes(t));
}

function hasTemporalQuery(goal: string): boolean {
  const lower = goal.toLowerCase();
  return /202[5-9]|20[3-9]\d/.test(goal) ||
    ['latest', 'current', 'recent', 'news', 'today', 'yesterday'].some(w => lower.includes(w));
}

function selectTopology(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): OrchestrationTopology {
  if (effortLevel === 'SIMPLE') return 'SINGLE';
  if (effortLevel === 'DEEP_RESEARCH') return 'HYBRID';
  if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') {
    return effortLevel === 'COMPLEX' ? 'HIERARCHICAL' : 'PARALLEL';
  }
  if (taskType === 'CODING') return 'PARALLEL';
  if (taskType === 'REASONING') return 'DEBATE';
  if (taskType === 'CREATIVE') return 'ENSEMBLE';
  return 'SEQUENTIAL';
}

function selectDecompositionStrategy(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): DeliberationPlan['decompositionStrategy'] {
  if (effortLevel === 'SIMPLE') return 'NONE';
  if (effortLevel === 'DEEP_RESEARCH') return 'RECURSIVE';
  if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') return 'ASPECT';
  if (taskType === 'CODING') return 'STEP';
  if (taskType === 'REASONING') return 'ASPECT';
  return 'STEP';
}

function inferCapabilities(taskType: DeliberationPlan['taskType'], goal: string): string[] {
  const caps = new Set<string>();
  const lower = goal.toLowerCase();

  if (taskType === 'CODING' || taskType === 'ANALYSIS') caps.add('code_understanding');
  if (taskType === 'RESEARCH') caps.add('web_search');
  if (lower.includes('image') || lower.includes('visual') || lower.includes('ui')) caps.add('vision');
  if (lower.includes('math') || lower.includes('calculate') || lower.includes('compute')) caps.add('math');
  if (lower.includes('data') || lower.includes('json') || lower.includes('parse')) caps.add('data_processing');
  if (lower.includes('security') || lower.includes('vulnerab') || lower.includes('audit')) caps.add('security_analysis');

  caps.add('reasoning');
  return Array.from(caps);
}

function allocateThinkingBudget(
  effortLevel: EffortLevel,
  taskType: DeliberationPlan['taskType'],
): { thinking: number; execution: number; synthesis: number } {
  const base = effortLevel === 'SIMPLE' ? 512
    : effortLevel === 'MODERATE' ? 2048
    : effortLevel === 'COMPLEX' ? 4096
    : 8192;

  const thinkingRatio = taskType === 'REASONING' ? 0.4
    : taskType === 'RESEARCH' ? 0.25
    : taskType === 'CREATIVE' ? 0.3
    : 0.2;

  const synthesisRatio = taskType === 'RESEARCH' ? 0.3
    : taskType === 'ANALYSIS' ? 0.25
    : 0.15;

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

function estimateSteps(
  taskType: DeliberationPlan['taskType'],
  effortLevel: EffortLevel,
): number {
  const base = effortLevel === 'SIMPLE' ? 5
    : effortLevel === 'MODERATE' ? 15
    : effortLevel === 'COMPLEX' ? 30
    : 60;
  const multiplier = taskType === 'RESEARCH' ? 1.5
    : taskType === 'CODING' ? 1.3
    : taskType === 'REASONING' ? 0.8
    : 1.0;
  return Math.round(base * multiplier);
}

function estimateTotalTokens(effortLevel: EffortLevel, steps: number): number {
  const perStepTokens = effortLevel === 'SIMPLE' ? 2000
    : effortLevel === 'MODERATE' ? 4000
    : effortLevel === 'COMPLEX' ? 8000
    : 16000;
  return steps * perStepTokens;
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

const DELIBERATION_PROMPT = `You are a task analysis engine for a multi-agent orchestration system.
Analyze the following task and return a JSON object with these fields:
{
  "taskType": "FACTUAL" | "REASONING" | "CREATIVE" | "RESEARCH" | "CODING" | "ANALYSIS",
  "requiresExternalInfo": boolean,
  "recommendedTopology": "SINGLE" | "SEQUENTIAL" | "PARALLEL" | "HIERARCHICAL" | "HYBRID" | "DEBATE" | "ENSEMBLE" | "EVALUATOR_OPTIMIZER",
  "decompositionStrategy": "NONE" | "ASPECT" | "STEP" | "RECURSIVE",
  "capabilitiesNeeded": string[],
  "estimatedAgentCount": number (1-20),
  "estimatedSteps": number (1-60),
  "estimatedTokens": number,
  "confidence": number (0-1),
  "reasoning": string[]
}

Rules:
- FACTUAL: simple lookup, no analysis needed
- REASONING: requires logical inference, evaluation
- CREATIVE: content generation, design
- RESEARCH: needs external information gathering
- CODING: implementation, debugging
- ANALYSIS: review, audit, comparison

Topology guidelines:
- SINGLE: simple, single-step tasks (1 agent)
- PARALLEL: independent subtasks researched simultaneously (2-5 agents)
- HIERARCHICAL: complex multi-step with dependencies (3-10 agents)
- HYBRID: deep research combining parallel + sequential (5-20 agents)
- DEBATE: reasoning tasks benefiting from multiple perspectives
- ENSEMBLE: creative tasks wanting diverse outputs
- EVALUATOR_OPTIMIZER: iterative refinement tasks

Respond with ONLY a valid JSON object. No markdown, no code fences.`;

/**
 * LLM-powered deliberation — rich meta-reasoning using a cheap LLM call.
 * Falls back to keyword-based deliberate() if no provider is available or the call fails.
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
    const request: LLMRequest = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DELIBERATION_PROMPT },
        { role: 'user', content: `Task: ${goal}\n\nAvailable tools: ${((context?.availableTools as string[] | undefined) ?? []).join(', ') || 'none'}` },
      ],
      maxTokens: 1024,
      temperature: 0.2,
    };

    const response = await provider.call(request);
    const jsonStr = response.content.trim();
    const parsed = JSON.parse(jsonStr);

    const llmReasoning: string[] = Array.isArray(parsed.reasoning) ? parsed.reasoning : [];

    // Validate and fill any missing fields with keyword-based fallback
    const keywordPlan = deliberate(goal, context);
    const effortLevel = classifyEffortLevel(goal, {
      toolCount: (context?.availableTools as string[] | undefined)?.length,
      riskLevel: (context?.governanceProfile as Record<string, string> | undefined)?.riskLevel,
    });

    const plan: DeliberationPlan = {
      requiresExternalInfo: typeof parsed.requiresExternalInfo === 'boolean' ? parsed.requiresExternalInfo : keywordPlan.requiresExternalInfo,
      taskType: isValidTaskType(parsed.taskType) ? parsed.taskType : keywordPlan.taskType,
      recommendedTopology: isValidTopology(parsed.recommendedTopology) ? parsed.recommendedTopology : keywordPlan.recommendedTopology,
      estimatedAgentCount: typeof parsed.estimatedAgentCount === 'number' ? parsed.estimatedAgentCount : keywordPlan.estimatedAgentCount,
      estimatedSteps: typeof parsed.estimatedSteps === 'number' ? parsed.estimatedSteps : keywordPlan.estimatedSteps,
      estimatedTokens: typeof parsed.estimatedTokens === 'number' ? parsed.estimatedTokens : keywordPlan.estimatedTokens,
      tokenBudget: keywordPlan.tokenBudget,
      decompositionStrategy: isValidDecomposition(parsed.decompositionStrategy) ? parsed.decompositionStrategy : keywordPlan.decompositionStrategy,
      capabilitiesNeeded: Array.isArray(parsed.capabilitiesNeeded) ? parsed.capabilitiesNeeded : keywordPlan.capabilitiesNeeded,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0.1, Math.min(1.0, parsed.confidence)) : keywordPlan.confidence,
      reasoning: [
        '=== LLM deliberation ===',
        ...llmReasoning.slice(0, 10),
        `=== Effort level: ${effortLevel} ===`,
      ],
    };

    return plan;
  } catch {
    return deliberate(goal, context);
  }
}

function isValidTaskType(t: unknown): t is DeliberationPlan['taskType'] {
  return typeof t === 'string' && ['FACTUAL', 'REASONING', 'CREATIVE', 'RESEARCH', 'CODING', 'ANALYSIS'].includes(t);
}

function isValidTopology(t: unknown): t is OrchestrationTopology {
  return typeof t === 'string' && ['SINGLE', 'SEQUENTIAL', 'PARALLEL', 'HIERARCHICAL', 'HYBRID', 'DEBATE', 'ENSEMBLE', 'EVALUATOR_OPTIMIZER'].includes(t);
}

function isValidDecomposition(d: unknown): d is DeliberationPlan['decompositionStrategy'] {
  return typeof d === 'string' && ['NONE', 'ASPECT', 'STEP', 'RECURSIVE'].includes(d);
}
