// packages/core/tests/chaos/recoveryVerifier.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RecoveryVerifier } from '../../src/chaos/recoveryVerifier';

describe('RecoveryVerifier', () => {
  it('calls RecoveryBootstrapper.bootstrap after delay', async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const verifier = new RecoveryVerifier({ bootstrap, delayMs: 10 });
    const fault = { id: 'f1', layer: 'L2' as const, scenario: { layers: ['L2'] as any } };
    const result = await verifier.verifyAndRecover(fault, { tenantId: 'acme' });
    expect(bootstrap).toHaveBeenCalled();
    expect(result.recoveryAttempted).toBe(true);
    expect(result.recoverySucceeded).toBe(true);
  });

  it('returns failed status when bootstrap throws', async () => {
    const bootstrap = vi.fn().mockRejectedValue(new Error('bootstrap failed'));
    const verifier = new RecoveryVerifier({ bootstrap, delayMs: 10 });
    const fault = { id: 'f1', layer: 'L1' as const, scenario: { layers: ['L1'] as any } };
    const result = await verifier.verifyAndRecover(fault, { tenantId: 'acme' });
    expect(result.recoveryAttempted).toBe(true);
    expect(result.recoverySucceeded).toBe(false);
    expect(result.error).toContain('bootstrap failed');
  });
});
