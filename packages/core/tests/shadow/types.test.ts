// packages/core/tests/shadow/types.test.ts
import { describe, it, expect } from 'vitest';
import {
  defaultShadowConfig,
  validateShadowConfig,
  isDriftThresholdBreached,
  loadShadowConfig,
} from '../../src/shadow/types';

describe('shadow types', () => {
  it('defaultShadowConfig has safe defaults', () => {
    const cfg = defaultShadowConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.sampleRate).toBe(0.1);
    expect(cfg.scrubPii).toBe(true);
  });

  it('validateShadowConfig rejects sampleRate > 1', () => {
    const result = validateShadowConfig({ ...defaultShadowConfig(), sampleRate: 1.5 });
    expect(result.valid).toBe(false);
  });

  it('isDriftThresholdBreached returns true when drift > 5%', () => {
    expect(isDriftThresholdBreached({ statusDeltaPct: 6, latencyDeltaPct: 1, costDeltaPct: 1 })).toBe(true);
    expect(isDriftThresholdBreached({ statusDeltaPct: 3, latencyDeltaPct: 3, costDeltaPct: 3 })).toBe(false);
  });

  it('loadShadowConfig returns default when no config file', () => {
    const cfg = loadShadowConfig();
    expect(cfg.enabled).toBe(false);
  });
});
