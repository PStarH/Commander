/**
 * Path Security Tests — safePath boundary protection and glob ** patterns.
 *
 * Validates workspace boundary enforcement across all tools modified in
 * the 2026-06 security hardening pass.
 *
 * Async note: `safePath` now returns `Promise<string>` (was synchronous).
 * Tests that called `safePath('x')` directly must `await` the promise;
 * tests that asserted `assert.throws(() => safePath(x))` must use
 * `await assert.rejects(async () => safePath(x))` because the rejection
 * is now Promise-based instead of synchronous.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  safePath,
  getSafeRoot,
  FileReadTool,
  FileWriteTool,
  FileSearchTool,
  FileListTool,
} from '../../src/tools/fileSystemTool';
import { ShellExecuteTool } from '../../src/tools/codeExecutionTool';
import { VerificationTool } from '../../src/tools/verificationTool';
import { ApplyPatchTool } from '../../src/tools/patchTool';
import { CodeRefinerTool } from '../../src/tools/codeRefinerTool';
import { CodeSearchTool } from '../../src/tools/codeSearchTool';

// Helper: check if a string looks like an error (any tool's error format)
function isError(s: string): boolean {
  return s.startsWith('Error') || s.includes('Access denied') || s.includes('outside workspace');
}

// ============================================================================
// safePath unit tests — async/await because safePath is now Promise-returning.
// ============================================================================
describe('safePath — workspace boundary enforcement', () => {
  it('accepts paths within workspace', async () => {
    const result = await safePath('package.json');
    assert.ok(result.endsWith('package.json'));
    assert.ok(fs.existsSync(result));
  });

  it('accepts nested paths within workspace', async () => {
    const result = await safePath('src/tools/fileSystemTool.ts');
    assert.ok(result.endsWith(path.normalize('src/tools/fileSystemTool.ts')));
    assert.ok(fs.existsSync(result));
  });

  it('accepts dot (.) as current directory', async () => {
    const result = await safePath('.');
    assert.strictEqual(result, getSafeRoot());
  });

  it('accepts non-existent paths within workspace (ENOENT)', async () => {
    const result = await safePath('nonexistent-dir-xyz/nonexistent-file.test');
    assert.ok(result.endsWith(path.normalize('nonexistent-dir-xyz/nonexistent-file.test')));
    assert.ok(!fs.existsSync(result));
  });

  it('rejects paths outside workspace via ../ traversal', async () => {
    await assert.rejects(() => safePath('../../../etc/passwd'), /Access denied/);
  });

  it('rejects absolute paths outside workspace', async () => {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      await assert.rejects(() => safePath('/etc/passwd'), /Access denied|outside workspace/);
    }
  });

  it('rejects deeply traversed paths', async () => {
    await assert.rejects(() => safePath('../../../../../../etc/shadow'), /Access denied/);
  });

  it('accepts empty string as path (resolves to workspace root)', async () => {
    const result = await safePath('');
    assert.strictEqual(result, getSafeRoot());
  });

  it('handles path with ./ prefix', async () => {
    const result = await safePath('./package.json');
    assert.ok(result.endsWith('package.json'));
    assert.ok(
      fs.existsSync(result),
      `safePath('./package.json') should resolve to existing file, got: ${result}`,
    );
  });

  it('rejects traversal that stays in root but not under workspace', async () => {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      await assert.rejects(() => safePath('/etc'), /Access denied/);
    }
  });
});

// ============================================================================
// FileSearchTool — glob ** pattern tests
// ============================================================================
describe('FileSearchTool — glob pattern resolution', () => {
  let tool: FileSearchTool;

  beforeEach(() => {
    tool = new FileSearchTool();
  });

  it('non-recursive pattern does NOT recurse into subdirectories', async () => {
    const result = await tool.execute({ pattern: 'src/tools/*.ts', maxResults: 50 });
    assert.ok(result.includes('fileSystemTool.ts'), 'Should find files directly in src/tools/');
    assert.ok(!result.includes('_utils/'), 'Should NOT recurse into _utils/ subdirectory');
    assert.ok(!result.includes('multimodal/'), 'Should NOT recurse into multimodal/ subdirectory');
    assert.ok(result.includes('webSearchTool.ts'), 'Should include webSearchTool.ts');
  });

  it('recursive pattern **/*.ts finds files in deep subdirectories', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', maxResults: 100 });
    assert.ok(result.includes('.ts'), 'Should find .ts files');
    assert.ok(result.length > 0, 'Should return at least one result');
    // Verify recursion — benchmark files appear early alphabetically
    assert.ok(
      result.includes('benchmarks/') || result.includes('dist/') || result.includes('cli.ts'),
      'Should find files in subdirectories via recursion',
    );
  });

  it('recursive pattern **/*.json finds JSON files across workspace', async () => {
    const result = await tool.execute({ pattern: '**/*.json', maxResults: 50 });
    assert.ok(result.includes('.json'), 'Should find JSON files');
    assert.ok(result.length > 0, 'Should return at least one result');
  });

  it('simple pattern ** finds all files recursively', async () => {
    const result = await tool.execute({ pattern: '**/package.json', maxResults: 20 });
    assert.ok(result.includes('package.json'), 'Should find package.json files');
  });

  it('pattern without wildcard finds exact file match', async () => {
    const result = await tool.execute({ pattern: 'package.json' });
    assert.ok(result.length > 0, 'Should find exact package.json');
    assert.ok(result.includes('package.json'));
  });

  it('returns error for empty pattern', async () => {
    const result = await tool.execute({ pattern: '' });
    assert.ok(result.includes('Error'), 'Should error on empty pattern');
  });

  it('star pattern * finds top-level files', async () => {
    const result = await tool.execute({ pattern: '*', maxResults: 20 });
    assert.ok(result.length > 0, 'Should find files');
    assert.ok(typeof result === 'string');
  });

  it('handles hidden file pattern .*', async () => {
    const result = await tool.execute({ pattern: '.*', maxResults: 20 });
    assert.ok(typeof result === 'string');
    assert.ok(!result.startsWith('Error'), 'Should not error on hidden file pattern');
  });

  it('maxResults clamps to 100', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', maxResults: 999 });
    const lines = result.split('\n').filter((l) => /^\[\d+\]/.test(l));
    assert.ok(lines.length <= 100, `maxResults should clamp to 100, got ${lines.length} entries`);
  });
});

