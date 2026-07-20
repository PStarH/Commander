import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { describe, it } from 'node:test';

describe('compatibility.v2 contracts root', () => {
  it('does not throw on import from an unrelated cwd', async () => {
    const saved = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'contracts-cwd-'));
    try {
      chdir(dir);
      const mod = await import('./compatibility.v2.js');
      const snapshot = mod.snapshotContracts();
      assert.ok(Object.keys(snapshot.contracts).length > 0);
    } finally {
      chdir(saved);
    }
  });

  it('includes schemas and fixtures in package files', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { files: string[] };
    assert.ok(pkg.files.includes('schemas'));
    assert.ok(pkg.files.includes('fixtures'));
  });
});
