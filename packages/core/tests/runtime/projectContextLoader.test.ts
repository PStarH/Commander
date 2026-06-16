import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadProjectContext, buildProjectContextBlock, computeProjectContextCacheKey } from '../../src/runtime/projectContextLoader.js';

interface FileSnapshot {
  filePath: string;
  mtimeMs: number;
  content: string;
}

describe('loadProjectContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-project-context-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty context when no files exist', () => {
    const ctx = loadProjectContext(tmpDir);
    assert.deepStrictEqual(ctx.filesRead, []);
    assert.strictEqual(ctx.content, '');
    assert.match(ctx.cacheKey, /^[0-9a-f]{64}$/);
  });

  it('reads PROJECT.md when present', () => {
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), '# Project\n\nUse TypeScript strict mode.');
    const ctx = loadProjectContext(tmpDir);
    assert.deepStrictEqual(ctx.filesRead, [path.join(tmpDir, 'PROJECT.md')]);
    assert.match(ctx.content, /PROJECT\.md/);
    assert.match(ctx.content, /Use TypeScript strict mode/);
  });

  it('merges multiple files in precedence order', () => {
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), '# Project');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude\n\nPrefer interfaces.');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\n\nUse tabs, not spaces.');
    const ctx = loadProjectContext(tmpDir);
    assert.strictEqual(ctx.filesRead.length, 3);
    assert.strictEqual(ctx.filesRead[0], path.join(tmpDir, 'PROJECT.md'));
    assert.strictEqual(ctx.filesRead[1], path.join(tmpDir, 'CLAUDE.md'));
    assert.strictEqual(ctx.filesRead[2], path.join(tmpDir, 'AGENTS.md'));
    const projectIndex = ctx.content.indexOf('# Project');
    const claudeIndex = ctx.content.indexOf('Prefer interfaces');
    const agentsIndex = ctx.content.indexOf('Use tabs, not spaces');
    assert.ok(projectIndex < claudeIndex);
    assert.ok(claudeIndex < agentsIndex);
  });

  it('skips empty files', () => {
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), '   ');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\n\nImportant.');
    const ctx = loadProjectContext(tmpDir);
    assert.strictEqual(ctx.filesRead.length, 1);
    assert.strictEqual(ctx.filesRead[0], path.join(tmpDir, 'AGENTS.md'));
  });

  it('produces stable cache key for unchanged files', () => {
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), '# Project');
    const a = loadProjectContext(tmpDir);
    const b = loadProjectContext(tmpDir);
    assert.strictEqual(a.cacheKey, b.cacheKey);
  });

  it('changes cache key when file content changes', () => {
    const filePath = path.join(tmpDir, 'PROJECT.md');
    fs.writeFileSync(filePath, '# Project');
    const before = loadProjectContext(tmpDir);

    // Ensure mtime changes
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(filePath, future, future);
    fs.writeFileSync(filePath, '# Project\n\nUpdated.');

    const after = loadProjectContext(tmpDir);
    assert.notStrictEqual(before.cacheKey, after.cacheKey);
  });

  it('caps files at MAX_FILE_BYTES', () => {
    const huge = 'x'.repeat(100_000);
    fs.writeFileSync(path.join(tmpDir, 'PROJECT.md'), `# Project\n\n${huge}\n\nEND`);
    const ctx = loadProjectContext(tmpDir);
    assert.ok(ctx.content.length < 100_000);
    assert.doesNotMatch(ctx.content, /END$/);
  });

  it('uses process.cwd() as default project path', () => {
    // This test just verifies the function accepts no arguments and returns a valid context.
    const ctx = loadProjectContext();
    assert.ok(Array.isArray(ctx.filesRead));
    assert.strictEqual(typeof ctx.cacheKey, 'string');
  });
});

describe('buildProjectContextBlock', () => {
  it('returns empty string when no files were read', () => {
    const block = buildProjectContextBlock({ filesRead: [], content: '', cacheKey: 'abc' });
    assert.strictEqual(block, '');
  });

  it('returns formatted block when context exists', () => {
    const block = buildProjectContextBlock({
      filesRead: ['/path/PROJECT.md'],
      content: '<!-- PROJECT.md -->\n# Project',
      cacheKey: 'abc',
    });
    assert.match(block, /<project_context>/);
    assert.match(block, /<\/project_context>/);
    assert.match(block, /PROJECT\.md/);
    assert.match(block, /# Project/);
  });
});

describe('computeProjectContextCacheKey', () => {
  it('is deterministic for identical snapshots', () => {
    const snapshots: FileSnapshot[] = [
      { filePath: '/a/PROJECT.md', mtimeMs: 123, content: 'x' },
    ];
    const a = computeProjectContextCacheKey(snapshots);
    const b = computeProjectContextCacheKey(snapshots);
    assert.strictEqual(a, b);
  });

  it('differs when mtime changes', () => {
    const a = computeProjectContextCacheKey([{ filePath: '/a/PROJECT.md', mtimeMs: 123, content: 'x' }]);
    const b = computeProjectContextCacheKey([{ filePath: '/a/PROJECT.md', mtimeMs: 456, content: 'x' }]);
    assert.notStrictEqual(a, b);
  });

  it('differs when file set changes', () => {
    const a = computeProjectContextCacheKey([{ filePath: '/a/PROJECT.md', mtimeMs: 123, content: 'x' }]);
    const b = computeProjectContextCacheKey([
      { filePath: '/a/PROJECT.md', mtimeMs: 123, content: 'x' },
      { filePath: '/a/AGENTS.md', mtimeMs: 123, content: 'y' },
    ]);
    assert.notStrictEqual(a, b);
  });
});
