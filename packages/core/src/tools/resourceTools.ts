/**
 * STRAP-Consolidated Resource Tools
 *
 * Single Tool Resource Action Pattern (STRAP):
 * Instead of one tool per CRUD operation, define domain-level resource tools
 * with an `action` parameter. This reduces tool count by 80–90% and directly
 * addresses the semantic confusion problem (Section 2.3 of the Synthesis doc).
 *
 * Resource domains consolidated:
 *   - file       → file_read, file_write, file_edit, file_search, file_list, glob
 *   - memory     → memory_store, memory_recall, memory_list
 *   - web        → web_search, web_fetch
 *   - browser    → browser_search, browser_fetch
 *   - code       → code_search, refine_code, fix_code
 *   - checkpoint → checkpoint_save, checkpoint_rewind, checkpoint_list, checkpoint_collapse
 *   - handoff    → handoff, handoff_check
 *   - exec       → python_execute, shell_execute, execute_script
 *   - media      → vision_analyze, screenshot_capture, pdf_extract
 *   - system     → request_human_input, request_tool
 */
import type { Tool, ToolDefinition, AgentExecutionContext } from '../runtime/types';
import type { AgentHandoff } from '../runtime/agentHandoff';
import {
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FileSearchTool,
  FileListTool,
  GlobTool,
} from './fileSystemTool';
import { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
import { WebSearchTool, WebFetchTool } from './webSearchTool';
import { BrowserSearchTool, BrowserFetchTool } from './browserTool';
import { CodeSearchTool } from './codeSearchTool';
import { CodeRefinerTool } from './codeRefinerTool';
import { CodeFixerTool } from './codeFixer';
import {
  CheckpointSaveTool,
  CheckpointRewindTool,
  CheckpointListTool,
  CheckpointCollapseTool,
} from './checkpointTool';
import { HandoffTool, HandoffCheckTool } from './handoffTool';
import { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
import { ExecuteScriptTool } from './scriptTool';
import { VisionAnalyzeTool } from './multimodal/visionTool';
import { PdfExtractTool } from './multimodal/pdfTool';
import { ScreenshotCaptureTool } from './multimodal/screenshotTool';
import { createRequestHumanInputTool } from './requestHumanInputTool';
import { createRequestToolTool } from './requestToolTool';

// ============================================================================
// Helper utilities
// ============================================================================

interface ResourceActionDef {
  description: string;
  params: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: AgentExecutionContext) => Promise<string>;
}

function normalizeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as { output?: string; error?: string; content?: string };
    return r.output ?? r.error ?? r.content ?? JSON.stringify(result);
  }
  return String(result ?? '');
}

