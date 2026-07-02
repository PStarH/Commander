// packages/core/tests/chaos/l4Tenant.test.ts
import { describe, it, expect, vi } from 'vitest';
import { L4TenantLayer } from '../../src/chaos/l4TenantLayer';

describe('L4TenantLayer', () => {
  it('only applies fault when context tenantId matches', async () => {
    const layer = new L4TenantLayer();
    layer.arm({ tenantId: 'acme', faultType: 'rate_limit' });
    expect(layer.shouldApply({ tenantId: 'acme' })).toBe(true);
    expect(layer.shouldApply({ tenantId: 'other' })).toBe(false);
  });

  it('records cross-tenant access attempts', () => {
    const layer = new L4TenantLayer();
    const monitor = vi.fn();
    layer.onCrossTenantAccess(monitor);
    layer.recordAccess({ from: 'acme', to: 'globex' });
    expect(monitor).toHaveBeenCalledWith({ from: 'acme', to: 'globex' });
  });

  it('returns zero cross-tenant effects when only one tenant armed', () => {
    const layer = new L4TenantLayer();
    layer.arm({ tenantId: 'acme', faultType: 'rate_limit' });
    const effects = layer.simulateBlastRadius();
    expect(effects.crossTenantLeaks).toBe(0);
    expect(effects.armedTenants).toEqual(['acme']);
  });
});
