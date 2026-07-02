// packages/core/tests/chaos/types.test.ts
import { describe, it, expect } from 'vitest';
import { validateScenario, parseLayers } from '../../src/chaos/types';

describe('chaos types', () => {
  it('parseLayers splits comma-separated layer string', () => {
    expect(parseLayers('L1,L2,L3')).toEqual(['L1', 'L2', 'L3']);
    expect(parseLayers('L4')).toEqual(['L4']);
  });

  it('parseLayers rejects unknown layers', () => {
    expect(() => parseLayers('L1,L9')).toThrow();
  });

  it('validateScenario requires tenantId when L4 selected', () => {
    const result = validateScenario({ layers: ['L4'], tenantId: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('tenantId required for L4');
  });

  it('validateScenario passes with valid L4 + tenantId', () => {
    const result = validateScenario({ layers: ['L4'], tenantId: 'acme' });
    expect(result.valid).toBe(true);
  });
});
