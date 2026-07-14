import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAdmissionControlEnabled,
  acquireRuntimeAdmission,
  releaseRuntimeAdmission,
  canAdmitSchedulerWork,
} from '../../src/runtime/runtimeAdmission';
import {
  BackpressureController,
  setGlobalBackpressureController,
} from '../../src/runtime/backpressureController';

describe('runtimeAdmission', () => {
  beforeEach(() => {
    setAdmissionControlEnabled(true);
    setGlobalBackpressureController(
      new BackpressureController({
        maxTokens: 1,
        refillRatePerSecond: 0.01,
        bufferSize: 1,
        maxWaitMs: 1,
      }),
    );
  });

  it('rejects when token bucket is exhausted', async () => {
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    expect(await acquireRuntimeAdmission('http_execute')).toBe(false);
    releaseRuntimeAdmission();
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    releaseRuntimeAdmission();
  });

  it('canAdmitSchedulerWork probes without consuming tokens', async () => {
    expect(canAdmitSchedulerWork()).toBe(true);
    expect(await acquireRuntimeAdmission('http_execute')).toBe(true);
    expect(canAdmitSchedulerWork()).toBe(false);
    releaseRuntimeAdmission();
    expect(canAdmitSchedulerWork()).toBe(true);
  });
});