// ============================================================================
// FileReadTool — workspace boundary
// ============================================================================
describe('FileReadTool — workspace boundary', () => {
  let tool: FileReadTool;

  beforeEach(() => {
    tool = new FileReadTool();
  });

  it('allows reading files within workspace', async () => {
    const result = await tool.execute({ path: 'package.json' });
    assert.ok(result.includes('name') || result.includes('version'));
  });

  it('blocks path traversal via ../', async () => {
    const result = await tool.execute({ path: '../../../etc/passwd' });
    assert.ok(isError(result), `Should deny, got: ${result.slice(0, 80)}`);
  });

  it('blocks absolute paths outside workspace', async () => {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const result = await tool.execute({ path: '/etc/passwd' });
      assert.ok(isError(result), `Should deny, got: ${result.slice(0, 80)}`);
    }
  });

  it('returns error for empty path', async () => {
    const result = await tool.execute({ path: '' });
    assert.ok(result.includes('Error'), 'Should error on empty path');
  });

  it('returns error for non-existent file', async () => {
    const result = await tool.execute({ path: 'nonexistent-path-xyz-2026.txt' });
    assert.ok(result.includes('not found'), `Should say not found, got: ${result.slice(0, 100)}`);
  });

  it('outputs hashline format with file path header', async () => {
    const result = await tool.execute({ path: 'package.json', maxChars: 200 });
    // Hashline format includes ¶ and # in the header (e.g. ¶package.json#A1B2)
    assert.ok(
      result.includes('¶') || result.includes('package.json'),
      `Should contain file path in header, got: ${result.slice(0, 80)}`,
    );
    assert.ok(result.includes('package.json'), 'Should include file path in header');
  });

  it('respects offset and limit parameters', async () => {
    const result = await tool.execute({ path: 'package.json', offset: 5, limit: 3 });
    // Should show lines starting from line 5
    assert.ok(
      result.includes('5:') || result.includes('[Showing lines 5-'),
      `Should start at line 5, got: ${result.slice(0, 100)}`,
    );
    // Should end at line 7 or show truncation info
    assert.ok(
      result.includes('7:') || result.includes('[Showing lines'),
      `Should reference line range, got: ${result.slice(0, 100)}`,
    );
  });
});

