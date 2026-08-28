import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('pre-push hook', () => {
  it('runs the formatter from the linked worktree root', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
      encoding: 'utf8',
    }).trim();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-prepush-hook-'));
    const fakePnpm = path.join(binDir, 'pnpm');
    fs.writeFileSync(fakePnpm, '#!/bin/sh\nprintf "%s" "$PWD" >&2\nexit 1\n');
    fs.chmodSync(fakePnpm, 0o755);

    try {
      assert.throws(
        () =>
          execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prepushHook.ts'], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
              ...process.env,
              GIT_DIR: gitDir,
              PATH: binDir + path.delimiter + process.env.PATH,
            },
            stdio: 'pipe',
          }),
        (error: Error & { stderr?: string }) => {
          assert.match(
            String(error.stderr),
            new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
