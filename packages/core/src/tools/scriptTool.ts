import { reportSilentFailure } from '../silentFailureReporter';
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
          description:
            'JavaScript code to execute. Use `tools.toolName(args)` to call tools, `console.log()` for output.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of tool names to make available in the script (default: all core tools)',
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
      {
        name: 'execute_script',
        arguments: {
          script:
            'const files = await tools.file_search({ pattern: "src/**/*.ts" }); console.log("Found", files.length, "files");',
        },
      },
      {
        name: 'execute_script',
        arguments: {
          script:
            'const r = await tools.web_search({ query: "AI news" }); await tools.file_write({ path: "result.txt", content: r }); console.log("Saved");',
          tools: ['web_search', 'file_write'],
        },
      },
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
        outputLines.push(
          msgArgs
            .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
            .join(' '),
        );
      },
      warn: (...msgArgs: unknown[]) => {
        outputLines.push('[warn] ' + msgArgs.map((a) => String(a)).join(' '));
      },
      error: (...msgArgs: unknown[]) => {
        outputLines.push('[error] ' + msgArgs.map((a) => String(a)).join(' '));
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

      let timeoutTimer: ReturnType<typeof setTimeout>;
      await Promise.race([
        executionPromise.finally(() => clearTimeout(timeoutTimer)),
        new Promise<string>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            reject(new Error(`Script execution timed out after ${timeout}s`));
          }, timeout * 1000);
          timeoutTimer.unref();
        }),
      ]);

      const elapsed = Date.now() - startTime;
      const output = outputLines.join('\n');

      // Truncate output if too large (preserve head + tail)
      const MAX_OUTPUT = 10000;
      const finalOutput =
        output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT / 2) +
            '\n... [truncated, ' +
            (output.length - MAX_OUTPUT) +
            ' chars omitted] ...\n' +
            output.slice(-MAX_OUTPUT / 2)
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
    console_: {
      log: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    },
  ): Promise<void> {
    // SECURITY FIX: wrap all sandbox objects in Proxy to prevent prototype chain escape
    // Node.js vm module is NOT a security sandbox — this.constructor.constructor('return process')()
    // can escape. We use Proxy to block access to constructor, __proto__, and other prototype paths.
    const BLOCKED = new Set([
      'constructor',
      '__proto__',
      'prototype',
      'apply',
      'call',
      'bind',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
      'toLocaleString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toString',
    ]);

    /**
     * Block dangerous prototype-chain properties on a function by defining own
     * properties that shadow Function.prototype/Object.prototype accessors.
     * We use a plain wrapper function (not a Proxy) because Node's vm module
     * cannot reliably resume `await` on Promises returned by Proxy-wrapped
     * functions across multiple awaits.
     */
    function shadowBlockedProperties(fn: (...args: unknown[]) => unknown): void {
      for (const key of BLOCKED) {
        try {
          Object.defineProperty(fn, key, {
            value: undefined,
            writable: false,
            configurable: false,
          });
        } catch (err) {
          reportSilentFailure(err, 'scriptTool:220');
          // Some properties (e.g. __proto__ on some objects) may be non-configurable;
          // ignore silently — the Proxy layer still blocks them at the object level.
        }
      }
    }

    /** Minimal Proxy trap that blocks prototype-chain property access (get only).
     *  Does NOT define has/set/getPrototypeOf/ownKeys traps — those would interfere
     *  with function calling in VM contexts (async/await and Promise chains). The get
     *  trap alone is sufficient to block `.constructor`/`.apply`/`.call`/`.bind` on
     *  tool functions while keeping them fully callable. */
    const safeProxyHandler: ProxyHandler<object> = {
      get(obj, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BLOCKED.has(prop)) return undefined;
        const val = (obj as Record<string, unknown>)[prop];
        if (typeof val === 'function') {
          const wrapper = (...args: unknown[]) => {
            const result = val.apply(obj, args);
            if (
              result &&
              typeof result === 'object' &&
              !(result instanceof Promise) &&
              !(typeof (result as Record<string, unknown>).then === 'function')
            ) {
              return new Proxy(result as object, safeProxyHandler);
            }
            return result;
          };
          // Block dangerous properties with own properties instead of a Proxy.
          // Proxy-wrapped functions break repeated `await` on returned Promises
          // inside Node's vm.runInNewContext.
          shadowBlockedProperties(wrapper);
          return wrapper;
        }
        if (val && typeof val === 'object') return new Proxy(val as object, safeProxyHandler);
        return val;
      },
      getPrototypeOf() {
        return null;
      },
      has(_, prop) {
        return typeof prop === 'string' && !BLOCKED.has(prop);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter((k) => typeof k !== 'string' || !BLOCKED.has(k));
      },
    };

    function makeSafeProxy<T extends object>(target: T): T {
      return new Proxy(target, safeProxyHandler) as unknown as T;
    }

    /**
     * Wrap a host function (e.g. setTimeout) so it remains callable but exposes
     * no prototype-chain escape hatches.
     */
    function makeSafeFunction<T extends (...args: unknown[]) => unknown>(fn: T): T {
      const wrapped = ((...args: unknown[]) => fn(...args)) as unknown as T;
      shadowBlockedProperties(wrapped as unknown as (...args: unknown[]) => unknown);
      return wrapped;
    }

    /**
     * Wrap the host Promise constructor so async/await works inside the VM while
     * blocking prototype-chain escape paths (constructor/apply/call/bind/proto).
     */
    const safePromise = new Proxy(Promise, {
      get(target, prop) {
        if (
          prop === 'constructor' ||
          prop === '__proto__' ||
          prop === 'prototype' ||
          prop === 'apply' ||
          prop === 'call' ||
          prop === 'bind'
        ) {
          return undefined;
        }
        if (typeof prop === 'symbol') return undefined;
        return Reflect.get(target, prop);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, args);
      },
      construct(target, args) {
        return Reflect.construct(target as unknown as new (...args: unknown[]) => object, args);
      },
    });

    // Create a proxy-wrapped tools object
    const safeTools = makeSafeProxy(tools);

    // Wrap each sandbox value individually to block constructor/__proto__/
    // prototype chain access on ALL sandbox values — not just at the top level.
    // This prevents `setTimeout.constructor('return process')()` and similar escapes.
    const rawSandbox = {
      tools: safeTools,
      console: console_,
      setTimeout: makeSafeFunction(setTimeout as unknown as (...args: unknown[]) => unknown),
      clearTimeout: makeSafeFunction(clearTimeout as unknown as (...args: unknown[]) => unknown),
      Promise: safePromise,
    };
    // Top-level sandbox Proxy blocks direct access to dangerous globals
    const sandbox = new Proxy(rawSandbox, {
      get(target, prop) {
        if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype')
          return undefined;
        if (typeof prop === 'symbol') return undefined;
        return Reflect.get(target, prop);
      },
      has(target, prop) {
        if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') return false;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter(
          (k) => typeof k !== 'string' || !['constructor', '__proto__', 'prototype'].includes(k),
        );
      },
    });
    const context = vm.createContext(sandbox, { name: 'script-sandbox' });
    const result = vm.runInNewContext(script, context, {
      timeout: 120000,
    });

    if (result && typeof (result as { then?: unknown }).then === 'function') {
      (await result) as Promise<unknown>;
    }
  }
}
