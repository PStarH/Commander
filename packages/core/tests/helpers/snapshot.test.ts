/**
 * Tests for Snapshot Testing Framework.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  toMatchSnapshot,
  snapshotExists,
  loadSnapshotFile,
  deleteSnapshot,
  clearSnapshotCache,
} from './snapshot';

describe('Snapshot Framework', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
    clearSnapshotCache();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── toMatchSnapshot ───────────────────────────────────────────────────────

  describe('toMatchSnapshot', () => {
    it('creates snapshot on first run', () => {
      toMatchSnapshot('first-run-test', 'Hello, world!', { dir: testDir });

      const snapFile = path.join(testDir, 'first-run-test.snap');
      assert.ok(fs.existsSync(snapFile));

      const content = fs.readFileSync(snapFile, 'utf-8');
      assert.ok(content.includes('Hello, world!'));
      assert.ok(content.includes('Snapshot: first-run-test'));
    });

    it('passes when output matches snapshot', () => {
      // Create snapshot
      toMatchSnapshot('match-test', 'stable output', { dir: testDir });

      // Should pass without error
      toMatchSnapshot('match-test', 'stable output', { dir: testDir });
    });

    it('throws when output differs', () => {
      // Create snapshot
      toMatchSnapshot('diff-test', 'original', { dir: testDir });

      // Should throw on different output
      assert.throws(
        () => toMatchSnapshot('diff-test', 'changed', { dir: testDir }),
        (err: Error) => {
          assert.ok(err.message.includes('Snapshot mismatch'));
          assert.ok(err.message.includes('diff-test'));
          assert.ok(err.message.includes('original'));
          assert.ok(err.message.includes('changed'));
          return true;
        },
      );
    });

    it('strips ANSI codes by default', () => {
      const colored = '\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m';
      toMatchSnapshot('ansi-test', colored, { dir: testDir });

      const content = loadSnapshotFile('ansi-test', testDir);
      assert.ok(content);
      assert.ok(!content.includes('\x1b['));
      assert.ok(content.includes('Red'));
      assert.ok(content.includes('Green'));
    });

    it('preserves ANSI codes when stripAnsi is false', () => {
      const colored = '\x1b[31mRed\x1b[0m';
      toMatchSnapshot('ansi-preserve-test', colored, { dir: testDir, stripAnsi: false });

      const content = loadSnapshotFile('ansi-preserve-test', testDir);
      assert.ok(content);
      assert.ok(content.includes('\x1b[31m'));
    });

    it('handles multiline content', () => {
      const multiline = 'Line 1\nLine 2\nLine 3';
      toMatchSnapshot('multiline-test', multiline, { dir: testDir });

      const content = loadSnapshotFile('multiline-test', testDir);
      assert.ok(content);
      assert.ok(content.includes('Line 1'));
      assert.ok(content.includes('Line 2'));
      assert.ok(content.includes('Line 3'));
    });

    it('sanitizes snapshot names', () => {
      toMatchSnapshot('Test: Special/Chars (here)', 'content', { dir: testDir });

      // File should exist with sanitized name
      const files = fs.readdirSync(testDir);
      assert.ok(files.some((f) => f.includes('special')));
      assert.ok(files.some((f) => f.includes('chars')));
    });
  });

  // ── snapshotExists ────────────────────────────────────────────────────────

  describe('snapshotExists', () => {
    it('returns false for nonexistent snapshot', () => {
      assert.strictEqual(snapshotExists('nonexistent', testDir), false);
    });

    it('returns true after creating snapshot', () => {
      toMatchSnapshot('exists-test', 'content', { dir: testDir });
      assert.strictEqual(snapshotExists('exists-test', testDir), true);
    });
  });

  // ── loadSnapshotFile ──────────────────────────────────────────────────────

  describe('loadSnapshotFile', () => {
    it('returns null for nonexistent snapshot', () => {
      assert.strictEqual(loadSnapshotFile('nonexistent', testDir), null);
    });

    it('loads snapshot content', () => {
      toMatchSnapshot('load-test', 'test content', { dir: testDir });
      const content = loadSnapshotFile('load-test', testDir);
      assert.strictEqual(content, 'test content');
    });

    it('strips header comments', () => {
      toMatchSnapshot('header-test', 'body content', { dir: testDir });
      const content = loadSnapshotFile('header-test', testDir);
      assert.ok(!content?.startsWith('//'));
      assert.ok(content?.includes('body content'));
    });
  });

  // ── deleteSnapshot ────────────────────────────────────────────────────────

  describe('deleteSnapshot', () => {
    it('deletes existing snapshot', () => {
      toMatchSnapshot('delete-test', 'content', { dir: testDir });
      assert.ok(snapshotExists('delete-test', testDir));

      deleteSnapshot('delete-test', testDir);
      assert.strictEqual(snapshotExists('delete-test', testDir), false);
    });

    it('does not throw for nonexistent snapshot', () => {
      // Should not throw
      deleteSnapshot('nonexistent', testDir);
    });
  });

  // ── Update mode ───────────────────────────────────────────────────────────

  describe('update mode', () => {
    it('updates snapshot when COMMANDER_UPDATE_SNAPSHOTS=1', () => {
      // Create initial snapshot
      toMatchSnapshot('update-test', 'original', { dir: testDir });
      clearSnapshotCache();
      assert.strictEqual(loadSnapshotFile('update-test', testDir), 'original');

      // Simulate update mode
      const originalEnv = process.env.COMMANDER_UPDATE_SNAPSHOTS;
      process.env.COMMANDER_UPDATE_SNAPSHOTS = '1';

      try {
        clearSnapshotCache();
        toMatchSnapshot('update-test', 'updated', { dir: testDir });
        clearSnapshotCache();
        assert.strictEqual(loadSnapshotFile('update-test', testDir), 'updated');
      } finally {
        process.env.COMMANDER_UPDATE_SNAPSHOTS = originalEnv;
      }
    });
  });

  // ── Diff generation ───────────────────────────────────────────────────────

  describe('diff generation', () => {
    it('generates meaningful diff on mismatch', () => {
      toMatchSnapshot('diff-gen-test', 'line1\nline2\nline3', { dir: testDir });

      try {
        toMatchSnapshot('diff-gen-test', 'line1\nchanged\nline3', { dir: testDir });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.includes('Line 2'));
        assert.ok(err.message.includes('- line2'));
        assert.ok(err.message.includes('+ changed'));
      }
    });
  });
});
