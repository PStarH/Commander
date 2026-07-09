import { describe, it, expect } from 'vitest';
import { getRegisteredModuleIds, getModule } from '../../../src/benchmarks/algorithmicEffectiveness/registry';

describe('registry', () => {
  it('lists registered module ids', () => {
    const ids = getRegisteredModuleIds();
    expect(ids).toContain('thompsonMemory');
    expect(ids).toContain('strategySelector');
  });

  it('returns a module by id', () => {
    const mod = getModule('thompsonMemory');
    expect(mod.id).toBe('thompsonMemory');
  });

  it('throws for unknown module', () => {
    expect(() => getModule('unknown')).toThrow(/not found/);
  });
});
