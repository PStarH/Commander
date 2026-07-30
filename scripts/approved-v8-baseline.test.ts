import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseApprovedV8Baseline,
  verifyApprovedV8Baseline,
} from './approved-v8-baseline.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('approved v8 source baseline', () => {
  it('accepts only the exact owner-supplied manifest schema', () => {
    const valid = {
      format: 'commander.approved-v8-baseline/v1',
      commitSha: '1'.repeat(40),
      treeSha: '2'.repeat(40),
    };
    assert.deepEqual(parseApprovedV8Baseline(JSON.stringify(valid)), valid);
    assert.throws(
      () => parseApprovedV8Baseline(JSON.stringify({ ...valid, patch: 'dirty.diff' })),
      /APPROVED_V8_BASELINE_INVALID/,
    );
    assert.throws(
      () => parseApprovedV8Baseline(JSON.stringify({ ...valid, commitSha: 'HEAD' })),
      /APPROVED_V8_BASELINE_INVALID/,
    );
  });

  it('verifies the tracked commit/tree from a clean detached worktree and records source digests', () => {
    const fixturePath = resolve(
      root,
      'scripts/fixtures/helm-lifecycle/approved-v8-baseline.json',
    );
    const manifest = parseApprovedV8Baseline(readFileSync(fixturePath, 'utf8'));
    const evidence = verifyApprovedV8Baseline(root, manifest);

    assert.equal(evidence.commitSha, manifest.commitSha);
    assert.equal(evidence.treeSha, manifest.treeSha);
    assert.match(evidence.sourceArchiveSha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.chartArchiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.detached, true);
    assert.equal(evidence.clean, true);
    assert.equal(evidence.lfsPlaceholders.length, 0);
    assert.equal(evidence.submodules.length, 0);
    assert.equal(
      execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
      }).includes('commander-approved-v8-'),
      false,
    );
  });

  it('rejects a tree digest that does not belong to the approved commit', () => {
    const commitSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.throws(
      () => verifyApprovedV8Baseline(root, {
        format: 'commander.approved-v8-baseline/v1',
        commitSha,
        treeSha: '0'.repeat(40),
      }),
      /APPROVED_V8_BASELINE_TREE_MISMATCH/,
    );
  });
});
