// scripts/install-hooks-contract.test.ts — LM-14 contract test for the hook installer.
//
// Every case builds a THROWAWAY git repo under os.tmpdir(). This test never
// touches the real checkout's hooks, and every child git process runs with
// GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_SYSTEM=/dev/null (plus a private
// HOME/TMPDIR) so the operator's ~/.gitconfig is never read or written.
//
// Run: node --import tsx --test scripts/install-hooks-contract.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-hooks.sh');
const GITHOOKS_SRC = path.join(REPO_ROOT, '.githooks');

const SHIM_MARKER = '# COMMANDER-MANAGED-HOOK-SHIM v1';
const BYPASS_LINE = 'COMMANDER_SKIP_PRECOMMIT=1';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm14-hooks-contract-')));
const TMP_HOME = path.join(SANDBOX, 'home');
const TMP_TMP = path.join(SANDBOX, 'tmp');
fs.mkdirSync(TMP_HOME, { recursive: true });
fs.mkdirSync(TMP_TMP, { recursive: true });

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: TMP_HOME,
    TMPDIR: TMP_TMP,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'lm14-test',
    GIT_AUTHOR_EMAIL: 'lm14@example.invalid',
    GIT_COMMITTER_NAME: 'lm14-test',
    GIT_COMMITTER_EMAIL: 'lm14@example.invalid',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

