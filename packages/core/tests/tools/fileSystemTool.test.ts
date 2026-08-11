/**
 * Unit tests for FileSystem tools (file_read, file_write, file_edit, file_search, file_list).
 *
 * Note: These tests use the current working directory as the workspace root.
 * The SAFE_ROOT is set at module load time, so we work within the existing workspace.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  FileSearchTool,
  FileListTool,
  isWithinRoot,
  safePath,
} from '../../src/tools/fileSystemTool';

describe('isWithinRoot', () => {
  it('treats Windows drive paths as case-insensitive boundaries', () => {
    assert.strictEqual(
      isWithinRoot(
        String.raw`C:\Users\RunnerAdmin\AppData\Local\Temp\workspace\reports`,
        String.raw`c:\users\runneradmin\appdata\local\temp\workspace`,
      ),
      true,
    );
  });

  it('normalizes Windows namespace paths before containment checks', () => {
    assert.strictEqual(
      isWithinRoot(
        String.raw`\\?\C:\Users\runneradmin\workspace\reports`,
        String.raw`C:\Users\runneradmin\workspace`,
      ),
      true,
    );
  });

  it('rejects Windows traversal after path normalization', () => {
    assert.strictEqual(
      isWithinRoot(
        String.raw`C:\Users\runneradmin\workspace\..\outside`,
        String.raw`C:\Users\runneradmin\workspace`,
      ),
      false,
    );
  });

  it('rejects an 8.3-style sibling that only shares a textual prefix', () => {
    assert.strictEqual(
      isWithinRoot(String.raw`C:\workspace-evil\reports`, String.raw`C:\workspace`),
      false,
    );
  });

  it(
    'resolves an actual Windows 8.3 workspace alias before containment',
    {
      skip: process.platform !== 'win32',
    },
    async () => {
      const originalWorkspace = process.env.COMMANDER_WORKSPACE;
      const workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(process.env.TEMP ?? 'C:\\Temp', 'commander-8point3-')),
      );
      const file = path.join(workspace, 'existing.txt');
      fs.writeFileSync(file, 'ok');

      try {
        const shortPath = spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/c', `for %I in ("${workspace}") do @echo %~sI`],
          { encoding: 'utf8' },
        );
        assert.strictEqual(shortPath.error, undefined);
        assert.strictEqual(shortPath.status, 0, shortPath.stderr);
        const shortWorkspace = shortPath.stdout.trim().split(/\r?\n/).at(-1);
        assert.ok(shortWorkspace, shortPath.stdout);

        if (!/~\d/.test(shortWorkspace!)) {
          console.warn(
            '[pathSecurity] Windows 8.3 short-path capability unavailable; using real junction/case coverage',
          );
          const linkedWorkspace = path.join(path.dirname(workspace), 'CommanderCaseLink');
          fs.symlinkSync(workspace, linkedWorkspace, 'junction');
          try {
            process.env.COMMANDER_WORKSPACE = linkedWorkspace.toUpperCase();
            const resolved = await safePath('existing.txt');
            assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(file));
          } finally {
            fs.rmSync(linkedWorkspace, { recursive: true, force: true });
          }
          return;
        }

        process.env.COMMANDER_WORKSPACE = shortWorkspace!.toUpperCase();
        const resolved = await safePath('existing.txt');
        assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(file));
      } finally {
        if (originalWorkspace === undefined) delete process.env.COMMANDER_WORKSPACE;
        else process.env.COMMANDER_WORKSPACE = originalWorkspace;
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});

describe('FileReadTool', () => {
  let tool: FileReadTool;

  beforeEach(() => {
    tool = new FileReadTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_read');
    assert.strictEqual(tool.definition.category, 'filesystem');
    assert.ok(tool.definition.description);
    assert.ok(tool.definition.inputSchema);
  });

  it('reads package.json', async () => {
    const result = await tool.execute({ path: 'package.json' });
    assert.ok(result.includes('name') || result.includes('version'));
    assert.ok(result.includes('1:'), 'Should have hashline numbered content');
  });

  it('returns error for missing path', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('path'));
  });

  it('returns error for nonexistent file', async () => {
    const result = await tool.execute({ path: 'nonexistent-file-xyz.txt' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
  });

  it('truncates when maxChars is small', async () => {
    const result = await tool.execute({ path: 'package.json', maxChars: 20 });
    assert.ok(result.includes('truncated'));
  });

  it('includes line numbers', async () => {
    const result = await tool.execute({ path: 'package.json' });
    assert.ok(result.match(/^1:/m), 'Line 1 should be numbered');
    assert.ok(result.match(/^2:/m), 'Line 2 should be numbered');
  });

  it('blocks path traversal', async () => {
    const result = await tool.execute({ path: '../../../etc/passwd' });
    assert.ok(result.includes('Error'));
  });
});

describe('FileWriteTool', () => {
  let tool: FileWriteTool;

  beforeEach(() => {
    tool = new FileWriteTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_write');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('returns error for missing path', async () => {
    const result = await tool.execute({ content: 'test' });
    assert.ok(result.includes('Error'));
  });

  it('handles missing content', async () => {
    // Tool may write empty string or return error
    const result = await tool.execute({ path: 'test-empty.txt' });
    assert.ok(typeof result === 'string');
  });

  it('blocks path traversal', async () => {
    const result = await tool.execute({ path: '../../../tmp/evil.txt', content: 'evil' });
    assert.ok(result.includes('Error'));
  });
});

describe('FileEditTool', () => {
  let tool: FileEditTool;

  beforeEach(() => {
    tool = new FileEditTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_edit');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('returns error for missing parameters', async () => {
    const result = await tool.execute({ path: 'test.txt' });
    assert.ok(result.includes('Error'));
  });

  it('returns error for nonexistent file', async () => {
    const result = await tool.execute({
      path: 'nonexistent-xyz.txt',
      oldString: 'old',
      newString: 'new',
    });
    assert.ok(result.includes('Error'));
  });
});

describe('FileSearchTool', () => {
  let tool: FileSearchTool;

  beforeEach(() => {
    tool = new FileSearchTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_search');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('searches for TypeScript files', async () => {
    const result = await tool.execute({ pattern: 'src/**/*.ts' });
    assert.ok(result.includes('.ts'));
  });

  it('returns error for missing pattern', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });
});

describe('FileListTool', () => {
  let tool: FileListTool;

  beforeEach(() => {
    tool = new FileListTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'file_list');
    assert.strictEqual(tool.definition.category, 'filesystem');
  });

  it('lists root directory', async () => {
    const result = await tool.execute({ path: '.' });
    assert.ok(result.includes('src'));
    assert.ok(result.includes('package.json'));
  });

  it('lists src directory', async () => {
    const result = await tool.execute({ path: 'src' });
    assert.ok(result.includes('tools'));
    assert.ok(result.includes('runtime'));
  });

  it('returns error for nonexistent directory', async () => {
    const result = await tool.execute({ path: 'nonexistent-dir-xyz' });
    assert.ok(result.includes('Error'));
  });
});
