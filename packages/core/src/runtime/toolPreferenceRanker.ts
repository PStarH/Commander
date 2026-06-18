/**
 * Tool Preference Ranker — Dynamic tool prioritization by task context.
 *
 * Replaces keyword-only scoring with multi-dimensional tool preference:
 * 1. Task type classification (code_edit, research, git_workflow, etc.)
 * 2. Tool chain awareness — expected sequences per task type
 * 3. Category priority per task type
 * 4. Context-aware adjustments (recent errors, modified files, provider)
 *
 * Used by toolRetriever.ts buildTwoTierTools to promote the right tools
 * to Tier 1 (full schema), reducing token waste from irrelevant tool schemas.
 *
 * Research basis:
 * - arXiv 2602.17046: Dynamic tool retrieval → 32% routing accuracy improvement
 * - arXiv 2604.21816: Two-tier loading saves 60-80% tool token cost
 * - This ranker improves Tier 1 selection accuracy, directly amplifying both benefits.
 */

// ============================================================================
// Types
// ============================================================================

/** Task categories the ranker detects from the goal text. */
export type TaskType =
  | 'code_edit'
  | 'code_search'
  | 'research'
  | 'analysis'
  | 'file_management'
  | 'git_workflow'
  | 'test_run'
  | 'verification'
  | 'general';

/** Context the ranker uses for dynamic adjustments. */
export interface RankerContext {
  /** Whether any files have been modified in this run */
  hasModifiedFiles?: boolean;
  /** Whether type/lint errors have been detected */
  hasTypeErrors?: boolean;
  /** Provider name (openai, anthropic, google, deepseek) */
  modelProvider?: string;
  /** Model tier (eco, standard, power) */
  modelTier?: string;
  /** Approximate number of tokens remaining in budget */
  budgetRemaining?: number;
}

/** A single tool preference with normalized score, priority, and reasoning. */
export interface ToolPreference {
  toolName: string;
  /** Normalized score 0–1 */
  score: number;
  /** Ordinal priority: 1 = always-include, 10 = lowest priority */
  priority: number;
  /** Human-readable reasons for the score */
  reasons: string[];
}

/** Categories as used internally by the ranker. */
type ToolCategory =
  | 'file_system'
  | 'code_execution'
  | 'web_information'
  | 'browser_automation'
  | 'memory'
  | 'version_control'
  | 'orchestration'
  | 'multimodal'
  | 'validation'
  | 'knowledge';

// ============================================================================
// Tool → Category mapping (same as toolRetriever.ts to keep in sync)
// ============================================================================

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  file_read: 'file_system',
  file_write: 'file_system',
  file_edit: 'file_system',
  file_search: 'file_system',
  file_list: 'file_system',
  glob: 'file_system',
  python_execute: 'code_execution',
  shell_execute: 'code_execution',
  execute_script: 'code_execution',
  code_search: 'code_execution',
  apply_patch: 'code_execution',
  refine_code: 'code_execution',
  fix_code: 'code_execution',
  web_search: 'web_information',
  web_fetch: 'web_information',
  browser_search: 'browser_automation',
  browser_fetch: 'browser_automation',
  memory_store: 'memory',
  memory_recall: 'memory',
  memory_list: 'memory',
  git: 'version_control',
  agent: 'orchestration',
  a2a_delegate: 'orchestration',
  vision_analyze: 'multimodal',
  pdf_extract: 'multimodal',
  screenshot_capture: 'multimodal',
  verify_answer: 'validation',
  verify: 'validation',
  skill_view: 'knowledge',
};

// ============================================================================
// Task type classification
// ============================================================================

