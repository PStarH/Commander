import { describe, it, expect } from 'vitest';
import {
  getRegisteredModuleIds,
  getModule,
} from '../../../src/benchmarks/algorithmicEffectiveness';

describe('algorithmicEffectiveness suite integration', () => {
  it('exports all registered modules', () => {
    const ids = getRegisteredModuleIds();
    expect(ids).toEqual(expect.arrayContaining(['thompsonMemory', 'strategySelector']));
  });

  it('each module has valid taskSuite and factories', () => {
    for (const id of getRegisteredModuleIds()) {
      const mod = getModule(id);
      expect(mod.taskSuite.length).toBeGreaterThan(0);
      expect(typeof mod.baselineFactory).toBe('function');
      expect(typeof mod.treatmentFactory).toBe('function');
      expect(typeof mod.runTrial).toBe('function');
    }
  });
});
