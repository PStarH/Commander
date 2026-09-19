import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { atomicExport } from './atomicExport.js';

describe('atomic owner-only report export', () => {
  it('writes the selected file with mode 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-export-'));
    const output = join(directory, 'report.json');
    atomicExport(output, '{"schema":"test"}\n');
    assert.equal(readFileSync(output, 'utf8'), '{"schema":"test"}\n');
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
  });

  it('refuses symlink targets and non-directory parents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-export-'));
    const real = join(directory, 'real.json');
    const link = join(directory, 'link.json');
    writeFileSync(real, 'unchanged', { mode: 0o600 });
    symlinkSync(real, link);
    assert.throws(() => atomicExport(link, 'replaced'), /SHADOW_EXPORT_SYMLINK_FORBIDDEN/);
    assert.equal(readFileSync(real, 'utf8'), 'unchanged');
    assert.throws(
      () => atomicExport(join(real, 'child.json'), 'x'),
      /SHADOW_EXPORT_PARENT_INVALID/,
    );
  });

  it('accepts a symlinked parent directory and writes through it at 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-export-'));
    const realParent = join(directory, 'real-parent');
    const linkedParent = join(directory, 'linked-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const output = join(linkedParent, 'report.json');
    atomicExport(output, '{"schema":"through-symlink"}\n');
    assert.equal(
      readFileSync(join(realParent, 'report.json'), 'utf8'),
      '{"schema":"through-symlink"}\n',
    );
    assert.equal(lstatSync(join(realParent, 'report.json')).mode & 0o777, 0o600);
  });

  it('still refuses a symlinked output target inside a symlinked parent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-export-'));
    const realParent = join(directory, 'real-parent');
    const linkedParent = join(directory, 'linked-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const real = join(realParent, 'real.json');
    writeFileSync(real, 'unchanged', { mode: 0o600 });
    symlinkSync(real, join(linkedParent, 'link.json'));
    assert.throws(
      () => atomicExport(join(linkedParent, 'link.json'), 'replaced'),
      /SHADOW_EXPORT_SYMLINK_FORBIDDEN/,
    );
    assert.equal(readFileSync(real, 'utf8'), 'unchanged');
  });
});