const TASK_PATTERNS: Array<{ type: TaskType; patterns: RegExp[] }> = [
  {
    type: 'file_management',
    patterns: [
      /\b(?:organize|move|rename|copy|delete|clean|archive|backup)\b.*\b(?:files?|director(?:y|ies)|folders?)\b/i,
      /\b(?:list|ls|show|tree)\b.*\b(?:director(?:y|ies)|folders?|files|structure)\b/i,
      /\b(?:create|make|mkdir|touch)\b.*\b(?:director(?:y|ies)|folders?|files?)\b/i,
    ],
  },
  {
    type: 'git_workflow',
    patterns: [
      /\b(?:git|commit|push|pull|merge|rebase|branch|tag|release|checkout|stash)\b/i,
      /\b(?:version|changelog|release\s+notes|semver)\b/i,
      /\b(?:pull\s+request|merge\s+request|PR|MR)\b/i,
    ],
  },
  {
    type: 'test_run',
    patterns: [
      /\b(?:tests?|run\s+tests?|execute\s+tests?|vitest|jest|mocha|pytest|specs?)\b/i,
      /\b(?:coverage|snapshot|assertion|mock|stub|fixture)\b/i,
      /\b(?:TDD|BDD|unit\s+tests?|integration\s+tests?|e2e)\b/i,
    ],
  },
  {
    type: 'verification',
    patterns: [
      /\b(?:verify|validate|check|confirm|ensure|make\s+sure)\b/i,
      /\b(?:typecheck|lint|type.?check|eslint|tsc)\b/i,
      /\b(?:passes|passing|green|clean)\b.*\b(?:tests?|builds?|checks?|types?)\b/i,
    ],
  },
  {
    type: 'code_edit',
    patterns: [
      /\b(?:edit|modify|change|update|fix|patch|refactor|rewrite|implement|add|create|remove|delete|rename|move)\b.*\b(?:files?|codes?|functions?|classes?|modules?|components?|imports?|exports?|bugs?|errors?|configs?|interfaces?|types?)\b/i,
      /\b(?:write|generate|produce|build|scaffold)\b.*\b(?:code|script|module|component|class|function|file)\b/i,
      /\b(?:refactor|rewrite|migrate|convert)\b/i,
      /\b(?:implement|add|create)\b.*\b(?:feature|endpoint|route|handler|middleware|service)\b/i,
      /\b(?:typecheck|tsc|lint|eslint|format|prettier)\b/i,
      /\b(?:fix|debug|patch|resolve|repair)\b.*\b(?:bugs?|errors?|issues?|problems?)\b/i,
      /\b(?:update|change|modify)\b.*\b(?:config|settings|setup)\b/i,
    ],
  },
  {
    type: 'code_search',
    patterns: [
      /\b(?:find|search|grep|locate|look\s+for|where\s+is|show\s+me)\b.*\b(?:files?|codes?|functions?|classes?|imports?|exports?|variables?|constants?|types?|interfaces?)\b/i,
      /\b(?:what|how|where)\b.*\b(?:defined|implemented|used|called|imported|exported)\b/i,
      /\b(?:list|show|display)\b.*\b(?:all|every)\b.*\b(?:files?|functions?|classes?|tests?)\b/i,
      /\b(?:search|scan|grep|ripgrep|find)\b/i,
    ],
  },
  {
    type: 'research',
    patterns: [
      /\b(?:research|investigate|explore|survey|compare|benchmark|evaluate)\b/i,
      /\b(?:what\s+(?:is|are)|tell\s+me\s+about|explain|describe)\b/i,
      /\b(?:how\s+(?:does|do|to|can|should))\b/i,
      /\b(?:best\s+practice|recommendation|guide|tutorial|documentation)\b/i,
      /\b(?:latest|current|modern|state\s+of)\b/i,
    ],
  },
  {
    type: 'analysis',
    patterns: [
      /\b(?:analyze|analysis|audit|review|assess|profile|measure|track|monitor)\b/i,
      /\b(?:performance|security|complexity|coverage|quality|cost)\b.*\b(?:analysis|audit|review|report)\b/i,
      /\b(?:report|summary|breakdown|overview)\b/i,
      /\b(?:understand|figure\s+out|determine|identify)\b.*\b(?:why|how|what|which)\b/i,
    ],
  },
];

/** Classify the task goal into one or more task types. */
export function classifyTaskType(goal: string): TaskType {
  const goalLower = goal.toLowerCase();
  let bestMatch: { type: TaskType; score: number } = { type: 'general', score: 0 };

  for (const entry of TASK_PATTERNS) {
    let score = 0;
    for (const pattern of entry.patterns) {
      if (pattern.test(goalLower)) {
        score += 1;
      }
    }
    if (score > bestMatch.score) {
      bestMatch = { type: entry.type, score };
    }
  }

  return bestMatch.type;
}

// ============================================================================
// Category priority per task type (lower = higher priority)
// ============================================================================