function buildInputSchema(actions: Record<string, ResourceActionDef>): Record<string, unknown> {
  const actionEnum = Object.keys(actions);

  const mergedProperties: Record<string, unknown> = {
    action: {
      type: 'string',
      enum: actionEnum,
      description: `The operation to perform. Valid: ${actionEnum.join(', ')}`,
    },
  };

  for (const [actionName, def] of Object.entries(actions)) {
    const params = def.params as Record<string, unknown>;
    for (const [k, v] of Object.entries(params)) {
      if (!mergedProperties[k]) {
        const desc = (v as Record<string, unknown>).description || '';
        mergedProperties[k] = {
          ...(v as object),
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

async function executeResourceAction(
  actions: Record<string, ResourceActionDef>,
  args: Record<string, unknown>,
  ctx?: AgentExecutionContext,
): Promise<string> {
  const action = String(args.action ?? '');
  const def = actions[action];
  if (!def) {
    return `Error: Unknown action "${action}". Valid actions: ${Object.keys(actions).join(', ')}`;
  }
  try {
    return await def.handler(args, ctx);
  } catch (err) {
    return `Error executing ${action}: ${String(err)}`;
  }
}

// ============================================================================
// file — Consolidated file system operations
// ============================================================================

export class FileResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
    read: {
      description: 'Read the contents of a file',
      params: {
        path: { type: 'string', description: 'Path to the file to read' },
        maxChars: { type: 'number', description: 'Maximum characters to return' },
        offset: { type: 'number', description: 'Start at this line number (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
      },
      handler: async (args) => normalizeToolResult(await new FileReadTool().execute(args)),
    },
    write: {
      description: 'Write content to a file (creates or overwrites)',
      params: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      handler: async (args) => normalizeToolResult(await new FileWriteTool().execute(args)),
    },
    edit: {
      description: 'Edit a file by replacing a specific string',
      params: {
        path: { type: 'string', description: 'Path to the file to edit' },
        oldString: { type: 'string', description: 'The exact string to replace' },
        newString: { type: 'string', description: 'The replacement string' },
      },
      handler: async (args) => normalizeToolResult(await new FileEditTool().execute(args)),
    },
    search: {
      description: 'Search for text patterns in files using ripgrep',
      params: {
        pattern: { type: 'string', description: 'The search pattern (regex or literal)' },
        path: { type: 'string', description: 'Optional directory path to search within' },
      },
      handler: async (args) => normalizeToolResult(await new FileSearchTool().execute(args)),
    },
    list: {
      description: 'List files and directories in a path',
      params: { path: { type: 'string', description: 'Directory path to list' } },
      handler: async (args) => normalizeToolResult(await new FileListTool().execute(args)),
    },
    glob: {
      description: 'Find files matching a glob pattern',
      params: { pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' } },
      handler: async (args) => normalizeToolResult(await new GlobTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'file',
      description:
        'Interact with the file system: read, write, edit, search, list, glob. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'filesystem',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// memory — Consolidated memory/persistence operations
// ============================================================================

export class MemoryResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
    store: {
      description: 'Store a value in persistent memory',
      params: {
        key: { type: 'string', description: 'Key to store under' },
        value: { type: 'string', description: 'Value to store' },
      },
      handler: async (args) => normalizeToolResult(await new MemoryStoreTool().execute(args)),
    },
    recall: {
      description: 'Recall a value from persistent memory by key',
      params: { key: { type: 'string', description: 'Key to look up' } },
      handler: async (args) => normalizeToolResult(await new MemoryRecallTool().execute(args)),
    },
    list: {
      description: 'List all keys in persistent memory',
      params: {},
      handler: async (_args) => normalizeToolResult(await new MemoryListTool().execute()),
    },
  };

  constructor() {
    this.definition = {
      name: 'memory',
      description:
        'Persistent key-value memory: store, recall, list keys. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'memory',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// web — Consolidated web operations
// ============================================================================

export class WebResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
    search: {
      description: 'Search the web for information',
      params: { query: { type: 'string', description: 'Search query' } },
      handler: async (args) => normalizeToolResult(await new WebSearchTool().execute(args)),
    },
    fetch: {
      description: 'Fetch and extract readable content from a URL',
      params: { url: { type: 'string', description: 'URL to fetch' } },
      handler: async (args) => normalizeToolResult(await new WebFetchTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'web',
      description:
        'Search the web or fetch content from URLs. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'web',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// browser — Consolidated browser automation operations
// ============================================================================

export class BrowserResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
    search: {
      description: 'Search the web using a browser',
      params: { query: { type: 'string', description: 'Search query' } },
      handler: async (args) => normalizeToolResult(await new BrowserSearchTool().execute(args)),
    },
    fetch: {
      description: 'Fetch a web page in a browser and extract content',
      params: { url: { type: 'string', description: 'URL to navigate to' } },
      handler: async (args) => normalizeToolResult(await new BrowserFetchTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'browser',
      description:
        'Control a browser to search the web or fetch pages. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'web',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// code — Consolidated code analysis and manipulation operations
// ============================================================================

export class CodeResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
    search: {
      description: 'Search codebase for symbols, definitions, and references',
      params: {
        query: { type: 'string', description: 'Search query (symbol name, function, class, etc.)' },
      },
      handler: async (args) => normalizeToolResult(await new CodeSearchTool().execute(args)),
    },
    refine: {
      description: 'Refactor or optimize code according to a prompt',
      params: {
        path: { type: 'string', description: 'Path to the file to refine' },
        instructions: { type: 'string', description: 'Instructions for the refinement' },
      },
      handler: async (args) => normalizeToolResult(await new CodeRefinerTool().execute(args)),
    },
    fix: {
      description: 'Fix syntax errors in a code file',
      params: { path: { type: 'string', description: 'Path to the file with errors' } },
      handler: async (args) => normalizeToolResult(await new CodeFixerTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'code',
      description: 'Search, refine, and fix code. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'code',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// checkpoint — Consolidated checkpoint/rewind operations
// ============================================================================

export class CheckpointResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
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
      handler: async (args) => normalizeToolResult(await new CheckpointSaveTool().execute(args)),
    },
    rewind: {
      description: 'Rewind to a previous checkpoint',
      params: {
        checkpointId: { type: 'string', description: 'Checkpoint ID from checkpoint save' },
      },
      handler: async (args) => normalizeToolResult(await new CheckpointRewindTool().execute(args)),
    },
    list: {
      description: 'List all saved checkpoints',
      params: {},
      handler: async (_args) => normalizeToolResult(await new CheckpointListTool().execute({})),
    },
    collapse: {
      description: 'Collapse a checkpoint into a concise summary',
      params: { checkpointId: { type: 'string', description: 'Checkpoint ID to collapse' } },
      handler: async (args) =>
        normalizeToolResult(await new CheckpointCollapseTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'checkpoint',
      description:
        'Save, rewind, list, and collapse conversation checkpoints. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'workflow',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// handoff — Consolidated agent-to-agent handoff operations
// ============================================================================

export class HandoffResourceTool implements Tool {
  definition: ToolDefinition;
  private handoff?: AgentHandoff;
  private agentId = 'agent';

  setHandoff(handoff: AgentHandoff, agentId?: string): void {
    this.handoff = handoff;
    if (agentId) this.agentId = agentId;
  }

  private actions: Record<string, ResourceActionDef> = {
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
        if (!this.handoff) return 'Error: Handoff infrastructure not available';
        return normalizeToolResult(await new HandoffTool(this.handoff, this.agentId).execute(args));
      },
    },
    check: {
      description: 'Check the status of a pending handoff',
      params: {
        handoffId: { type: 'string', description: 'The handoff ID returned by handoff send' },
      },
      handler: async (args) => {
        if (!this.handoff) return 'Error: Handoff infrastructure not available';
        return normalizeToolResult(await new HandoffCheckTool(this.handoff).execute(args));
      },
    },
  };

  constructor() {
    this.definition = {
      name: 'handoff',
      description:
        'Hand off tasks to another agent or check handoff status. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'development',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// exec — Consolidated code execution operations
// ============================================================================

export class ExecResourceTool implements Tool {
  definition: ToolDefinition;
  private scriptTool = new ExecuteScriptTool();
  private toolMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  setTools(tools: Map<string, Tool>): void {
    this.toolMap = new Map();
    for (const [name, tool] of tools) {
      this.toolMap.set(name, (args) =>
        Promise.resolve(tool.execute(args)).then(normalizeToolResult),
      );
    }
    this.scriptTool.setTools(this.toolMap);
  }

  private actions: Record<string, ResourceActionDef> = {
    python: {
      description: 'Execute Python code in a sandboxed environment',
      params: {
        code: { type: 'string', description: 'Python code to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      handler: async (args) => normalizeToolResult(await new PythonExecuteTool().execute(args)),
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
      handler: async (args) => normalizeToolResult(await new ShellExecuteTool().execute(args)),
    },
    script: {
      description:
        'Execute a JavaScript script that calls other tools programmatically via `tools.toolName(args)`',
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

  constructor() {
    this.definition = {
      name: 'exec',
      description:
        'Execute Python, shell, or JavaScript scripts. Use `action` to choose the execution mode.',
      inputSchema: buildInputSchema(this.actions),
      category: 'code',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// media — Consolidated multimodal operations
// ============================================================================

export class MediaResourceTool implements Tool {
  definition: ToolDefinition;

  private actions: Record<string, ResourceActionDef> = {
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
      handler: async (args) => normalizeToolResult(await new VisionAnalyzeTool().execute(args)),
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
      handler: async (args) => normalizeToolResult(await new ScreenshotCaptureTool().execute(args)),
    },
    extract_pdf: {
      description: 'Extract text content from a PDF file',
      params: {
        path: { type: 'string', description: 'Path to the PDF file' },
        pageStart: { type: 'number', description: 'First page to extract (1-indexed, default: 1)' },
        pageEnd: { type: 'number', description: 'Last page to extract' },
        maxChars: { type: 'number', description: 'Maximum characters to return' },
      },
      handler: async (args) => normalizeToolResult(await new PdfExtractTool().execute(args)),
    },
  };

  constructor() {
    this.definition = {
      name: 'media',
      description:
        'Analyze images, capture screenshots, and extract PDF text. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'multimodal',
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    return executeResourceAction(this.actions, args);
  }
}

// ============================================================================
// system — Consolidated control/meta operations
// ============================================================================

export class SystemResourceTool implements Tool {
  definition: ToolDefinition;
  private humanInputTool = createRequestHumanInputTool();
  private requestToolResolver: ((name: string) => ToolDefinition | undefined) | undefined;
  private registryTools: string[] = [];

  setToolResolver(
    resolver: (name: string) => ToolDefinition | undefined,
    registryTools?: string[],
  ): void {
    this.requestToolResolver = resolver;
    if (registryTools) this.registryTools = registryTools;
  }

  private actions: Record<string, ResourceActionDef> = {
    human_input: {
      description: 'Pause execution and request input from a human',
      params: {
        reason: { type: 'string', description: 'Why you need human input' },
        value: { description: 'Optional payload to present to the human' },
      },
      handler: async (args, ctx) =>
        normalizeToolResult(await this.humanInputTool.execute(args, ctx)),
    },
    tool_schema: {
      description: 'Request the full schema of an available tool',
      params: { tool_name: { type: 'string', description: 'Name of the tool to request' } },
      handler: async (args) => {
        if (!this.requestToolResolver) {
          return 'Error: Tool schema resolver not available';
        }
        const requestTool = createRequestToolTool(this.requestToolResolver, this.registryTools);
        return normalizeToolResult(await requestTool.execute(args));
      },
    },
  };

  constructor() {
    this.definition = {
      name: 'system',
      description:
        'Request human input or retrieve a tool schema on demand. Use `action` to choose the operation.',
      inputSchema: buildInputSchema(this.actions),
      category: 'control',
    };
  }

  async execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string> {
    return executeResourceAction(this.actions, args, ctx);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createResourceTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const instances: [string, Tool][] = [
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
export function wireResourceToolDependencies(
  tools: Map<string, Tool>,
  deps: {
    handoff?: { handoff: AgentHandoff; agentId?: string };
    toolResolver?: (name: string) => ToolDefinition | undefined;
    registryTools?: string[];
  },
): void {
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
    systemTool.setToolResolver(deps.toolResolver ?? (() => undefined), deps.registryTools);
  }
}
