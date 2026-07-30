import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function run(command: string): string {
  return execFileSync('pnpm', [command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('legacy authority architecture gates', () => {
  it('passes the Architecture V2 source gate', () => {
    assert.match(run('arch:gate'), /Architecture V2 gate passed/);
  });

  it('passes the package constitution guard', () => {
    assert.match(run('arch:guard'), /Architecture constitution guard passed/);
  });
});
