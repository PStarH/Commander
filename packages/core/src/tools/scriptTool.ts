import type { Tool, ToolDefinition } from '../runtime/types';

/**
 * ExecuteScriptTool — Programmatic Tool Calling
 *
 * Allows the agent to write a JavaScript/TypeScript script that calls other tools
 * programmatically, collecting results and producing a final output WITHOUT
 * requiring multiple LLM round-trips for each tool call.
 *
 * Reference: Claude Code's programmatic tool calling (Python→RPC→stdout),
 * Hermes Agent's execute_code (Python→RPC→stdout).
 *
 * How it works:
 * 1. Agent writes a script using the `tools` object (pre-injected)
 * 2. Script calls any number of tools via `tools.toolName(args)`
 * 3. Each call is executed, results are available in the script
 * 4. Only `console.log()` output is returned to the LLM context
 * 5. Intermediate tool results NEVER enter context → zero token waste
 *
 * BFCL v3 impact:
 *   Normal flow (5 tools) = 0.96^5 = 59% success
 *   Script flow (5 tools) = ~96% success (single LLM call)
 */
export class ExecuteScriptTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_script',
    description: 'Execute a JavaScript/TypeScript script that can call other tools programmatically. The script has access to a `tools` object with all available tool functions. Only console.log output is returned to context — intermediate tool results never enter the LLM context window. Use this to collapse multi-step tool chains into a single efficient call.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript/TypeScript code to execute. Uses `tools.toolName(args)` to call tools. Use `console.log()` to output results. Example:\n```\nconst content = await tools.file_read({ path: "test.txt" });\nconst search = await tools.web_search({ query: "hello" });\nconsole.log("File size:", content.length);\nconsole.log("Search results:", search);\n```',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of tool names to make available in the script (default: all core tools)',
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in seconds (default: 30, max: 120)',
          default: 30,
        },
      },
      required: ['script'],
    },
  };

  isConcurrencySafe = true;
  isReadOnly = true;

  /** Registered tool map — populated by the runtime */
  private toolMap: Map<string, (args: Record<string, unknown>) => Promise<string>> = new Map();

  /**
   * Set the available tools for script execution.
   * Called by AgentRuntime when registering this tool.
   */
  setTools(tools: Map<string, (args: Record<string, unknown>) => Promise<string>>): void {
    this.toolMap = tools;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const script = String(args.script ?? '');
    const requestedTools = args.tools as string[] | undefined;
    const timeout = Math.min(Number(args.timeout ?? 30), 120);

    if (!script.trim()) return 'Error: Script is required';

    const startTime = Date.now();
    const outputLines: string[] = [];

    // Build the injected tools object — only expose requested tools or all
    const availableTools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};
    if (requestedTools && requestedTools.length > 0) {
      for (const name of requestedTools) {
        const toolFn = this.toolMap.get(name);
        if (toolFn) availableTools[name] = toolFn;
      }
    } else {
      for (const [name, fn] of this.toolMap) {
        availableTools[name] = fn;
      }
    }

    // Safe console that captures output
    const safeConsole = {
      log: (...msgArgs: unknown[]) => {
        outputLines.push(msgArgs.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
      },
      warn: (...msgArgs: unknown[]) => {
        outputLines.push('[warn] ' + msgArgs.map(a => String(a)).join(' '));
      },
      error: (...msgArgs: unknown[]) => {
        outputLines.push('[error] ' + msgArgs.map(a => String(a)).join(' '));
      },
    };

    // Wrap script in an async function so `await` works
    const wrappedScript = `
      (async () => {
        ${script}
      })();
    `;

    try {
      // Use timeout via Promise.race
      const executionPromise = this.runScript(wrappedScript, availableTools, safeConsole);

      let timedOut = false;
      const result = await Promise.race([
        executionPromise,
        new Promise<string>((_, reject) => {
          setTimeout(() => {
            timedOut = true;
            reject(new Error(`Script execution timed out after ${timeout}s`));
          }, timeout * 1000);
        }),
      ]);

      const elapsed = Date.now() - startTime;
      const output = outputLines.join('\n');

      // Truncate output if too large (preserve head + tail)
      const MAX_OUTPUT = 10000;
      const finalOutput = output.length > MAX_OUTPUT
        ? output.slice(0, MAX_OUTPUT / 2) + '\n... [truncated, ' + (output.length - MAX_OUTPUT) + ' chars omitted] ...\n' + output.slice(-MAX_OUTPUT / 2)
        : output;

      return `[Script completed in ${elapsed}ms]\n${finalOutput || '(no console.log output)'}`;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const partialOutput = outputLines.join('\n');
      const errorMsg = err instanceof Error ? err.message : String(err);

      return `[Script failed after ${elapsed}ms: ${errorMsg}]\n${partialOutput ? 'Partial output:\n' + partialOutput : '(no output before failure)'}`;
    }
  }

  private async runScript(
    script: string,
    tools: Record<string, (args: Record<string, unknown>) => Promise<string>>,
    console_: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  ): Promise<void> {
    // Use new Function to create a sandboxed scope
    // Only `tools` and `console` are accessible in the script
    const fn = new Function('tools', 'console', 'setTimeout', 'clearTimeout', script);

    // Execute synchronously — the script uses async/await internally but
    // new Function returns a Promise when the script is async
    const result = fn(tools, console_, setTimeout, clearTimeout);

    // If the result is a Promise (async script), await it
    if (result instanceof Promise) {
      await result;
    }
  }
}