import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createGitSnapshot,
  restoreGitSnapshot,
  getGitSnapshot,
  clearGitSnapshot,
  hasGitSnapshot,
} from '../../src/atr/gitSnapshot';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('gitSnapshot', () => {
  const testRunId = 'test-run-git-snapshot';
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary git repository for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-snapshot-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    // Create an initial commit so HEAD exists
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'initial');
    execSync('git add -A', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => {
    clearGitSnapshot(testRunId);
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createGitSnapshot', () => {
    it('should create snapshot in a git repo with clean working tree', () => {
      const result = createGitSnapshot(testRunId, tempDir);

      expect(result.created).toBe(true);
      expect(result.baseCommitSha).toBeTruthy();
      expect(result.wasClean).toBe(true);
      expect(result.ref).toBe(result.baseCommitSha);
    });

    it('should create snapshot with stash when working tree is dirty', () => {
      // Modify a tracked file to make the working tree dirty
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'modified');

      const result = createGitSnapshot(testRunId, tempDir);

      expect(result.created).toBe(true);
      expect(result.baseCommitSha).toBeTruthy();
      expect(result.wasClean).toBe(false);
      // ref should be a stash SHA (different from base commit)
      expect(result.ref).toBeTruthy();
      expect(result.ref).not.toBe(result.baseCommitSha);
    });

    it('should store snapshot in the in-memory store', () => {
      createGitSnapshot(testRunId, tempDir);
      expect(hasGitSnapshot(testRunId)).toBe(true);

      const stored = getGitSnapshot(testRunId);
      expect(stored).toBeDefined();
      expect(stored!.created).toBe(true);
    });

    it('should handle missing runId gracefully', () => {
      const result = getGitSnapshot('nonexistent-run');
      expect(result).toBeUndefined();
      expect(hasGitSnapshot('nonexistent-run')).toBe(false);
    });
  });

  describe('restoreGitSnapshot', () => {
    it('should return false when no snapshot exists for the runId', () => {
      const result = restoreGitSnapshot('nonexistent-run', tempDir);
      expect(result).toBe(false);
    });

    it('should restore to base commit when snapshot exists', () => {
      createGitSnapshot(testRunId, tempDir);

      // Make a change after snapshot
      fs.writeFileSync(path.join(tempDir, 'new-file.txt'), 'created during run');
      execSync('git add -A', { cwd: tempDir, stdio: 'pipe' });
      execSync('git commit -m "change during run"', { cwd: tempDir, stdio: 'pipe' });

      // Restore should reset to the pre-run state
      const result = restoreGitSnapshot(testRunId, tempDir);
      expect(result).toBe(true);

      // The new file should be gone after restore
      expect(fs.existsSync(path.join(tempDir, 'new-file.txt'))).toBe(false);
    });

    it('should restore dirty working tree with stash', () => {
      // Start with a dirty working tree (modify tracked file)
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'before run');
      createGitSnapshot(testRunId, tempDir);

      // Simulate agent making changes during the run (modify the tracked file)
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'modified during run');

      // Restore should reset to pre-run state
      const result = restoreGitSnapshot(testRunId, tempDir);
      expect(result).toBe(true);

      // The tracked file should be restored to pre-run state
      expect(fs.readFileSync(path.join(tempDir, 'README.md'), 'utf-8')).toBe('before run');
    });
  });

  describe('clearGitSnapshot', () => {
    it('should remove snapshot from store', () => {
      createGitSnapshot(testRunId, tempDir);
      expect(hasGitSnapshot(testRunId)).toBe(true);

      clearGitSnapshot(testRunId);
      expect(hasGitSnapshot(testRunId)).toBe(false);
    });
  });
});
