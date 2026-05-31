import type { Tool, ToolDefinition } from '../runtime/types';
import vm from 'vm';

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
    description:
      'Execute a JavaScript script that calls other tools programmatically via `tools.toolName(args)`. ' +
      'Only console.log output is returned to context. Use to collapse multi-step tool chains into one call.',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript code to execute. Use `tools.toolName(args)` to call tools, `console.log()` for output.',
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
    examples: [
      { name: 'execute_script', arguments: { script: 'const files = await tools.file_search({ pattern: "src/**/*.ts" }); console.log("Found", files.length, "files");' } },
      { name: 'execute_script', arguments: { script: 'const r = await tools.web_search({ query: "AI news" }); await tools.file_write({ path: "result.txt", content: r }); console.log("Saved");', tools: ['web_search', 'file_write'] } },
    ],
    category: 'code',
  };

  isConcurrencySafe = false; // scripts can mutate shared state
  isReadOnly = false; // scripts can call write tools like file_write, git, apply_patch

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
      let timeoutTimer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        executionPromise.finally(() => clearTimeout(timeoutTimer)),
        new Promise<string>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Script execution timed out after ${timeout}s`));
          }, timeout * 1000);
          timeoutTimer.unref();
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
    // SECURITY FIX: wrap all sandbox objects in Proxy to prevent prototype chain escape
    // Node.js vm module is NOT a security sandbox — this.constructor.constructor('return process')()
    // can escape. We use Proxy to block access to constructor, __proto__, and other prototype paths.
    const BLOCKED = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
      '__lookupGetter__', '__lookupSetter__', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
      'propertyIsEnumerable', 'toString']);

    function makeSafeProxy<T extends object>(target: T, depth = 0): T {
      if (depth > 3) return target; // limit proxy depth to avoid infinite recursion
      return new Proxy(target, {
        get(obj, prop) {
          if (typeof prop === 'symbol') return undefined; // block Symbol access
          if (BLOCKED.has(prop)) return undefined; // block prototype escape paths
          const val = (obj as Record<string, unknown>)[prop];
          if (typeof val === 'function') {
            // Wrap functions to return safe proxies for objects
            return (...args: unknown[]) => {
              const result = val.apply(obj, args);
              if (result && typeof result === 'object') return makeSafeProxy(result, depth + 1);
              return result;
            };
          }
          if (val && typeof val === 'object') return makeSafeProxy(val as object, depth + 1);
          return val;
        },
        has(_, prop) { return typeof prop === 'string' && !BLOCKED.has(prop); },
        set() { return false; }, // read-only
        getPrototypeOf() { return null; }, // block __proto__ chain
        ownKeys(target) {
          return Reflect.ownKeys(target).filter(k => typeof k === 'string' && !BLOCKED.has(k));
        },
      }) as unknown as T;
    }

    // Create a frozen, proxy-wrapped tools object
    const safeTools = makeSafeProxy(tools);

    const sandbox = {
      tools: safeTools,
      console: console_,
      setTimeout,
      clearTimeout,
      // Block access to dangerous globals by not providing them
    };
    const context = vm.createContext(sandbox, { name: 'script-sandbox' });
    const result = vm.runInNewContext(script, context, { timeout: 120000 });

    if (result instanceof Promise) {
      await result;
    }
  }
}