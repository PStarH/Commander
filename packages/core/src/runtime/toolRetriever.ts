/**
 * Dynamic Tool Retrieval (ITR - Instruction-Tool Retrieval)
 *
 * Research finding (arXiv 2602.17046): Dynamic tool retrieval achieves:
 * - 95% reduction in per-step context tokens
 * - 32% improvement in tool routing accuracy
 * - 70% cost reduction
 *
 * Instead of loading ALL tool definitions into every LLM request,
 * we dynamically select only the tools relevant to the current task
 * and conversation state. This reduces prompt size, improves model
 * focus, and cuts costs.
 *
 * The retriever uses a two-stage approach:
 * 1. Keyword-based relevance scoring (fast, no LLM call)
 * 2. Conversation-aware refinement based on recent tool usage patterns
 */
import type { ToolDefinition } from './types';
const TOOL_RELEVANCE_KEYWORDS: Record<string, string[]> = {
  web_search: ['search web', 'search internet', 'look up', 'find online', 'google', 'what is', 'who is', 'web search', 'latest', 'news', 'current'],
  web_fetch: ['fetch url', 'get webpage', 'read url', 'http get', 'download page', 'scrape'],
  browser_search: ['browse', 'duckduckgo', 'search browser', 'navigate browser'],
  browser_fetch: ['browser fetch', 'render page', 'get page content', 'javascript render'],
  file_read: ['read file', 'open file', 'view file', 'cat file', 'show file content', 'get file'],
  file_write: ['write file', 'create file', 'save file', 'output to file', 'put file'],
  file_edit: ['edit file', 'modify file', 'update file', 'change file', 'patch file', 'replace in file', 'edit', 'modify', 'update config'],
  file_search: ['search files', 'find file', 'glob', 'locate file', 'search directory', 'list files'],
  file_list: ['list directory', 'ls', 'dir', 'show directory', 'enumerate'],
  python_execute: ['run python', 'execute python', 'python script', 'calculate', 'compute', 'analyze data', 'plot'],
  shell_execute: ['run command', 'execute shell', 'terminal', 'bash', 'zsh', 'npm', 'npx', 'git', 'install', 'build'],
  memory_store: ['remember', 'save memory', 'store memory', 'record'],
  memory_recall: ['recall', 'retrieve memory', 'search memory', 'remember', 'what did i', 'previous'],
  memory_list: ['list memories', 'show memories', 'browse memory'],
  git: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'version control', 'repository', 'repo'],
  agent: ['delegate', 'sub-agent', 'subagent', 'spawn agent', 'fork', 'parallel task'],
  execute_script: ['run script', 'execute script', 'script', 'run js', 'run ts', 'javascript', 'typescript', 'node script'],
  vision_analyze: ['image', 'picture', 'photo', 'screenshot', 'visual', 'analyze image', 'describe image', 'ocr', 'what is in this image'],
  pdf_extract: ['pdf', 'extract pdf', 'read pdf', 'parse pdf', 'pdf text', 'pdf content'],
  screenshot_capture: ['screenshot', 'capture screen', 'take screenshot', 'screen capture', 'grab screen'],
  code_search: ['search code', 'find code', 'grep code', 'code search', 'search repository', 'find function', 'find class', 'ripgrep', 'find', 'search', 'locate', 'todo', 'fixme', 'hack', 'pattern', 'comment', 'count'],
  apply_patch: ['patch', 'apply patch', 'diff', 'unified diff', 'code patch', 'apply diff'],
  refine_code: ['refine', 'improve code', 'refactor', 'clean up code', 'code quality', 'code review', 'optimize code'],
  verify_answer: ['verify', 'check answer', 'validate answer', 'verify answer', 'format answer', 'answer quality'],
  fix_code: ['fix code', 'debug', 'fix error', 'fix bug', 'code fix', 'repair code', 'syntax error', 'runtime error'],
};

const TOOL_CATEGORIES: Record<string, string> = {
  web_search: 'web_information',
  web_fetch: 'web_information',
  browser_search: 'browser_automation',
  browser_fetch: 'browser_automation',
  file_read: 'file_system',
  file_write: 'file_system',
  file_edit: 'file_system',
  file_search: 'file_system',
  file_list: 'file_system',
  python_execute: 'code_execution',
  shell_execute: 'code_execution',
  memory_store: 'memory',
  memory_recall: 'memory',
  memory_list: 'memory',
  git: 'version_control',
  agent: 'orchestration',
  execute_script: 'code_execution',
  vision_analyze: 'multimodal',
  pdf_extract: 'multimodal',
  screenshot_capture: 'multimodal',
  code_search: 'code_execution',
  apply_patch: 'code_execution',
  refine_code: 'code_execution',
  verify_answer: 'validation',
  fix_code: 'code_execution',
  skill_view: 'knowledge',
  a2a_delegate: 'orchestration',
};