function run(cmd: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

function mustGit(cwd: string, ...args: string[]): string {
  const r = run('git', args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function installer(cwd: string, args: string[] = []): SpawnSyncReturns<string> {
  return run('bash', [INSTALLER, ...args], cwd);
}

function makeRepo(label: string): string {
  const dir = path.join(SANDBOX, label);
  fs.mkdirSync(dir, { recursive: true });
  const init = run('git', ['init', '-q', '-b', 'main'], dir);
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  fs.cpSync(GITHOOKS_SRC, path.join(dir, '.githooks'), { recursive: true });
  for (const hook of ['pre-commit', 'pre-push']) {
    fs.chmodSync(path.join(dir, '.githooks', hook), 0o755);
  }
  // Commit .githooks so linked worktrees check out a real copy of it (as the
  // actual repository does). These git commands only ever run inside the
  // throwaway repo under os.tmpdir().
  mustGit(dir, 'add', '.githooks');
  mustGit(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** The hooks directory git itself resolves for this checkout (config honoured). */
function hooksDir(cwd: string): string {
  const raw = mustGit(cwd, 'rev-parse', '--git-path', 'hooks');
  return path.isAbsolute(raw) ? raw : path.join(cwd, raw);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifestOf(cwd: string, hook: string): string {
  return path.join(hooksDir(cwd), `${hook}.commander-manifest`);
}

function writeHook(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function legacyBypassHook(): string {
  return [
    '#!/usr/bin/env bash',
    '# legacy local pre-commit with an environment escape hatch',
    `if [ "\${${BYPASS_LINE}:-0}" = "1" ]; then`,
    '  echo "skipped" >&2',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function out(res: SpawnSyncReturns<string>): string {
  return `${res.stdout}${res.stderr}`;
}

// ── plain repo ───────────────────────────────────────────────────────────────

test('plain repo: installs a managed shim into the resolved hooks dir and writes a manifest', () => {
  const repo = makeRepo('plain');
  const srcHashBefore = sha256(path.join(repo, '.githooks', 'pre-commit'));

  const res = installer(repo);
  assert.equal(res.status, 0, `installer failed: ${out(res)}`);

  const dir = hooksDir(repo);
  assert.equal(dir, path.join(repo, '.git', 'hooks'), 'unexpected resolved hooks dir');
  const target = path.join(dir, 'pre-commit');
  assert.ok(fs.existsSync(target), 'managed shim was not installed');

  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes(SHIM_MARKER), 'installed file is not a managed shim');
  assert.ok(content.includes('/.githooks/pre-commit'), 'shim does not delegate to .githooks');
  assert.ok(
    content.includes(`REPO_ROOT="${repo}"`),
    'shim does not resolve the repo root it was installed from',
  );
  assert.notEqual(fs.statSync(target).mode & 0o111, 0, 'shim is not executable');

  const manifest = fs.readFileSync(manifestOf(repo, 'pre-commit'), 'utf8');
  for (const key of [
    'target=',
    'backup=',
    'backup_sha256=',
    'installed_sha256=',
    'previous_core_hooks_path=',
  ]) {
    assert.ok(manifest.includes(key), `manifest is missing ${key}`);
  }
  assert.equal(
    /^installed_sha256=(.*)$/m.exec(manifest)?.[1],
    sha256(target),
    'recorded installed hash mismatch',
  );
  assert.equal(
    /^previous_core_hooks_path=(.*)$/m.exec(manifest)?.[1],
    '',
    'core.hooksPath should have been empty',
  );

  // Nothing was backed up (there was nothing) and the version-controlled source
  // is untouched — the installer only writes shims into the hooks dir.
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('commander-backup')),
    [],
    'unexpected backup created for an empty hooks dir',
  );
  assert.equal(
    sha256(path.join(repo, '.githooks', 'pre-commit')),
    srcHashBefore,
    '.githooks source was modified',
  );
});

test('installed shim delegates to .githooks with the forwarded argv', () => {
  const repo = makeRepo('delegate');
  assert.equal(installer(repo).status, 0, 'install failed');
  writeHook(
    path.join(repo, '.githooks', 'pre-commit'),
    '#!/usr/bin/env bash\nprintf "stub:%s\\n" "$*"\nexit 0\n',
  );
  const target = path.join(hooksDir(repo), 'pre-commit');
  const res = run('bash', [target, 'origin', 'https://example.invalid/repo.git'], repo);
  assert.equal(res.status, 0, `shim execution failed: ${out(res)}`);
  assert.match(res.stdout, /stub:origin https:\/\/example\.invalid\/repo\.git/);
});

// ── repeated install ─────────────────────────────────────────────────────────

test('repeated install of identical content is a no-op (no new backups, unchanged bytes)', () => {
  const repo = makeRepo('repeat');
  const first = installer(repo);
  assert.equal(first.status, 0, `first install failed: ${out(first)}`);

  const dir = hooksDir(repo);
  const target = path.join(dir, 'pre-commit');
  const hashBefore = sha256(target);
  const manifestBefore = fs.readFileSync(manifestOf(repo, 'pre-commit'), 'utf8');

  const second = installer(repo);
  assert.equal(second.status, 0, `second install failed: ${out(second)}`);
  assert.match(second.stdout, /no-op/i, 'second install did not report a no-op');

  assert.equal(sha256(target), hashBefore, 'no-op install rewrote the shim bytes');
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('commander-backup')),
    [],
    'no-op install created a backup',
  );
  assert.equal(fs.readFileSync(manifestOf(repo, 'pre-commit'), 'utf8'), manifestBefore);
});

// ── linked worktree (.git is a file) ─────────────────────────────────────────

test('linked worktree: shim lands in the real hooks dir even though the repo root has .git as a file', () => {
  const repo = makeRepo('wt-main');
  const wt = path.join(SANDBOX, 'wt-linked');
  const add = run('git', ['worktree', 'add', '-q', '--detach', wt], repo);
  assert.equal(add.status, 0, `git worktree add failed: ${add.stderr}`);
  assert.ok(
    fs.statSync(path.join(wt, '.git')).isFile(),
    'precondition failed: .git in the worktree is not a file',
  );

  const res = installer(wt);
  assert.equal(res.status, 0, `installer failed in a worktree: ${out(res)}`);

  const dir = hooksDir(wt);
  assert.ok(path.isAbsolute(dir), 'worktree hooks path should be absolute');
  const target = path.join(dir, 'pre-commit');
  assert.ok(fs.existsSync(target), 'shim not installed into the worktree hooks dir');
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(content.includes(SHIM_MARKER), 'worktree hook is not a managed shim');
  assert.ok(content.includes(`REPO_ROOT="${wt}"`), 'shim does not point at the worktree checkout');
  assert.ok(
    !fs.existsSync(path.join(wt, '.git', 'hooks')),
    'installer treated the .git file as a directory',
  );
});

// ── custom core.hooksPath ────────────────────────────────────────────────────

test('custom core.hooksPath: exits non-zero, writes nothing, keeps git config', () => {
  const repo = makeRepo('custompath');
  const custom = path.join(repo, 'custom-hooks');
  fs.mkdirSync(custom, { recursive: true });
  mustGit(repo, 'config', 'core.hooksPath', 'custom-hooks');
  const configBefore = mustGit(repo, 'config', '--get', 'core.hooksPath');

  const res = installer(repo);
  assert.notEqual(res.status, 0, 'installer accepted an unsupported custom hooksPath');
  assert.match(res.stderr, /core\.hooksPath/, 'refusal message does not name core.hooksPath');

  assert.equal(
    mustGit(repo, 'config', '--get', 'core.hooksPath'),
    configBefore,
    'git config was changed on failure',
  );
  assert.deepEqual(fs.readdirSync(custom), [], 'wrote into the custom hooksPath');
  assert.ok(
    !fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')),
    'wrote into the default hooks dir anyway',
  );
  assert.ok(!fs.existsSync(manifestOf(repo, 'pre-commit')), 'wrote a manifest despite refusing');
});

test('core.hooksPath pointing at .githooks is honoured: reports already-wired, writes nothing', () => {
  const repo = makeRepo('hookspath-githooks');
  mustGit(repo, 'config', 'core.hooksPath', '.githooks');
  const srcBefore = sha256(path.join(repo, '.githooks', 'pre-commit'));

  const res = installer(repo);
  assert.equal(res.status, 0, `installer should report an already-wired hooksPath: ${out(res)}`);
  assert.match(out(res), /hooksPath/, 'no explanation printed');

  assert.equal(
    sha256(path.join(repo, '.githooks', 'pre-commit')),
    srcBefore,
    'clobbered the version-controlled hook',
  );
  assert.deepEqual(
    fs
      .readdirSync(path.join(repo, '.githooks'))
      .filter((f) => f.startsWith('pre-commit') && f !== 'pre-commit'),
    [],
    'wrote installer state into .githooks',
  );
  assert.ok(
    !fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')),
    'wrote a shim into the unused default dir',
  );
});

// ── unknown pre-existing hook ────────────────────────────────────────────────

test('unknown pre-existing hook: refuses non-zero, overwrites nothing, installs nothing (all-or-nothing)', () => {
  const repo = makeRepo('unknown-hook');
  const dir = hooksDir(repo);
  const target = path.join(dir, 'pre-commit');
  writeHook(target, '#!/usr/bin/env bash\n# local hook this installer does not own\nexit 0\n');
  const hashBefore = sha256(target);

  const res = installer(repo);
  assert.notEqual(res.status, 0, 'installer overwrote an unowned hook');
  assert.match(res.stderr, /Refusing to overwrite/, 'refusal message missing');

  assert.equal(sha256(target), hashBefore, 'unowned hook was modified');
  assert.ok(
    !fs.existsSync(manifestOf(repo, 'pre-commit')),
    'wrote a manifest for a refused install',
  );
  assert.ok(
    !fs.existsSync(path.join(dir, 'pre-push')),
    'installed pre-push despite pre-commit being refused',
  );
});

// ── legacy bypass backups ────────────────────────────────────────────────────

test('legacy .bak backup containing a bypass is never silently restored on uninstall', () => {
  const repo = makeRepo('legacy-bak');
  const dir = hooksDir(repo);
  const legacyBackup = path.join(dir, 'pre-commit.bak.1700000000');
  writeHook(legacyBackup, legacyBypassHook());
  const backupHash = sha256(legacyBackup);

  const install = installer(repo);
  assert.equal(install.status, 0, `install failed: ${out(install)}`);
  assert.ok(
    fs.readFileSync(path.join(dir, 'pre-commit'), 'utf8').includes(SHIM_MARKER),
    'shim missing after install',
  );

  const uninstall = installer(repo, ['--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed: ${out(uninstall)}`);

  const target = path.join(dir, 'pre-commit');
  assert.ok(
    !fs.existsSync(target),
    'uninstall left the legacy bypass content installed at the target',
  );
  assert.equal(sha256(legacyBackup), backupHash, 'legacy backup was modified or deleted');
  assert.ok(
    fs.readFileSync(legacyBackup, 'utf8').includes(BYPASS_LINE),
    'legacy backup content changed',
  );
});

test('adopted hook with a known bypass: backed up, then uninstall refuses to restore it', () => {
  const repo = makeRepo('adopt-bypass');
  const dir = hooksDir(repo);
  const target = path.join(dir, 'pre-commit');
  writeHook(target, legacyBypassHook());

  const install = installer(repo, ['--adopt-existing']);
  assert.equal(install.status, 0, `adopt install failed: ${out(install)}`);
  assert.ok(fs.readFileSync(target, 'utf8').includes(SHIM_MARKER), 'shim missing after adopt');

  const manifest = fs.readFileSync(manifestOf(repo, 'pre-commit'), 'utf8');
  const backup = /^backup=(.*)$/m.exec(manifest)?.[1] ?? '';
  assert.notEqual(backup, '', 'manifest did not record a backup path');
  assert.ok(fs.existsSync(backup), 'recorded backup file missing');
  assert.ok(
    fs.readFileSync(backup, 'utf8').includes(BYPASS_LINE),
    'backup does not hold the original hook',
  );
  assert.equal(
    /^backup_sha256=(.*)$/m.exec(manifest)?.[1],
    sha256(backup),
    'recorded backup hash mismatch',
  );
  assert.match(manifest, /^backup_contains_known_bypass=1$/m, 'bypass not flagged in the manifest');

  const installedHash = sha256(target);
  const backupHash = sha256(backup);
  const uninstall = installer(repo, ['--uninstall']);
  assert.notEqual(uninstall.status, 0, 'uninstall silently restored a bypassable hook');
  assert.match(uninstall.stderr, /bypass/i, 'refusal message does not explain the bypass');

  assert.equal(sha256(target), installedHash, 'refused uninstall still changed the installed shim');
  assert.equal(sha256(backup), backupHash, 'refused uninstall changed the backup');
  assert.ok(
    !fs.readFileSync(target, 'utf8').includes(BYPASS_LINE),
    'bypass content ended up at the target',
  );
  assert.ok(fs.existsSync(manifestOf(repo, 'pre-commit')), 'manifest removed despite the refusal');
  assert.ok(
    fs.readFileSync(path.join(dir, 'pre-push'), 'utf8').includes(SHIM_MARKER),
    'refusal was not all-or-nothing: pre-push was uninstalled',
  );
});

test('adopted clean hook is restored byte-identically on uninstall', () => {
  const repo = makeRepo('adopt-clean');
  const target = path.join(hooksDir(repo), 'pre-commit');
  writeHook(target, '#!/usr/bin/env bash\n# local hook without any bypass\nexit 0\n');
  const hashBefore = sha256(target);

  assert.equal(installer(repo, ['--adopt-existing']).status, 0, 'adopt install failed');
  const uninstall = installer(repo, ['--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed: ${out(uninstall)}`);

  assert.equal(sha256(target), hashBefore, 'original hook was not restored byte-identically');
  assert.ok(
    !fs.existsSync(manifestOf(repo, 'pre-commit')),
    'manifest left behind after a successful uninstall',
  );
});

// ── third-party modification ─────────────────────────────────────────────────

test('shim modified by a third party: uninstall refuses and changes nothing', () => {
  const repo = makeRepo('modified');
  assert.equal(installer(repo).status, 0, 'install failed');
  const dir = hooksDir(repo);
  const target = path.join(dir, 'pre-commit');
  fs.appendFileSync(target, '\n# tampered by someone else\n');
  const tamperedHash = sha256(target);
  const configBefore = mustGit(repo, 'config', '--list', '--local');

  const uninstall = installer(repo, ['--uninstall']);
  assert.notEqual(uninstall.status, 0, 'uninstall accepted a hook modified by someone else');
  assert.match(uninstall.stderr, /modified after installation/i, 'refusal message missing');

  assert.equal(sha256(target), tamperedHash, 'refused uninstall rewrote the modified file');
  assert.equal(
    mustGit(repo, 'config', '--list', '--local'),
    configBefore,
    'git config changed on failure',
  );
  assert.ok(fs.existsSync(manifestOf(repo, 'pre-commit')), 'manifest removed despite the refusal');
});
