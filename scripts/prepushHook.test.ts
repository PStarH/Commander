import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'prepushHook.ts');

// Records the working directory and argv of every formatter invocation. Using
// a stub keeps the assertions about path selection independent of whether the
// checked-out files happen to satisfy Prettier right now.
const STUB_PNPM = [
  '#!/bin/sh',
  'pwd -P > "$PREPUSH_TEST_RECORD"',
  'for arg in "$@"; do',
  '  printf \'arg=%s\\n\' "$arg" >> "$PREPUSH_TEST_RECORD"',
  'done',
  'exit 0',
  '',
].join('\n');

interface HookFixture {
  main: string;
  linked: string;
  linkedGitDir: string;
  refUpdate: string;
  expected: string[];
  env: NodeJS.ProcessEnv;
  formatterCalls: () => { cwd: string; args: string[] };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Builds a throwaway repository whose HEAD^..HEAD touches exactly two
 * TypeScript paths plus one Markdown file. The expected formatter target set
 * is therefore fixed by construction instead of being derived from this
 * repository's history, which grows one commit at a time.
 */
function withHookFixture(run: (fixture: HookFixture) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-prepush-hook-'));
  const main = path.join(tempRoot, 'main');
  const linked = path.join(tempRoot, 'linked');
  const binDir = path.join(tempRoot, 'bin');
  const recordPath = path.join(tempRoot, 'formatter-calls.txt');
  const identity = ['-c', 'user.name=Prepush Hook Test', '-c', 'user.email=test@example.com'];

  try {
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    git(main, ['init', '-q']);
    fs.writeFileSync(path.join(main, 'first.ts'), 'export const first = 1;\n');
    git(main, ['add', '.']);
    git(main, [...identity, 'commit', '-q', '-m', 'base']);
    const remote = git(main, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(main, 'first.ts'), 'export const first = 2;\n');
    fs.writeFileSync(path.join(main, 'second.tsx'), 'export const second = 2;\n');
    fs.writeFileSync(path.join(main, 'notes.md'), '# not formatter-checked\n');
    git(main, ['add', '.']);
    git(main, [...identity, 'commit', '-q', '-m', 'change']);
    const local = git(main, ['rev-parse', 'HEAD']);

    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(main, 'node_modules'), 'dir');
    git(main, ['worktree', 'add', '--detach', linked]);
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(linked, 'node_modules'), 'dir');

    const stubPnpm = path.join(binDir, 'pnpm');
    fs.writeFileSync(stubPnpm, STUB_PNPM);
    fs.chmodSync(stubPnpm, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: binDir + path.delimiter + process.env.PATH,
      PREPUSH_TEST_RECORD: recordPath,
    };
    delete env.GIT_DIR;
    delete env.CORE_PREPUSH_HOOK;

    run({
      main,
      linked,
      linkedGitDir: git(linked, ['rev-parse', '--path-format=absolute', '--git-dir']),
      refUpdate: 'refs/heads/test ' + local + ' refs/heads/test ' + remote + '\n',
      expected: ['first.ts', 'second.tsx'],
      env,
      formatterCalls: () => {
        assert.ok(fs.existsSync(recordPath), 'stub pnpm was never invoked');
        const lines = fs.readFileSync(recordPath, 'utf8').trimEnd().split('\n');
        for (const line of lines.slice(1)) {
          assert.match(line, /^arg=/, 'unexpected stub output line: ' + line);
        }
        return { cwd: lines[0]!, args: lines.slice(1).map((line) => line.slice(4)) };
      },
    });
  } finally {
    try {
      git(main, ['worktree', 'remove', '--force', linked]);
    } catch {
      // The fixture directory is removed below regardless.
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runHook(cwd: string, env: NodeJS.ProcessEnv, input: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', HOOK_PATH], {
    cwd,
    encoding: 'utf8',
    env,
    input,
  });
}

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
    withHookFixture((fixture) => {
      const result = runHook(fixture.main, fixture.env, fixture.refUpdate);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Prettier check on 2 changed path\(s\)/);
      const calls = fixture.formatterCalls();
      assert.equal(fs.realpathSync(calls.cwd), fs.realpathSync(fixture.main));
      assert.deepEqual(calls.args, ['exec', 'prettier', '--check', ...fixture.expected]);
    });
  });

  it('resolves the linked worktree root when Git supplies its administrative directory', () => {
    withHookFixture((fixture) => {
      const result = runHook(
        fixture.linked,
        { ...fixture.env, GIT_DIR: fixture.linkedGitDir },
        fixture.refUpdate,
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Prettier check on 2 changed path\(s\)/);
      const calls = fixture.formatterCalls();
      assert.equal(fs.realpathSync(calls.cwd), fs.realpathSync(fixture.linked));
      assert.deepEqual(calls.args, ['exec', 'prettier', '--check', ...fixture.expected]);
    });
  });
});