/**
 * Score how relevant each tool is to the current task.
 * Returns a Map<toolName, score> where higher = more relevant.
 */
function scoreToolsByGoal(goal: string, availableTools: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const goalLower = goal.toLowerCase();

  for (const toolName of availableTools) {
    let score = 0;
    const keywords = TOOL_RELEVANCE_KEYWORDS[toolName];

    if (keywords) {
      for (const kw of keywords) {
        if (goalLower.includes(kw)) {
          score += kw.includes(' ') ? 3 : 1;
        }
      }
    }

    if (toolName === 'file_read') score += 0.5;
    if (toolName === 'shell_execute') score += 0.3;
    if (toolName === 'python_execute') score += 0.3;
    if (toolName === 'code_search') score += 0.5;

    scores.set(toolName, score);
  }

  return scores;
}

/**
 * Refine scores based on recent tool usage in the conversation.
 * If the model has been using web_search repeatedly, keep it high.
 * If a tool has errored >2 times, demote it (model might be confused).
 */
function refineScoresWithHistory(
  scores: Map<string, number>,
  recentToolCalls: Array<{ name: string; error?: string }>,
): Map<string, number> {
  const refined = new Map(scores);

  if (recentToolCalls.length === 0) return refined;

  const usageCount = new Map<string, number>();
  const errorCount = new Map<string, number>();

  for (const tc of recentToolCalls) {
    usageCount.set(tc.name, (usageCount.get(tc.name) ?? 0) + 1);
    if (tc.error) {
      errorCount.set(tc.name, (errorCount.get(tc.name) ?? 0) + 1);
    }
  }

  for (const [toolName, score] of scores.entries()) {
    const uses = usageCount.get(toolName) ?? 0;
    const errors = errorCount.get(toolName) ?? 0;
    refined.set(toolName, score + Math.min(uses, 5) * 1.5 - errors * 3);
  }

  return refined;
}

/**
 * Select the optimal subset of tools based on task context.
 * The `minTools` parameter ensures core tools are always available.
 */
export function selectTools(
  goal: string,
  availableTools: string[],
  options?: {
    recentToolCalls?: Array<{ name: string; error?: string }>;
    /** Minimum number of tools to return (default: 3) */
    minTools?: number;
    /** Maximum number of tools to return (default: 15, i.e. all) */
    maxTools?: number;
    /** Force-include these tools regardless of scoring (default: ['file_read', 'shell_execute']) */
    alwaysInclude?: string[];
    /** Tools that conflict with each other (mutually exclusive pairs) */
    stoplist?: [string, string][];
  },
): string[] {
  const minTools = options?.minTools ?? 3;
  const maxTools = options?.maxTools ?? 15;
  const alwaysInclude = options?.alwaysInclude ?? ['file_read', 'shell_execute'];
  const recentCalls = options?.recentToolCalls ?? [];

  let scores = scoreToolsByGoal(goal, availableTools);
  scores = refineScoresWithHistory(scores, recentCalls);

  const result = new Set<string>();

  for (const tool of alwaysInclude) {
    if (availableTools.includes(tool)) {
      result.add(tool);
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  for (const [toolName] of sorted) {
    if (result.size >= maxTools) break;
    result.add(toolName);
  }

  if (result.size < minTools) {
    for (const tool of availableTools) {
      if (result.size >= minTools) break;
      result.add(tool);
    }
  }

  return Array.from(result);
}

/**
 * Stable sort priority for each tool category.
 * Lower number = appears first in the prompt (higher cache stability).
 * Categories with more frequently used tools come first.
 */
const CATEGORY_SORT_PRIORITY: Record<string, number> = {
  file_system: 1,
  code_execution: 2,
  web_information: 3,
  browser_automation: 4,
  memory: 5,
  version_control: 6,
  orchestration: 7,
  multimodal: 8,
  knowledge: 9,
  validation: 10,
};

export function getToolCategory(toolName: string): string {
  return TOOL_CATEGORIES[toolName] ?? 'other';
}

/**
 * Sort tool definitions by a stable category+name order for maximum prompt cache hit rates.
 * Cache-friendly ordering ensures the tool definition prefix is identical across LLM calls,
 * regardless of the specific task goal.
 *
 * The order is: category priority (ascending) → tool name (alphabetical).
 */
export function sortToolDefinitionsForCache(
  defs: ToolDefinition[],
): ToolDefinition[] {
  return [...defs].sort((a, b) => {
    const catA = CATEGORY_SORT_PRIORITY[TOOL_CATEGORIES[a.name] ?? 'other'] ?? 99;
    const catB = CATEGORY_SORT_PRIORITY[TOOL_CATEGORIES[b.name] ?? 'other'] ?? 99;
    if (catA !== catB) return catA - catB;
    return a.name.localeCompare(b.name);
  });
}

export function getToolRelevanceScores(
  goal: string,
  availableTools: string[],
): Map<string, number> {
  return scoreToolsByGoal(goal, availableTools);
}
