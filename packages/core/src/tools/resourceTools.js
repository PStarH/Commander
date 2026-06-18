"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemResourceTool = exports.MediaResourceTool = exports.ExecResourceTool = exports.HandoffResourceTool = exports.CheckpointResourceTool = exports.CodeResourceTool = exports.BrowserResourceTool = exports.WebResourceTool = exports.MemoryResourceTool = exports.FileResourceTool = void 0;
exports.createResourceTools = createResourceTools;
exports.wireResourceToolDependencies = wireResourceToolDependencies;
const fileSystemTool_1 = require("./fileSystemTool");
const persistenceTool_1 = require("./persistenceTool");
const webSearchTool_1 = require("./webSearchTool");
const browserTool_1 = require("./browserTool");
const codeSearchTool_1 = require("./codeSearchTool");
const codeRefinerTool_1 = require("./codeRefinerTool");
const codeFixer_1 = require("./codeFixer");
const checkpointTool_1 = require("./checkpointTool");
const handoffTool_1 = require("./handoffTool");
const codeExecutionTool_1 = require("./codeExecutionTool");
const scriptTool_1 = require("./scriptTool");
const visionTool_1 = require("./multimodal/visionTool");
const pdfTool_1 = require("./multimodal/pdfTool");
const screenshotTool_1 = require("./multimodal/screenshotTool");
const requestHumanInputTool_1 = require("./requestHumanInputTool");
const requestToolTool_1 = require("./requestToolTool");
function normalizeToolResult(result) {
    var _a, _b, _c;
    if (typeof result === 'string')
        return result;
    if (result && typeof result === 'object') {
        const r = result;
        return (_c = (_b = (_a = r.output) !== null && _a !== void 0 ? _a : r.error) !== null && _b !== void 0 ? _b : r.content) !== null && _c !== void 0 ? _c : JSON.stringify(result);
    }
    return String(result !== null && result !== void 0 ? result : '');
}
function buildInputSchema(actions) {
    const actionEnum = Object.keys(actions);
    const mergedProperties = {
        action: {
            type: 'string',
            enum: actionEnum,
            description: `The operation to perform. Valid: ${actionEnum.join(', ')}`,
        },
    };
    for (const [actionName, def] of Object.entries(actions)) {
        const params = def.params;
        for (const [k, v] of Object.entries(params)) {
            if (!mergedProperties[k]) {
                const desc = v.description || '';
                mergedProperties[k] = {
                    ...v,
                    description: `[action:${actionName}] ${desc}`,
                };
            }
        }
    }
    return {
        type: 'object',
        properties: mergedProperties,
        required: ['action'],
    };
}
async function executeResourceAction(actions, args, ctx) {
    var _a;
    const action = String((_a = args.action) !== null && _a !== void 0 ? _a : '');
    const def = actions[action];
    if (!def) {
        return `Error: Unknown action "${action}". Valid actions: ${Object.keys(actions).join(', ')}`;
    }
    try {
        return await def.handler(args, ctx);
    }
    catch (err) {
        return `Error executing ${action}: ${String(err)}`;
    }
}
// ============================================================================
// file — Consolidated file system operations
// ============================================================================
class FileResourceTool {
    constructor() {
        this.actions = {
            read: {
                description: 'Read the contents of a file',
                params: {
                    path: { type: 'string', description: 'Path to the file to read' },
                    maxChars: { type: 'number', description: 'Maximum characters to return' },
                    offset: { type: 'number', description: 'Start at this line number (1-indexed)' },
                    limit: { type: 'number', description: 'Maximum number of lines to return' },
                },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.FileReadTool().execute(args)),
            },
            write: {
                description: 'Write content to a file (creates or overwrites)',
                params: {
                    path: { type: 'string', description: 'Path to the file to write' },
                    content: { type: 'string', description: 'Content to write to the file' },
                },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.FileWriteTool().execute(args)),
            },
            edit: {
                description: 'Edit a file by replacing a specific string',
                params: {
                    path: { type: 'string', description: 'Path to the file to edit' },
                    oldString: { type: 'string', description: 'The exact string to replace' },
                    newString: { type: 'string', description: 'The replacement string' },
                },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.FileEditTool().execute(args)),
            },
            search: {
                description: 'Search for text patterns in files using ripgrep',
                params: {
                    pattern: { type: 'string', description: 'The search pattern (regex or literal)' },
                    path: { type: 'string', description: 'Optional directory path to search within' },
                },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.FileSearchTool().execute(args)),
            },
            list: {
                description: 'List files and directories in a path',
                params: { path: { type: 'string', description: 'Directory path to list' } },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.FileListTool().execute(args)),
            },
            glob: {
                description: 'Find files matching a glob pattern',
                params: { pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' } },
                handler: async (args) => normalizeToolResult(await new fileSystemTool_1.GlobTool().execute(args)),
            },
        };
        this.definition = {
            name: 'file',
            description: 'Interact with the file system: read, write, edit, search, list, glob. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'filesystem',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.FileResourceTool = FileResourceTool;
// ============================================================================
// memory — Consolidated memory/persistence operations
// ============================================================================
class MemoryResourceTool {
    constructor() {
        this.actions = {
            store: {
                description: 'Store a value in persistent memory',
                params: {
                    key: { type: 'string', description: 'Key to store under' },
                    value: { type: 'string', description: 'Value to store' },
                },
                handler: async (args) => normalizeToolResult(await new persistenceTool_1.MemoryStoreTool().execute(args)),
            },
            recall: {
                description: 'Recall a value from persistent memory by key',
                params: { key: { type: 'string', description: 'Key to look up' } },
                handler: async (args) => normalizeToolResult(await new persistenceTool_1.MemoryRecallTool().execute(args)),
            },
            list: {
                description: 'List all keys in persistent memory',
                params: {},
                handler: async (_args) => normalizeToolResult(await new persistenceTool_1.MemoryListTool().execute()),
            },
        };
        this.definition = {
            name: 'memory',
            description: 'Persistent key-value memory: store, recall, list keys. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'memory',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.MemoryResourceTool = MemoryResourceTool;
// ============================================================================
// web — Consolidated web operations
// ============================================================================
class WebResourceTool {
    constructor() {
        this.actions = {
            search: {
                description: 'Search the web for information',
                params: { query: { type: 'string', description: 'Search query' } },
                handler: async (args) => normalizeToolResult(await new webSearchTool_1.WebSearchTool().execute(args)),
            },
            fetch: {
                description: 'Fetch and extract readable content from a URL',
                params: { url: { type: 'string', description: 'URL to fetch' } },
                handler: async (args) => normalizeToolResult(await new webSearchTool_1.WebFetchTool().execute(args)),
            },
        };
        this.definition = {
            name: 'web',
            description: 'Search the web or fetch content from URLs. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'web',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.WebResourceTool = WebResourceTool;
// ============================================================================
// browser — Consolidated browser automation operations
// ============================================================================
class BrowserResourceTool {
    constructor() {
        this.actions = {
            search: {
                description: 'Search the web using a browser',
                params: { query: { type: 'string', description: 'Search query' } },
                handler: async (args) => normalizeToolResult(await new browserTool_1.BrowserSearchTool().execute(args)),
            },
            fetch: {
                description: 'Fetch a web page in a browser and extract content',
                params: { url: { type: 'string', description: 'URL to navigate to' } },
                handler: async (args) => normalizeToolResult(await new browserTool_1.BrowserFetchTool().execute(args)),
            },
        };
        this.definition = {
            name: 'browser',
            description: 'Control a browser to search the web or fetch pages. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'web',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.BrowserResourceTool = BrowserResourceTool;
// ============================================================================
// code — Consolidated code analysis and manipulation operations
// ============================================================================
class CodeResourceTool {
    constructor() {
        this.actions = {
            search: {
                description: 'Search codebase for symbols, definitions, and references',
                params: {
                    query: { type: 'string', description: 'Search query (symbol name, function, class, etc.)' },
                },
                handler: async (args) => normalizeToolResult(await new codeSearchTool_1.CodeSearchTool().execute(args)),
            },
            refine: {
                description: 'Refactor or optimize code according to a prompt',
                params: {
                    path: { type: 'string', description: 'Path to the file to refine' },
                    instructions: { type: 'string', description: 'Instructions for the refinement' },
                },
                handler: async (args) => normalizeToolResult(await new codeRefinerTool_1.CodeRefinerTool().execute(args)),
            },
            fix: {
                description: 'Fix syntax errors in a code file',
                params: { path: { type: 'string', description: 'Path to the file with errors' } },
                handler: async (args) => normalizeToolResult(await new codeFixer_1.CodeFixerTool().execute(args)),
            },
        };
        this.definition = {
            name: 'code',
            description: 'Search, refine, and fix code. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'code',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.CodeResourceTool = CodeResourceTool;
// ============================================================================
// checkpoint — Consolidated checkpoint/rewind operations
// ============================================================================
class CheckpointResourceTool {
    constructor() {
        this.actions = {
            save: {
                description: 'Save a checkpoint of the current conversation state',
                params: {
                    label: { type: 'string', description: 'Human-readable label for this checkpoint' },
                    messages: {
                        type: 'array',
                        description: 'Current conversation messages',
                        items: { type: 'object' },
                    },
                    stepNumber: { type: 'number', description: 'Current step number' },
                    filesRead: { type: 'array', description: 'Files read so far', items: { type: 'string' } },
                    filesModified: {
                        type: 'array',
                        description: 'Files modified so far',
                        items: { type: 'string' },
                    },
                },
                handler: async (args) => normalizeToolResult(await new checkpointTool_1.CheckpointSaveTool().execute(args)),
            },
            rewind: {
                description: 'Rewind to a previous checkpoint',
                params: {
                    checkpointId: { type: 'string', description: 'Checkpoint ID from checkpoint save' },
                },
                handler: async (args) => normalizeToolResult(await new checkpointTool_1.CheckpointRewindTool().execute(args)),
            },
            list: {
                description: 'List all saved checkpoints',
                params: {},
                handler: async (_args) => normalizeToolResult(await new checkpointTool_1.CheckpointListTool().execute({})),
            },
            collapse: {
                description: 'Collapse a checkpoint into a concise summary',
                params: { checkpointId: { type: 'string', description: 'Checkpoint ID to collapse' } },
                handler: async (args) => normalizeToolResult(await new checkpointTool_1.CheckpointCollapseTool().execute(args)),
            },
        };
        this.definition = {
            name: 'checkpoint',
            description: 'Save, rewind, list, and collapse conversation checkpoints. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'workflow',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.CheckpointResourceTool = CheckpointResourceTool;
// ============================================================================
// handoff — Consolidated agent-to-agent handoff operations
// ============================================================================
class HandoffResourceTool {
    setHandoff(handoff, agentId) {
        this.handoff = handoff;
        if (agentId)
            this.agentId = agentId;
    }
    constructor() {
        this.agentId = 'agent';
        this.actions = {
            send: {
                description: 'Hand off the current task to another agent',
                params: {
                    toAgent: { type: 'string', description: 'Target agent ID or name' },
                    goal: { type: 'string', description: 'What the target agent should accomplish' },
                    context: {
                        type: 'string',
                        description: 'Additional context (current progress, findings, constraints)',
                    },
                    tokenBudget: {
                        type: 'number',
                        description: 'Token budget for the target agent (default: 25000)',
                    },
                },
                handler: async (args) => {
                    if (!this.handoff)
                        return 'Error: Handoff infrastructure not available';
                    return normalizeToolResult(await new handoffTool_1.HandoffTool(this.handoff, this.agentId).execute(args));
                },
            },
            check: {
                description: 'Check the status of a pending handoff',
                params: {
                    handoffId: { type: 'string', description: 'The handoff ID returned by handoff send' },
                },
                handler: async (args) => {
                    if (!this.handoff)
                        return 'Error: Handoff infrastructure not available';
                    return normalizeToolResult(await new handoffTool_1.HandoffCheckTool(this.handoff).execute(args));
                },
            },
        };
        this.definition = {
            name: 'handoff',
            description: 'Hand off tasks to another agent or check handoff status. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'development',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.HandoffResourceTool = HandoffResourceTool;
// ============================================================================
// exec — Consolidated code execution operations
// ============================================================================
class ExecResourceTool {
    setTools(tools) {
        this.toolMap = new Map();
        for (const [name, tool] of tools) {
            this.toolMap.set(name, (args) => Promise.resolve(tool.execute(args)).then(normalizeToolResult));
        }
        this.scriptTool.setTools(this.toolMap);
    }
    constructor() {
        this.scriptTool = new scriptTool_1.ExecuteScriptTool();
        this.toolMap = new Map();
        this.actions = {
            python: {
                description: 'Execute Python code in a sandboxed environment',
                params: {
                    code: { type: 'string', description: 'Python code to execute' },
                    timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
                },
                handler: async (args) => normalizeToolResult(await new codeExecutionTool_1.PythonExecuteTool().execute(args)),
            },
            shell: {
                description: 'Execute a shell command in a sandboxed environment',
                params: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 120)' },
                    workdir: {
                        type: 'string',
                        description: 'Working directory relative to workspace (default: ".")',
                    },
                    backend: {
                        type: 'string',
                        enum: ['local', 'ssh', 'docker'],
                        description: 'Execution backend (default: local)',
                    },
                },
                handler: async (args) => normalizeToolResult(await new codeExecutionTool_1.ShellExecuteTool().execute(args)),
            },
            script: {
                description: 'Execute a JavaScript script that calls other tools programmatically via `tools.toolName(args)`',
                params: {
                    script: { type: 'string', description: 'JavaScript code to execute' },
                    tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'List of tool names to make available in the script',
                    },
                    timeout: {
                        type: 'number',
                        description: 'Maximum execution time in seconds (default: 30, max: 120)',
                    },
                },
                handler: async (args) => normalizeToolResult(await this.scriptTool.execute(args)),
            },
        };
        this.definition = {
            name: 'exec',
            description: 'Execute Python, shell, or JavaScript scripts. Use `action` to choose the execution mode.',
            inputSchema: buildInputSchema(this.actions),
            category: 'code',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.ExecResourceTool = ExecResourceTool;
// ============================================================================
// media — Consolidated multimodal operations
// ============================================================================
class MediaResourceTool {
    constructor() {
        this.actions = {
            analyze_image: {
                description: 'Analyze an image file (screenshot, diagram, UI mockup, chart)',
                params: {
                    source: { type: 'string', description: 'File path to image or base64 data URL' },
                    prompt: { type: 'string', description: 'Optional specific question about the image' },
                    detail: {
                        type: 'string',
                        enum: ['low', 'high', 'auto'],
                        description: 'Detail level for vision processing',
                    },
                },
                handler: async (args) => normalizeToolResult(await new visionTool_1.VisionAnalyzeTool().execute(args)),
            },
            screenshot: {
                description: 'Capture a screenshot of the current screen, a window, or a URL',
                params: {
                    url: { type: 'string', description: 'URL to capture (optional)' },
                    outputPath: { type: 'string', description: 'Where to save the screenshot file' },
                    selector: { type: 'string', description: 'CSS selector to capture a specific element' },
                    width: { type: 'number', description: 'Viewport width in pixels' },
                    height: { type: 'number', description: 'Viewport height in pixels' },
                    fullPage: { type: 'boolean', description: 'Capture full page if true' },
                },
                handler: async (args) => normalizeToolResult(await new screenshotTool_1.ScreenshotCaptureTool().execute(args)),
            },
            extract_pdf: {
                description: 'Extract text content from a PDF file',
                params: {
                    path: { type: 'string', description: 'Path to the PDF file' },
                    pageStart: { type: 'number', description: 'First page to extract (1-indexed, default: 1)' },
                    pageEnd: { type: 'number', description: 'Last page to extract' },
                    maxChars: { type: 'number', description: 'Maximum characters to return' },
                },
                handler: async (args) => normalizeToolResult(await new pdfTool_1.PdfExtractTool().execute(args)),
            },
        };
        this.definition = {
            name: 'media',
            description: 'Analyze images, capture screenshots, and extract PDF text. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'multimodal',
        };
    }
    async execute(args) {
        return executeResourceAction(this.actions, args);
    }
}
exports.MediaResourceTool = MediaResourceTool;
// ============================================================================
// system — Consolidated control/meta operations
// ============================================================================
class SystemResourceTool {
    setToolResolver(resolver, registryTools) {
        this.requestToolResolver = resolver;
        if (registryTools)
            this.registryTools = registryTools;
    }
    constructor() {
        this.humanInputTool = (0, requestHumanInputTool_1.createRequestHumanInputTool)();
        this.registryTools = [];
        this.actions = {
            human_input: {
                description: 'Pause execution and request input from a human',
                params: {
                    reason: { type: 'string', description: 'Why you need human input' },
                    value: { description: 'Optional payload to present to the human' },
                },
                handler: async (args, ctx) => normalizeToolResult(await this.humanInputTool.execute(args, ctx)),
            },
            tool_schema: {
                description: 'Request the full schema of an available tool',
                params: { tool_name: { type: 'string', description: 'Name of the tool to request' } },
                handler: async (args) => {
                    if (!this.requestToolResolver) {
                        return 'Error: Tool schema resolver not available';
                    }
                    const requestTool = (0, requestToolTool_1.createRequestToolTool)(this.requestToolResolver, this.registryTools);
                    return normalizeToolResult(await requestTool.execute(args));
                },
            },
        };
        this.definition = {
            name: 'system',
            description: 'Request human input or retrieve a tool schema on demand. Use `action` to choose the operation.',
            inputSchema: buildInputSchema(this.actions),
            category: 'control',
        };
    }
    async execute(args, ctx) {
        return executeResourceAction(this.actions, args, ctx);
    }
}
exports.SystemResourceTool = SystemResourceTool;
// ============================================================================
// Factory
// ============================================================================
function createResourceTools() {
    const tools = new Map();
    const instances = [
        ['file', new FileResourceTool()],
        ['memory', new MemoryResourceTool()],
        ['web', new WebResourceTool()],
        ['browser', new BrowserResourceTool()],
        ['code', new CodeResourceTool()],
        ['checkpoint', new CheckpointResourceTool()],
        ['handoff', new HandoffResourceTool()],
        ['exec', new ExecResourceTool()],
        ['media', new MediaResourceTool()],
        ['system', new SystemResourceTool()],
    ];
    for (const [name, tool] of instances) {
        tools.set(name, tool);
    }
    return tools;
}
/**
 * Wire runtime dependencies for resource tools that need them.
 * Call after all tools are registered with the runtime.
 */
function wireResourceToolDependencies(tools, deps) {
    var _a;
    const handoffTool = tools.get('handoff');
    if (handoffTool && handoffTool instanceof HandoffResourceTool && deps.handoff) {
        handoffTool.setHandoff(deps.handoff.handoff, deps.handoff.agentId);
    }
    const execTool = tools.get('exec');
    if (execTool && execTool instanceof ExecResourceTool) {
        execTool.setTools(tools);
    }
    const systemTool = tools.get('system');
    if (systemTool && systemTool instanceof SystemResourceTool) {
        systemTool.setToolResolver((_a = deps.toolResolver) !== null && _a !== void 0 ? _a : (() => undefined), deps.registryTools);
    }
}
