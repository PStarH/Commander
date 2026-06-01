import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureProvenance, createRunProvenance } from '../../src/runtime/provenance';

describe('Provenance tracking', () => {

  // -----------------------------------------------------------------------
  // captureProvenance — structure and types
  // -----------------------------------------------------------------------

  it('returns an object with git and system fields', () => {
    const prov = captureProvenance();
    assert.ok(prov.git, 'should have git field');
    assert.ok(prov.system, 'should have system field');
  });

  it('git.commitHash is a non-empty string', () => {
    const prov = captureProvenance();
    assert.equal(typeof prov.git.commitHash, 'string');
    assert.ok(prov.git.commitHash.length > 0, 'commitHash should not be empty');
  });

  it('git.commitHash looks like a hex SHA or "unknown"', () => {
    const prov = captureProvenance();
    const isHex = /^[0-9a-f]{7,40}$/.test(prov.git.commitHash);
    const isUnknown = prov.git.commitHash === 'unknown';
    assert.ok(isHex || isUnknown, `commitHash should be hex SHA or "unknown", got: ${prov.git.commitHash}`);
  });

  it('git.branch is a non-empty string', () => {
    const prov = captureProvenance();
    assert.equal(typeof prov.git.branch, 'string');
    assert.ok(prov.git.branch.length > 0, 'branch should not be empty');
  });

  it('git.dirty is a boolean', () => {
    const prov = captureProvenance();
    assert.equal(typeof prov.git.dirty, 'boolean');
  });

  it('system.nodeVersion matches process.version', () => {
    const prov = captureProvenance();
    assert.equal(prov.system.nodeVersion, process.version);
  });

  it('system.platform matches process.platform', () => {
    const prov = captureProvenance();
    assert.equal(prov.system.platform, process.platform);
  });

  it('system.arch matches process.arch', () => {
    const prov = captureProvenance();
    assert.equal(prov.system.arch, process.arch);
  });

  it('does not include runId, timestamp, model, or tags fields', () => {
    const prov = captureProvenance();
    assert.equal((prov as any).runId, undefined);
    assert.equal((prov as any).timestamp, undefined);
    assert.equal((prov as any).model, undefined);
    assert.equal((prov as any).tags, undefined);
  });

  it('in this repo git.dirty should be true (working tree has changes)', () => {
    const prov = captureProvenance();
    // The test suite runs in a repo with uncommitted changes (per git status)
    assert.equal(prov.git.dirty, true);
  });

  it('in this repo git.branch should be "master" (current branch)', () => {
    const prov = captureProvenance();
    assert.equal(prov.git.branch, 'master');
  });

  // -----------------------------------------------------------------------
  // createRunProvenance — composition and metadata
  // -----------------------------------------------------------------------

  it('creates a full RunProvenance with runId and timestamp', () => {
    const model = {
      provider: 'openai',
      modelId: 'gpt-4o',
      tier: 'power' as const,
      temperature: 0.7,
      maxTokens: 4096,
    };
    const prov = createRunProvenance('run-42', model, { env: 'test', suite: 'unit' });

    assert.equal(prov.runId, 'run-42');
    assert.ok(prov.timestamp, 'should have timestamp');
    assert.ok(new Date(prov.timestamp).getTime() > 0, 'timestamp should be valid ISO date');
  });

  it('copies model config into provenance', () => {
    const model = {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      tier: 'standard' as const,
    };
    const prov = createRunProvenance('run-m', model);

    assert.equal(prov.model.provider, 'anthropic');
    assert.equal(prov.model.modelId, 'claude-sonnet-4-20250514');
    assert.equal(prov.model.tier, 'standard');
  });

  it('defaults tags to empty object when not provided', () => {
    const prov = createRunProvenance('run-1', {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      tier: 'standard',
    });
    assert.deepEqual(prov.tags, {});
  });

  it('passes through tags when provided', () => {
    const prov = createRunProvenance('run-t', {
      provider: 'openai',
      modelId: 'gpt-4',
      tier: 'power',
    }, { benchmark: 'bfcl', version: 'v2' });

    assert.deepEqual(prov.tags, { benchmark: 'bfcl', version: 'v2' });
  });

  it('includes reasoningConfig when provided in model', () => {
    const prov = createRunProvenance('run-rc', {
      provider: 'openai',
      modelId: 'o3-mini',
      tier: 'power',
      reasoningConfig: { enabled: true, budget: 10000, effort: 'high' },
    });

    assert.deepEqual(prov.model.reasoningConfig, {
      enabled: true,
      budget: 10000,
      effort: 'high',
    });
  });

  it('has undefined reasoningConfig when not provided', () => {
    const prov = createRunProvenance('run-norc', {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      tier: 'standard',
    });
    assert.equal(prov.model.reasoningConfig, undefined);
  });

  it('timestamp falls within a reasonable time window', () => {
    const before = new Date().toISOString();
    const prov = createRunProvenance('run-ts', {
      provider: 'openai',
      modelId: 'gpt-4',
      tier: 'power',
    });
    const after = new Date().toISOString();

    assert.ok(prov.timestamp >= before, `timestamp ${prov.timestamp} should be >= ${before}`);
    assert.ok(prov.timestamp <= after, `timestamp ${prov.timestamp} should be <= ${after}`);
  });

  it('inherits git and system info from captureProvenance', () => {
    const prov = createRunProvenance('run-inherit', {
      provider: 'openai',
      modelId: 'gpt-4',
      tier: 'power',
    });

    // These should match what captureProvenance returns
    assert.equal(prov.system.nodeVersion, process.version);
    assert.equal(prov.system.platform, process.platform);
    assert.equal(prov.system.arch, process.arch);
    assert.ok(prov.git.commitHash.length > 0);
    assert.ok(prov.git.branch.length > 0);
    assert.equal(typeof prov.git.dirty, 'boolean');
  });

  it('each call produces a unique timestamp (or at least valid)', () => {
    const p1 = createRunProvenance('run-1', {
      provider: 'openai', modelId: 'gpt-4', tier: 'power',
    });
    const p2 = createRunProvenance('run-2', {
      provider: 'openai', modelId: 'gpt-4', tier: 'power',
    });
    // Both should have valid timestamps (they may be the same if called in the same ms)
    assert.ok(new Date(p1.timestamp).getTime() > 0);
    assert.ok(new Date(p2.timestamp).getTime() > 0);
  });
});
