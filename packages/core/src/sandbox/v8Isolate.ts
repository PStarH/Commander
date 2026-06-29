/**
 * V8 Isolate Sandbox — Process-level memory isolation for untrusted code
 *
 * Uses the `isolated-vm` npm package to create true V8 Isolate-level
 * isolation: separate heap, separate GC, separate compiler, with
 * resource limits (heap size, execution timeout).
 *
 * This is the "V8-Level" isolation layer from Pillar III of the
 * architecture blueprint. It sits between the Node.js `vm` module
 * (which is NOT a security boundary) and OS-level sandboxes
 * (seccomp/TEE/Docker).
 *
 * Key properties:
 * - Separate heap: no shared mutable state between isolates
 * - Resource limits: maxHeapSize, timeoutMs enforced by V8
 * - Preemption: Isolate::TerminateExecution() for immediate kill
 * - Transferable data: only structured-cloneable data crosses boundary
 *
 * If `isolated-vm` is not installed, the module degrades gracefully
 * and `available` returns false. Callers should fall back to the
 * OS-level sandbox (Docker/seccomp) or reject the execution.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { ISandbox, ISandboxConfig, ISandboxResult, SandboxTier } from '../contracts/pillarIII';

// ============================================================================
// isolated-vm type declarations (minimal — full types in @types/isolated-vm)
// ============================================================================

interface IvmIsolate {
  createContext(): IvmContext;
  compileScript(code: string, options?: unknown): IvmScript;
  dispose(): void;
  getHeapStatistics(): { usedHeapSize: number; heapSizeLimit: number };
  cpuTime?: number;
  wallTime?: number;
}

interface IvmContext {
  global: {
    set(key: string, value: unknown, options?: unknown): void;
    get(key: string, options?: unknown): unknown;
    setSync(key: string, value: unknown, options?: unknown): void;
    getSync(key: string, options?: unknown): unknown;
  };
  eval(code: string, options?: unknown): Promise<unknown>;
  evalSync(code: string, options?: unknown): unknown;
  release(): void;
}

interface IvmScript {
  run(context: IvmContext, options?: unknown): Promise<unknown>;
  runSync(context: IvmContext, options?: unknown): unknown;
}

interface IvmExternalCopy {
  copyInto(): unknown;
}

interface IsolatedVmModule {
  Isolate: new (options?: { memoryLimit?: number; snapshot?: unknown }) => IvmIsolate;
  Context: unknown;
  Script: unknown;
  ExternalCopy: {
    copy(value: unknown): IvmExternalCopy;
  };
  Reference: new (fn: (...args: unknown[]) => unknown) => {
    apply(...args: unknown[]): Promise<unknown>;
    applySync(...args: unknown[]): unknown;
    deref(): unknown;
    dispose(): void;
  };
  Transferable: unknown;
}

// ============================================================================
// Module loading (optional dependency)
// ============================================================================

let isolatedVm: IsolatedVmModule | null = null;
let loadAttempted = false;

function loadIsolatedVm(): IsolatedVmModule | null {
  if (loadAttempted) return isolatedVm;
  loadAttempted = true;

  try {
    isolatedVm = require('isolated-vm');
    getGlobalLogger().info('V8IsolateSandbox', 'isolated-vm loaded successfully');
  } catch (err) {
    reportSilentFailure(err, 'v8IsolateSandbox:load');
    getGlobalLogger().info(
      'V8IsolateSandbox',
      'isolated-vm not available — V8 Isolate sandbox disabled',
      {
        hint: 'Install with: pnpm add isolated-vm',
      },
    );
  }

  return isolatedVm;
}

// ============================================================================
// V8 Isolate Sandbox
// ============================================================================

/**
 * V8 Isolate sandbox implementation.
 *
 * Each execution gets a fresh V8 Isolate with:
 * - Separate heap (no shared memory with host)
 * - Memory limit (configurable, default 128MB)
 * - Execution timeout (configurable, default 5000ms)
 * - No access to Node.js APIs (no require, no process, no fs)
 *
 * Data transfer is via structured clone only — functions, classes,
 * and prototypes do not cross the isolate boundary.
 */
export class V8IsolateSandbox implements ISandbox {
  private activeIsolates: Map<string, IvmIsolate> = new Map();
  private isolateCounter = 0;

  /** Whether isolated-vm is available */
  get available(): boolean {
    return loadIsolatedVm() !== null;
  }

  get tier(): SandboxTier {
    return 'v8-isolate';
  }

