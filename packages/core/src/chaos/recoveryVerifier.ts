// packages/core/src/chaos/recoveryVerifier.ts
import type { ChaosLayer } from './types';

export interface FaultRef {
  id: string;
  layer: ChaosLayer;
  scenario: { layers: ChaosLayer[] };
}

export interface RecoveryContext {
  tenantId?: string;
}

export interface RecoveryResult {
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
  durationMs: number;
  error?: string;
}

export interface VerifierDeps {
  bootstrap: () => Promise<void>;
  delayMs: number;
}

export class RecoveryVerifier {
  constructor(private deps: VerifierDeps) {}

  async verifyAndRecover(fault: FaultRef, ctx: RecoveryContext): Promise<RecoveryResult> {
    void ctx;
    const start = Date.now();
    await new Promise((r) => setTimeout(r, this.deps.delayMs));
    try {
      await this.deps.bootstrap();
      return { recoveryAttempted: true, recoverySucceeded: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        recoveryAttempted: true,
        recoverySucceeded: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
