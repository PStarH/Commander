import type { AgentExecutionResult } from './types';

export type SingleAgentTaskKind =
  | 'code_change'
  | 'debugging'
  | 'research'
  | 'verification'
  | 'git_workflow'
  | 'analysis'
  | 'general';

export interface SingleAgentTaskProfile {
  kind: SingleAgentTaskKind;
  needsPlan: boolean;
  needsRepositoryInspection: boolean;
  needsExternalEvidence: boolean;
  needsVerification: boolean;
  needsSelfCorrection: boolean;
  reasons: string[];
}

export interface SingleAgentPlanAssessment {
  score: number;
  presentSignals: string[];
  missingSignals: string[];
  recommendations: string[];
}

export interface SingleAgentToolSelectionAudit {
  score: number;
  requiredCoreTools: string[];
  missingCoreTools: string[];
  riskyTools: string[];
  recommendations: string[];
}

export interface SingleAgentEvalRun {
  result: Pick<
    AgentExecutionResult,
    'status' | 'summary' | 'steps' | 'totalDurationMs' | 'totalTokenUsage' | 'error'
  >;
  expectedCompleted?: boolean;
  bugIntroduced?: boolean;
  costUsd?: number;
}

export interface SingleAgentEvalMetrics {
  totalRuns: number;
  successRate: number;
  taskCompletionRate: number;
  bugIntroductionRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  averageCostUsd: number;
  averageTokens: number;
}

export interface SingleAgentEvalCase {
  id: string;
  category: SingleAgentTaskKind;
  prompt: string;
  verification: string[];
  trackedMetrics: Array<keyof SingleAgentEvalMetrics>;
}

const CODE_CHANGE_PATTERNS = [
  /\b(implement|add|create|modify|change|update|refactor|migrate|rename|remove)\b/i,
  /\b(file|code|function|class|module|component|endpoint|route|type|interface)\b/i,
];

const DEBUGGING_PATTERNS = [
  /\b(fix|debug|repair|resolve|failing|failure|bug|error|exception|regression)\b/i,
  /\b(test|typecheck|lint|build|stack\s*trace|assertion)\b/i,
];

const RESEARCH_PATTERNS = [
  /\b(research|study|survey|compare|benchmark|evidence|source|citation|latest|current)\b/i,
  /\b(paper|documentation|docs|literature|state\s+of\s+the\s+art)\b/i,
];

const GIT_PATTERNS = [/\b(git|commit|branch|merge|rebase|stash|pull|push|PR|pull\s+request)\b/i];
const VERIFICATION_PATTERNS = [
  /\b(verify|validate|check|test|typecheck|lint|build|passes|green)\b/i,
];

export function classifySingleAgentTask(goal: string): SingleAgentTaskProfile {
  const matched: SingleAgentTaskKind[] = [];
  if (matchesAny(goal, DEBUGGING_PATTERNS)) matched.push('debugging');
  if (matchesAll(goal, CODE_CHANGE_PATTERNS)) matched.push('code_change');
  if (matchesAny(goal, RESEARCH_PATTERNS)) matched.push('research');
  if (matchesAny(goal, GIT_PATTERNS)) matched.push('git_workflow');
  if (matchesAny(goal, VERIFICATION_PATTERNS)) matched.push('verification');
  if (/\b(analyze|audit|review|measure|track|assess)\b/i.test(goal)) matched.push('analysis');

  const kind = matched[0] ?? 'general';
  const isCodeLike =
    matched.includes('code_change') ||
    matched.includes('debugging') ||
    matched.includes('verification');
  const isLongHorizon =
    /\b(across|multiple|several|all|entire|architecture|system|suite|benchmark|evaluation)\b/i.test(
      goal,
    );

  const reasons: string[] = [];
  if (isCodeLike) reasons.push('Task changes or validates code.');
  if (matched.includes('research'))
    reasons.push('Task asks for external evidence or current knowledge.');
  if (isLongHorizon) reasons.push('Task spans multiple files, steps, or evaluation dimensions.');

  return {
    kind,
    needsPlan: isLongHorizon || matched.includes('research') || matched.includes('analysis'),
    needsRepositoryInspection:
      isCodeLike || matched.includes('git_workflow') || matched.includes('analysis'),
    needsExternalEvidence: matched.includes('research'),
    needsVerification:
      isCodeLike || matched.includes('verification') || matched.includes('git_workflow'),
    needsSelfCorrection: isCodeLike || matched.includes('verification') || isLongHorizon,
    reasons,
  };
}

export function buildSingleAgentOperatingLoop(goal: string): string[] {
  const profile = classifySingleAgentTask(goal);
  const loop = ['Inspect: gather the minimum repository or source context needed before acting.'];

  if (profile.needsPlan) {
    loop.push(
      'Plan: state the concrete change path, verification command, and risk before editing.',
    );
  } else {
    loop.push(
      'Plan light: for small tasks, keep the plan implicit and proceed directly after inspection.',
    );
  }

  loop.push('Act: make the smallest scoped change that satisfies the goal.');

  if (profile.needsVerification) {
    loop.push('Verify: run the closest deterministic check and treat failures as feedback.');
  }

  if (profile.needsExternalEvidence) {
    loop.push('Ground: attach evidence to claims and separate sourced facts from inference.');
  }

  if (profile.needsSelfCorrection) {
    loop.push(
      'Correct: when a check or tool fails, identify the failure mode before retrying with a different action.',
    );
  }

  return loop;
}