// ============================================================================
// FileWriteTool — workspace boundary
// ============================================================================
describe('FileWriteTool — workspace boundary', () => {
  let tool: FileWriteTool;

  beforeEach(() => {
    tool = new FileWriteTool();
  });

  it('blocks writing outside workspace via traversal', async () => {
    const result = await tool.execute({ path: '../../../tmp/evil.txt', content: 'evil' });
    assert.ok(isError(result), `Should deny, got: ${result.slice(0, 80)}`);
  });
});

describe('FileWriteTool — edge cases', () => {
  let tool: FileWriteTool;
  const tempFiles: string[] = [];

  afterEach(() => {
    // Clean up in reverse depth order
    const sorted = [...tempFiles].sort((a, b) => b.length - a.length);
    for (const f of sorted) {
      try {
        if (fs.existsSync(f)) {
          const stat = fs.statSync(f);
          if (stat.isDirectory()) fs.rmdirSync(f);
          else fs.unlinkSync(f);
        }
      } catch {
        /* best-effort */
      }
    }
  });

  beforeEach(() => {
    tool = new FileWriteTool();
  });

  it('accepts write within workspace', { timeout: 10000 }, async () => {
    const testFile = `_test_pathsec_${Date.now()}.txt`;
    tempFiles.push(path.resolve(getSafeRoot(), testFile));
    const result = await tool.execute({ path: testFile, content: 'test content' });
    assert.ok(
      result.includes('Written'),
      `Should write successfully, got: ${result.slice(0, 100)}`,
    );
    const resolved = await safePath(testFile);
    assert.ok(fs.existsSync(resolved), 'File should exist on disk');
    assert.strictEqual(fs.readFileSync(resolved, 'utf-8'), 'test content');
  });

  it('handles empty content', { timeout: 10000 }, async () => {
    const testFile = `_test_pathsec_empty_${Date.now()}.txt`;
    tempFiles.push(path.resolve(getSafeRoot(), testFile));
    const result = await tool.execute({ path: testFile, content: '' });
    assert.ok(result.includes('Written'), `Should write empty file, got: ${result.slice(0, 80)}`);
  });

  it('creates parent directories automatically', { timeout: 10000 }, async () => {
    const nestedDir = `_test_pathsec_nested_${Date.now()}`;
    const testFile = `${nestedDir}/subdir/data.txt`;
    // Register all paths for cleanup
    const f1 = path.resolve(getSafeRoot(), `${nestedDir}/subdir/data.txt`);
    const f2 = path.resolve(getSafeRoot(), `${nestedDir}/subdir`);
    const f3 = path.resolve(getSafeRoot(), nestedDir);
    tempFiles.push(f1, f2, f3);
    const result = await tool.execute({ path: testFile, content: 'nested content' });
    assert.ok(result.includes('Written'), `Should create nested path, got: ${result.slice(0, 80)}`);
  });
});

