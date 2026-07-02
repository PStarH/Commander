// packages/core/src/chaos/orchestrator.ts
import { L1LlmLayer } from './l1LlmLayer';
import { L2ToolLayer } from './l2ToolLayer';
import { L3SystemLayer } from './l3SystemLayer';
import { L4TenantLayer } from './l4TenantLayer';
import { RecoveryVerifier, type RecoveryResult } from './recoveryVerifier';
import { type ChaosScenario, validateScenario, type ChaosLayer } from './types';

export interface OrchestratorDeps {
  bootstrap: () => Promise<void>;
  delayMs: number;
}

export interface GapCallback {
  onGapDetected: (gap: { layer: string; faultType: string; description: string }) => void;
}

export interface RunResult {
  layer: string;
  faultType: string;
  recovery: RecoveryResult;
}

export class ChaosOrchestrator {
  private l1: L1LlmLayer;
  private l2: L2ToolLayer;
  private l3: L3SystemLayer;
  private l4: L4TenantLayer;
  private verifier: RecoveryVerifier;

  constructor(
    private deps: OrchestratorDeps,
    private gap?: GapCallback,
  ) {
    this.l1 = new L1LlmLayer();
    this.l2 = new L2ToolLayer();
    this.l3 = new L3SystemLayer();
    this.l4 = new L4TenantLayer();
    this.verifier = new RecoveryVerifier({ bootstrap: deps.bootstrap, delayMs: deps.delayMs });
  }

  get layers(): { l1: L1LlmLayer; l2: L2ToolLayer; l3: L3SystemLayer; l4: L4TenantLayer } {
    return { l1: this.l1, l2: this.l2, l3: this.l3, l4: this.l4 };
  }

  async run(scenario: ChaosScenario): Promise<RunResult[]> {
    const validation = validateScenario(scenario);
    if (!validation.valid) {
      throw new Error(`Invalid scenario: ${validation.errors.join(', ')}`);
    }
    const results: RunResult[] = [];

    for (const layer of scenario.layers) {
      const fault = this.runLayer(layer, scenario);
      const recovery = await this.verifier.verifyAndRecover(
        { id: `${layer}-${Date.now()}`, layer, scenario },
        { tenantId: scenario.tenantId },
      );
      // ATK-011 fix: only fire onGapDetected when a real fault was
      // actually injected AND recovery failed. Healthy runs (no
      // faultTypes) and successful recoveries are not gaps; firing for
      // every layer run polluted the gap registry with false positives.
      const faultInjected = !!(scenario.faultTypes && scenario.faultTypes.length > 0);
      if (faultInjected && !recovery.recoverySucceeded && this.gap) {
        this.gap.onGapDetected({
          layer,
          faultType: fault.faultType,
          description: `Layer ${layer} recovery failed after fault: ${fault.faultType}`,
        });
      }
      results.push({ layer, faultType: fault.faultType, recovery });
    }

    // ATK-013 fix: disarm all injected faults after the run completes.
    // Without this, an L2 tool fault armed in step N persists and silently
    // breaks the next legitimate request.
    this.disarmAll();

    return results;
  }

  /**
   * ATK-013: disarm every layer's active faults. Idempotent.
   */
  disarmAll(): void {
    try {
      this.l1.disarm();
    } catch {
      /* layer may not implement disarm */
    }
    try {
      this.l2.disarm();
    } catch {
      /* layer may not implement disarm */
    }
    if (typeof (this.l3 as unknown as { disarm?: () => void }).disarm === 'function') {
      try {
        (this.l3 as unknown as { disarm: () => void }).disarm();
      } catch {
        /* noop */
      }
    }
    try {
      this.l4.disarm();
    } catch {
      /* layer may not implement disarm */
    }
  }

  private runLayer(layer: ChaosLayer, scenario: ChaosScenario): { faultType: string } {
    const defaultFault = scenario.faultTypes?.[0] ?? 'unspecified';
    return { faultType: defaultFault };
  }
}
