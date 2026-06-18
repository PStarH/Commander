"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectTools = selectTools;
exports.getToolCategory = getToolCategory;
exports.sortToolDefinitionsForCache = sortToolDefinitionsForCache;
exports.getToolRelevanceScores = getToolRelevanceScores;
exports.buildTwoTierTools = buildTwoTierTools;
exports.detectContextPromotions = detectContextPromotions;
exports.buildRegistrySummary = buildRegistrySummary;
exports.estimateToolTokenCost = estimateToolTokenCost;
exports.calculateTierMetrics = calculateTierMetrics;
const TOOL_RELEVANCE_KEYWORDS = {
    web_search: [
        'search web',
        'search internet',
        'look up',
        'find online',
        'google',
        'what is',
        'who is',
        'web search',
        'latest',
        'news',
        'current',
    ],
    web_fetch: ['fetch url', 'get webpage', 'read url', 'http get', 'download page', 'scrape'],
    browser_search: ['browse', 'duckduckgo', 'search browser', 'navigate browser'],
    browser_fetch: ['browser fetch', 'render page', 'get page content', 'javascript render'],
    file_read: ['read file', 'open file', 'view file', 'cat file', 'show file content', 'get file'],
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
    ],
    memory_store: ['remember', 'save memory', 'store memory', 'record'],
    memory_recall: [
        'recall',
        'retrieve memory',
        'search memory',
        'remember',
        'what did i',
        'previous',
    ],
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
    agent: ['delegate', 'sub-agent', 'subagent', 'spawn agent', 'fork', 'parallel task'],
    execute_script: [
        'run script',
        'execute script',
        'script',
        'run js',
        'run ts',
        'javascript',
        'typescript',
        'node script',
    ],
    vision_analyze: [
        'image',
        'picture',
        'photo',
        'screenshot',
        'visual',
        'analyze image',
        'describe image',
        'ocr',
        'what is in this image',
    ],
    pdf_extract: ['pdf', 'extract pdf', 'read pdf', 'parse pdf', 'pdf text', 'pdf content'],
    screenshot_capture: [
        'screenshot',
        'capture screen',
        'take screenshot',
        'screen capture',
        'grab screen',
    ],
    code_search: [
        'search code',
        'find code',
        'grep code',
        'code search',
        'search repository',
        'find function',
        'find class',
        'ripgrep',
        'find',
        'search',
        'locate',
        'todo',
        'fixme',
        'hack',
        'pattern',
        'comment',
        'count',
    ],
    apply_patch: ['patch', 'apply patch', 'diff', 'unified diff', 'code patch', 'apply diff'],
    refine_code: [
        'refine',
        'improve code',
        'refactor',
        'clean up code',
        'code quality',
        'code review',
        'optimize code',
    ],
    verify_answer: [
        'verify',
        'check answer',
        'validate answer',
        'verify answer',
        'format answer',
        'answer quality',
    ],
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
};
const TOOL_CATEGORIES = {
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
function scoreToolsByGoal(goal, availableTools) {
    const scores = new Map();
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
        if (toolName === 'file_read')
            score += 0.5;
        if (toolName === 'shell_execute')
            score += 0.3;
        if (toolName === 'python_execute')
            score += 0.3;
        if (toolName === 'code_search')
            score += 0.5;
        scores.set(toolName, score);
    }
    return scores;
}
/**
 * Refine scores based on recent tool usage in the conversation.
 * If the model has been using web_search repeatedly, keep it high.
 * If a tool has errored >2 times, demote it (model might be confused).
 */