export function assessSingleAgentPlan(plan: string, goal = ''): SingleAgentPlanAssessment {
  const profile = classifySingleAgentTask(goal);
  const checks = [
    {
      name: 'inspection',
      present: /\b(read|inspect|search|trace|review|understand|look)\b/i.test(plan),
    },
    {
      name: 'ordered steps',
      present: /\b(step|first|then|after|sequence|order|plan)\b/i.test(plan),
    },
    {
      name: 'verification',
      present: /\b(test|typecheck|lint|build|verify|validate|screenshot)\b/i.test(plan),
    },
    {
      name: 'risk control',
      present: /\b(risk|rollback|checkpoint|git status|diff|minimal|scope)\b/i.test(plan),
    },
    {
      name: 'evidence',
      present: /\b(source|citation|evidence|docs|paper|benchmark|claim)\b/i.test(plan),
    },
    {
      name: 'self-correction',
      present: /\b(fail|failure|retry|iterate|fix any failures|rerun)\b/i.test(plan),
    },
  ];

  const required = checks.filter((check) => {
    if (check.name === 'evidence') return profile.needsExternalEvidence;
    if (check.name === 'verification') return profile.needsVerification;
    if (check.name === 'self-correction') return profile.needsSelfCorrection;
    return true;
  });

  const presentSignals = required.filter((check) => check.present).map((check) => check.name);
  const missingSignals = required.filter((check) => !check.present).map((check) => check.name);
  const score = required.length === 0 ? 1 : round2(presentSignals.length / required.length);

  return {
    score,
    presentSignals,
    missingSignals,
    recommendations: missingSignals.map((signal) => recommendationForMissingPlanSignal(signal)),
  };
}

export function recommendCoreToolsForSingleAgent(
  goal: string,
  availableTools: string[],
  options?: { recentToolCalls?: Array<{ name: string; error?: string }> },
): string[] {
  const available = new Set(availableTools);
  const profile = classifySingleAgentTask(goal);
  const recommended: string[] = [];

  addFirstAvailable(recommended, available, ['file_read']);

  if (profile.needsRepositoryInspection) {
    addFirstAvailable(recommended, available, ['code_search', 'file_search', 'file_list']);
  }

  if (profile.kind === 'code_change' || profile.kind === 'debugging') {
    addFirstAvailable(recommended, available, [
      'file_edit',
      'apply_patch',
      'fix_code',
      'refine_code',
    ]);
  }

  if (profile.needsVerification) {
    addFirstAvailable(recommended, available, [
      'shell_execute',
      'execute_script',
      'python_execute',
    ]);
    addFirstAvailable(recommended, available, ['verify_answer', 'verify']);
  }

  if (profile.needsExternalEvidence) {
    addFirstAvailable(recommended, available, ['web_search', 'browser_search']);
    addFirstAvailable(recommended, available, ['web_fetch', 'browser_fetch']);
  }

  if (profile.kind === 'git_workflow') {
    addFirstAvailable(recommended, available, ['git']);
  }

  for (const fallback of fallbackToolsForRepeatedErrors(
    options?.recentToolCalls ?? [],
    available,
  )) {
    addUnique(recommended, fallback);
  }

  return recommended;
}

export function auditSingleAgentToolSelection(
  goal: string,
  selectedTools: string[],
  availableTools: string[],
): SingleAgentToolSelectionAudit {
  const requiredCoreTools = recommendCoreToolsForSingleAgent(goal, availableTools);
  const selected = new Set(selectedTools);
  const missingCoreTools = requiredCoreTools.filter((tool) => !selected.has(tool));
  const riskyTools = selectedTools.filter((tool) => tool === 'agent' || tool === 'a2a_delegate');
  const penalties = missingCoreTools.length + riskyTools.length;
  const denominator = Math.max(requiredCoreTools.length + riskyTools.length, 1);
  const score = round2(Math.max(0, 1 - penalties / denominator));

  return {
    score,
    requiredCoreTools,
    missingCoreTools,
    riskyTools,
    recommendations: [
      ...missingCoreTools.map((tool) => `Include ${tool} for this single-agent task.`),
      ...riskyTools.map((tool) => `Avoid ${tool} unless coordination has evidence-backed ROI.`),
    ],
  };
}

