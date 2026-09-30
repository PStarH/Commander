import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureProvenance, createRunProvenance } from '../../src/runtime/provenance';
import { getDirname } from '../../src/esmCompat';

const __dirname = getDirname(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

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
    assert.ok(
      isHex || isUnknown,
      `commitHash should be hex SHA or "unknown", got: ${prov.git.commitHash}`,
    );
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

  /**
   * Read the checked-out branch straight from `.git/HEAD`. This is a plain file
   * read, so it is independent of the `execFileSync('git', …)` path that
   * `captureProvenance` uses — comparing against it is a real check rather than
   * a restatement of the implementation. Returns undefined for a detached HEAD.
   */
  function branchFromGitHead(): string | undefined {
    try {
      const head = fs.readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
      return /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1];
    } catch {
      return undefined;
    }
  }

  it('git.branch reports the branch git actually has checked out', () => {
    const expected = branchFromGitHead();
    const prov = captureProvenance();
    if (expected === undefined) {
      // Detached HEAD, or `.git` is a file (linked worktree / submodule): there
      // is no branch name to compare against, so only require a populated field.
      assert.equal(typeof prov.git.branch, 'string');
      assert.ok(prov.git.branch.length > 0, 'branch should not be empty');
      return;
    }
    // Must be the real branch — not the 'unknown' fallback, and not stale. This
    // assertion used to hardcode 'master', so it could not pass on any other
    // branch (the repo currently checks out `codex/first-customer-trial-20260908`).
    assert.equal(prov.git.branch, expected);
    assert.notEqual(prov.git.branch, 'unknown', 'the git fallback must not be used inside a repo');
  });

  it('git.dirty agrees with whether the working tree has uncommitted changes', () => {
    const prov = captureProvenance();
    // Derive the expectation instead of pinning it: a hardcoded `true` passes
    // only while this working tree happens to be dirty, and fails on every clean
    // checkout (e.g. CI after a fresh clone) — which is not a defect in
    // `captureProvenance`. This mirrors the implementation's own mechanism, so
    // it guards propagation of the value rather than the git invocation.
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(prov.git.dirty, porcelain.trim().length > 0);
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
    const prov = createRunProvenance(
      'run-t',
      {
        provider: 'openai',
        modelId: 'gpt-4',
        tier: 'power',
      },
      { benchmark: 'bfcl', version: 'v2' },
    );

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
      provider: 'openai',
      modelId: 'gpt-4',
      tier: 'power',
    });
    const p2 = createRunProvenance('run-2', {
      provider: 'openai',
      modelId: 'gpt-4',
      tier: 'power',
    });
    // Both should have valid timestamps (they may be the same if called in the same ms)
    assert.ok(new Date(p1.timestamp).getTime() > 0);
    assert.ok(new Date(p2.timestamp).getTime() > 0);
  });
});