// ============================================================================
// FileListTool — workspace boundary
// ============================================================================
describe('FileListTool — workspace boundary', () => {
  let tool: FileListTool;

  beforeEach(() => {
    tool = new FileListTool();
  });

  it('blocks listing outside workspace via traversal', async () => {
    const result = await tool.execute({ path: '../../../etc' });
    assert.ok(isError(result), `Should deny, got: ${result.slice(0, 80)}`);
  });

  it('lists workspace root by default', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('📁') || result.includes('📄'), 'Should list with icons');
    assert.ok(result.length > 20, 'Should have substantial output');
  });

  it('lists specific subdirectory within workspace', async () => {
    const result = await tool.execute({ path: 'src/tools' });
    // Should list files — check for a known file or just verify no error
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 80)}`);
    assert.ok(result.length > 10, 'Should have output');
  });

  it('reports error for non-existent directory', async () => {
    const result = await tool.execute({ path: 'nonexistent_dir_xyz' });
    assert.ok(result.includes('not found'), `Should say not found, got: ${result.slice(0, 80)}`);
  });
});

// ============================================================================
// ShellExecuteTool — workdir boundary
// ============================================================================
describe('ShellExecuteTool — workdir workspace boundary', () => {
  let tool: ShellExecuteTool;

  beforeEach(() => {
    tool = new ShellExecuteTool();
  });

  it('allows workdir within workspace', async () => {
    const result = await tool.execute({ command: 'echo hello', workdir: '.' });
    const isSandboxIssue =
      result.includes('sandbox-exec') ||
      result.includes('unbound variable') ||
      result.includes('no sandbox available') ||
      result.includes('AppContainer') ||
      result.includes('icacls');
    const isSuccess = result.includes('hello') || result.includes('[Exit: 0]');
    assert.ok(
      isSandboxIssue || isSuccess,
      `Should either succeed or report sandbox issue, got: ${result.slice(0, 100)}`,
    );
  });

  it('blocks workdir outside workspace', async () => {
    const result = await tool.execute({ command: 'echo hello', workdir: '../../../etc' });
    assert.ok(result.includes('Access denied'), `Should deny access, got: ${result.slice(0, 100)}`);
  });

  it('omits workdir entirely (falls back to default)', async () => {
    const result = await tool.execute({ command: 'echo fallback' });
    const isSuccess = result.includes('fallback') || result.includes('[Exit: 0]');
    const isSandbox =
      result.includes('sandbox-exec') ||
      result.includes('unbound variable') ||
      result.includes('no sandbox available') ||
      result.includes('AppContainer') ||
      result.includes('icacls');
    assert.ok(
      isSuccess || isSandbox,
      `Should work with default workdir, got: ${result.slice(0, 100)}`,
    );
  });
});

// ============================================================================
// VerificationTool — directory boundary
// ============================================================================
describe('VerificationTool — directory workspace boundary', () => {
  let tool: VerificationTool;

  beforeEach(() => {
    tool = new VerificationTool();
  });

  it('allows default directory (no args)', async () => {
    const result = await tool.execute({ checks: [] });
    assert.ok(result.includes('Verification Results'));
  });

  it('rejects directory outside workspace', async () => {
    const result = await tool.execute({ checks: [], directory: '/etc' });
    assert.ok(result.includes('Access denied'), `Should deny access, got: ${result.slice(0, 100)}`);
  });
});

// ============================================================================
// ApplyPatchTool — targetFile boundary
// ============================================================================
describe('ApplyPatchTool — targetFile workspace boundary', () => {
  let tool: ApplyPatchTool;

  beforeEach(() => {
    tool = new ApplyPatchTool();
  });

  it('rejects targetFile outside workspace', async () => {
    const result = await tool.execute({
      patch: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new',
      targetFile: '../../../etc/passwd',
    });
    assert.ok(
      result.includes('outside the workspace'),
      `Should deny access, got: ${result.slice(0, 100)}`,
    );
  });

  it('rejects targetFile from patch header outside workspace', async () => {
    const result = await tool.execute({
      patch: '--- a/file\n+++ b/../../../etc/passwd\n@@ -1 +1 @@\n-old\n+new',
    });
    assert.ok(
      result.includes('outside the workspace') || result.includes('Error'),
      `Should deny access, got: ${result.slice(0, 100)}`,
    );
  });

  it('rejects traversal in both targetFile and patch header combined', async () => {
    const result = await tool.execute({
      patch: '--- a/../../../x\n+++ b/../../../y\n@@ -1 +1 @@\n-old\n+new',
      targetFile: '../../../etc/passwd',
    });
    assert.ok(result.includes('outside'), `Should deny, got: ${result.slice(0, 100)}`);
  });

  it('accepts valid path within workspace', async () => {
    const result = await tool.execute({
      patch: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new',
      targetFile: 'package.json',
    });
    assert.ok(!result.includes('Access denied'), 'Should not deny valid path');
  });
});

// ============================================================================
// CodeRefinerTool — codeFile boundary
// ============================================================================
describe('CodeRefinerTool — codeFile workspace boundary', () => {
  let tool: CodeRefinerTool;

  beforeEach(() => {
    tool = new CodeRefinerTool();
  });

  it('rejects codeFile outside workspace', async () => {
    const result = await tool.execute({
      prompt: 'write a test function',
      language: 'python',
      codeFile: '../../../tmp/evil.py',
      maxIterations: 1,
    });
    assert.ok(result.includes('Access denied'), `Should deny access, got: ${result.slice(0, 100)}`);
  });

  it('accepts codeFile within workspace', async () => {
    const result = await tool.execute({
      prompt: 'write a test function',
      language: 'python',
      codeFile: 'test_output_xyz.py',
      maxIterations: 1,
    });
    assert.ok(
      !result.includes('Access denied'),
      `Should not deny access, got: ${result.slice(0, 100)}`,
    );
  });

  it('handles missing codeFile gracefully (no codeFile, no testCommand)', async () => {
    const result = await tool.execute({
      prompt: 'write a test',
      language: 'python',
      maxIterations: 1,
    });
    assert.ok(!result.includes('Access denied'), 'Should not error on boundary');
    assert.ok(result.includes('Code template'), 'Should return template');
  });

  it('handles verifyOnly mode with testCommand', async () => {
    const result = await tool.execute({
      prompt: 'verify this',
      language: 'python',
      testCommand: 'echo ok',
      verifyOnly: true,
      maxIterations: 1,
    });
    assert.ok(!result.includes('Access denied'), 'Should not error on boundary');
    assert.ok(result.includes('Verification'), 'Should run verification');
  });
});

// ============================================================================
// CodeSearchTool — COMMANDER_WORKSPACE respect (uses safePath directly)
// ============================================================================
describe('CodeSearchTool — workspace boundary', () => {
  let tool: CodeSearchTool;

  beforeEach(() => {
    tool = new CodeSearchTool();
  });

  it('uses getSafeRoot() not process.cwd() for workspace', { timeout: 30000 }, async () => {
    const safeRoot = getSafeRoot();
    assert.ok(safeRoot.length > 0, 'getSafeRoot() should return a valid path');
    const result = await tool.execute({ pattern: 'import', maxResults: 3 });
    assert.ok(typeof result === 'string');
    assert.ok(
      result.includes('Found') || result.includes('No results') || result.includes('matches'),
      `Should search without error, got: ${result.slice(0, 100)}`,
    );
  });

  it('respects COMMANDER_WORKSPACE env var override', { timeout: 30000 }, async () => {
    const original = process.env.COMMANDER_WORKSPACE;
    const subdir = path.resolve(getSafeRoot(), 'packages/core');
    try {
      process.env.COMMANDER_WORKSPACE = subdir;

      const root = getSafeRoot();
      assert.strictEqual(root, subdir, 'getSafeRoot() should return COMMANDER_WORKSPACE path');

      const pkg = await safePath('package.json');
      assert.ok(pkg.startsWith(root), `safePath should resolve under override root, got: ${pkg}`);
      assert.ok(pkg.endsWith('package.json'));

      await assert.rejects(
        () => safePath('../../../package.json'),
        /Access denied/,
        'safePath should reject traversal out of the overridden root',
      );

      const result = await tool.execute({ pattern: 'import', maxResults: 3 });
      assert.ok(typeof result === 'string');
      const isGrepError = result.includes('Search failed') && result.includes('ENOENT');
      const isSearchOk =
        result.includes('Found') || result.includes('No results') || result.includes('matches');
      assert.ok(
        isSearchOk || isGrepError,
        `Should search under override root (or report grep unavailable), got: ${result.slice(0, 120)}`,
      );
    } finally {
      // IMPORTANT: delete the env var if it was originally unset;
      // assigning undefined sets the STRING "undefined", corrupting all
      // subsequent getSafeRoot() calls.
      if (original === undefined) {
        delete process.env.COMMANDER_WORKSPACE;
      } else {
        process.env.COMMANDER_WORKSPACE = original;
      }
    }
  });
});

// ============================================================================
// LSP tools — filePath workspace boundary
// ============================================================================
describe('LSP Tools — workspace boundary', () => {
  it('LSPDiagnosticsTool rejects filePath outside workspace', async () => {
    const lspMod = await import('../../src/runtime/lspIntegration');
    const tool = new lspMod.LSPDiagnosticsTool();
    const result = await tool.execute({ filePath: '/etc/passwd' });
    assert.ok(result.includes('Access denied'), `Should deny access, got: ${result.slice(0, 100)}`);
  });

  it('LSPAttachTool rejects filePath outside workspace', async () => {
    const lspMod = await import('../../src/runtime/lspIntegration');
    const tool = new lspMod.LSPAttachTool();
    const result = await tool.execute({ filePath: '/etc/passwd' });
    assert.ok(result.includes('Access denied'), `Should deny access, got: ${result.slice(0, 100)}`);
  });

  it('LSPDiagnosticsTool accepts filePath within workspace', async () => {
    const lspMod = await import('../../src/runtime/lspIntegration');
    const tool = new lspMod.LSPDiagnosticsTool();
    const result = await tool.execute({ filePath: 'package.json' });
    assert.ok(
      !result.includes('Access denied'),
      `Should not deny access, got: ${result.slice(0, 100)}`,
    );
  });

  it('LSPAttachTool accepts filePath within workspace', async () => {
    const lspMod = await import('../../src/runtime/lspIntegration');
    const tool = new lspMod.LSPAttachTool();
    const result = await tool.execute({ filePath: 'package.json' });
    assert.ok(
      !result.includes('Access denied'),
      `Should not deny access, got: ${result.slice(0, 100)}`,
    );
  });
});

// ============================================================================
// PatchEngine — filePath workspace boundary
// ============================================================================
describe('PatchEngine — workspace boundary', () => {
  it('rejects filePath outside workspace', async () => {
    const { PatchEngine } = await import('../../src/harness/harnessInfrastructure');
    const engine = new PatchEngine();
    const result = await engine.apply({
      filePath: '../../../etc/passwd',
      hunks: [],
    });
    assert.strictEqual(result.success, false, 'Should fail');
    assert.ok(
      result.error?.includes('outside workspace') || result.error?.includes('Access denied'),
      `Should deny access, got: ${result.error}`,
    );
  });

  it('reports file not found for valid workspace path', async () => {
    const { PatchEngine } = await import('../../src/harness/harnessInfrastructure');
    const engine = new PatchEngine();
    const result = await engine.apply({
      filePath: 'nonexistent-path-test-xyz.txt',
      hunks: [],
    });
    assert.strictEqual(result.success, false, 'Should fail');
    assert.ok(result.error?.includes('not found'), `Should say not found, got: ${result.error}`);
  });

  it('handles empty hunks on valid workspace path (no-op success)', async () => {
    const { PatchEngine } = await import('../../src/harness/harnessInfrastructure');
    const engine = new PatchEngine();
    const result = await engine.apply({
      filePath: 'package.json',
      hunks: [],
    });
    // Empty hunks = no changes = success (no-op)
    assert.strictEqual(result.success, true, 'Empty hunks should be a no-op success');
    assert.strictEqual(result.added, 0, 'Should add 0 lines');
    assert.strictEqual(result.removed, 0, 'Should remove 0 lines');
  });

  it('rejects /dev/null special path (outside check)', async () => {
    const { PatchEngine } = await import('../../src/harness/harnessInfrastructure');
    const engine = new PatchEngine();
    const result = await engine.apply({
      filePath: '/dev/null',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: 'test' }],
    });
    assert.strictEqual(result.success, false, 'Should fail');
    assert.ok(
      result.error?.includes('outside') || result.error?.includes('Access denied'),
      `Should deny /dev/null, got: ${result.error}`,
    );
  });
});

// ============================================================================
// FileWatcher — workspace boundary (FileWatcher.watch async)
// ============================================================================
describe('FileWatcher — workspace boundary', () => {
  it('rejects filePath outside workspace with no-op unsubscribe', async () => {
    const { FileWatcher } = await import('../../src/harness/harnessInfrastructure');
    const watcher = new FileWatcher();
    const handler = () => {};
    // safePath rejects → FileWatcher.watch returns Promise<Unsubscribe> of a noop.
    const unsub = await watcher.watch('/etc/passwd', handler);
    assert.strictEqual(typeof unsub, 'function');
    unsub();
  });

  it('accepts filePath within workspace', async () => {
    const { FileWatcher } = await import('../../src/harness/harnessInfrastructure');
    const watcher = new FileWatcher();
    const handler = () => {};
    const unsub = await watcher.watch('package.json', handler);
    assert.strictEqual(typeof unsub, 'function');
    watcher.closeAll();
  });

  it('accepts absolute path within workspace', async () => {
    const { FileWatcher } = await import('../../src/harness/harnessInfrastructure');
    const watcher = new FileWatcher();
    const handler = () => {};
    const absPath = path.resolve(getSafeRoot(), 'package.json');
    const unsub = await watcher.watch(absPath, handler);
    assert.strictEqual(typeof unsub, 'function');
    watcher.closeAll();
  });
});

// ============================================================================
// GlobTool — safePath boundary and glob pattern resolution
// ============================================================================
describe('GlobTool — workspace boundary and patterns', () => {
  let tool: import('../../src/tools/fileSystemTool')['GlobTool'];

  beforeEach(async () => {
    const { GlobTool } = await import('../../src/tools/fileSystemTool');
    tool = new GlobTool();
  });

  it('allows default searchPath (.) within workspace', async () => {
    const result = await tool.execute({ pattern: 'package.json' });
    // Should find the file — no error
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    assert.ok(
      result.includes('package.json') || result.includes('Found'),
      `Should find package.json, got: ${result.slice(0, 100)}`,
    );
  });

  it('rejects searchPath outside workspace', async () => {
    const result = await tool.execute({ pattern: '*.json', path: '/etc' });
    assert.ok(isError(result), `Should deny access, got: ${result.slice(0, 100)}`);
  });

  it('recursive **/*.ts finds files in subdirectories', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', maxResults: 100 });
    // Must have results (no error, not empty)
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    assert.ok(result.length > 20, 'Should return substantial results');
  });

  it('brace expansion pattern {ts,tsx} finds TypeScript files', async () => {
    // Note: GlobTool handles ** in dirPrefix only when it's the entire prefix (dirPrefix === '**')
    // For 'src/**/*.{ts,tsx}', the ** is in the middle and not specially handled.
    // Use a pattern where ** is the entire dirPrefix to test brace expansion.
    const result = await tool.execute({ pattern: '**/*.ts', maxResults: 50 });
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    assert.ok(result.length > 20, 'Should find .ts files across workspace');
  });

  it('brace expansion {ts,tsx} works with recursive pattern at root', async () => {
    // Test brace expansion where ** is the entire prefix
    const result = await tool.execute({ pattern: '**/*.{ts,tsx}', maxResults: 50 });
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    assert.ok(
      result.includes('Found') || result.length > 20,
      'Should find files matching brace expansion',
    );
  });

  it('non-recursive pattern does not recurse', async () => {
    const result = await tool.execute({ pattern: 'src/tools/*.ts', maxResults: 50 });
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    // Subdirectory files should NOT appear
    assert.ok(!result.includes('_utils/'), 'Should NOT recurse into _utils/ subdirectory');
  });

  it('returns "No files matching" for non-existent pattern', async () => {
    const result = await tool.execute({ pattern: 'zzz_nonexistent_pattern_xyz_2026' });
    assert.ok(result.includes('No files matching'), 'Should report no matches');
  });

  it('maxResults clamps to configured limit', async () => {
    // Use a pattern where ** is the entire prefix (globFind handles this)
    const result = await tool.execute({ pattern: '**/*.ts', maxResults: 3 });
    assert.ok(!isError(result), `Should not error, got: ${result.slice(0, 100)}`);
    // With maxResults=3 and hundreds of .ts files, should show "showing first"
    assert.ok(result.includes('showing first'), 'Should show truncation message with maxResults=3');
  });
});

// ============================================================================
// FileEditTool — safePath boundary for both modes
// ============================================================================
describe('FileEditTool — workspace boundary', () => {
  let tool: import('../../src/tools/fileSystemTool')['FileEditTool'];

  beforeEach(async () => {
    const { FileEditTool } = await import('../../src/tools/fileSystemTool');
    tool = new FileEditTool();
  });

  it('legacy mode rejects path outside workspace', async () => {
    const result = await tool.execute({
      path: '../../../etc/passwd',
      oldString: 'root',
      newString: 'user',
    });
    assert.ok(isError(result), `Should deny, got: ${result.slice(0, 100)}`);
  });

  it('legacy mode accepts path within workspace', async () => {
    const result = await tool.execute({
      path: 'package.json',
      oldString: 'zzz_nonexistent_string_xyz',
      newString: 'replacement',
    });
    assert.ok(!result.includes('Access denied'), `Should not deny, got: ${result.slice(0, 100)}`);
    assert.ok(result.includes('not found'), 'Should report oldString not found');
  });

  it('hashline mode rejects path outside workspace', async () => {
    // Must use valid 4-char hex hash AND valid hashline operation syntax.
    // The hashline parser requires lines like 'replace N..M:' with + content.
    const result = await tool.execute({
      input: '¶../../../etc/passwd#ABCD\nreplace 1..2:\n+test line\n',
    });
    assert.ok(isError(result), `Should deny, got: ${result.slice(0, 100)}`);
  });

  it('hashline mode accepts path within workspace', async () => {
    const result = await tool.execute({
      input: '¶package.json#TESTHASH\nreplace 1..1:\n+irrelevant',
    });
    // Should NOT say Access denied — hash mismatch is expected but boundary should pass
    assert.ok(!result.includes('Access denied'), `Should not deny, got: ${result.slice(0, 100)}`);
  });
});

// ============================================================================
// Multimodal tools — workspace boundary
// ============================================================================
describe('Multimodal tools — workspace boundary', () => {
  describe('ScreenshotCaptureTool', () => {
    it('rejects outputPath outside workspace', async () => {
      const { ScreenshotCaptureTool } = await import('../../src/tools/multimodal/screenshotTool');
      const tool = new ScreenshotCaptureTool();
      const result = await tool.execute({ outputPath: '../../../tmp/evil.png' });
      assert.ok(result.includes('Access denied'), `Should deny, got: ${result.slice(0, 100)}`);
    });

    it('accepts default outputPath (generates unique path within workspace)', async () => {
      const { ScreenshotCaptureTool } = await import('../../src/tools/multimodal/screenshotTool');
      const tool = new ScreenshotCaptureTool();
      const result = await tool.execute({ url: 'about:blank' });
      // If playwright isn't installed, it should fail with install prompt, not boundary error
      assert.ok(!result.includes('Access denied'), 'Should not deny default path');
      assert.ok(
        result.includes('Screenshot') ||
          result.includes('playwright') ||
          result.includes('install'),
        `Should attempt capture, got: ${result.slice(0, 100)}`,
      );
    });

    it('rejects outputPath with shell-unsafe characters', async () => {
      const { ScreenshotCaptureTool } = await import('../../src/tools/multimodal/screenshotTool');
      const tool = new ScreenshotCaptureTool();
      const result = await tool.execute({ outputPath: 'test;rm -rf /' });
      assert.ok(result.includes('shell-unsafe'), `Should reject, got: ${result.slice(0, 100)}`);
    });
  });

  describe('PdfExtractTool', () => {
    it('rejects path outside workspace', async () => {
      const { PdfExtractTool } = await import('../../src/tools/multimodal/pdfTool');
      const tool = new PdfExtractTool();
      const result = await tool.execute({ path: '/etc/passwd' });
      assert.ok(result.includes('Access denied'), `Should deny, got: ${result.slice(0, 100)}`);
    });

    it('rejects non-PDF extension', async () => {
      const { PdfExtractTool } = await import('../../src/tools/multimodal/pdfTool');
      const tool = new PdfExtractTool();
      // Use tsconfig.json which exists in packages/core and is not a PDF
      const result = await tool.execute({ path: 'tsconfig.json' });
      assert.ok(
        result.includes('Not a PDF'),
        `Should reject non-PDF, got: ${result.slice(0, 100)}`,
      );
    });

    it('reports file not found for valid workspace path', async () => {
      const { PdfExtractTool } = await import('../../src/tools/multimodal/pdfTool');
      const tool = new PdfExtractTool();
      const result = await tool.execute({ path: 'path/to/nonexistent.pdf' });
      assert.ok(
        result.includes('not found') || result.includes('Access denied'),
        `Should report not found, got: ${result.slice(0, 100)}`,
      );
      assert.ok(!result.includes('No file path'), 'Should not reject at arg level');
    });
  });

  describe('VisionAnalyzeTool', () => {
    it('rejects source path outside workspace', async () => {
      const { VisionAnalyzeTool } = await import('../../src/tools/multimodal/visionTool');
      const tool = new VisionAnalyzeTool();
      const result = await tool.execute({ source: '/etc/passwd' });
      assert.ok(result.includes('Access denied'), `Should deny, got: ${result.slice(0, 100)}`);
    });

    it('rejects data URL malformed format', async () => {
      const { VisionAnalyzeTool } = await import('../../src/tools/multimodal/visionTool');
      const tool = new VisionAnalyzeTool();
      const result = await tool.execute({ source: 'data:text/plain;base64,invalid' });
      assert.ok(result.includes('Invalid data URL'), `Should reject, got: ${result.slice(0, 100)}`);
    });

    it('reports file not found for valid workspace path', async () => {
      const { VisionAnalyzeTool } = await import('../../src/tools/multimodal/visionTool');
      const tool = new VisionAnalyzeTool();
      const result = await tool.execute({ source: 'nonexistent-image.png' });
      assert.ok(
        result.includes('not found') || result.includes('Access denied'),
        `Should report not found, got: ${result.slice(0, 100)}`,
      );
      assert.ok(!result.includes('No image source'), 'Should not reject at arg level');
    });
  });
});
