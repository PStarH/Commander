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

import {
  CompensationRegistry,
  type CompensableAction,
  type CompensationHandler,
} from '../runtime/compensationRegistry';
import { getRunLedgerBundle } from './runLedger';
import type { CompensationOutcome } from './runLedger';

export interface BridgeSagaContext {
  runId: string;
  leaseToken: string;
  fencingEpoch: number;
  tenantId?: string;
}

export class CompensationBridge {
  private legacy: CompensationRegistry;

  constructor(legacy?: CompensationRegistry) {
    this.legacy = legacy ?? new CompensationRegistry();
  }

  getLegacy(): CompensationRegistry {
    return this.legacy;
  }

  register(toolName: string, handler: CompensationHandler): void {
    this.legacy.register(toolName, handler);
    const bundle = getRunLedgerBundle();
    bundle.ledger.registerCompensation(toolName, handler);
  }

  recordAction(action: CompensableAction): void {
    this.legacy.recordAction(action);
  }

  recordActionSaga(action: CompensableAction, ctx: BridgeSagaContext): string | null {
    const bundle = getRunLedgerBundle();
    const persisted = bundle.ledger.recordAction({
      runId: ctx.runId,
      leaseToken: ctx.leaseToken,
      fencingEpoch: ctx.fencingEpoch,
      tenantId: ctx.tenantId,
      actionId: action.actionId,
      toolName: action.toolName,
      externalSystem: (action as { externalSystem?: string }).externalSystem ?? 'unknown',
      args: action.args,
      idempotencyKey: (action as { idempotencyKey?: string }).idempotencyKey ?? action.actionId,
      compensable: true,
      tags: action.tags,
      description: action.description,
    });
    if (persisted) this.legacy.recordAction(action);
    return persisted?.actionId ?? null;
  }

  async compensate(actionId: string): Promise<{ success: boolean; error?: string }> {
    return this.legacy.compensate(actionId);
  }

  async compensateAll(): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    return this.legacy.compensateAll();
  }

  async compensateViaLedger(
    runId: string,
    leaseToken: string,
    fencingEpoch: number,
    errorMessage: string,
    options?: { tenantId?: string; maxAttempts?: number },
  ): Promise<{ aborted: boolean; outcome: CompensationOutcome }> {
    const bundle = getRunLedgerBundle();
    return bundle.ledger.abortAndCompensate(runId, leaseToken, fencingEpoch, errorMessage, options);
  }

  getPendingCount(): number {
    return this.legacy.getPendingCount();
  }

  getCompensatedCount(): number {
    return this.legacy.getCompensatedCount();
  }

  clear(): void {
    this.legacy.clear();
  }
}

let bridgeInstance: CompensationBridge | null = null;

export function getCompensationBridge(): CompensationBridge {
  if (!bridgeInstance) bridgeInstance = new CompensationBridge();
  return bridgeInstance;
}

export function resetCompensationBridge(): void {
  bridgeInstance = null;
}