function refineScoresWithHistory(scores, recentToolCalls) {
    var _a, _b, _c, _d;
    const refined = new Map(scores);
    if (recentToolCalls.length === 0)
        return refined;
    const usageCount = new Map();
    const errorCount = new Map();
    for (const tc of recentToolCalls) {
        usageCount.set(tc.name, ((_a = usageCount.get(tc.name)) !== null && _a !== void 0 ? _a : 0) + 1);
        if (tc.error) {
            errorCount.set(tc.name, ((_b = errorCount.get(tc.name)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
    }
    const scoreEntries = Array.from(scores.entries());
    for (let i = 0; i < scoreEntries.length; i++) {
        const [toolName, score] = scoreEntries[i];
        const uses = (_c = usageCount.get(toolName)) !== null && _c !== void 0 ? _c : 0;
        const errors = (_d = errorCount.get(toolName)) !== null && _d !== void 0 ? _d : 0;
        refined.set(toolName, score + Math.min(uses, 5) * 1.5 - errors * 3);
    }
    return refined;
}
/**
 * Select the optimal subset of tools based on task context.
 * The `minTools` parameter ensures core tools are always available.
 */
function selectTools(goal, availableTools, options) {
    var _a, _b, _c, _d;
    const minTools = (_a = options === null || options === void 0 ? void 0 : options.minTools) !== null && _a !== void 0 ? _a : 3;
    const maxTools = (_b = options === null || options === void 0 ? void 0 : options.maxTools) !== null && _b !== void 0 ? _b : 15;
    const alwaysInclude = (_c = options === null || options === void 0 ? void 0 : options.alwaysInclude) !== null && _c !== void 0 ? _c : ['file_read', 'shell_execute'];
    const recentCalls = (_d = options === null || options === void 0 ? void 0 : options.recentToolCalls) !== null && _d !== void 0 ? _d : [];
    let scores = scoreToolsByGoal(goal, availableTools);
    scores = refineScoresWithHistory(scores, recentCalls);
    const availableSet = new Set(availableTools);
    const result = new Set();
    for (const tool of alwaysInclude) {
        if (availableSet.has(tool)) {
            result.add(tool);
        }
    }
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < sorted.length; i++) {
        if (result.size >= maxTools)
            break;
        result.add(sorted[i][0]);
    }
    if (result.size < minTools) {
        for (const tool of availableTools) {
            if (result.size >= minTools)
                break;
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
const CATEGORY_SORT_PRIORITY = {
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
function getToolCategory(toolName) {
    var _a;
    return (_a = TOOL_CATEGORIES[toolName]) !== null && _a !== void 0 ? _a : 'other';
}
/**
 * Sort tool definitions by a stable category+name order for maximum prompt cache hit rates.
 * Cache-friendly ordering ensures the tool definition prefix is identical across LLM calls,
 * regardless of the specific task goal.
 *
 * The order is: category priority (ascending) → tool name (alphabetical).
 */
function sortToolDefinitionsForCache(defs) {
    return [...defs].sort((a, b) => {
        var _a, _b, _c, _d;
        const catA = (_b = CATEGORY_SORT_PRIORITY[(_a = TOOL_CATEGORIES[a.name]) !== null && _a !== void 0 ? _a : 'other']) !== null && _b !== void 0 ? _b : 99;
        const catB = (_d = CATEGORY_SORT_PRIORITY[(_c = TOOL_CATEGORIES[b.name]) !== null && _c !== void 0 ? _c : 'other']) !== null && _d !== void 0 ? _d : 99;
        if (catA !== catB)
            return catA - catB;
        return a.name.localeCompare(b.name);
    });
}
function getToolRelevanceScores(goal, availableTools) {
    return scoreToolsByGoal(goal, availableTools);
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
function buildTwoTierTools(goal, allTools, maxActive = 8, recentToolCalls) {
    var _a;
    if (allTools.length <= maxActive) {
        return {
            active: sortToolDefinitionsForCache(allTools),
            registry: [],
        };
    }
    const toolNames = allTools.map((t) => t.name);
    const scores = scoreToolsByGoal(goal, toolNames);
    const refined = recentToolCalls ? refineScoresWithHistory(scores, recentToolCalls) : scores;
    const sorted = Array.from(refined.entries()).sort((a, b) => b[1] - a[1]);
    const isCodingTask = /\b(code|debug|fix|build|compile|test|refactor|implement|deploy|run|execute|install)\b/i.test(goal);
    const alwaysInclude = isCodingTask ? ['file_read', 'shell_execute'] : ['file_read'];
    const activeNames = new Set();
    const registryEntries = [];
    for (let i = 0; i < alwaysInclude.length; i++) {
        if (toolNames.includes(alwaysInclude[i]))
            activeNames.add(alwaysInclude[i]);
    }
    for (let i = 0; i < sorted.length; i++) {
        if (activeNames.size >= maxActive)
            break;
        activeNames.add(sorted[i][0]);
    }
    const toolMap = new Map(allTools.map((t) => [t.name, t]));
    const active = [];
    const activeNamesArray = Array.from(activeNames);
    for (let i = 0; i < activeNamesArray.length; i++) {
        const tool = toolMap.get(activeNamesArray[i]);
        if (tool)
            active.push(tool);
    }
    for (const tool of allTools) {
        if (!activeNames.has(tool.name)) {
            registryEntries.push({
                name: tool.name,
                description: truncateDescription(tool.description, 80),
                category: (_a = TOOL_CATEGORIES[tool.name]) !== null && _a !== void 0 ? _a : 'other',
            });
        }
    }
    return {
        active: sortToolDefinitionsForCache(active),
        registry: registryEntries.sort((a, b) => {
            var _a, _b;
            const catA = (_a = CATEGORY_SORT_PRIORITY[a.category]) !== null && _a !== void 0 ? _a : 99;
            const catB = (_b = CATEGORY_SORT_PRIORITY[b.category]) !== null && _b !== void 0 ? _b : 99;
            if (catA !== catB)
                return catA - catB;
            return a.name.localeCompare(b.name);
        }),
    };
}
const CONTEXT_PROMOTED_TOOLS = [
    { pattern: /\b(git|commit|push|pull|merge|branch|diff)\b/i, tools: ['git'] },
    { pattern: /\b(search|find|look|query|grep)\b/i, tools: ['code_search', 'web_search'] },
    { pattern: /\b(deploy|docker|container|k8s|kubernetes)\b/i, tools: ['shell_execute'] },
    { pattern: /\b(browse|website|url|http|scrape)\b/i, tools: ['browser'] },
];
function detectContextPromotions(goal, registryTools) {
    const registryNames = new Set(registryTools.map((t) => t.name));
    const promotions = [];
    for (const { pattern, tools } of CONTEXT_PROMOTED_TOOLS) {
        if (pattern.test(goal)) {
            for (const toolName of tools) {
                if (registryNames.has(toolName) && !promotions.includes(toolName)) {
                    promotions.push(toolName);
                }
            }
        }
    }
    return promotions;
}
/**
 * Build a compact text summary of the tool registry (Tier 2 tools).
 * This is injected into the system prompt so the LLM knows what tools exist
 * without paying the full schema cost.
 */
function buildRegistrySummary(registry) {
    if (registry.length === 0)
        return '';
    const lines = [
        '## Additional Tools (available on request)',
        'The following tools are available but not loaded. To use one, call `request_tool` with the tool name.',
        '',
    ];
    // Group by category
    const byCategory = new Map();
    for (const tool of registry) {
        const cat = tool.category;
        if (!byCategory.has(cat))
            byCategory.set(cat, []);
        byCategory.get(cat).push(tool);
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
function truncateDescription(desc, maxLen) {
    if (desc.length <= maxLen)
        return desc;
    const truncated = desc.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > maxLen * 0.6 ? truncated.substring(0, lastSpace) : truncated) + '…';
}
/**
 * Estimate the token cost of tool schemas.
 * Useful for logging and metrics.
 */
function estimateToolTokenCost(tools) {
    var _a, _b, _c, _d, _e;
    let totalChars = 0;
    for (const tool of tools) {
        totalChars += (_b = (_a = tool.name) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
        totalChars += (_d = (_c = tool.description) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0;
        totalChars += JSON.stringify((_e = tool.inputSchema) !== null && _e !== void 0 ? _e : {}).length;
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
/**
 * Calculate metrics for a two-tier tool layout.
 * Useful for logging cost savings.
 */
function calculateTierMetrics(tier, allToolsCount) {
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
