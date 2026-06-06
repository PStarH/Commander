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

  const scoreEntries = Array.from(scores.entries());
  for (let i = 0; i < scoreEntries.length; i++) {
    const [toolName, score] = scoreEntries[i];
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

  const availableSet = new Set(availableTools);
  const result = new Set<string>();

  for (const tool of alwaysInclude) {
    if (availableSet.has(tool)) {
      result.add(tool);
    }
  }

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);

  for (let i = 0; i < sorted.length; i++) {
    if (result.size >= maxTools) break;
    result.add(sorted[i][0]);
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

// ============================================================================
// Two-Tier Tool Loading (Lazy Schema Loading)
//
// Research (arXiv:2604.21816): MCP eager schema injection costs 10k-60k tokens
// per turn. Two-tier loading reduces this by ~80-95%.
//
// Tier 1 (Active): Full JSON schema injected as LLM tools (top-N relevant)
// Tier 2 (Registry): Name + one-line description in system prompt (rest)
//
// The LLM can request Tier 2 tools on-demand via the `request_tool` tool.
// ============================================================================

export interface ToolTier {
  /** Tools with full schema (injected as LLM tools array) */
  active: ToolDefinition[];
  /** Tools with compact summary only (injected as text in system prompt) */
  registry: Array<{ name: string; description: string; category: string }>;
}

/**
 * Build a two-tier tool layout for a given goal.
 *
 * @param goal - The current task goal
 * @param allTools - All available tool definitions
 * @param maxActive - Maximum tools to include with full schema (default: 8)
 * @param recentToolCalls - Recent tool calls for history-aware scoring
 * @returns Two-tier layout with active (full schema) and registry (compact) tools
 */
export function buildTwoTierTools(
  goal: string,
  allTools: ToolDefinition[],
  maxActive: number = 8,
  recentToolCalls?: Array<{ name: string; error?: string }>,
): ToolTier {
  if (allTools.length <= maxActive) {
    // All tools fit — no need for tiering
    return {
      active: sortToolDefinitionsForCache(allTools),
      registry: [],
    };
  }

  const toolNames = allTools.map(t => t.name);
  const scores = scoreToolsByGoal(goal, toolNames);
  const refined = recentToolCalls
    ? refineScoresWithHistory(scores, recentToolCalls)
    : scores;

  // Sort by relevance score descending
  const sorted = Array.from(refined.entries()).sort((a, b) => b[1] - a[1]);

  // Always-include tools (core utilities the LLM almost always needs)
  const alwaysInclude = ['file_read', 'shell_execute'];
  const activeNames = new Set<string>();
  const registryEntries: ToolTier['registry'] = [];

  // Phase 1: Add always-include tools
  for (let i = 0; i < alwaysInclude.length; i++) {
    if (toolNames.includes(alwaysInclude[i])) activeNames.add(alwaysInclude[i]);
  }

  // Phase 2: Add highest-scoring tools up to maxActive
  for (let i = 0; i < sorted.length; i++) {
    if (activeNames.size >= maxActive) break;
    activeNames.add(sorted[i][0]);
  }

  // Phase 3: Build active and registry lists
  const toolMap = new Map(allTools.map(t => [t.name, t]));
  const active: ToolDefinition[] = [];
  const activeNamesArray = Array.from(activeNames);
  for (let i = 0; i < activeNamesArray.length; i++) {
    const tool = toolMap.get(activeNamesArray[i]);
    if (tool) active.push(tool);
  }

  for (const tool of allTools) {
    if (!activeNames.has(tool.name)) {
      registryEntries.push({
        name: tool.name,
        description: truncateDescription(tool.description, 80),
        category: TOOL_CATEGORIES[tool.name] ?? 'other',
      });
    }
  }

  return {
    active: sortToolDefinitionsForCache(active),
    registry: registryEntries.sort((a, b) => {
      const catA = CATEGORY_SORT_PRIORITY[a.category] ?? 99;
      const catB = CATEGORY_SORT_PRIORITY[b.category] ?? 99;
      if (catA !== catB) return catA - catB;
      return a.name.localeCompare(b.name);
    }),
  };
}

/**
 * Build a compact text summary of the tool registry (Tier 2 tools).
 * This is injected into the system prompt so the LLM knows what tools exist
 * without paying the full schema cost.
 */
export function buildRegistrySummary(registry: ToolTier['registry']): string {
  if (registry.length === 0) return '';

  const lines: string[] = [
    '## Additional Tools (available on request)',
    'The following tools are available but not loaded. To use one, call `request_tool` with the tool name.',
    '',
  ];

  // Group by category
  const byCategory = new Map<string, typeof registry>();
  for (const tool of registry) {
    const cat = tool.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(tool);
  }

  const categoryEntries = Array.from(byCategory.entries());
  for (let i = 0; i < categoryEntries.length; i++) {
    const [category, tools] = categoryEntries[i];
    lines.push(`### ${category}`);
    for (let j = 0; j < tools.length; j++) {
      lines.push(`- **${tools[j].name}**: ${tools[j].description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Truncate a tool description to a maximum length, preserving word boundaries.
 */
function truncateDescription(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) return desc;
  const truncated = desc.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? truncated.substring(0, lastSpace) : truncated) + '…';
}

/**
 * Estimate the token cost of tool schemas.
 * Useful for logging and metrics.
 */
export function estimateToolTokenCost(tools: ToolDefinition[]): number {
  let totalChars = 0;
  for (const tool of tools) {
    totalChars += (tool.name?.length ?? 0);
    totalChars += (tool.description?.length ?? 0);
    totalChars += JSON.stringify(tool.inputSchema ?? {}).length;
    // Examples cost
    if (tool.examples) {
      for (const ex of tool.examples) {
        totalChars += JSON.stringify(ex).length;
      }
    }
  }
  // Rough estimate: ~4 chars per token for JSON content
  return Math.ceil(totalChars / 4);
}

export interface TwoTierMetrics {
  activeCount: number;
  registryCount: number;
  activeTokenEstimate: number;
  registryTokenEstimate: number;
  savingsPercent: number;
}

/**
 * Calculate metrics for a two-tier tool layout.
 * Useful for logging cost savings.
 */
export function calculateTierMetrics(
  tier: ToolTier,
  allToolsCount: number,
): TwoTierMetrics {
  const activeTokens = estimateToolTokenCost(tier.active);
  // Registry is text, ~20 tokens per tool entry
  const registryTokens = tier.registry.length * 20;
  // What it would cost if we loaded ALL tools with full schema
  const fullSchemaEstimate = activeTokens * (allToolsCount / Math.max(tier.active.length, 1));

  return {
    activeCount: tier.active.length,
    registryCount: tier.registry.length,
    activeTokenEstimate: activeTokens,
    registryTokenEstimate: registryTokens,
    savingsPercent: fullSchemaEstimate > 0
      ? Math.round((1 - (activeTokens + registryTokens) / fullSchemaEstimate) * 100)
      : 0,
  };
}
