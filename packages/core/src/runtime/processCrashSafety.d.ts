/**
 * ProcessCrashSafety — Installs process-level crash handlers.
 *
 * Closes the "no process.on('uncaughtException')" gap from the reversibility
 * audit. Without this, a single uncaught error in any LLM callback, tool
 * promise rejection, or async tool execution kills the process, leaving:
 *   - Held leases (zombie processes)
 *   - Unwritten DLQ entries
 *   - In-flight compensation handlers orphaned
 *
 * On crash, this module:
 *   1. Logs to DLQ for each active run
 *   2. Releases leases via LeaseManager
 *   3. Aborts scheduler for each active run
 *   4. Exits with code 1
 *
 * Idempotent: calling install() multiple times is safe (replaces handler).
 */
import type { DeadLetterQueue } from './deadLetterQueue';
import type { LeaseManager } from '../atr/leaseManager';
export type CrashSource = 'uncaughtException' | 'unhandledRejection' | 'SIGTERM' | 'SIGINT' | 'exit_timeout';
export interface CrashSafetyDeps {
    dlq: DeadLetterQueue;
    leaseManager: LeaseManager;
    /** Active run IDs (pass AgentRuntime's activeRuns Set) */
    activeRunIds: () => Iterable<string>;
    /** Lease token per runId (returns empty string if no lease) */
    leaseTokenFor?: (runId: string) => string | undefined;
    /** Fencing epoch per runId */
    fencingEpochFor?: (runId: string) => number | undefined;
    /** Tenant ID per runId (for DLQ isolation) */
    tenantIdFor?: (runId: string) => string | undefined;
    /** Graceful shutdown timeout before force-exit (ms) */
    exitTimeoutMs?: number;
}
export declare function installProcessCrashHandlers(deps: CrashSafetyDeps): void;
export declare function isShuttingDown(): boolean;
export declare function resetCrashHandlersForTesting(): void;
//# sourceMappingURL=processCrashSafety.d.ts.map