const CATEGORY_PRIORITY_BY_TASK: Record<TaskType, Partial<Record<ToolCategory, number>>> = {
  code_edit: {
    file_system: 1,
    code_execution: 2,
    validation: 3,
    version_control: 4,
    memory: 6,
    web_information: 7,
    browser_automation: 8,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  code_search: {
    code_execution: 1,
    file_system: 2,
    web_information: 5,
    memory: 6,
    browser_automation: 7,
    validation: 8,
    version_control: 8,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  research: {
    web_information: 1,
    file_system: 2,
    code_execution: 3,
    browser_automation: 4,
    memory: 5,
    knowledge: 6,
    validation: 8,
    version_control: 9,
    orchestration: 9,
    multimodal: 8,
  },
  analysis: {
    file_system: 1,
    code_execution: 2,
    web_information: 3,
    validation: 5,
    memory: 6,
    knowledge: 7,
    browser_automation: 8,
    version_control: 9,
    orchestration: 9,
    multimodal: 8,
  },
  file_management: {
    file_system: 1,
    version_control: 4,
    memory: 6,
    code_execution: 7,
    validation: 8,
    web_information: 9,
    browser_automation: 9,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  git_workflow: {
    version_control: 1,
    file_system: 2,
    code_execution: 5,
    validation: 6,
    memory: 7,
    web_information: 8,
    browser_automation: 8,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  test_run: {
    code_execution: 1,
    file_system: 2,
    validation: 3,
    memory: 6,
    version_control: 7,
    web_information: 8,
    browser_automation: 9,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  verification: {
    validation: 1,
    code_execution: 2,
    file_system: 3,
    memory: 6,
    version_control: 7,
    web_information: 8,
    browser_automation: 9,
    orchestration: 9,
    multimodal: 9,
    knowledge: 9,
  },
  general: {
    file_system: 1,
    code_execution: 2,
    web_information: 3,
    memory: 5,
    validation: 6,
    version_control: 7,
    browser_automation: 7,
    knowledge: 8,
    orchestration: 9,
    multimodal: 8,
  },
};

// ============================================================================
// Tool chains — expected sequences per task type
// ============================================================================

interface ToolChainStep {
  toolName: string;
  /** Boost applied when the tool's turn comes up in the chain */
  boost: number;
  /** If true, this tool is critical for the task type */
  critical?: boolean;
}

const TOOL_CHAINS_BY_TASK: Record<TaskType, ToolChainStep[]> = {
  code_edit: [
    { toolName: 'file_read', boost: 0.3, critical: true },
    { toolName: 'code_search', boost: 0.15 },
    { toolName: 'file_edit', boost: 0.25, critical: true },
    { toolName: 'verify', boost: 0.15 },
    { toolName: 'fix_code', boost: 0.1 },
  ],
  code_search: [
    { toolName: 'code_search', boost: 0.3, critical: true },
    { toolName: 'file_read', boost: 0.2 },
    { toolName: 'file_search', boost: 0.1 },
  ],
  research: [
    { toolName: 'web_search', boost: 0.25, critical: true },
    { toolName: 'web_fetch', boost: 0.15 },
    { toolName: 'file_read', boost: 0.1 },
    { toolName: 'memory_recall', boost: 0.1 },
  ],
  analysis: [
    { toolName: 'file_read', boost: 0.2, critical: true },
    { toolName: 'code_search', boost: 0.15 },
    { toolName: 'python_execute', boost: 0.1 },
    { toolName: 'file_search', boost: 0.1 },
  ],
  file_management: [
    { toolName: 'file_list', boost: 0.2, critical: true },
    { toolName: 'file_search', boost: 0.15 },
    { toolName: 'glob', boost: 0.1 },
    { toolName: 'file_read', boost: 0.1 },
  ],
  git_workflow: [
    { toolName: 'git', boost: 0.3, critical: true },
    { toolName: 'file_read', boost: 0.1 },
    { toolName: 'file_edit', boost: 0.1 },
  ],
  test_run: [
    { toolName: 'shell_execute', boost: 0.2, critical: true },
    { toolName: 'file_read', boost: 0.1 },
    { toolName: 'verify', boost: 0.15 },
    { toolName: 'fix_code', boost: 0.1 },
  ],
  verification: [
    { toolName: 'verify', boost: 0.3, critical: true },
    { toolName: 'shell_execute', boost: 0.15 },
    { toolName: 'file_read', boost: 0.1 },
    { toolName: 'fix_code', boost: 0.1 },
  ],
  general: [
    { toolName: 'file_read', boost: 0.15, critical: true },
    { toolName: 'shell_execute', boost: 0.1 },
  ],
};

// ============================================================================
// Keyword-based scores (legacy, kept for hybrid scoring)
// ============================================================================

const TOOL_RELEVANCE_KEYWORDS: Record<string, string[]> = {
  web_search: [
    'search web',
    'search internet',
    'look up',
    'find online',
    'google',
    'what is',
    'who is',
    'latest',
    'news',
    'current',
  ],
  web_fetch: ['fetch url', 'get webpage', 'read url', 'http get', 'download page', 'scrape'],
  browser_search: ['browse', 'duckduckgo', 'search browser'],
  browser_fetch: ['browser fetch', 'render page', 'get page content'],
  file_read: [
    'read file',
    'open file',
    'view file',
    'cat file',
    'show file content',
    'get file',
    'look at',
  ],
  file_write: ['write file', 'create file', 'save file', 'output to file', 'put file'],
  file_edit: [
    'edit file',
    'modify file',
    'update file',
    'change file',
    'patch file',
    'replace in file',
    'edit',
    'modify',
    'update config',
  ],
  file_search: [
    'search files',
    'find file',
    'glob',
    'locate file',
    'search directory',
    'list files',
  ],
  file_list: ['list directory', 'ls', 'dir', 'show directory', 'enumerate'],
  python_execute: [
    'run python',
    'execute python',
    'python script',
    'calculate',
    'compute',
    'analyze data',
    'plot',
  ],
  shell_execute: [
    'run command',
    'execute shell',
    'terminal',
    'bash',
    'zsh',
    'npm',
    'npx',
    'git',
    'install',
    'build',
    'run test',
  ],
  memory_store: ['remember', 'save memory', 'store memory', 'record'],
  memory_recall: ['recall', 'retrieve memory', 'search memory', 'remember', 'previous'],
  memory_list: ['list memories', 'show memories', 'browse memory'],
  git: [
    'git',
    'commit',
    'push',
    'pull',
    'branch',
    'merge',
    'version control',
    'repository',
    'repo',
  ],
  agent: ['delegate', 'sub-agent', 'subagent', 'spawn agent', 'fork', 'parallel'],
  execute_script: [
    'run script',
    'execute script',
    'run js',
    'run ts',
    'javascript',
    'typescript',
    'node script',
  ],
  vision_analyze: ['image', 'picture', 'photo', 'screenshot', 'visual', 'ocr'],
  pdf_extract: ['pdf', 'extract pdf', 'read pdf', 'parse pdf'],
  screenshot_capture: ['screenshot', 'capture screen', 'take screenshot'],
  code_search: [
    'search code',
    'find code',
    'grep code',
    'find function',
    'find class',
    'ripgrep',
    'find',
    'search',
    'locate',
    'todo',
    'fixme',
    'pattern',
    'count',
  ],
  apply_patch: ['patch', 'apply patch', 'diff', 'unified diff'],
  refine_code: [
    'refine',
    'improve code',
    'refactor',
    'clean up code',
    'code quality',
    'optimize code',
  ],
  verify_answer: ['verify', 'check answer', 'validate answer', 'format answer'],
  fix_code: [
    'fix code',
    'debug',
    'fix error',
    'fix bug',
    'code fix',
    'repair code',
    'syntax error',
    'runtime error',
  ],
  verify: ['verify', 'typecheck', 'lint', 'eslint', 'tsc', 'test', 'build check'],
};

// ============================================================================
// Main Ranking Function
// ============================================================================

/**
 * Rank available tools by relevance to a given task, producing normalized
 * scores (0–1), priority levels (1–10), and human-readable reasons.
 *
 * Scoring dimensions (weighted):
 *   1. Task-type category priority (40%)
 *   2. Tool chain membership (30%)
 *   3. Keyword matching (20%)
 *   4. Context adjustments (10%)
 *
 * @param goal - The task goal text
 * @param availableTools - Names of available tools
 * @param context - Optional runtime context for dynamic adjustments
 * @returns Ordered array of ToolPreferences, highest score first
 */
export function rankToolsByTask(
  goal: string,
  availableTools: string[],
  context?: RankerContext,
): ToolPreference[] {
  const taskType = classifyTaskType(goal);
  const goalLower = goal.toLowerCase();
  const categoryPriorities =
    CATEGORY_PRIORITY_BY_TASK[taskType] ?? CATEGORY_PRIORITY_BY_TASK.general;
  const toolChain = TOOL_CHAINS_BY_TASK[taskType] ?? TOOL_CHAINS_BY_TASK.general;

  // Build tool chain set for fast lookup
  const chainTools = new Set(toolChain.map((c) => c.toolName));
  const chainBoostMap = new Map(toolChain.map((c) => [c.toolName, c.boost]));
  const criticalTools = new Set(toolChain.filter((c) => c.critical).map((c) => c.toolName));

  const preferences: ToolPreference[] = [];

  for (const toolName of availableTools) {
    const reasons: string[] = [];
    let score = 0;

    // ── Dimension 1: Category priority (40%) ──
    const category = TOOL_CATEGORY[toolName] ?? 'other';
    const catPriority = categoryPriorities[category] ?? 10;
    const catScore = ((10 - catPriority) / 10) * 0.4; // 0.04–0.40
    score += catScore;
    if (catPriority <= 3) reasons.push(`high-priority category: ${category}`);

    // ── Dimension 2: Tool chain membership (30%) ──
    if (chainTools.has(toolName)) {
      const chainBoost = chainBoostMap.get(toolName) ?? 0.1;
      score += chainBoost;
      const isCritical = criticalTools.has(toolName);
      if (isCritical) reasons.push(`critical tool for ${taskType}`);
      else reasons.push(`in tool chain for ${taskType}`);
    }

    // ── Dimension 3: Keyword matching (20%) ──
    const keywords = TOOL_RELEVANCE_KEYWORDS[toolName];
    if (keywords) {
      let kwMatches = 0;
      for (const kw of keywords) {
        if (goalLower.includes(kw)) {
          kwMatches += kw.includes(' ') ? 3 : 1;
        }
      }
      const kwScore = Math.min((kwMatches / 4) * 0.2, 0.2);
      score += kwScore;
      if (kwMatches > 0) reasons.push(`keyword matches: ${kwMatches}`);
    }

    // ── Dimension 4: Context adjustments (10%) ──
    if (context) {
      // If files modified, boost verification tools for the next turn
      if (context.hasModifiedFiles && (toolName === 'verify' || toolName === 'fix_code')) {
        score += 0.05;
        reasons.push('boosted: files modified, need verification');
      }

      // If type errors detected, boost fix_code and file_read
      if (
        context.hasTypeErrors &&
        (toolName === 'fix_code' || toolName === 'file_read' || toolName === 'verify')
      ) {
        score += 0.05;
        reasons.push('boosted: type errors detected');
      }

      // Budget pressure: demote expensive tools
      if (context.budgetRemaining !== undefined && context.budgetRemaining < 1000) {
        const expensiveTools = [
          'web_search',
          'web_fetch',
          'browser_search',
          'vision_analyze',
          'pdf_extract',
        ];
        if (expensiveTools.includes(toolName)) {
          score -= 0.05;
          reasons.push('demoted: low budget');
        }
      }
    }

    // Clamp score to [0, 1]
    score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

    // Compute priority from score (1–10)
    const priority =
      score >= 0.8
        ? 1
        : score >= 0.6
          ? 2
          : score >= 0.4
            ? 3
            : score >= 0.25
              ? 4
              : score >= 0.15
                ? 5
                : score >= 0.1
                  ? 6
                  : score >= 0.05
                    ? 7
                    : score >= 0.02
                      ? 8
                      : score > 0
                        ? 9
                        : 10;

    preferences.push({
      toolName,
      score,
      priority,
      reasons: reasons.length > 0 ? reasons : ['no special reason — default priority'],
    });
  }

  // Sort by score descending, then by name ascending for stability
  preferences.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));

  return preferences;
}

/**
 * Get the set of critical tools for a given task type.
 * These are the tools the model SHOULD be offered for the task.
 */
export function getCriticalTools(taskType: TaskType): string[] {
  const chain = TOOL_CHAINS_BY_TASK[taskType] ?? TOOL_CHAINS_BY_TASK.general;
  return chain.filter((c) => c.critical).map((c) => c.toolName);
}

/**
 * Convert preferences into a simple Map<string, number> for backward
 * compatibility with the existing toolRetriever APIs.
 */
export function preferencesToScoreMap(preferences: ToolPreference[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of preferences) {
    // Scale to roughly match the old score range (0–10)
    map.set(p.toolName, p.score * 10);
  }
  return map;
}