export function computeSingleAgentEvalMetrics(runs: SingleAgentEvalRun[]): SingleAgentEvalMetrics {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      taskCompletionRate: 0,
      bugIntroductionRate: 0,
      averageLatencyMs: 0,
      p95LatencyMs: 0,
      totalCostUsd: 0,
      averageCostUsd: 0,
      averageTokens: 0,
    };
  }

  const successes = runs.filter((run) => run.result.status === 'success').length;
  const completed = runs.filter(
    (run) => run.expectedCompleted ?? run.result.status === 'success',
  ).length;
  const bugIntroductions = runs.filter(
    (run) => run.bugIntroduced ?? inferBugIntroduction(run.result),
  ).length;
  const latencies = runs.map((run) => run.result.totalDurationMs).sort((a, b) => a - b);
  const totalCostUsd = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const totalTokens = runs.reduce(
    (sum, run) => sum + (run.result.totalTokenUsage?.totalTokens ?? 0),
    0,
  );

  return {
    totalRuns: runs.length,
    successRate: round2(successes / runs.length),
    taskCompletionRate: round2(completed / runs.length),
    bugIntroductionRate: round2(bugIntroductions / runs.length),
    averageLatencyMs: Math.round(latencies.reduce((sum, n) => sum + n, 0) / runs.length),
    p95LatencyMs:
      latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
    totalCostUsd: round4(totalCostUsd),
    averageCostUsd: round4(totalCostUsd / runs.length),
    averageTokens: Math.round(totalTokens / runs.length),
  };
}

export const DEFAULT_SINGLE_AGENT_EVAL_CASES: SingleAgentEvalCase[] = [
  {
    id: 'single-agent-debug-failing-test',
    category: 'debugging',
    prompt:
      'Fix a failing unit test by reproducing the failure, changing the minimal code path, and rerunning the focused test.',
    verification: ['focused test exits 0', 'no unrelated files changed'],
    trackedMetrics: ['successRate', 'bugIntroductionRate', 'averageLatencyMs', 'averageCostUsd'],
  },
  {
    id: 'single-agent-multifile-refactor',
    category: 'code_change',
    prompt:
      'Refactor a cross-file API without changing behavior, then run typecheck and affected tests.',
    verification: [
      'typecheck exits 0',
      'affected tests exit 0',
      'git diff contains expected files only',
    ],
    trackedMetrics: ['taskCompletionRate', 'bugIntroductionRate', 'averageTokens'],
  },
  {
    id: 'single-agent-evidence-research',
    category: 'research',
    prompt:
      'Produce an evidence-backed technical recommendation with sourced claims and explicit inferences.',
    verification: [
      'claims include sources',
      'inferences are labelled',
      'latency and source count recorded',
    ],
    trackedMetrics: ['successRate', 'averageLatencyMs', 'averageCostUsd'],
  },
];

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function matchesAll(input: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(input));
}

function addFirstAvailable(result: string[], available: Set<string>, candidates: string[]): void {
  const found = candidates.find((candidate) => available.has(candidate));
  if (found) addUnique(result, found);
}

function addUnique(result: string[], value: string): void {
  if (!result.includes(value)) result.push(value);
}

function fallbackToolsForRepeatedErrors(
  recentToolCalls: Array<{ name: string; error?: string }>,
  available: Set<string>,
): string[] {
  const errorCounts = new Map<string, number>();
  for (const call of recentToolCalls) {
    if (call.error) errorCounts.set(call.name, (errorCounts.get(call.name) ?? 0) + 1);
  }

  const fallbacks: string[] = [];
  if ((errorCounts.get('code_search') ?? 0) >= 2)
    addFirstAvailable(fallbacks, available, ['file_search', 'shell_execute']);
  if ((errorCounts.get('file_edit') ?? 0) >= 2)
    addFirstAvailable(fallbacks, available, ['apply_patch', 'file_write']);
  if ((errorCounts.get('web_search') ?? 0) >= 2)
    addFirstAvailable(fallbacks, available, ['browser_search', 'web_fetch']);
  if ((errorCounts.get('shell_execute') ?? 0) >= 2)
    addFirstAvailable(fallbacks, available, ['python_execute', 'execute_script']);
  return fallbacks;
}

function recommendationForMissingPlanSignal(signal: string): string {
  switch (signal) {
    case 'inspection':
      return 'Add an inspection step before editing or answering.';
    case 'ordered steps':
      return 'Order the work into explicit dependent steps.';
    case 'verification':
      return 'Name the deterministic check that will prove completion.';
    case 'risk control':
      return 'State the blast radius and how the change will stay scoped.';
    case 'evidence':
      return 'Attach sources to factual claims and label inferences.';
    case 'self-correction':
      return 'Define how failures will be diagnosed and retried differently.';
    default:
      return `Address missing planning signal: ${signal}.`;
  }
}

function inferBugIntroduction(
  result: Pick<AgentExecutionResult, 'summary' | 'steps' | 'error'>,
): boolean {
  const combined = [
    result.summary,
    result.error ?? '',
    ...result.steps.map((step) => step.content),
  ].join('\n');
  return /\b(regression|introduced\s+a\s+bug|new\s+failure|test\s+failed\s+after|typecheck\s+failed|build\s+failed)\b/i.test(
    combined,
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
