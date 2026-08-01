import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeChartContentDigest,
  stampChartContentDigest,
  verifyChartContentDigest,
} from './chart-content-digest.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'commander-chart-digest-'));
  mkdirSync(join(root, 'templates'));
  writeFileSync(
    join(root, 'Chart.yaml'),
    'apiVersion: v2\nname: fixture\nannotations:\n  commander.io/content-sha256: 0000000000000000000000000000000000000000000000000000000000000000\n',
  );
  writeFileSync(join(root, 'templates', 'deployment.yaml'), 'kind: ConfigMap\n');
  return root;
}

describe('chart content digest', () => {
  it('is stable across its own 64-byte annotation value and changes for content bytes', () => {
    const root = fixture();
    try {
      const first = computeChartContentDigest(root);
      stampChartContentDigest(root);
      assert.equal(verifyChartContentDigest(root), first);
      writeFileSync(join(root, 'templates', 'deployment.yaml'), 'kind: Secret\n');
      assert.notEqual(computeChartContentDigest(root), first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds path and content boundaries and rejects unsafe chart entries', () => {
    const first = fixture();
    const second = fixture();
    try {
      writeFileSync(join(first, 'templates', 'deployment.yaml'), 'bc');
      writeFileSync(join(second, 'templates', 'deployment.yaml'), 'c');
      writeFileSync(join(second, 'templates', 'a'), 'b');
      assert.notEqual(computeChartContentDigest(first), computeChartContentDigest(second));

      symlinkSync('/tmp', join(first, 'templates', 'linked'));
      assert.throws(() => computeChartContentDigest(first), /CHART_CONTENT_PATH_INVALID/);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('fails closed for a missing or malformed Chart annotation', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'Chart.yaml'), 'apiVersion: v2\nname: fixture\n');
      assert.throws(() => verifyChartContentDigest(root), /CHART_CONTENT_ANNOTATION_INVALID/);
      writeFileSync(
        join(root, 'Chart.yaml'),
        'apiVersion: v2\nname: fixture\nannotations:\n  commander.io/content-sha256: SHA256:bad\n',
      );
      assert.throws(() => verifyChartContentDigest(root), /CHART_CONTENT_ANNOTATION_INVALID/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('zeros the annotation at a UTF-8 byte offset, not a JavaScript character offset', () => {
    const root = fixture();
    try {
      writeFileSync(
        join(root, 'Chart.yaml'),
        'apiVersion: v2\ndescription: Commander \u2014 production\nannotations:\n  commander.io/content-sha256: 0000000000000000000000000000000000000000000000000000000000000000\n',
      );
      stampChartContentDigest(root);
      assert.doesNotThrow(() => verifyChartContentDigest(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
