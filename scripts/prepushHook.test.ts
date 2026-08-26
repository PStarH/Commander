import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('pre-push format hook', () => {
  it('checks only the explicit CI replay paths', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/prepushHook.ts', 'scripts/task1-helm-prerequisite-command.ts'],
      {
        encoding: 'utf8',
        env: { ...process.env, CORE_PREPUSH_HOOK: '1' },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prettier check on 1 changed path/);
  });

  it('checks only files changed by the pre-push ref update', () => {
    const local = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/prepushHook.ts'], {
      encoding: 'utf8',
      input: 'refs/heads/test ' + local + ' refs/heads/test ' + remote + '\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prettier check on 2 changed path\(s\)/);
  });
});