  /**
   * Execute code within a V8 Isolate.
   *
   * The code runs in complete isolation from the host process:
   * - No access to `process`, `require`, `fs`, `http`, etc.
   * - Separate V8 heap with memory limit
   * - Execution timeout enforced by V8 (not setTimeout)
   * - Only structured-cloneable data can be returned
   *
   * @param code - JavaScript code to execute
   * @param capabilities - Not used in V8 Isolate (capabilities are implicit: none)
   * @param config - Sandbox configuration
   */
  async execute(
    code: string,
    _capabilities: string[] = [],
    config: Partial<ISandboxConfig> = {},
  ): Promise<ISandboxResult> {
    const ivm = loadIsolatedVm();
    if (!ivm) {
      return {
        output: null,
        success: false,
        error: 'isolated-vm is not installed. Install with: pnpm add isolated-vm',
        capabilitiesUsed: [],
        executionTimeMs: 0,
        peakMemoryMb: 0,
      };
    }

    const timeoutMs = config.timeoutMs ?? 5000;
    const maxHeapMb = config.maxHeapMb ?? 128;
    const startTime = Date.now();

    let isolate: IvmIsolate | null = null;
    const capabilitiesUsed: string[] = [];

    try {
      // Create a new isolate with memory limit
      isolate = new ivm.Isolate({
        memoryLimit: maxHeapMb,
      });

      const context = isolate.createContext();

      // Inject a safe console.log that captures output
      const logs: string[] = [];
      const logFn = (...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      };

      // Set up the global scope with safe builtins only
      context.global.setSync('console', {
        log: logFn,
        error: logFn,
        warn: logFn,
        info: logFn,
        debug: logFn,
      });

      // Set a safe global identifier
      context.global.setSync('__sandbox', {
        logs,
        capabilitiesUsed,
      });

      // Wrap the user code to capture the result
      const wrappedCode = `
        (function() {
          var __result;
          try {
            __result = eval(${JSON.stringify(code)});
          } catch(e) {
            __result = { __error: e.message || String(e) };
          }
          return __result;
        })()
      `;

      // Compile and run with timeout
      const script = isolate.compileScript(wrappedCode);
      const rawResult = await script.run(context, {
        timeout: timeoutMs,
        promise: true,
        copy: true, // Transfer result via structured clone
      });

      const executionTimeMs = Date.now() - startTime;
      let heapStats: { usedHeapSize: number; heapSizeLimit: number } | undefined;
      try {
        heapStats = isolate.getHeapStatistics();
      } catch {
        // Isolate may have been disposed
      }
      const peakMemoryMb = heapStats ? heapStats.usedHeapSize / (1024 * 1024) : 0;

      // Check if result was an error
      const resultObj = rawResult as { __error?: string } | null;
      if (resultObj && typeof resultObj === 'object' && '__error' in resultObj) {
        return {
          output: logs.join('\n'),
          success: false,
          error: resultObj.__error,
          capabilitiesUsed,
          executionTimeMs,
          peakMemoryMb,
        };
      }

      return {
        output: rawResult,
        success: true,
        capabilitiesUsed,
        executionTimeMs,
        peakMemoryMb,
      };
    } catch (err) {
      const executionTimeMs = Date.now() - startTime;
      const errorMsg = (err as Error)?.message ?? String(err);

      // Check for timeout
      const isTimeout = errorMsg.includes('timed out') || errorMsg.includes('timeout');

      return {
        output: null,
        success: false,
        error: isTimeout ? `Execution timed out after ${timeoutMs}ms` : errorMsg,
        capabilitiesUsed,
        executionTimeMs,
        peakMemoryMb: 0,
      };
    } finally {
      // Always dispose the isolate
      if (isolate) {
        try {
          isolate.dispose();
        } catch {
          // Already disposed
        }
      }
    }
  }

  /**
   * Create a persistent V8 Isolate for reuse.
   * Returns an isolate ID for later reference.
   */
  async createIsolate(config?: Partial<ISandboxConfig>): Promise<string> {
    const ivm = loadIsolatedVm();
    if (!ivm) {
      throw new Error('isolated-vm is not installed');
    }

    const maxHeapMb = config?.maxHeapMb ?? 128;
    const isolate = new ivm.Isolate({ memoryLimit: maxHeapMb });

    const id = `isolate-${++this.isolateCounter}`;
    this.activeIsolates.set(id, isolate);

    getGlobalLogger().debug('V8IsolateSandbox', 'Created isolate', {
      id,
      maxHeapMb,
    });

    return id;
  }

  /**
   * Terminate an isolate immediately (preemption).
   * This is the V8 equivalent of SIGKILL — the isolate cannot recover.
   */
  terminate(isolateId: string): void {
    const isolate = this.activeIsolates.get(isolateId);
    if (isolate) {
      try {
        isolate.dispose();
      } catch {
        // Already disposed
      }
      this.activeIsolates.delete(isolateId);
      getGlobalLogger().debug('V8IsolateSandbox', 'Terminated isolate', { isolateId });
    }
  }

  /**
   * Get resource metrics for an isolate.
   */
  getMetrics(isolateId: string): { heapUsedMb: number; executionTimeMs: number } {
    const isolate = this.activeIsolates.get(isolateId);
    if (!isolate) {
      return { heapUsedMb: 0, executionTimeMs: 0 };
    }

    try {
      const stats = isolate.getHeapStatistics();
      return {
        heapUsedMb: stats.usedHeapSize / (1024 * 1024),
        executionTimeMs: isolate.cpuTime ?? 0,
      };
    } catch {
      return { heapUsedMb: 0, executionTimeMs: 0 };
    }
  }

  /**
   * Dispose all active isolates (cleanup).
   */
  disposeAll(): void {
    for (const [id, isolate] of this.activeIsolates) {
      try {
        isolate.dispose();
      } catch {
        // Already disposed
      }
    }
    this.activeIsolates.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalV8Sandbox: V8IsolateSandbox | null = null;

export function getV8IsolateSandbox(): V8IsolateSandbox {
  if (!globalV8Sandbox) {
    globalV8Sandbox = new V8IsolateSandbox();
  }
  return globalV8Sandbox;
}

/**
 * Check if V8 Isolate sandbox is available (isolated-vm installed).
 */
export function isV8IsolateAvailable(): boolean {
  return loadIsolatedVm() !== null;
}
