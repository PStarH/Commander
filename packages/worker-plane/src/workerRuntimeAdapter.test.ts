import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStepExecutor, createExecutorManifest } from './workerRuntimeAdapter.js';

describe('workerRuntimeAdapter', () => {
  it('creates an agent step executor without dynamic require', () => {
    const executor = createAgentStepExecutor({ defaultMaxSteps: 3 });
    assert.equal(typeof executor.execute, 'function');
  });

  it('validates executor manifest against declared capabilities', () => {
    const manifest = createExecutorManifest({
      agent: () => createAgentStepExecutor(),
      tool: () => ({ execute: async () => ({}) }),
    });

    assert.doesNotThrow(() => manifest.validate(['agent']));
    assert.throws(() => manifest.validate(['agent', 'connector']), /missing required capabilities: connector/);
  });

  it('accepts wildcard capabilities as all manifest entries', () => {
    const manifest = createExecutorManifest({
      agent: () => createAgentStepExecutor(),
      tool: () => ({ execute: async () => ({}) }),
    });

    assert.doesNotThrow(() => manifest.validate(['*']));
  });
});
