/**
 * CompensationBridge — connect legacy CompensationRegistry to RunLedger.
 *
 * The legacy CompensationRegistry is in-memory and per-AgentRuntime. The new
 * RunLedger is crash-safe and saga-correct (REVERSE execution order, 3
 * retries, lease-fenced). The bridge lets existing code keep using the
 * registry API while the ledger becomes the source of truth for actual
 * saga compensation.
 *
 * Design rule: do not collapse the legacy registry. New callers should use
 * RunLedger directly. Old callers route through this bridge.
 *
 * Mapping:
 *   register(toolName, handler)       → legacy map + ledger.handlers
 *   recordActionSaga(action, ctx)     → ledger.recordAction (persisted, fence-validated)
 *                                         + legacy.recordAction (back-compat)
 *   compensateViaLedger(...)          → ledger.abortAndCompensate (real saga)
 *   compensate / compensateAll       → legacy in-memory only
 *   getPendingCount / clear / etc.    → legacy passthrough
 */
import { CompensationRegistry, type CompensableAction, type CompensationHandler } from '../runtime/compensationRegistry';
import type { CompensationOutcome } from './runLedger';
export interface BridgeSagaContext {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
}
export declare class CompensationBridge {
    private legacy;
    constructor(legacy?: CompensationRegistry);
    getLegacy(): CompensationRegistry;
    register(toolName: string, handler: CompensationHandler): void;
    recordAction(action: CompensableAction): void;
    recordActionSaga(action: CompensableAction, ctx: BridgeSagaContext): string | null;
    compensate(actionId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    compensateAll(): Promise<{
        succeeded: number;
        failed: number;
        errors: string[];
    }>;
    compensateViaLedger(runId: string, leaseToken: string, fencingEpoch: number, errorMessage: string, options?: {
        tenantId?: string;
        maxAttempts?: number;
    }): Promise<{
        aborted: boolean;
        outcome: CompensationOutcome;
    }>;
    getPendingCount(): number;
    getCompensatedCount(): number;
    clear(): void;
}
export declare function getCompensationBridge(): CompensationBridge;
export declare function resetCompensationBridge(): void;
//# sourceMappingURL=compensationBridge.d.ts.map