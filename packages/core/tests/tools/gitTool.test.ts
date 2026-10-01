/**
 * Unit tests for GitTool.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitTool } from '../../src/tools/gitTool';
import { getSafeRoot } from '../../src/tools/fileSystemTool';
import { setMultiTenantEnabled } from '../../src/runtime/tenantContext';

describe('GitTool', () => {
  let tool: GitTool;

  beforeEach(() => {
    tool = new GitTool();
  });

  it('has correct definition', () => {
    assert.strictEqual(tool.definition.name, 'git');
    assert.ok(tool.definition.description);
  });

  it('has required parameters', () => {
    const schema = tool.definition.inputSchema;
    assert.ok(schema.properties.command);
    assert.ok(schema.required.includes('command'));
  });

  it('returns error for missing command', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('shows git status', async () => {
    const result = await tool.execute({ command: 'status' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('shows git log', async () => {
    const result = await tool.execute({ command: 'log --oneline -5' });
    assert.ok(typeof result === 'string');
  });

  it('shows git branch', async () => {
    const result = await tool.execute({ command: 'branch' });
    assert.ok(typeof result === 'string');
  });
});

describe('GitTool — workdir containment', () => {
  let tool: GitTool;

  beforeEach(() => {
    tool = new GitTool();
  });

  // TR-01: the workdir boundary used to swallow a thrown TenantIsolationError
  // and fall back to `process.cwd()`, so the model-supplied workdir reached
  // git in the host checkout. A missing tenant binding must fail closed.
  it('fails closed instead of falling back to the host cwd when no tenant is bound', async () => {
    setMultiTenantEnabled(true);
    try {
      await assert.rejects(
        () => tool.execute({ command: 'status', workdir: '.' }),
        /tenant context/i,
      );
    } finally {
      setMultiTenantEnabled(false);
    }
  });

  // TR-01: containment was lexical only (`isWithinRoot`), so a symlink living
  // inside the workspace could point git at a directory outside it.
  it('rejects a workdir symlink that escapes the workspace', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gittool-escape-')));
    const linkName = `_test_gittool_escape_${Date.now().toString(36)}`;
    const linkPath = path.join(getSafeRoot(), linkName);
    fs.symlinkSync(outside, linkPath, 'dir');
    try {
      const result = await tool.execute({ command: 'status', workdir: linkName });
      assert.ok(
        result.includes('Access denied'),
        `Escaping workdir symlink must be denied, got: ${result.slice(0, 200)}`,
      );
    } finally {
      fs.unlinkSync(linkPath);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('GitTool — host command config', () => {
  let tool: GitTool;

  beforeEach(() => {
    tool = new GitTool();
  });

  it('rejects git config, including writes outside the workdir', async () => {
    const result = await tool.execute({ command: 'config --file /tmp/pwned.ini core.foo bar' });
    assert.match(result, /not in the allowed commands list/);
  });

  it('does not run a repository fsmonitor command', async () => {
    const root = getSafeRoot();
    const dir = fs.mkdtempSync(path.join(root, '.gittool-fsmonitor-'));
    const marker = path.join(os.tmpdir(), `gittool-fsmonitor-${process.pid}`);
    const rel = path.relative(root, dir);
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
      execFileSync('git', ['config', 'core.fsmonitor', `touch ${marker}`], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      const result = await tool.execute({ command: 'status', workdir: rel });
      assert.equal(fs.existsSync(marker), false, result);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(marker, { force: true });
    }
  });
});
